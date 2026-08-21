from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest

from bizhub.config import company_profile_digest
from bizhub.db import BASELINE_VERSION, SCHEMA_SQL, SCHEMA_VERSION, initialize_database, utc_now


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


def test_external_mapping_readback_requires_authentication(client):
    client.post("/api/auth/logout", headers={"X-BizHub-Request": "1"})
    assert client.get("/api/external-records", params={"source_id": "synthetic"}).status_code == 401
