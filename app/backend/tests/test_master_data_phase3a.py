from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest

from bizhub.config import company_profile_digest
from bizhub.db import BASELINE_VERSION, SCHEMA_SQL, SCHEMA_VERSION, initialize_database, utc_now
from bizhub.service import payload_digest


def import_records(api, resource: str, source_id: str, records: list[dict]) -> dict:
    preview = api(
        "post",
        "/api/imports/json/preview",
        json={"resource": resource, "source_id": source_id, "records": records},
    )
    assert preview.status_code == 200, preview.text
    applied = api(
        "post",
        "/api/imports/apply",
        json={
            "resource": resource,
            "source_id": source_id,
            "records": records,
            "preview_token": preview.json()["preview_token"],
            "review_note": "confirmed synthetic master-data import",
        },
    )
    assert applied.status_code == 200, applied.text
    return applied.json()


def reconcile_preview(api, resource: str, source_id: str, records: list[dict]):
    return api(
        "post",
        "/api/imports/reconcile/preview",
        json={"resource": resource, "source_id": source_id, "records": records},
    )


def reconcile_apply(api, resource: str, source_id: str, records: list[dict], preview_token: str):
    return api(
        "post",
        "/api/imports/reconcile/apply",
        json={
            "resource": resource,
            "source_id": source_id,
            "records": records,
            "preview_token": preview_token,
            "review_note": "confirmed synthetic master-data reconcile",
        },
    )


def test_version_one_database_upgrades_through_checksum_ledger(client, tmp_path: Path):
    legacy = tmp_path / "legacy-v1.sqlite"
    now = utc_now()
    with sqlite3.connect(legacy) as conn:
        conn.executescript(SCHEMA_SQL)
        conn.execute(
            "INSERT INTO app_state(id,schema_version,profile_digest,state_version,created_at,updated_at) "
            "VALUES(1,?,?,?,?,?)",
            (BASELINE_VERSION, company_profile_digest(), 0, now, now),
        )

    initialize_database(legacy)

    with sqlite3.connect(legacy) as conn:
        assert conn.execute("SELECT schema_version FROM app_state WHERE id=1").fetchone()[0] == SCHEMA_VERSION
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        migrations = conn.execute(
            "SELECT version,name,length(checksum) FROM bizhub_migration_ledger ORDER BY version"
        ).fetchall()
        assert migrations == [
            (1, "initial_schema", 64),
            (2, "master_data_aliases_and_external_record_updates", 64),
            (3, "party_successor_identity", 64),
        ]
        assert conn.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []

    with sqlite3.connect(legacy) as conn:
        conn.execute("UPDATE bizhub_migration_ledger SET checksum=? WHERE version=2", ("0" * 64,))
    with pytest.raises(RuntimeError, match="ledger has drifted"):
        initialize_database(legacy)


