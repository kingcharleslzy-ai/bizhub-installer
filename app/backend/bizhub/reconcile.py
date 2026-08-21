from __future__ import annotations

import sqlite3
import time
from typing import Any

from .db import bump_state_version, state_version, utc_now
from .imports import _normalized_records
from .service import (
    _audit,
    _decode_token,
    _encode_token,
    alias_readback,
    execute_master_data_reconcile,
    normalize_alias,
    party_readback,
    payload_digest,
    unit_readback,
    validate_master_data_reconcile,
)


RECONCILE_RESOURCES = {"party", "party_alias", "unit", "unit_alias"}
RECONCILE_CONTRACT = "bizhub.master-data-reconcile-preview.v1"
PREVIEW_TTL_SECONDS = 15 * 60


def _current_payload(
    conn: sqlite3.Connection,
    *,
    resource: str,
    entity_id: int,
    source_id: str,
    external_id: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    if resource == "party":
        readback = party_readback(conn, entity_id)
        payload = {
            "source_id": source_id,
            "external_id": external_id,
            "canonical_name": readback["canonical_name"],
            "legal_name": readback["legal_name"],
            "roles": readback["roles"],
            "status": readback["status"],
            "successor_party_id": readback["successor_party_id"],
        }
    elif resource == "unit":
        readback = unit_readback(conn, entity_id)
        payload = {
            "source_id": source_id,
            "external_id": external_id,
            "code": readback["code"],
            "display_name": readback["display_name"],
            "dimension": readback["dimension"],
            "status": readback["status"],
        }
    elif resource in {"party_alias", "unit_alias"}:
        readback = alias_readback(conn, resource, entity_id)
        owner_field = "party_id" if resource == "party_alias" else "unit_id"
        payload = {
            "source_id": source_id,
            "external_id": external_id,
            owner_field: readback[owner_field],
            "alias": readback["alias"],
            "status": readback["status"],
        }
    else:
        raise ValueError("unsupported reconcile resource")
    return payload, readback


def _semantic_payload(payload: dict[str, Any]) -> dict[str, Any]:
    result = {
        key: value for key, value in payload.items() if key not in {"source_id", "external_id"}
    }
    if "roles" in result:
        result["roles"] = sorted(result["roles"])
    return result


def _field_diffs(current: dict[str, Any], desired: dict[str, Any]) -> list[dict[str, Any]]:
    before = _semantic_payload(current)
    after = _semantic_payload(desired)
    return [
        {"field": field, "before": before.get(field), "after": after.get(field)}
        for field in sorted(set(before) | set(after))
        if before.get(field) != after.get(field)
    ]


def _business_key(resource: str, payload: dict[str, Any]) -> str:
    if resource == "party":
        return normalize_alias(str(payload["canonical_name"]))
    if resource == "unit":
        return normalize_alias(str(payload["code"]))
    return normalize_alias(str(payload["alias"]))


def _analyze(
    conn: sqlite3.Connection,
    *,
    resource: str,
    source_id: str,
    records: list[dict[str, Any]],
) -> tuple[list[tuple[Any, dict[str, Any]]], list[dict[str, Any]], int]:
    if resource not in RECONCILE_RESOURCES:
        raise ValueError("unsupported reconcile resource")
    if any("status" not in record for record in records):
        raise ValueError("every reconcile record requires explicit status")
    normalized_pairs = _normalized_records(resource, source_id, records)
    changes: list[dict[str, Any]] = []
    unchanged = 0
    business_keys: set[str] = set()
    for model, desired in normalized_pairs:
        key = _business_key(resource, desired)
        if key in business_keys:
            raise ValueError("reconcile contains a duplicate business key")
        business_keys.add(key)
        external_id = str(desired["external_id"])
        mapping = conn.execute(
            "SELECT * FROM external_records WHERE source_id=? AND external_id=?",
            (source_id, external_id),
        ).fetchone()
        if mapping is None:
            raise ValueError("reconcile requires an existing external identity")
        if mapping["resource_type"] != resource:
            raise ValueError("external identity belongs to a different resource type")
        entity_id = int(mapping["entity_id"])
        current, _ = _current_payload(
            conn,
            resource=resource,
            entity_id=entity_id,
            source_id=source_id,
            external_id=external_id,
        )
        diffs = _field_diffs(current, desired)
        desired_digest = payload_digest(desired)
        current_digest = str(mapping["payload_digest"])
        if current_digest == desired_digest:
            if diffs:
                raise ValueError("external mapping digest disagrees with current resource readback")
            unchanged += 1
            continue
        validate_master_data_reconcile(conn, resource, model, entity_id)
        changes.append(
            {
                "external_id": external_id,
                "resource_type": resource,
                "entity_id": entity_id,
                "change_kind": "update" if diffs else "identity_digest_refresh",
                "current_payload_digest": current_digest,
                "desired_payload_digest": desired_digest,
                "field_diffs": diffs,
            }
        )
    return normalized_pairs, changes, unchanged


def preview_reconcile(
    conn: sqlite3.Connection,
    *,
    resource: str,
    source_id: str,
    records: list[dict[str, Any]],
) -> dict[str, Any]:
    normalized_pairs, changes, unchanged = _analyze(
        conn,
        resource=resource,
        source_id=source_id,
        records=records,
    )
    normalized = [payload for _, payload in normalized_pairs]
    version = state_version(conn)
    expires_at = int(time.time()) + PREVIEW_TTL_SECONDS
    token = _encode_token(
        {
            "contract": RECONCILE_CONTRACT,
            "resource": resource,
            "source_id": source_id,
            "records_digest": payload_digest(normalized),
            "changes_digest": payload_digest(changes),
            "state_version": version,
            "expires_at": expires_at,
        }
    )
    return {
        "schema_version": RECONCILE_CONTRACT,
        "status": "ready" if changes else "already_satisfied",
        "resource": resource,
        "source_id": source_id,
        "record_count": len(normalized_pairs),
        "ready_count": len(changes),
        "already_satisfied_count": unchanged,
        "state_version": version,
        "changes": changes,
        "preview_token": token,
        "expires_at": expires_at,
    }


def apply_reconcile(
    conn: sqlite3.Connection,
    *,
    resource: str,
    source_id: str,
    records: list[dict[str, Any]],
    preview_token: str,
    actor: str,
    review_note: str,
) -> dict[str, Any]:
    normalized_pairs, changes, unchanged = _analyze(
        conn,
        resource=resource,
        source_id=source_id,
        records=records,
    )
    if not changes:
        return {
            "schema_version": "bizhub.master-data-reconcile-result.v1",
            "status": "already_satisfied",
            "resource": resource,
            "applied_count": 0,
            "already_satisfied_count": unchanged,
            "entities": [],
            "state_version": state_version(conn),
        }
    normalized = [payload for _, payload in normalized_pairs]
    token = _decode_token(preview_token)
    expected = {
        "contract": RECONCILE_CONTRACT,
        "resource": resource,
        "source_id": source_id,
        "records_digest": payload_digest(normalized),
        "changes_digest": payload_digest(changes),
        "state_version": state_version(conn),
    }
    for key, value in expected.items():
        if token.get(key) != value:
            raise ValueError("reconcile preview token does not match the current input, diff, or state")

    models_by_external_id = {
        str(payload["external_id"]): (model, payload) for model, payload in normalized_pairs
    }
    applied: list[dict[str, Any]] = []
    try:
        conn.execute("BEGIN IMMEDIATE")
        if state_version(conn) != int(token["state_version"]):
            raise ValueError("formal state changed after reconcile preview")
        for change in changes:
            model, desired = models_by_external_id[change["external_id"]]
            mapping = conn.execute(
                "SELECT * FROM external_records WHERE source_id=? AND external_id=?",
                (source_id, change["external_id"]),
            ).fetchone()
            if (
                mapping is None
                or mapping["resource_type"] != resource
                or int(mapping["entity_id"]) != change["entity_id"]
                or mapping["payload_digest"] != change["current_payload_digest"]
            ):
                raise ValueError("external mapping changed after reconcile preview")
            entity_id = int(mapping["entity_id"])
            _, before_readback = _current_payload(
                conn,
                resource=resource,
                entity_id=entity_id,
                source_id=source_id,
                external_id=change["external_id"],
            )
            validate_master_data_reconcile(conn, resource, model, entity_id)
            candidate_readback = (
                execute_master_data_reconcile(conn, resource, model, entity_id)
                if change["field_diffs"]
                else before_readback
            )
            after_payload, after_readback = _current_payload(
                conn,
                resource=resource,
                entity_id=entity_id,
                source_id=source_id,
                external_id=change["external_id"],
            )
            if _field_diffs(after_payload, desired):
                raise ValueError("reconcile resource readback does not match the approved payload")
            if candidate_readback != after_readback:
                raise ValueError("reconcile owner readback changed unexpectedly")
            updated_at = utc_now()
            updated = conn.execute(
                "UPDATE external_records SET payload_digest=?,updated_at=? WHERE id=?",
                (change["desired_payload_digest"], updated_at, int(mapping["id"])),
            )
            if updated.rowcount != 1:
                raise ValueError("reconcile external mapping readback failed")
            mapping_readback = conn.execute(
                "SELECT payload_digest FROM external_records WHERE id=?", (int(mapping["id"]),)
            ).fetchone()
            if mapping_readback is None or mapping_readback["payload_digest"] != change["desired_payload_digest"]:
                raise ValueError("reconcile external mapping readback does not match the approved payload")
            _audit(
                conn,
                action=f"reconcile:{resource}",
                entity_type=resource,
                entity_ref=f"{resource}:{entity_id}",
                before={
                    "resource": before_readback,
                    "external_identity": {
                        "source_id": source_id,
                        "external_id": change["external_id"],
                        "payload_digest": change["current_payload_digest"],
                    },
                },
                after={
                    "resource": after_readback,
                    "external_identity": {
                        "source_id": source_id,
                        "external_id": change["external_id"],
                        "payload_digest": change["desired_payload_digest"],
                    },
                },
                actor=actor,
                review_note=review_note,
            )
            applied.append(
                {
                    "external_id": change["external_id"],
                    "resource_type": resource,
                    "entity_id": entity_id,
                    "change_kind": change["change_kind"],
                    "field_diffs": change["field_diffs"],
                    "payload_digest": change["desired_payload_digest"],
                    "readback": after_readback,
                }
            )
        version = bump_state_version(conn)
        conn.execute("COMMIT")
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    return {
        "schema_version": "bizhub.master-data-reconcile-result.v1",
        "status": "applied",
        "resource": resource,
        "applied_count": len(applied),
        "already_satisfied_count": unchanged,
        "entities": applied,
        "state_version": version,
    }
