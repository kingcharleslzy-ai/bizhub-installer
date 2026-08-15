from __future__ import annotations

from copy import deepcopy
import os
import sqlite3

import pytest


def apply(api, action: str, data: dict, note: str = "verified by automated test"):
    preview = api("post", "/api/actions/preview", json={"action": action, "data": data})
    assert preview.status_code == 200, preview.text
    body = preview.json()
    result = api(
        "post",
        "/api/actions/apply",
        json={"action": action, "data": data, "preview_token": body["preview_token"], "review_note": note},
    )
    assert result.status_code == 200, result.text
    return result.json()


def seed_catalog(api):
    supplier = apply(api, "create_party", {"canonical_name": "Supplier A", "roles": ["supplier"]})
    customer = apply(api, "create_party", {"canonical_name": "Customer A", "roles": ["customer"]})
    unit = apply(api, "create_unit", {"code": "pcs", "display_name": "Pieces", "dimension": "count"})
    product = apply(api, "create_product", {"canonical_name": "Widget", "sku": "WIDGET-1", "unit_id": unit["entity_id"]})
    location = apply(api, "create_location", {"code": "MAIN", "display_name": "Main Warehouse"})
    return {
        "supplier": supplier["entity_id"],
        "customer": customer["entity_id"],
        "product": product["entity_id"],
        "unit": unit["entity_id"],
        "location": location["entity_id"],
    }


def test_purchase_sale_inventory_and_reversal(api):
    ids = seed_catalog(api)
    purchase = apply(
        api,
        "create_purchase_order",
        {
            "source_id": "erp",
            "external_id": "po-001",
            "order_no": "PO-001",
            "supplier_id": ids["supplier"],
            "order_date": "2026-08-15",
            "lines": [{"product_id": ids["product"], "unit_id": ids["unit"], "quantity": "10"}],
        },
    )
    purchase_line = purchase["readback"]["lines"][0]["id"]
    received = apply(
        api,
        "receive_purchase",
        {
            "source_id": "erp",
            "external_id": "receipt-001",
            "order_id": purchase["entity_id"],
            "location_id": ids["location"],
            "business_date": "2026-08-15",
            "lines": [{"line_id": purchase_line, "quantity": "6"}],
        },
    )
    assert received["readback"]["status"] == "partially_fulfilled"
    assert received["readback"]["lines"][0]["remaining_quantity"] == "4"

    sale = apply(
        api,
        "create_sales_order",
        {
            "source_id": "erp",
            "external_id": "so-001",
            "order_no": "SO-001",
            "customer_id": ids["customer"],
            "order_date": "2026-08-15",
            "lines": [{"product_id": ids["product"], "unit_id": ids["unit"], "quantity": "4"}],
        },
    )
    sale_line = sale["readback"]["lines"][0]["id"]
    shipped = apply(
        api,
        "ship_sale",
        {
            "source_id": "erp",
            "external_id": "shipment-001",
            "order_id": sale["entity_id"],
            "location_id": ids["location"],
            "business_date": "2026-08-15",
            "lines": [{"line_id": sale_line, "quantity": "3"}],
        },
    )
    assert shipped["readback"]["lines"][0]["remaining_quantity"] == "1"
    inventory = api("get", "/api/inventory").json()
    assert inventory["balances"][0]["quantity"] == "3"

    movement_id = shipped["readback"]["movement_ids"][0]
    reversed_result = apply(
        api,
        "reverse_movement",
        {"movement_id": movement_id, "business_date": "2026-08-15", "note": "reverse test shipment"},
    )
    assert reversed_result["readback"]["movement_kind"] == "reversal"
    inventory = api("get", "/api/inventory").json()
    assert inventory["balances"][0]["quantity"] == "6"
    sale_readback = api("get", "/api/orders/sale").json()[0]
    assert sale_readback["lines"][0]["remaining_quantity"] == "4"
    assert len(api("get", "/api/audit").json()) == 10
    connection = sqlite3.connect(os.environ["BIZHUB_DATABASE_PATH"])
    try:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("UPDATE inventory_movements SET quantity_delta='999' WHERE id=1")
    finally:
        connection.close()