def test_party_unit_alias_import_and_external_mapping_readback(api):
    source_id = "synthetic-master-v1"
    parties = [
        {
            "external_id": "party:10",
            "canonical_name": "Example Customer",
            "legal_name": "Example Customer Limited",
            "roles": ["customer"],
            "status": "active",
        },
        {
            "external_id": "party:11",
            "canonical_name": "Former Supplier",
            "roles": ["supplier"],
            "status": "deprecated",
        },
    ]
    units = [
        {
            "external_id": "unit:20",
            "code": "pcs",
            "display_name": "Pieces",
            "dimension": "count",
            "status": "active",
        }
    ]
    assert import_records(api, "party", source_id, parties)["applied_count"] == 2
    assert import_records(api, "unit", source_id, units)["applied_count"] == 1

    party_mappings = api(
        "get",
        "/api/external-records",
        params={"source_id": source_id, "resource_type": "party", "limit": 1},
    )
    assert party_mappings.status_code == 200, party_mappings.text
    first_page = party_mappings.json()
    assert first_page["schema_version"] == "bizhub.external-mapping-readback.v1"
    assert len(first_page["items"]) == 1
    assert first_page["next_after_id"] is not None
    second_page = api(
        "get",
        "/api/external-records",
        params={
            "source_id": source_id,
            "resource_type": "party",
            "after_id": first_page["next_after_id"],
            "limit": 10,
        },
    ).json()
    party_items = [*first_page["items"], *second_page["items"]]
    party_ids = {item["external_id"]: item["entity_id"] for item in party_items}
    unit_item = api(
        "get",
        "/api/external-records",
        params={"source_id": source_id, "resource_type": "unit"},
    ).json()["items"][0]

    party_aliases = [
        {
            "external_id": "party_alias:100",
            "party_id": party_ids["party:10"],
            "alias": "Example Customer Co.",
            "status": "active",
        }
    ]
    unit_aliases = [
        {
            "external_id": "unit_alias:200",
            "unit_id": unit_item["entity_id"],
            "alias": "piece",
            "status": "active",
        }
    ]
    assert import_records(api, "party_alias", source_id, party_aliases)["applied_count"] == 1
    assert import_records(api, "unit_alias", source_id, unit_aliases)["applied_count"] == 1

    catalog = api("get", "/api/resources/catalog").json()
    customer = next(item for item in catalog["parties"] if item["canonical_name"] == "Example Customer")
    deprecated = next(item for item in catalog["parties"] if item["canonical_name"] == "Former Supplier")
    assert customer["aliases"] == [{"id": 1, "alias": "Example Customer Co.", "status": "active"}]
    assert deprecated["status"] == "deprecated"
    assert catalog["units"][0]["aliases"] == [{"id": 1, "alias": "piece", "status": "active"}]

    replay = api(
        "post",
        "/api/imports/json/preview",
        json={"resource": "party_alias", "source_id": source_id, "records": party_aliases},
    ).json()
    assert replay["status"] == "already_satisfied"

    duplicate_identity = api(
        "post",
        "/api/imports/json/preview",
        json={
            "resource": "party_alias",
            "source_id": "another-source",
            "records": [{**party_aliases[0], "external_id": "party_alias:101"}],
        },
    )
    assert duplicate_identity.status_code == 409
    assert "already exists" in duplicate_identity.json()["detail"]

    changed = api(
        "post",
        "/api/imports/json/preview",
        json={
            "resource": "party",
            "source_id": source_id,
            "records": [{**parties[0], "canonical_name": "Changed Without Reconcile"}],
        },
    )
    assert changed.status_code == 409
    assert "different content" in changed.json()["detail"]

    conflicting = api(
        "post",
        "/api/imports/json/preview",
        json={
            "resource": "party_alias",
            "source_id": "another-source",
            "records": [
                {
                    "external_id": "party_alias:999",
                    "party_id": party_ids["party:11"],
                    "alias": "Ｅｘａｍｐｌｅ　Ｃｕｓｔｏｍｅｒ　Ｃｏ．",
                    "status": "active",
                }
            ],
        },
    )
    assert conflicting.status_code == 409
    assert "different canonical resource" in conflicting.json()["detail"]

    canonical_conflict = api(
        "post",
        "/api/imports/json/preview",
        json={
            "resource": "party_alias",
            "source_id": "another-source",
            "records": [
                {
                    "external_id": "party_alias:1000",
                    "party_id": party_ids["party:11"],
                    "alias": "Ｅｘａｍｐｌｅ　Ｃｕｓｔｏｍｅｒ",
                    "status": "active",
                }
            ],
        },
    )
    assert canonical_conflict.status_code == 409
    assert "conflicts with a different canonical resource" in canonical_conflict.json()["detail"]

    canonical_reuses_alias = api(
        "post",
        "/api/imports/json/preview",
        json={
            "resource": "party",
            "source_id": "another-source",
            "records": [
                {
                    "external_id": "party:12",
                    "canonical_name": "Example Customer Co.",
                    "roles": ["customer"],
                }
            ],
        },
    )
    assert canonical_reuses_alias.status_code == 409
    assert "conflicts with an existing alias" in canonical_reuses_alias.json()["detail"]

    with sqlite3.connect(os.environ["BIZHUB_DATABASE_PATH"]) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_deprecated_party_successor_allows_exact_active_alias_owner(api):
    source_id = "synthetic-successor-v1"
    successor = {
        "external_id": "party:20",
        "canonical_name": "Current Customer",
        "roles": ["customer"],
        "status": "active",
    }
    assert import_records(api, "party", source_id, [successor])["applied_count"] == 1
    successor_id = api(
        "get",
        "/api/external-records",
        params={"source_id": source_id, "resource_type": "party"},
    ).json()["items"][0]["entity_id"]

    predecessor = {
        "external_id": "party:10",
        "canonical_name": "Former Customer Name",
        "roles": ["customer"],
        "status": "deprecated",
        "successor_party_id": successor_id,
    }
    assert import_records(api, "party", source_id, [predecessor])["applied_count"] == 1
    alias = {
        "external_id": "party_alias:10",
        "party_id": successor_id,
        "alias": "Former Customer Name",
        "status": "active",
    }
    assert import_records(api, "party_alias", source_id, [alias])["applied_count"] == 1

    catalog = api("get", "/api/resources/catalog").json()
    old = next(item for item in catalog["parties"] if item["canonical_name"] == "Former Customer Name")
    current = next(item for item in catalog["parties"] if item["canonical_name"] == "Current Customer")
    assert old["status"] == "deprecated"
    assert old["successor_party_id"] == successor_id
    assert current["aliases"] == [{"id": 1, "alias": "Former Customer Name", "status": "active"}]

    active_with_successor = api(
        "post",
        "/api/imports/json/preview",
        json={
            "resource": "party",
            "source_id": source_id,
            "records": [
                {
                    "external_id": "party:30",
                    "canonical_name": "Invalid Active Successor",
                    "roles": ["customer"],
                    "status": "active",
                    "successor_party_id": successor_id,
                }
            ],
        },
    )
    assert active_with_successor.status_code == 409
    assert "active party cannot have a successor" in active_with_successor.json()["detail"]

    another = {
        "external_id": "party:40",
        "canonical_name": "Another Customer",
        "roles": ["customer"],
        "status": "active",
    }
    assert import_records(api, "party", source_id, [another])["applied_count"] == 1
    another_id = api(
        "get",
        "/api/external-records",
        params={"source_id": source_id, "resource_type": "party", "limit": 10},
    ).json()["items"][-1]["entity_id"]
    wrong_owner = api(
        "post",
        "/api/imports/json/preview",
        json={
            "resource": "party_alias",
            "source_id": source_id,
            "records": [
                {
                    "external_id": "party_alias:20",
                    "party_id": another_id,
                    "alias": "Former Customer Name",
                    "status": "active",
                }
            ],
        },
    )
    assert wrong_owner.status_code == 409
    assert "different canonical resource" in wrong_owner.json()["detail"]


