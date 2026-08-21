from __future__ import annotations

import base64
import hashlib
import hmac
import json
import sqlite3
import time
import unicodedata
from decimal import Decimal
from typing import Any

from pydantic import ValidationError

from .config import company_profile, secret_key
from .contracts import ACTION_MODELS, StrictModel
from .db import bump_state_version, state_version, utc_now


PREVIEW_TTL_SECONDS = 15 * 60


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def payload_digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def normalize_alias(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return " ".join(normalized.split()).casefold()


def decimal_text(value: Decimal | str | int | float) -> str:
    parsed = Decimal(str(value))
    rendered = format(parsed.normalize(), "f")
    return "0" if Decimal(rendered) == 0 else rendered


def _encode_token(payload: dict[str, Any]) -> str:
    raw = canonical_json(payload).encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    signature = hmac.new(secret_key(), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def _decode_token(token: str) -> dict[str, Any]:
    encoded, separator, signature = token.partition(".")
    if separator != "." or not signature:
        raise ValueError("preview token is invalid")
    expected = hmac.new(secret_key(), encoded.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError("preview token signature is invalid")
    try:
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        payload = json.loads(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        raise ValueError("preview token payload is invalid") from exc
    if int(payload.get("expires_at") or 0) < int(time.time()):
        raise ValueError("preview token has expired")
    return payload


def _validated(action: str, data: dict[str, Any]) -> StrictModel:
    model = ACTION_MODELS.get(action)
    if model is None:
        raise ValueError("unsupported action")
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc


def _payload(model: StrictModel) -> dict[str, Any]:
    return model.model_dump(mode="json", exclude_none=True)


def _external_identity(model: StrictModel) -> tuple[str, str] | None:
    source_id = getattr(model, "source_id", None)
    external_id = getattr(model, "external_id", None)
    return (str(source_id), str(external_id)) if source_id and external_id else None


def _existing_external(
    conn: sqlite3.Connection,
    model: StrictModel,
    normalized: dict[str, Any],
) -> sqlite3.Row | None:
    identity = _external_identity(model)
    if not identity:
        return None
    row = conn.execute(
        "SELECT * FROM external_records WHERE source_id=? AND external_id=?",
        identity,
    ).fetchone()
    if row and row["payload_digest"] != payload_digest(normalized):
        raise ValueError("external identity already exists with different content")
    return row


def _require_row(conn: sqlite3.Connection, table: str, entity_id: int, label: str) -> sqlite3.Row:
    if table not in {"parties", "products", "units", "locations"}:
        raise RuntimeError("unsupported reference table")
    row = conn.execute(f"SELECT * FROM {table} WHERE id=? AND status='active'", (entity_id,)).fetchone()
    if row is None:
        raise ValueError(f"active {label} does not exist")
    return row


def _require_existing_row(conn: sqlite3.Connection, table: str, entity_id: int, label: str) -> sqlite3.Row:
    if table not in {"parties", "units"}:
        raise RuntimeError("unsupported alias owner table")
    row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (entity_id,)).fetchone()
    if row is None:
        raise ValueError(f"{label} does not exist")
    return row


def _require_party_role(conn: sqlite3.Connection, party_id: int, role: str) -> None:
    _require_row(conn, "parties", party_id, role)
    if conn.execute(
        "SELECT 1 FROM party_roles WHERE party_id=? AND role_key=?",
        (party_id, role),
    ).fetchone() is None:
        raise ValueError(f"party is not an active {role}")


def stock_balance(conn: sqlite3.Connection, product_id: int, unit_id: int, location_id: int) -> Decimal:
    rows = conn.execute(
        "SELECT quantity_delta FROM inventory_movements WHERE product_id=? AND unit_id=? AND location_id=?",
        (product_id, unit_id, location_id),
    ).fetchall()
    return sum((Decimal(row[0]) for row in rows), Decimal("0"))


def _fulfilled_quantity(conn: sqlite3.Connection, order_type: str, line_id: int) -> Decimal:
    rows = conn.execute(
        "SELECT quantity FROM order_fulfillments WHERE order_type=? AND order_line_id=?",
        (order_type, line_id),
    ).fetchall()
    return sum((Decimal(row[0]) for row in rows), Decimal("0"))


def _order_tables(order_type: str) -> tuple[str, str]:
    if order_type == "sale":
        return "sales_orders", "sales_order_lines"
    if order_type == "purchase":
        return "purchase_orders", "purchase_order_lines"
    raise ValueError("unsupported order type")


def _validate_order_lines(conn: sqlite3.Connection, lines: list[Any]) -> None:
    seen: set[tuple[int, int]] = set()
    for line in lines:
        product = _require_row(conn, "products", line.product_id, "product")
        _require_row(conn, "units", line.unit_id, "unit")
        if int(product["unit_id"]) != line.unit_id:
            raise ValueError("order line unit does not match the product base unit")
        key = (line.product_id, line.unit_id)
        if key in seen:
            raise ValueError("an order cannot repeat the same product and unit")
        seen.add(key)


def _validate_fulfillment(conn: sqlite3.Connection, model: Any, order_type: str) -> None:
    order_table, line_table = _order_tables(order_type)
    order = conn.execute(f"SELECT * FROM {order_table} WHERE id=?", (model.order_id,)).fetchone()
    if order is None:
        raise ValueError("order does not exist")
    if order["status"] in {"fulfilled", "cancelled"}:
        raise ValueError("order no longer accepts fulfillment")
    _require_row(conn, "locations", model.location_id, "location")
    seen: set[int] = set()
    for requested in model.lines:
        if requested.line_id in seen:
            raise ValueError("fulfillment line ids must be unique")
        seen.add(requested.line_id)
        line = conn.execute(
            f"SELECT * FROM {line_table} WHERE id=? AND order_id=?",
            (requested.line_id, model.order_id),
        ).fetchone()
        if line is None:
            raise ValueError("order line does not belong to this order")
        remaining = Decimal(line["quantity"]) - _fulfilled_quantity(conn, order_type, requested.line_id)
        if requested.quantity > remaining:
            raise ValueError("fulfillment quantity exceeds the remaining order quantity")
        if order_type == "sale":
            available = stock_balance(conn, line["product_id"], line["unit_id"], model.location_id)
            if requested.quantity > available:
                raise ValueError("shipment would make inventory negative")


def _validate_action(conn: sqlite3.Connection, action: str, model: StrictModel) -> None:
    if action == "create_party":
        status = model.status or "active"
        _validate_party_successor(conn, status, model.successor_party_id)
        _validate_canonical_value(
            conn,
            table="parties",
            column="canonical_name",
            alias_table="party_aliases",
            value=model.canonical_name,
            label="party",
            permitted_alias_owner_id=model.successor_party_id if status == "deprecated" else None,
        )
        return
    if action == "create_party_alias":
        _require_existing_row(conn, "parties", model.party_id, "party")
        _validate_alias_owner(conn, "party_aliases", "party_id", model.party_id, model.alias, model.status)
        return
    if action == "create_product":
        _require_row(conn, "units", model.unit_id, "unit")
        return
    if action == "create_unit":
        _validate_canonical_value(
            conn,
            table="units",
            column="code",
            alias_table="unit_aliases",
            value=model.code,
            label="unit",
        )
        return
    if action == "create_unit_alias":
        _require_existing_row(conn, "units", model.unit_id, "unit")
        _validate_alias_owner(conn, "unit_aliases", "unit_id", model.unit_id, model.alias, model.status)
        return
    if action == "create_location":
        return
    if action == "create_sales_order":
        _require_party_role(conn, model.customer_id, "customer")
        _validate_order_lines(conn, model.lines)
        return
    if action == "create_purchase_order":
        _require_party_role(conn, model.supplier_id, "supplier")
        _validate_order_lines(conn, model.lines)
        return
    if action == "receive_purchase":
        _validate_fulfillment(conn, model, "purchase")
        return
    if action == "ship_sale":
        _validate_fulfillment(conn, model, "sale")
        return
    if action == "post_inventory_adjustment":
        product = _require_row(conn, "products", model.product_id, "product")
        _require_row(conn, "units", model.unit_id, "unit")
        if int(product["unit_id"]) != model.unit_id:
            raise ValueError("inventory unit does not match the product base unit")
        _require_row(conn, "locations", model.location_id, "location")
        if stock_balance(conn, model.product_id, model.unit_id, model.location_id) + model.quantity_delta < 0:
            raise ValueError("inventory adjustment would make inventory negative")
        return
    if action == "reverse_movement":
        movement = conn.execute("SELECT * FROM inventory_movements WHERE id=?", (model.movement_id,)).fetchone()
        if movement is None:
            raise ValueError("inventory movement does not exist")
        if conn.execute(
            "SELECT 1 FROM inventory_movements WHERE reverses_movement_id=?",
            (model.movement_id,),
        ).fetchone():
            raise ValueError("inventory movement is already reversed")
        projected = stock_balance(
            conn,
            movement["product_id"],
            movement["unit_id"],
            movement["location_id"],
        ) - Decimal(movement["quantity_delta"])
        if projected < 0:
            raise ValueError("reversal would make inventory negative")
        return
    if action == "cancel_order":
        table, _ = _order_tables(model.order_type)
        order = conn.execute(f"SELECT * FROM {table} WHERE id=?", (model.order_id,)).fetchone()
        if order is None:
            raise ValueError("order does not exist")
        if order["status"] in {"fulfilled", "cancelled"}:
            raise ValueError("order cannot be cancelled in its current status")
        return
    raise ValueError("unsupported action")


def _validate_alias_owner(
    conn: sqlite3.Connection,
    table: str,
    owner_column: str,
    owner_id: int,
    alias: str,
    status: str | None,
    exclude_alias_id: int | None = None,
) -> None:
    normalized = normalize_alias(alias)
    if not normalized:
        raise ValueError("alias must contain visible text")
    if table == "party_aliases":
        canonical_rows = conn.execute(
            "SELECT id,canonical_name,status,successor_party_id FROM parties"
        ).fetchall()
        canonical_columns = ("canonical_name",)
    elif table == "unit_aliases":
        canonical_rows = conn.execute("SELECT id,code,display_name FROM units").fetchall()
        canonical_columns = ("code", "display_name")
    else:
        raise RuntimeError("unsupported alias table")
    for row in canonical_rows:
        if any(normalize_alias(str(row[column])) == normalized for column in canonical_columns):
            if int(row["id"]) == owner_id:
                raise ValueError("alias duplicates its canonical resource identity")
            if (
                table == "party_aliases"
                and (status or "active") == "active"
                and row["status"] == "deprecated"
                and row["successor_party_id"] is not None
                and int(row["successor_party_id"]) == owner_id
            ):
                continue
            raise ValueError("alias conflicts with a different canonical resource")
    parameters: list[Any] = [normalized]
    where = "normalized_alias=?"
    if exclude_alias_id is not None:
        where += " AND id<>?"
        parameters.append(exclude_alias_id)
    rows = conn.execute(
        f"SELECT {owner_column},status FROM {table} WHERE {where}",
        tuple(parameters),
    ).fetchall()
    if any(int(row[owner_column]) == owner_id for row in rows):
        raise ValueError("alias already exists for the canonical resource")
    if (status or "active") == "active" and any(row["status"] == "active" for row in rows):
        raise ValueError("active alias already belongs to a different canonical resource")


def _validate_canonical_value(
    conn: sqlite3.Connection,
    *,
    table: str,
    column: str,
    alias_table: str,
    value: str,
    label: str,
    exclude_entity_id: int | None = None,
    permitted_alias_owner_id: int | None = None,
) -> None:
    normalized = normalize_alias(value)
    if not normalized:
        raise ValueError(f"{label} canonical identity must contain visible text")
    for row in conn.execute(f"SELECT id,{column} FROM {table}"):
        if exclude_entity_id is not None and int(row["id"]) == exclude_entity_id:
            continue
        if normalize_alias(str(row[column])) == normalized:
            raise ValueError(f"{label} canonical identity already exists")
    alias_owner_column = "party_id" if alias_table == "party_aliases" else "unit_id"
    alias_rows = conn.execute(
        f"SELECT {alias_owner_column},status FROM {alias_table} WHERE normalized_alias=?",
        (normalized,),
    ).fetchall()
    if alias_rows:
        permitted = (
            alias_table == "party_aliases"
            and permitted_alias_owner_id is not None
            and all(int(row[alias_owner_column]) == permitted_alias_owner_id for row in alias_rows)
        )
        if not permitted:
            raise ValueError(f"{label} canonical identity conflicts with an existing alias")


def _validate_party_successor(
    conn: sqlite3.Connection,
    status: str,
    successor_party_id: int | None,
    *,
    entity_id: int | None = None,
) -> None:
    if status == "active" and successor_party_id is not None:
        raise ValueError("an active party cannot have a successor")
    if successor_party_id is None:
        return
    if entity_id is not None and successor_party_id == entity_id:
        raise ValueError("a party cannot succeed itself")
    successor = conn.execute(
        "SELECT status FROM parties WHERE id=?",
        (successor_party_id,),
    ).fetchone()
    if successor is None or successor["status"] != "active":
        raise ValueError("party successor must be an active existing party")


def validate_master_data_reconcile(
    conn: sqlite3.Connection,
    resource: str,
    model: StrictModel,
    entity_id: int,
) -> None:
    if resource == "party":
        current = _require_existing_row(conn, "parties", entity_id, "party")
        status = model.status or "active"
        _validate_party_successor(
            conn,
            status,
            model.successor_party_id,
            entity_id=entity_id,
        )
        _validate_canonical_value(
            conn,
            table="parties",
            column="canonical_name",
            alias_table="party_aliases",
            value=model.canonical_name,
            label="party",
            exclude_entity_id=entity_id,
            permitted_alias_owner_id=model.successor_party_id if status == "deprecated" else None,
        )
        current_roles = {
            str(row[0]) for row in conn.execute("SELECT role_key FROM party_roles WHERE party_id=?", (entity_id,))
        }
        removed_roles = current_roles - set(model.roles)
        if "customer" in removed_roles and conn.execute(
            "SELECT 1 FROM sales_orders WHERE customer_id=? LIMIT 1", (entity_id,)
        ).fetchone():
            raise ValueError("customer role cannot be removed after sales use")
        if "supplier" in removed_roles and conn.execute(
            "SELECT 1 FROM purchase_orders WHERE supplier_id=? LIMIT 1", (entity_id,)
        ).fetchone():
            raise ValueError("supplier role cannot be removed after purchase use")
        if status == "deprecated" and current["status"] != "deprecated":
            has_open_sales = conn.execute(
                "SELECT 1 FROM sales_orders WHERE customer_id=? AND status IN ('confirmed','partially_fulfilled') LIMIT 1",
                (entity_id,),
            ).fetchone()
            has_open_purchases = conn.execute(
                "SELECT 1 FROM purchase_orders WHERE supplier_id=? AND status IN ('confirmed','partially_fulfilled') LIMIT 1",
                (entity_id,),
            ).fetchone()
            if has_open_sales or has_open_purchases:
                raise ValueError("party cannot be deprecated while orders remain open")
        return
    if resource == "unit":
        current = _require_existing_row(conn, "units", entity_id, "unit")
        _validate_canonical_value(
            conn,
            table="units",
            column="code",
            alias_table="unit_aliases",
            value=model.code,
            label="unit",
            exclude_entity_id=entity_id,
        )
        identity_changed = model.code != current["code"] or model.dimension != current["dimension"]
        if identity_changed:
            used = any(
                conn.execute(f"SELECT 1 FROM {table} WHERE unit_id=? LIMIT 1", (entity_id,)).fetchone()
                for table in ("products", "sales_order_lines", "purchase_order_lines", "inventory_movements")
            )
            if used:
                raise ValueError("unit code or dimension cannot change after business use")
        if (model.status or "active") == "deprecated" and current["status"] != "deprecated":
            if conn.execute("SELECT 1 FROM products WHERE unit_id=? AND status='active' LIMIT 1", (entity_id,)).fetchone():
                raise ValueError("unit cannot be deprecated while active products use it")
        return
    if resource in {"party_alias", "unit_alias"}:
        table = "party_aliases" if resource == "party_alias" else "unit_aliases"
        owner_column = "party_id" if resource == "party_alias" else "unit_id"
        owner_table = "parties" if resource == "party_alias" else "units"
        owner_label = "party" if resource == "party_alias" else "unit"
        owner_id = model.party_id if resource == "party_alias" else model.unit_id
        if conn.execute(f"SELECT 1 FROM {table} WHERE id=?", (entity_id,)).fetchone() is None:
            raise ValueError(f"{resource} does not exist")
        _require_existing_row(conn, owner_table, owner_id, owner_label)
        _validate_alias_owner(
            conn,
            table,
            owner_column,
            owner_id,
            model.alias,
            model.status,
            exclude_alias_id=entity_id,
        )
        return
    raise ValueError("unsupported reconcile resource")


def execute_master_data_reconcile(
    conn: sqlite3.Connection,
    resource: str,
    model: StrictModel,
    entity_id: int,
) -> dict[str, Any]:
    now = utc_now()
    if resource == "party":
        conn.execute(
            "UPDATE parties SET canonical_name=?,legal_name=?,status=?,successor_party_id=?,updated_at=? WHERE id=?",
            (
                model.canonical_name.strip(),
                model.legal_name.strip(),
                model.status or "active",
                model.successor_party_id,
                now,
                entity_id,
            ),
        )
        current_roles = {
            str(row[0]) for row in conn.execute("SELECT role_key FROM party_roles WHERE party_id=?", (entity_id,))
        }
        desired_roles = set(model.roles)
        for role in sorted(current_roles - desired_roles):
            conn.execute("DELETE FROM party_roles WHERE party_id=? AND role_key=?", (entity_id, role))
        for role in sorted(desired_roles - current_roles):
            conn.execute(
                "INSERT INTO party_roles(party_id,role_key,created_at) VALUES(?,?,?)",
                (entity_id, role, now),
            )
        return party_readback(conn, entity_id)
    if resource == "unit":
        conn.execute(
            "UPDATE units SET code=?,display_name=?,dimension=?,status=?,updated_at=? WHERE id=?",
            (model.code, model.display_name.strip(), model.dimension, model.status or "active", now, entity_id),
        )
        return unit_readback(conn, entity_id)
    if resource in {"party_alias", "unit_alias"}:
        table = "party_aliases" if resource == "party_alias" else "unit_aliases"
        owner_column = "party_id" if resource == "party_alias" else "unit_id"
        owner_id = model.party_id if resource == "party_alias" else model.unit_id
        conn.execute(
            f"UPDATE {table} SET {owner_column}=?,alias=?,normalized_alias=?,status=?,updated_at=? WHERE id=?",
            (owner_id, model.alias.strip(), normalize_alias(model.alias), model.status or "active", now, entity_id),
        )
        return alias_readback(conn, resource, entity_id)
    raise ValueError("unsupported reconcile resource")


def preview_action(conn: sqlite3.Connection, action: str, data: dict[str, Any]) -> dict[str, Any]:
    model = _validated(action, data)
    normalized = _payload(model)
    existing = _existing_external(conn, model, normalized)
    if existing:
        return {
            "status": "already_satisfied",
            "action": action,
            "state_version": state_version(conn),
            "existing": {"resource_type": existing["resource_type"], "entity_id": existing["entity_id"]},
        }
    _validate_action(conn, action, model)
    version = state_version(conn)
    expires_at = int(time.time()) + PREVIEW_TTL_SECONDS
    token = _encode_token(
        {
            "contract": "bizhub.action-preview.v1",
            "action": action,
            "data_digest": payload_digest(normalized),
            "state_version": version,
            "expires_at": expires_at,
        }
    )
    return {
        "status": "ready",
        "action": action,
        "normalized": normalized,
        "state_version": version,
        "preview_token": token,
        "expires_at": expires_at,
    }


def _record_external(
    conn: sqlite3.Connection,
    model: StrictModel,
    normalized: dict[str, Any],
    resource_type: str,
    entity_id: int,
) -> None:
    identity = _external_identity(model)
    if not identity:
        return
    now = utc_now()
    conn.execute(
        "INSERT INTO external_records(source_id,external_id,resource_type,entity_id,payload_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        (*identity, resource_type, entity_id, payload_digest(normalized), now, now),
    )


def _audit(
    conn: sqlite3.Connection,
    *,
    action: str,
    entity_type: str,
    entity_ref: str,
    after: Any,
    actor: str,
    review_note: str,
    before: Any | None = None,
) -> None:
    conn.execute(
        "INSERT INTO audit_events(action,entity_type,entity_ref,before_json,after_json,actor,review_note,created_at) VALUES(?,?,?,?,?,?,?,?)",
        (
            action,
            entity_type,
            entity_ref,
            canonical_json(before or {}),
            canonical_json(after),
            actor,
            review_note,
            utc_now(),
        ),
    )


def _create_party(conn: sqlite3.Connection, model: Any) -> tuple[str, int, dict[str, Any]]:
    now = utc_now()
    cursor = conn.execute(
        "INSERT INTO parties(canonical_name,legal_name,status,successor_party_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        (
            model.canonical_name.strip(),
            model.legal_name.strip(),
            model.status or "active",
            model.successor_party_id,
            now,
            now,
        ),
    )
    entity_id = int(cursor.lastrowid)
    for role in model.roles:
        conn.execute(
            "INSERT INTO party_roles(party_id,role_key,created_at) VALUES(?,?,?)",
            (entity_id, role, now),
        )
    return "party", entity_id, party_readback(conn, entity_id)


def _create_simple(conn: sqlite3.Connection, action: str, model: Any) -> tuple[str, int, dict[str, Any]]:
    now = utc_now()
    if action == "create_product":
        cursor = conn.execute(
            "INSERT INTO products(canonical_name,sku,unit_id,status,created_at,updated_at) VALUES(?,?,?,'active',?,?)",
            (model.canonical_name.strip(), model.sku, model.unit_id, now, now),
        )
        resource = "product"
    elif action == "create_unit":
        cursor = conn.execute(
            "INSERT INTO units(code,display_name,dimension,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (model.code, model.display_name.strip(), model.dimension, model.status or "active", now, now),
        )
        resource = "unit"
    else:
        cursor = conn.execute(
            "INSERT INTO locations(code,display_name,status,created_at,updated_at) VALUES(?,?,'active',?,?)",
            (model.code, model.display_name.strip(), now, now),
        )
        resource = "location"
    entity_id = int(cursor.lastrowid)
    return resource, entity_id, simple_readback(conn, resource, entity_id)


def _create_alias(conn: sqlite3.Connection, action: str, model: Any) -> tuple[str, int, dict[str, Any]]:
    now = utc_now()
    if action == "create_party_alias":
        table, owner_column, owner_id, resource = "party_aliases", "party_id", model.party_id, "party_alias"
    else:
        table, owner_column, owner_id, resource = "unit_aliases", "unit_id", model.unit_id, "unit_alias"
    cursor = conn.execute(
        f"INSERT INTO {table}({owner_column},alias,normalized_alias,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        (owner_id, model.alias.strip(), normalize_alias(model.alias), model.status or "active", now, now),
    )
    entity_id = int(cursor.lastrowid)
    return resource, entity_id, alias_readback(conn, resource, entity_id)


def _create_order(conn: sqlite3.Connection, order_type: str, model: Any) -> tuple[str, int, dict[str, Any]]:
    order_table, line_table = _order_tables(order_type)
    party_column = "customer_id" if order_type == "sale" else "supplier_id"
    party_id = model.customer_id if order_type == "sale" else model.supplier_id
    now = utc_now()
    cursor = conn.execute(
        f"INSERT INTO {order_table}(order_no,{party_column},order_date,currency,status,note,created_at,updated_at) "
        "VALUES(?,?,?,?, 'confirmed',?,?,?)",
        (
            model.order_no.strip(),
            party_id,
            model.order_date.isoformat(),
            model.currency or company_profile().currency,
            model.note.strip(),
            now,
            now,
        ),
    )
    order_id = int(cursor.lastrowid)
    for index, line in enumerate(model.lines, start=1):
        conn.execute(
            f"INSERT INTO {line_table}(order_id,line_no,product_id,unit_id,quantity,unit_price) VALUES(?,?,?,?,?,?)",
            (
                order_id,
                index,
                line.product_id,
                line.unit_id,
                decimal_text(line.quantity),
                decimal_text(line.unit_price) if line.unit_price is not None else None,
            ),
        )
    resource = f"{order_type}_order"
    return resource, order_id, order_readback(conn, order_type, order_id)


def _update_order_status(conn: sqlite3.Connection, order_type: str, order_id: int) -> None:
    order_table, line_table = _order_tables(order_type)
    current = conn.execute(f"SELECT status FROM {order_table} WHERE id=?", (order_id,)).fetchone()
    if current is None or current["status"] == "cancelled":
        return
    lines = conn.execute(f"SELECT * FROM {line_table} WHERE order_id=?", (order_id,)).fetchall()
    fulfilled = [_fulfilled_quantity(conn, order_type, int(line["id"])) for line in lines]
    if all(value >= Decimal(line["quantity"]) for value, line in zip(fulfilled, lines, strict=True)):
        status = "fulfilled"
    elif any(value > 0 for value in fulfilled):
        status = "partially_fulfilled"
    else:
        status = "confirmed"
    conn.execute(f"UPDATE {order_table} SET status=?,updated_at=? WHERE id=?", (status, utc_now(), order_id))


def _fulfill(conn: sqlite3.Connection, order_type: str, model: Any) -> tuple[str, int, dict[str, Any]]:
    _, line_table = _order_tables(order_type)
    movement_ids: list[int] = []
    now = utc_now()
    for requested in model.lines:
        line = conn.execute(f"SELECT * FROM {line_table} WHERE id=?", (requested.line_id,)).fetchone()
        delta = requested.quantity if order_type == "purchase" else -requested.quantity
        kind = "receipt" if order_type == "purchase" else "shipment"
        cursor = conn.execute(
            "INSERT INTO inventory_movements(movement_kind,product_id,unit_id,location_id,quantity_delta,business_date,order_type,order_line_id,note,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (
                kind,
                line["product_id"],
                line["unit_id"],
                model.location_id,
                decimal_text(delta),
                model.business_date.isoformat(),
                order_type,
                requested.line_id,
                model.note.strip(),
                now,
            ),
        )
        movement_id = int(cursor.lastrowid)
        movement_ids.append(movement_id)
        conn.execute(
            "INSERT INTO order_fulfillments(order_type,order_line_id,movement_id,quantity,created_at) VALUES(?,?,?,?,?)",
            (order_type, requested.line_id, movement_id, decimal_text(requested.quantity), now),
        )
    _update_order_status(conn, order_type, model.order_id)
    result = order_readback(conn, order_type, model.order_id)
    result["movement_ids"] = movement_ids
    return f"{order_type}_fulfillment", movement_ids[0], result


def _adjust(conn: sqlite3.Connection, model: Any) -> tuple[str, int, dict[str, Any]]:
    kind = "opening" if model.opening else "adjustment"
    cursor = conn.execute(
        "INSERT INTO inventory_movements(movement_kind,product_id,unit_id,location_id,quantity_delta,business_date,note,created_at) VALUES(?,?,?,?,?,?,?,?)",
        (
            kind,
            model.product_id,
            model.unit_id,
            model.location_id,
            decimal_text(model.quantity_delta),
            model.business_date.isoformat(),
            model.note.strip(),
            utc_now(),
        ),
    )
    entity_id = int(cursor.lastrowid)
    return "inventory_movement", entity_id, movement_readback(conn, entity_id)


def _reverse(conn: sqlite3.Connection, model: Any) -> tuple[str, int, dict[str, Any]]:
    original = conn.execute("SELECT * FROM inventory_movements WHERE id=?", (model.movement_id,)).fetchone()
    cursor = conn.execute(
        "INSERT INTO inventory_movements(movement_kind,product_id,unit_id,location_id,quantity_delta,business_date,order_type,order_line_id,reverses_movement_id,note,created_at) "
        "VALUES('reversal',?,?,?,?,?,?,?,?,?,?)",
        (
            original["product_id"],
            original["unit_id"],
            original["location_id"],
            decimal_text(-Decimal(original["quantity_delta"])),
            model.business_date.isoformat(),
            original["order_type"],
            original["order_line_id"],
            model.movement_id,
            model.note.strip(),
            utc_now(),
        ),
    )
    entity_id = int(cursor.lastrowid)
    if original["order_type"] and original["order_line_id"]:
        original_fulfillment = conn.execute(
            "SELECT quantity FROM order_fulfillments WHERE movement_id=?",
            (model.movement_id,),
        ).fetchone()
        if original_fulfillment:
            conn.execute(
                "INSERT INTO order_fulfillments(order_type,order_line_id,movement_id,quantity,created_at) VALUES(?,?,?,?,?)",
                (
                    original["order_type"],
                    original["order_line_id"],
                    entity_id,
                    decimal_text(-Decimal(original_fulfillment["quantity"])),
                    utc_now(),
                ),
            )
            _, line_table = _order_tables(original["order_type"])
            order_id = conn.execute(
                f"SELECT order_id FROM {line_table} WHERE id=?",
                (original["order_line_id"],),
            ).fetchone()[0]
            _update_order_status(conn, original["order_type"], int(order_id))
    return "inventory_movement", entity_id, movement_readback(conn, entity_id)


def _cancel(conn: sqlite3.Connection, model: Any) -> tuple[str, int, dict[str, Any]]:
    table, _ = _order_tables(model.order_type)
    conn.execute(
        f"UPDATE {table} SET status='cancelled',note=CASE WHEN note='' THEN ? ELSE note || char(10) || ? END,updated_at=? WHERE id=?",
        (model.note.strip(), model.note.strip(), utc_now(), model.order_id),
    )
    return f"{model.order_type}_order", model.order_id, order_readback(conn, model.order_type, model.order_id)


def _execute(conn: sqlite3.Connection, action: str, model: StrictModel) -> tuple[str, int, dict[str, Any]]:
    if action == "create_party":
        return _create_party(conn, model)
    if action in {"create_party_alias", "create_unit_alias"}:
        return _create_alias(conn, action, model)
    if action in {"create_product", "create_unit", "create_location"}:
        return _create_simple(conn, action, model)
    if action == "create_sales_order":
        return _create_order(conn, "sale", model)
    if action == "create_purchase_order":
        return _create_order(conn, "purchase", model)
    if action == "receive_purchase":
        return _fulfill(conn, "purchase", model)
    if action == "ship_sale":
        return _fulfill(conn, "sale", model)
    if action == "post_inventory_adjustment":
        return _adjust(conn, model)
    if action == "reverse_movement":
        return _reverse(conn, model)
    if action == "cancel_order":
        return _cancel(conn, model)
    raise ValueError("unsupported action")


def apply_action(
    conn: sqlite3.Connection,
    *,
    action: str,
    data: dict[str, Any],
    preview_token: str,
    actor: str,
    review_note: str,
) -> dict[str, Any]:
    model = _validated(action, data)
    normalized = _payload(model)
    existing = _existing_external(conn, model, normalized)
    if existing:
        return {
            "status": "already_satisfied",
            "resource_type": existing["resource_type"],
            "entity_id": existing["entity_id"],
            "state_version": state_version(conn),
        }
    token = _decode_token(preview_token)
    expected = {
        "contract": "bizhub.action-preview.v1",
        "action": action,
        "data_digest": payload_digest(normalized),
        "state_version": state_version(conn),
    }
    for key, value in expected.items():
        if token.get(key) != value:
            raise ValueError("preview token does not match the current action or state")
    try:
        conn.execute("BEGIN IMMEDIATE")
        if state_version(conn) != int(token["state_version"]):
            raise ValueError("formal state changed after preview")
        _validate_action(conn, action, model)
        resource_type, entity_id, readback = _execute(conn, action, model)
        _record_external(conn, model, normalized, resource_type, entity_id)
        _audit(
            conn,
            action=action,
            entity_type=resource_type,
            entity_ref=f"{resource_type}:{entity_id}",
            after=readback,
            actor=actor,
            review_note=review_note,
        )
        version = bump_state_version(conn)
        conn.execute("COMMIT")
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    return {
        "status": "applied",
        "resource_type": resource_type,
        "entity_id": entity_id,
        "readback": readback,
        "state_version": version,
    }


def party_readback(conn: sqlite3.Connection, entity_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM parties WHERE id=?", (entity_id,)).fetchone()
    roles = [item[0] for item in conn.execute("SELECT role_key FROM party_roles WHERE party_id=? ORDER BY role_key", (entity_id,))]
    aliases = [dict(item) for item in conn.execute(
        "SELECT id,alias,status FROM party_aliases WHERE party_id=? ORDER BY normalized_alias,id",
        (entity_id,),
    )]
    return {
        "id": row["id"],
        "canonical_name": row["canonical_name"],
        "legal_name": row["legal_name"],
        "roles": roles,
        "aliases": aliases,
        "status": row["status"],
        "successor_party_id": row["successor_party_id"],
    }


def alias_readback(conn: sqlite3.Connection, resource: str, entity_id: int) -> dict[str, Any]:
    table = {"party_alias": "party_aliases", "unit_alias": "unit_aliases"}[resource]
    row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (entity_id,)).fetchone()
    if row is None:
        raise ValueError(f"{resource} does not exist")
    return dict(row)


def unit_readback(conn: sqlite3.Connection, entity_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM units WHERE id=?", (entity_id,)).fetchone()
    if row is None:
        raise ValueError("unit does not exist")
    result = dict(row)
    result["aliases"] = [dict(item) for item in conn.execute(
        "SELECT id,alias,status FROM unit_aliases WHERE unit_id=? ORDER BY normalized_alias,id",
        (entity_id,),
    )]
    return result


def simple_readback(conn: sqlite3.Connection, resource: str, entity_id: int) -> dict[str, Any]:
    if resource == "unit":
        return unit_readback(conn, entity_id)
    table = {"product": "products", "unit": "units", "location": "locations"}[resource]
    row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (entity_id,)).fetchone()
    return dict(row)


def movement_readback(conn: sqlite3.Connection, entity_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM inventory_movements WHERE id=?", (entity_id,)).fetchone()
    return dict(row)


def order_readback(conn: sqlite3.Connection, order_type: str, order_id: int) -> dict[str, Any]:
    order_table, line_table = _order_tables(order_type)
    row = conn.execute(f"SELECT * FROM {order_table} WHERE id=?", (order_id,)).fetchone()
    if row is None:
        raise ValueError("order does not exist")
    lines = []
    for line in conn.execute(f"SELECT * FROM {line_table} WHERE order_id=? ORDER BY line_no", (order_id,)):
        fulfilled = _fulfilled_quantity(conn, order_type, int(line["id"]))
        payload = dict(line)
        payload["fulfilled_quantity"] = decimal_text(fulfilled)
        payload["remaining_quantity"] = decimal_text(Decimal(line["quantity"]) - fulfilled)
        lines.append(payload)
    result = dict(row)
    result["lines"] = lines
    return result


def catalog(conn: sqlite3.Connection) -> dict[str, Any]:
    parties = [party_readback(conn, int(row[0])) for row in conn.execute("SELECT id FROM parties ORDER BY canonical_name")]
    return {
        "state_version": state_version(conn),
        "parties": parties,
        "products": [dict(row) for row in conn.execute("SELECT * FROM products ORDER BY canonical_name")],
        "units": [unit_readback(conn, int(row[0])) for row in conn.execute("SELECT id FROM units ORDER BY code")],
        "locations": [dict(row) for row in conn.execute("SELECT * FROM locations ORDER BY code")],
    }


def external_mappings(
    conn: sqlite3.Connection,
    *,
    source_id: str,
    resource_type: str | None,
    after_id: int,
    limit: int,
) -> dict[str, Any]:
    params: list[Any] = [source_id, after_id]
    where = "source_id=? AND id>?"
    if resource_type:
        where += " AND resource_type=?"
        params.append(resource_type)
    bounded = min(max(int(limit), 1), 500)
    params.append(bounded + 1)
    rows = conn.execute(
        f"SELECT id,source_id,external_id,resource_type,entity_id,payload_digest,created_at,"
        f"COALESCE(updated_at,created_at) AS updated_at FROM external_records WHERE {where} ORDER BY id LIMIT ?",
        tuple(params),
    ).fetchall()
    has_more = len(rows) > bounded
    visible = rows[:bounded]
    return {
        "schema_version": "bizhub.external-mapping-readback.v1",
        "source_id": source_id,
        "resource_type": resource_type,
        "items": [dict(row) for row in visible],
        "next_after_id": int(visible[-1]["id"]) if has_more and visible else None,
    }


def list_orders(conn: sqlite3.Connection, order_type: str) -> list[dict[str, Any]]:
    table, _ = _order_tables(order_type)
    return [order_readback(conn, order_type, int(row[0])) for row in conn.execute(f"SELECT id FROM {table} ORDER BY order_date DESC,id DESC")]


def inventory_projection(conn: sqlite3.Connection) -> dict[str, Any]:
    keys = conn.execute(
        "SELECT DISTINCT product_id,unit_id,location_id FROM inventory_movements ORDER BY product_id,unit_id,location_id"
    ).fetchall()
    balances = []
    for key in keys:
        balance = stock_balance(conn, key["product_id"], key["unit_id"], key["location_id"])
        balances.append({
            "product_id": key["product_id"],
            "unit_id": key["unit_id"],
            "location_id": key["location_id"],
            "quantity": decimal_text(balance),
        })
    movements = [dict(row) for row in conn.execute("SELECT * FROM inventory_movements ORDER BY id DESC LIMIT 500")]
    return {"state_version": state_version(conn), "balances": balances, "movements": movements}


def audit_events(conn: sqlite3.Connection, limit: int = 200) -> list[dict[str, Any]]:
    bounded = min(max(int(limit), 1), 500)
    return [dict(row) for row in conn.execute("SELECT * FROM audit_events ORDER BY id DESC LIMIT ?", (bounded,))]
