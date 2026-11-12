from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from contextlib import closing
from pathlib import Path
from typing import Any

from backend.kernel.profile_registry import BoundStorage
from backend.modules.inventory import public as stock
from backend.modules.procurement import public as purchases
from backend.modules.sales import public as sales


def _connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA query_only=ON")
    connection.execute("BEGIN")
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

    with closing(_connect(path)) as connection:
        locations = [
            {
                "id": str(row["location_id"]),
                "canonical_name": str(row["canonical_name"]),
                "status": str(row["status"]),
                "attributes": json.loads(str(row["attributes_json"])),
            }
            for row in connection.execute(
                "SELECT key AS location_id, display_name AS canonical_name, status, attributes_json FROM locations "
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
    domain, party_column, location_column, progress_column = (
        (purchases, "supplier_party_id", "receive_location_id", "received_quantity")
        if kind == "procurement" else
        (sales, "customer_party_id", "ship_from_location_id", "fulfilled_quantity")
    )
    with closing(_connect(path)) as connection:
        order_rows = domain.list_orders(BoundStorage(connection), limit=limit)
        parties = dict(connection.execute("SELECT id, canonical_name FROM business_parties"))
        order_ids = [str(row["order_id"]) for row in order_rows]
        lines_by_order: dict[str, list[dict[str, Any]]] = defaultdict(list)
        if order_ids:
            placeholders = ",".join("?" for _ in order_ids)
            line_rows = connection.execute(
                f"SELECT lines.*, products.canonical_name AS product_name, "
                f"units.display_name AS unit_name, locations.display_name AS location_name "
                f"FROM {domain.LINE_ROWS} AS lines "
                "JOIN products ON products.id=lines.product_id "
                "JOIN measurement_units AS units ON units.id=lines.unit_id "
                f"JOIN locations ON locations.key=lines.{location_column} "
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
            item["party_name"] = parties[row[party_column]]
            item["evidence_refs"] = json.loads(str(item.pop("evidence_refs_json")))
            item["lines"] = lines_by_order[str(row["order_id"])]
            output.append(item)
        return output


def inventory(path: Path, *, limit: int = 100) -> dict[str, list[dict[str, Any]]]:
    with closing(_connect(path)) as connection:
        storage = BoundStorage(connection)
        products = dict(connection.execute("SELECT id, canonical_name FROM products"))
        units = dict(connection.execute("SELECT id, display_name FROM measurement_units"))
        locations = dict(connection.execute("SELECT key, display_name FROM locations"))
        movements = stock.list_movements(storage, limit=limit)
        balances = stock.list_balances(storage)
        for item in (*movements, *balances):
            item["product_name"] = products[item["product_id"]]
            item["unit_name"] = units[item["unit_id"]]
        for movement in movements:
            movement["quantity"] = str(movement["quantity"])
            movement["from_location_name"] = locations.get(movement["from_location_id"], "")
            movement["to_location_name"] = locations.get(movement["to_location_id"], "")
        for balance in balances:
            balance["location_name"] = locations[balance["location_id"]]
        return {"balances": balances, "movements": movements}


def overview(path: Path) -> dict[str, int]:
    with closing(_connect(path)) as connection:
        tables = {
            "parties": "business_parties",
            "products": "products",
            "locations": "locations",
            "procurement_orders": "procurement_batches",
            "sales_orders": "sales_batches",
            "inventory_movements": "material_inventory_events",
        }
        return {
            key: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for key, table in tables.items()
        }