def test_external_mapping_readback_requires_authentication(client):
    client.post("/api/auth/logout", headers={"X-BizHub-Request": "1"})
    assert client.get("/api/external-records", params={"source_id": "synthetic"}).status_code == 401


def test_party_reconcile_previews_diff_applies_audit_and_replays(api):
    source_id = "synthetic-reconcile-v1"
    original = {
        "external_id": "party:1",
        "canonical_name": "Original Customer",
        "legal_name": "Original Customer Ltd.",
        "roles": ["customer"],
        "status": "active",
    }
    desired = {
        **original,
        "canonical_name": "Renamed Customer",
        "legal_name": "Renamed Customer Limited",
        "roles": ["supplier", "customer"],
    }
    import_records(api, "party", source_id, [original])

    preview_response = reconcile_preview(api, "party", source_id, [desired])
    assert preview_response.status_code == 200, preview_response.text
    preview = preview_response.json()
    assert preview["schema_version"] == "bizhub.master-data-reconcile-preview.v1"
    assert preview["status"] == "ready"
    assert preview["ready_count"] == 1
    change = preview["changes"][0]
    assert change["change_kind"] == "update"
    assert {item["field"] for item in change["field_diffs"]} == {"canonical_name", "legal_name", "roles"}

    applied_response = reconcile_apply(api, "party", source_id, [desired], preview["preview_token"])
    assert applied_response.status_code == 200, applied_response.text
    applied = applied_response.json()
    assert applied["status"] == "applied"
    assert applied["entities"][0]["readback"]["canonical_name"] == "Renamed Customer"
    assert applied["entities"][0]["readback"]["roles"] == ["customer", "supplier"]

    mapping = api(
        "get",
        "/api/external-records",
        params={"source_id": source_id, "resource_type": "party"},
    ).json()["items"][0]
    normalized_desired = {"source_id": source_id, **desired}
    assert mapping["payload_digest"] == payload_digest(normalized_desired)
    audit = api("get", "/api/audit", params={"limit": 1}).json()[0]
    assert audit["action"] == "reconcile:party"
    assert "Original Customer" in audit["before_json"]
    assert "Renamed Customer" in audit["after_json"]
    assert mapping["payload_digest"] in audit["after_json"]

    replay = reconcile_preview(api, "party", source_id, [desired]).json()
    assert replay["status"] == "already_satisfied"
    assert replay["changes"] == []


