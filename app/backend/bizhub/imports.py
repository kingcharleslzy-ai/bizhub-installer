from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import sqlite3
import time
from typing import Any

from .contracts import ACTION_MODELS
from .db import bump_state_version, state_version
from .service import (
    _audit,
    _decode_token,
    _execute,
    _existing_external,
    _payload,
    _record_external,
    _validate_action,
    _validated,
    canonical_json,
    normalize_alias,
    payload_digest,
)
from .config import secret_key


RESOURCE_ACTIONS = {
    "party": "create_party",
    "party_alias": "create_party_alias",
    "product": "create_product",
    "unit": "create_unit",
    "unit_alias": "create_unit_alias",
    "location": "create_location",
    "opening_inventory": "post_inventory_adjustment",
    "sales_order": "create_sales_order",
    "purchase_order": "create_purchase_order",
}


CSV_HEADERS = {
    "party": ["external_id", "canonical_name", "legal_name", "roles"],
    "product": ["external_id", "canonical_name", "sku", "unit_id"],
    "unit": ["external_id", "code", "display_name", "dimension"],
    "location": ["external_id", "code", "display_name"],
    "opening_inventory": [
        "external_id",
        "product_id",
        "unit_id",
        "location_id",
        "quantity_delta",
        "business_date",
        "note",
    ],
    "sales_order": [
        "external_id",
        "order_no",
        "customer_id",
        "order_date",
        "currency",
        "note",
        "lines_json",
    ],
    "purchase_order": [
        "external_id",
        "order_no",
        "supplier_id",
        "order_date",
        "currency",
        "note",
        "lines_json",
    ],
}


def csv_template(resource: str) -> str:
    headers = CSV_HEADERS.get(resource)
    if not headers:
        raise ValueError("unsupported import resource")
    output = io.StringIO()
    csv.writer(output, lineterminator="\n").writerow(headers)
    return output.getvalue()