def test_preview_tampering_and_state_drift_fail_closed(api):
    ids = seed_catalog(api)
    payload = {"canonical_name": "Another product", "sku": "P-2", "unit_id": ids["unit"]}
    preview = api("post", "/api/actions/preview", json={"action": "create_product", "data": payload}).json()

    changed = deepcopy(payload)
    changed["sku"] = "P-3"
    rejected = api(
        "post",
        "/api/actions/apply",
        json={"action": "create_product", "data": changed, "preview_token": preview["preview_token"], "review_note": "tampered input"},
    )
    assert rejected.status_code == 409

    apply(api, "create_location", {"code": "SECOND", "display_name": "Second Warehouse"})
    stale = api(
        "post",
        "/api/actions/apply",
        json={"action": "create_product", "data": payload, "preview_token": preview["preview_token"], "review_note": "stale preview"},
    )
    assert stale.status_code == 409

    negative = api(
        "post",
        "/api/actions/preview",
        json={
            "action": "post_inventory_adjustment",
            "data": {
                "product_id": ids["product"],
                "unit_id": ids["unit"],
                "location_id": ids["location"],
                "quantity_delta": "-1",
                "business_date": "2026-08-15",
                "note": "invalid negative stock",
            },
        },
    )
    assert negative.status_code == 409

    second_unit = apply(api, "create_unit", {"code": "kg", "display_name": "Kilogram", "dimension": "weight"})
    mismatched = api(
        "post",
        "/api/actions/preview",
        json={
            "action": "create_sales_order",
            "data": {
                "order_no": "BAD-UNIT",
                "customer_id": ids["customer"],
                "order_date": "2026-08-15",
                "lines": [{"product_id": ids["product"], "unit_id": second_unit["entity_id"], "quantity": "1"}],
            },
        },
    )
    assert mismatched.status_code == 409


def test_import_idempotency_validation_and_atomicity(api):
    apply(api, "create_unit", {"code": "pcs", "display_name": "Pieces", "dimension": "count"})
    records = [
        {"external_id": "p-1", "canonical_name": "Imported One", "sku": "IMP-1", "unit_id": 1},
        {"external_id": "p-2", "canonical_name": "Imported Two", "sku": "IMP-2", "unit_id": 1},
    ]
    preview = api(
        "post",
        "/api/imports/json/preview",
        json={"resource": "product", "source_id": "sheet", "records": records},
    ).json()
    applied = api(
        "post",
        "/api/imports/apply",
        json={
            "resource": "product",
            "source_id": "sheet",
            "records": records,
            "preview_token": preview["preview_token"],
            "review_note": "confirmed import",
        },
    )
    assert applied.status_code == 200
    assert applied.json()["applied_count"] == 2

    replay_preview = api(
        "post",
        "/api/imports/json/preview",
        json={"resource": "product", "source_id": "sheet", "records": records},
    ).json()
    assert replay_preview["already_satisfied_count"] == 2
    replay = api(
        "post",
        "/api/imports/apply",
        json={
            "resource": "product",
            "source_id": "sheet",
            "records": records,
            "preview_token": replay_preview["preview_token"],
            "review_note": "confirmed replay",
        },
    ).json()
    assert replay["status"] == "already_satisfied"

    unknown = api(
        "post",
        "/api/imports/json/preview",
        json={"resource": "product", "source_id": "sheet2", "records": [{**records[0], "unknown": True}]},
    )
    assert unknown.status_code == 409
    duplicate = api(
        "post",
        "/api/imports/json/preview",
        json={
            "resource": "product",
            "source_id": "sheet2",
            "records": [
                {"external_id": "x-1", "canonical_name": "X", "sku": "DUP", "unit_id": 1},
                {"external_id": "x-2", "canonical_name": "Y", "sku": "dup", "unit_id": 1},
            ],
        },
    )
    assert duplicate.status_code == 409
    assert len(api("get", "/api/resources/catalog").json()["products"]) == 2


def test_auth_and_mutation_marker(client):
    assert client.get("/api/resources/catalog").status_code == 200
    assert client.post("/api/actions/preview", json={"action": "create_product", "data": {}}).status_code == 403
    assert client.get("/api/health").status_code == 200
    for _ in range(5):
        response = client.post(
            "/api/auth/login", headers={"X-BizHub-Request": "1"},
            json={"username": "admin", "password": "wrong password"},
        )
        assert response.status_code == 401
    locked = client.post(
        "/api/auth/login", headers={"X-BizHub-Request": "1"},
        json={"username": "admin", "password": "correct horse battery staple"},
    )
    assert locked.status_code == 429
