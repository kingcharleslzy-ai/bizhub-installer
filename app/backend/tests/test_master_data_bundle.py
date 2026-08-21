from __future__ import annotations

import os
import sqlite3


SOURCE_ID = "synthetic-bundle-v1"


def bundle() -> dict:
    return {
        "source_id": SOURCE_ID,
        "resources": {
            "parties": [
                {
                    "external_id": "party:active",
                    "canonical_name": "Current Customer",
                    "legal_name": "Current Customer Ltd.",
                    "roles": ["customer"],
                    "status": "active",
                },
                {
                    "external_id": "party:deprecated",
                    "canonical_name": "Former Customer",
                    "legal_name": "Former Customer Ltd.",
                    "roles": ["customer"],
                    "status": "deprecated",
                    "successor_party_external_id": "party:active",
                },
            ],
            "party_aliases": [
                {
                    "external_id": "party_alias:former-name",
                    "party_external_id": "party:active",
                    "alias": "Former Customer",
                    "status": "active",
                },
                {
                    "external_id": "party_alias:deprecated-owner",
                    "party_external_id": "party:deprecated",
                    "alias": "Former Customer Legacy Label",
                    "status": "active",
                },
            ],
        },
    }


def preview(api, value: dict):
    return api("post", "/api/imports/master-data-bundle/preview", json=value)


def apply(api, value: dict, token: str):
    return api(
        "post",
        "/api/imports/master-data-bundle/apply",
        json={
            **value,
            "preview_token": token,
            "review_note": "confirmed synthetic dependency-aware bundle",
        },
    )


def test_bundle_preview_apply_exact_readback_audit_and_idempotent_replay(api):
    value = bundle()
    preview_response = preview(api, value)
    assert preview_response.status_code == 200, preview_response.text
    proposed = preview_response.json()

    assert proposed["schema_version"] == "bizhub.master-data-bundle-preview.v1"
    assert proposed["status"] == "ready"
    assert proposed["state_version"] == 0
    assert proposed["input_summary"]["resource_counts"] == {"party": 2, "party_alias": 2}
    assert proposed["input_summary"]["total_records"] == 4
    assert len(proposed["dependency_graph"]["nodes"]) == 4
    assert len(proposed["dependency_graph"]["edges"]) == 3
    ordered = proposed["dependency_graph"]["topological_order"]
    assert ordered.index({"resource_type": "party", "external_id": "party:active"}) < ordered.index(
        {"resource_type": "party", "external_id": "party:deprecated"}
    )
    assert proposed["operations"]["create_count"] == 4

    applied_response = apply(api, value, proposed["preview_token"])
    assert applied_response.status_code == 200, applied_response.text
    applied = applied_response.json()
    assert applied["schema_version"] == "bizhub.master-data-bundle-result.v1"
    assert applied["status"] == "applied"
    assert applied["applied_count"] == 4
    assert applied["state_version_before"] == 0
    assert applied["state_version"] == 1
    assert len(applied["readback"]) == 4
    assert len(applied["audit_events"]) == 4
    assert all(
        event["action"].startswith("import:master_data_bundle:create_party")
        for event in applied["audit_events"]
    )

    by_external_id = {
        item["external_identity"]["external_id"]: item for item in applied["readback"]
    }
    active = by_external_id["party:active"]
    deprecated = by_external_id["party:deprecated"]
    former_alias = by_external_id["party_alias:former-name"]
    deprecated_owner_alias = by_external_id["party_alias:deprecated-owner"]
    assert deprecated["resource"]["successor_party_id"] == active["entity_id"]
    assert deprecated["resolved_references"]["successor"]["entity_id"] == active["entity_id"]
    assert former_alias["resource"]["party_id"] == active["entity_id"]
    assert former_alias["resolved_references"]["owner"]["external_id"] == "party:active"
    assert deprecated_owner_alias["resource"]["party_id"] == deprecated["entity_id"]
    assert all(
        item["external_mapping"]["payload_digest"]
        and item["external_mapping"]["resource_type"] == item["resource_type"]
        for item in applied["readback"]
    )

    replay_preview = preview(api, value).json()
    assert replay_preview["status"] == "already_satisfied"
    assert replay_preview["operations"]["already_satisfied_count"] == 4
    replay_response = apply(api, value, replay_preview["preview_token"])
    assert replay_response.status_code == 200, replay_response.text
    replay = replay_response.json()
    assert replay["status"] == "already_satisfied"
    assert replay["applied_count"] == 0
    assert replay["state_version_before"] == replay["state_version"] == 1
    assert replay["audit_events"] == []
    assert api("get", "/api/audit", params={"limit": 20}).json().__len__() == 4


