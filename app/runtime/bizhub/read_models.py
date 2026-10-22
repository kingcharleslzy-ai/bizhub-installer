from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Any


def _connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA query_only=ON")
    return connection


def _catalog_rows(connection: sqlite3.Connection, sql: str, attributes: tuple[str, ...]) -> list[dict[str, Any]]:
    rows = connection.execute(sql).fetchall()
    return [
        {
            "id": row["id"],
            "canonical_name": str(row["canonical_name"]),
            "status": str(row["status"]),
            "attributes": {key: row[key] for key in attributes if row[key] not in (None, "")},
        }
        for row in rows
    ]


def catalog(path: Path) -> dict[str, list[dict[str, Any]]]:
    """往来方、产品、单位用库分配的数字编号；库位用文字编号。"""

    with _connect(path) as connection:
        locations = [
            {
                "id": str(row["location_id"]),
                "canonical_name": str(row["canonical_name"]),
                "status": str(row["status"]),
                "attributes": json.loads(str(row["attributes_json"])),
            }
            for row in connection.execute(
                "SELECT location_id, canonical_name, status, attributes_json FROM location_catalog "
                "ORDER BY canonical_name, location_id"
            )
        ]
        return {
            "parties": _catalog_rows(
                connection,
                "SELECT id, canonical_name, legal_name, status FROM business_parties ORDER BY canonical_name, id",
                ("legal_name",),
            ),
            "products": _catalog_rows(
                connection,
                "SELECT id, canonical_name, product_family, status FROM products ORDER BY canonical_name, id",
                ("product_family",),
            ),
            "units": _catalog_rows(
                connection,
                "SELECT id, display_name AS canonical_name, canonical_code AS code, dimension, factor_to_base, status "
                "FROM measurement_units ORDER BY display_name, id",
                ("code", "dimension", "factor_to_base"),
            ),
            "locations": locations,
        }


def orders(path: Path, kind: str, *, limit: int = 100) -> list[dict[str, Any]]:
    if kind not in {"procurement", "sales"}:
        raise ValueError("desktop_order_kind_invalid")
    bounded_limit = max(1, min(int(limit), 500))
    if kind == "procurement":
        order_table = "procurement_orders"
        line_table = "procurement_order_lines"
        party_column = "supplier_party_id"
        progress_column = "received_quantity"
        location_column = "receive_location_id"
    else:
        order_table = "sales_orders"
        line_table = "sales_order_lines"
        party_column = "customer_party_id"
        progress_column = "fulfilled_quantity"
        location_column = "ship_from_location_id"
    with _connect(path) as connection:
        order_rows = connection.execute(
            f"SELECT orders.*, parties.canonical_name AS party_name "
            f"FROM {order_table} AS orders "
            f"JOIN business_parties AS parties ON parties.id=orders.{party_column} "
            "ORDER BY orders.ordered_at DESC, orders.order_id DESC LIMIT ?",
            (bounded_limit,),
        ).fetchall()
        order_ids = [str(row["order_id"]) for row in order_rows]
        lines_by_order: dict[str, list[dict[str, Any]]] = defaultdict(list)
        if order_ids:
            placeholders = ",".join("?" for _ in order_ids)
            line_rows = connection.execute(
                f"SELECT lines.*, products.canonical_name AS product_name, "
                f"units.display_name AS unit_name, locations.canonical_name AS location_name "
                f"FROM {line_table} AS lines "
                "JOIN products ON products.id=lines.product_id "
                "JOIN measurement_units AS units ON units.id=lines.unit_id "
                f"JOIN location_catalog AS locations ON locations.location_id=lines.{location_column} "
                f"WHERE lines.order_id IN ({placeholders}) ORDER BY lines.order_id, lines.line_id",
                tuple(order_ids),
            ).fetchall()
            for row in line_rows:
                item = dict(row)
                for column in ("quantity", progress_column):
                    item[column] = str(item[column])
                lines_by_order[str(row["order_id"])].append(item)
        output: list[dict[str, Any]] = []
        for row in order_rows:
            item = dict(row)
            item["evidence_refs"] = json.loads(str(item.pop("evidence_refs_json")))
            item["lines"] = lines_by_order[str(row["order_id"])]
            output.append(item)
        return output


def inventory(path: Path, *, limit: int = 100) -> dict[str, list[dict[str, Any]]]:
    bounded_limit = max(1, min(int(limit), 500))
    with _connect(path) as connection:
        products = {
            str(row["id"]): str(row["canonical_name"])
            for row in connection.execute("SELECT id, canonical_name FROM products")
        }
        units = {
            str(row["id"]): str(row["display_name"])
            for row in connection.execute("SELECT id, display_name FROM measurement_units")
        }
        locations = {
            str(row["location_id"]): str(row["canonical_name"])
            for row in connection.execute("SELECT location_id, canonical_name FROM location_catalog")
        }
        all_movements = [dict(row) for row in connection.execute("SELECT * FROM inventory_movements")]
        balances: dict[tuple[str, str, str], Decimal] = defaultdict(Decimal)
        for movement in all_movements:
            quantity = Decimal(str(movement["quantity"]))
            product_id = str(movement["product_id"])
            unit_id = str(movement["unit_id"])
            if movement["to_location_id"] is not None:
                balances[(product_id, unit_id, str(movement["to_location_id"]))] += quantity
            if movement["from_location_id"] is not None:
                balances[(product_id, unit_id, str(movement["from_location_id"]))] -= quantity
        movement_rows = connection.execute(
            "SELECT * FROM inventory_movements ORDER BY occurred_at DESC, movement_id DESC LIMIT ?",
            (bounded_limit,),
        ).fetchall()
        movements = []
        for row in movement_rows:
            item = dict(row)
            item["quantity"] = str(item["quantity"])
            item["product_name"] = products.get(str(item["product_id"]), str(item["product_id"]))
            item["unit_name"] = units.get(str(item["unit_id"]), str(item["unit_id"]))
            item["from_location_name"] = locations.get(str(item["from_location_id"]), "")
            item["to_location_name"] = locations.get(str(item["to_location_id"]), "")
            movements.append(item)
        balance_items = [
            {
                "product_id": int(product_id),
                "product_name": products.get(product_id, product_id),
                "unit_id": int(unit_id),
                "unit_name": units.get(unit_id, unit_id),
                "location_id": location_id,
                "location_name": locations.get(location_id, location_id),
                "quantity": format(quantity, "f"),
            }
            for (product_id, unit_id, location_id), quantity in sorted(balances.items())
        ]
        return {"balances": balance_items, "movements": movements}


def overview(path: Path) -> dict[str, int]:
    with _connect(path) as connection:
        tables = {
            "parties": "business_parties",
            "products": "products",
            "locations": "location_catalog",
            "procurement_orders": "procurement_orders",
            "sales_orders": "sales_orders",
            "inventory_movements": "inventory_movements",
        }
        return {
            key: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for key, table in tables.items()
        }