def test_reconcile_identity_digest_refresh_and_alias_owner_change(api):
    source_id = "synthetic-reconcile-refresh"
    parties = [
        {"external_id": "party:1", "canonical_name": "First Party", "roles": ["customer"]},
        {"external_id": "party:2", "canonical_name": "Second Party", "roles": ["supplier"]},
    ]
    import_records(api, "party", source_id, parties)
    party_mappings = api(
        "get",
        "/api/external-records",
        params={"source_id": source_id, "resource_type": "party"},
    ).json()["items"]
    party_ids = {item["external_id"]: item["entity_id"] for item in party_mappings}

    explicit_status = {**parties[0], "status": "active"}
    refresh_preview = reconcile_preview(api, "party", source_id, [explicit_status]).json()
    assert refresh_preview["changes"][0]["change_kind"] == "identity_digest_refresh"
    assert refresh_preview["changes"][0]["field_diffs"] == []
    refreshed = reconcile_apply(
        api,
        "party",
        source_id,
        [explicit_status],
        refresh_preview["preview_token"],
    ).json()
    assert refreshed["entities"][0]["change_kind"] == "identity_digest_refresh"

    alias = {
        "external_id": "party_alias:1",
        "party_id": party_ids["party:1"],
        "alias": "Shared Trading Name",
        "status": "active",
    }
    import_records(api, "party_alias", source_id, [alias])
    moved_alias = {**alias, "party_id": party_ids["party:2"]}
    alias_preview = reconcile_preview(api, "party_alias", source_id, [moved_alias]).json()
    assert alias_preview["changes"][0]["field_diffs"] == [
        {"field": "party_id", "before": party_ids["party:1"], "after": party_ids["party:2"]}
    ]
    moved = reconcile_apply(
        api,
        "party_alias",
        source_id,
        [moved_alias],
        alias_preview["preview_token"],
    ).json()
    assert moved["entities"][0]["readback"]["party_id"] == party_ids["party:2"]


def test_reconcile_rejects_tamper_concurrency_missing_identity_and_unsafe_unit_change(api):
    source_id = "synthetic-reconcile-guards"
    unit = {
        "external_id": "unit:1",
        "code": "pcs",
        "display_name": "Pieces",
        "dimension": "count",
        "status": "active",
    }
    import_records(api, "unit", source_id, [unit])
    desired = {**unit, "display_name": "Individual Pieces"}
    preview = reconcile_preview(api, "unit", source_id, [desired]).json()

    tampered = reconcile_apply(
        api,
        "unit",
        source_id,
        [{**desired, "display_name": "Tampered Value"}],
        preview["preview_token"],
    )
    assert tampered.status_code == 409
    assert "does not match" in tampered.json()["detail"]

    import_records(
        api,
        "party",
        source_id,
        [{"external_id": "party:state-bump", "canonical_name": "State Bump", "roles": ["customer"]}],
    )
    stale = reconcile_apply(api, "unit", source_id, [desired], preview["preview_token"])
    assert stale.status_code == 409
    assert "does not match" in stale.json()["detail"]

    missing = reconcile_preview(
        api,
        "unit",
        source_id,
        [{**unit, "external_id": "unit:missing"}],
    )
    assert missing.status_code == 409
    assert "requires an existing external identity" in missing.json()["detail"]

    mismatched = reconcile_preview(
        api,
        "unit",
        source_id,
        [
            {
                "external_id": "party:state-bump",
                "code": "other",
                "display_name": "Other",
                "dimension": "count",
                "status": "active",
            }
        ],
    )
    assert mismatched.status_code == 409
    assert "different resource type" in mismatched.json()["detail"]

    unit_id = api(
        "get",
        "/api/external-records",
        params={"source_id": source_id, "resource_type": "unit"},
    ).json()["items"][0]["entity_id"]
    import_records(
        api,
        "product",
        source_id,
        [{"external_id": "product:1", "canonical_name": "Product", "sku": "SKU-1", "unit_id": unit_id}],
    )
    unsafe = reconcile_preview(api, "unit", source_id, [{**unit, "dimension": "weight"}])
    assert unsafe.status_code == 409
    assert "cannot change after business use" in unsafe.json()["detail"]