def test_bundle_unknown_owner_duplicate_identity_cycle_and_name_conflict_fail_closed(api):
    unknown = bundle()
    unknown["resources"]["party_aliases"][0]["party_external_id"] = "party:missing"
    response = preview(api, unknown)
    assert response.status_code == 409
    assert "unknown party external identity" in response.json()["detail"]

    duplicate = bundle()
    duplicate["resources"]["party_aliases"][0]["external_id"] = "party:active"
    response = preview(api, duplicate)
    assert response.status_code == 409
    assert "unique across the complete bundle" in response.json()["detail"]

    cycle = bundle()
    cycle["resources"]["parties"] = [
        {
            "external_id": "party:a",
            "canonical_name": "Party A",
            "roles": ["customer"],
            "status": "deprecated",
            "successor_party_external_id": "party:b",
        },
        {
            "external_id": "party:b",
            "canonical_name": "Party B",
            "roles": ["customer"],
            "status": "deprecated",
            "successor_party_external_id": "party:a",
        },
    ]
    cycle["resources"]["party_aliases"] = []
    response = preview(api, cycle)
    assert response.status_code == 409
    assert "contains a cycle" in response.json()["detail"]

    conflict = bundle()
    conflict["resources"]["parties"][1] = {
        "external_id": "party:duplicate-name",
        "canonical_name": " current  customer ",
        "roles": ["supplier"],
        "status": "active",
    }
    conflict["resources"]["party_aliases"] = []
    response = preview(api, conflict)
    assert response.status_code == 409
    assert "already exists within the bundle" in response.json()["detail"]

    health = api("get", "/api/health").json()
    assert health["state_version"] == 0
    assert api("get", "/api/resources/catalog").json()["parties"] == []
    assert api("get", "/api/audit", params={"limit": 20}).json() == []


def test_bundle_content_and_state_drift_fail_closed(api):
    value = bundle()
    proposed = preview(api, value).json()
    assert apply(api, value, proposed["preview_token"]).status_code == 200

    changed = bundle()
    changed["resources"]["parties"][0]["legal_name"] = "Changed after creation Ltd."
    drift = preview(api, changed)
    assert drift.status_code == 409
    assert "different content" in drift.json()["detail"]

    second = {
        "source_id": "synthetic-bundle-state-drift",
        "resources": {
            "parties": [
                {
                    "external_id": "party:later",
                    "canonical_name": "Later Party",
                    "roles": ["supplier"],
                    "status": "active",
                }
            ],
            "party_aliases": [],
        },
    }
    stale_preview = preview(api, second).json()
    bump = {
        "resource": "party",
        "source_id": "synthetic-other-write",
        "records": [
            {"external_id": "party:bump", "canonical_name": "State Bump", "roles": ["customer"]}
        ],
    }
    import_preview = api("post", "/api/imports/json/preview", json=bump).json()
    import_apply = api(
        "post",
        "/api/imports/apply",
        json={
            **bump,
            "preview_token": import_preview["preview_token"],
            "review_note": "confirmed independent state bump",
        },
    )
    assert import_apply.status_code == 200
    stale = apply(api, second, stale_preview["preview_token"])
    assert stale.status_code == 409
    assert "does not match" in stale.json()["detail"]
    mappings = api(
        "get",
        "/api/external-records",
        params={"source_id": second["source_id"], "limit": 20},
    ).json()
    assert mappings["items"] == []


def test_bundle_mid_transaction_failure_rolls_back_every_resource_mapping_audit_and_state(api):
    value = bundle()
    proposed = preview(api, value).json()
    with sqlite3.connect(os.environ["BIZHUB_DATABASE_PATH"]) as conn:
        conn.execute(
            "CREATE TRIGGER synthetic_bundle_alias_failure BEFORE INSERT ON party_aliases "
            "BEGIN SELECT RAISE(ABORT, 'synthetic bundle alias failure'); END"
        )

    failed = apply(api, value, proposed["preview_token"])
    assert failed.status_code == 409
    assert "synthetic bundle alias failure" in failed.json()["detail"]
    catalog = api("get", "/api/resources/catalog").json()
    assert catalog["state_version"] == 0
    assert catalog["parties"] == []
    assert api(
        "get",
        "/api/external-records",
        params={"source_id": SOURCE_ID, "limit": 20},
    ).json()["items"] == []
    assert api("get", "/api/audit", params={"limit": 20}).json() == []