def csv_records(resource: str, text: str) -> list[dict[str, Any]]:
    headers = CSV_HEADERS.get(resource)
    if not headers:
        raise ValueError("unsupported import resource")
    try:
        reader = csv.DictReader(io.StringIO(text))
        if reader.fieldnames != headers:
            raise ValueError(f"CSV headers must exactly equal: {','.join(headers)}")
        rows = []
        for raw in reader:
            row: dict[str, Any] = {key: (value or "").strip() for key, value in raw.items()}
            if resource == "party":
                row["roles"] = [value.strip() for value in row["roles"].split("|") if value.strip()]
            elif resource == "product":
                row["unit_id"] = int(row["unit_id"])
            elif resource == "opening_inventory":
                row.update(
                    {
                        "product_id": int(row["product_id"]),
                        "unit_id": int(row["unit_id"]),
                        "location_id": int(row["location_id"]),
                        "opening": True,
                    }
                )
            elif resource in {"sales_order", "purchase_order"}:
                party_key = "customer_id" if resource == "sales_order" else "supplier_id"
                row[party_key] = int(row[party_key])
                row["lines"] = json.loads(row.pop("lines_json"))
                if not row.get("currency"):
                    row.pop("currency", None)
            rows.append(row)
    except (csv.Error, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError(f"CSV content is invalid: {exc}") from exc
    if not rows:
        raise ValueError("CSV must contain at least one data row")
    return rows


def _normalized_records(resource: str, source_id: str, records: list[dict[str, Any]]) -> list[tuple[Any, dict[str, Any]]]:
    action = RESOURCE_ACTIONS.get(resource)
    if not action or action not in ACTION_MODELS:
        raise ValueError("unsupported import resource")
    normalized: list[tuple[Any, dict[str, Any]]] = []
    identities: set[str] = set()
    for record in records:
        payload = dict(record)
        external_id = str(payload.get("external_id") or "").strip()
        if not external_id:
            raise ValueError("every import record requires external_id")
        if external_id in identities:
            raise ValueError("external_id values must be unique within one import")
        identities.add(external_id)
        payload["source_id"] = source_id
        if resource == "opening_inventory":
            payload["opening"] = True
        model = _validated(action, payload)
        normalized.append((model, _payload(model)))
    return normalized


def _import_token(resource: str, source_id: str, records: list[dict[str, Any]], version: int) -> tuple[str, int]:
    expires_at = int(time.time()) + 15 * 60
    payload = {
        "contract": "bizhub.import-preview.v1",
        "resource": resource,
        "source_id": source_id,
        "records_digest": payload_digest(records),
        "state_version": version,
        "expires_at": expires_at,
    }
    raw = base64.urlsafe_b64encode(canonical_json(payload).encode()).decode().rstrip("=")
    signature = hmac.new(secret_key(), raw.encode(), hashlib.sha256).hexdigest()
    return f"{raw}.{signature}", expires_at


def preview_import(
    conn: sqlite3.Connection,
    *,
    resource: str,
    source_id: str,
    records: list[dict[str, Any]],
) -> dict[str, Any]:
    action = RESOURCE_ACTIONS.get(resource)
    normalized_pairs = _normalized_records(resource, source_id, records)
    ready = 0
    existing = 0
    normalized_payloads: list[dict[str, Any]] = []
    natural_keys: set[tuple[str, str]] = set()
    for model, payload in normalized_pairs:
        normalized_payloads.append(payload)
        if _existing_external(conn, model, payload):
            existing += 1
        else:
            _validate_action(conn, action, model)
            natural_key = _natural_key(resource, payload)
            if natural_key in natural_keys:
                raise ValueError("import contains a duplicate business key")
            natural_keys.add(natural_key)
            ready += 1
    version = state_version(conn)
    token, expires_at = _import_token(resource, source_id, normalized_payloads, version)
    return {
        "status": "ready" if ready else "already_satisfied",
        "resource": resource,
        "source_id": source_id,
        "record_count": len(records),
        "ready_count": ready,
        "already_satisfied_count": existing,
        "state_version": version,
        "preview_token": token,
        "expires_at": expires_at,
    }


def _natural_key(resource: str, payload: dict[str, Any]) -> tuple[str, str]:
    if resource in {"party_alias", "unit_alias"}:
        return resource, normalize_alias(str(payload["alias"]))
    fields = {
        "party": "canonical_name",
        "product": "sku",
        "unit": "code",
        "location": "code",
        "sales_order": "order_no",
        "purchase_order": "order_no",
        "opening_inventory": "external_id",
    }
    field = fields[resource]
    return resource, str(payload[field]).strip().casefold()


def apply_import(
    conn: sqlite3.Connection,
    *,
    resource: str,
    source_id: str,
    records: list[dict[str, Any]],
    preview_token: str,
    actor: str,
    review_note: str,
) -> dict[str, Any]:
    action = RESOURCE_ACTIONS.get(resource)
    normalized_pairs = _normalized_records(resource, source_id, records)
    pending = [
        (model, payload)
        for model, payload in normalized_pairs
        if _existing_external(conn, model, payload) is None
    ]
    if not pending:
        return {
            "status": "already_satisfied",
            "resource": resource,
            "applied_count": 0,
            "state_version": state_version(conn),
        }
    token = _decode_token(preview_token)
    normalized_payloads = [payload for _, payload in normalized_pairs]
    expected = {
        "contract": "bizhub.import-preview.v1",
        "resource": resource,
        "source_id": source_id,
        "records_digest": payload_digest(normalized_payloads),
        "state_version": state_version(conn),
    }
    for key, value in expected.items():
        if token.get(key) != value:
            raise ValueError("import preview token does not match the current input or state")
    applied: list[dict[str, Any]] = []
    try:
        conn.execute("BEGIN IMMEDIATE")
        if state_version(conn) != int(token["state_version"]):
            raise ValueError("formal state changed after import preview")
        for model, payload in pending:
            _validate_action(conn, action, model)
            resource_type, entity_id, readback = _execute(conn, action, model)
            _record_external(conn, model, payload, resource_type, entity_id)
            _audit(
                conn,
                action=f"import:{action}",
                entity_type=resource_type,
                entity_ref=f"{resource_type}:{entity_id}",
                after=readback,
                actor=actor,
                review_note=review_note,
            )
            applied.append({"resource_type": resource_type, "entity_id": entity_id})
        version = bump_state_version(conn)
        conn.execute("COMMIT")
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    return {
        "status": "applied",
        "resource": resource,
        "applied_count": len(applied),
        "already_satisfied_count": len(normalized_pairs) - len(applied),
        "entities": applied,
        "state_version": version,
    }