def test_reconcile_detects_mapping_entity_drift(api):
    source_id = "synthetic-reconcile-drift"
    party = {
        "external_id": "party:1",
        "canonical_name": "Expected Name",
        "roles": ["customer"],
        "status": "active",
    }
    import_records(api, "party", source_id, [party])
    mapping = api(
        "get",
        "/api/external-records",
        params={"source_id": source_id, "resource_type": "party"},
    ).json()["items"][0]
    with sqlite3.connect(os.environ["BIZHUB_DATABASE_PATH"]) as conn:
        conn.execute("UPDATE parties SET canonical_name='Drifted Name' WHERE id=?", (mapping["entity_id"],))

    drift = reconcile_preview(api, "party", source_id, [party])
    assert drift.status_code == 409
    assert "digest disagrees" in drift.json()["detail"]


def test_reconcile_preserves_roles_and_units_that_have_business_consumers(api):
    source_id = "synthetic-reconcile-consumers"
    party = {
        "external_id": "party:1",
        "canonical_name": "Order Customer",
        "roles": ["customer"],
        "status": "active",
    }
    unit = {
        "external_id": "unit:1",
        "code": "pcs",
        "display_name": "Pieces",
        "dimension": "count",
        "status": "active",
    }
    import_records(api, "party", source_id, [party])
    import_records(api, "unit", source_id, [unit])
    party_id = api(
        "get",
        "/api/external-records",
        params={"source_id": source_id, "resource_type": "party"},
    ).json()["items"][0]["entity_id"]
    unit_id = api(
        "get",
        "/api/external-records",
        params={"source_id": source_id, "resource_type": "unit"},
    ).json()["items"][0]["entity_id"]
    import_records(
        api,
        "product",
        source_id,
        [{"external_id": "product:1", "canonical_name": "Product", "sku": "SKU-1", "unit_id": unit_id}],
    )
    product_id = api(
        "get",
        "/api/external-records",
        params={"source_id": source_id, "resource_type": "product"},
    ).json()["items"][0]["entity_id"]
    import_records(
        api,
        "sales_order",
        source_id,
        [
            {
                "external_id": "sale:1",
                "order_no": "SO-1",
                "customer_id": party_id,
                "order_date": "2026-08-21",
                "lines": [{"product_id": product_id, "unit_id": unit_id, "quantity": "1"}],
            }
        ],
    )

    role_removal = reconcile_preview(
        api,
        "party",
        source_id,
        [{**party, "roles": ["supplier"]}],
    )
    assert role_removal.status_code == 409
    assert "cannot be removed after sales use" in role_removal.json()["detail"]

    party_deprecation = reconcile_preview(
        api,
        "party",
        source_id,
        [{**party, "status": "deprecated"}],
    )
    assert party_deprecation.status_code == 409
    assert "orders remain open" in party_deprecation.json()["detail"]

    unit_deprecation = reconcile_preview(
        api,
        "unit",
        source_id,
        [{**unit, "status": "deprecated"}],
    )
    assert unit_deprecation.status_code == 409
    assert "active products use it" in unit_deprecation.json()["detail"]
