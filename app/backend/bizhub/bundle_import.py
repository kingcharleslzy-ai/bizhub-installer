from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from typing import Any

from .contracts import ACTION_MODELS
from .db import bump_state_version, state_version
from .service import (
    _audit,
    _decode_token,
    _encode_token,
    _execute,
    _payload,
    _record_external,
    _validate_action,
    _validated,
    alias_readback,
    normalize_alias,
    party_readback,
    payload_digest,
)


BUNDLE_PREVIEW_CONTRACT = "bizhub.master-data-bundle-preview.v1"
BUNDLE_RESULT_CONTRACT = "bizhub.master-data-bundle-result.v1"
PREVIEW_TTL_SECONDS = 15 * 60
RESOURCE_ORDER = {"party": 0, "party_alias": 1}


Identity = tuple[str, str]


@dataclass(frozen=True)
class BundleAnalysis:
    source_id: str
    resources: dict[str, list[dict[str, Any]]]
    input_summary: dict[str, Any]
    dependency_graph: dict[str, Any]
    operations: list[dict[str, Any]]
    topological_order: tuple[Identity, ...]

    @property
    def operations_digest(self) -> str:
        return payload_digest(self.operations)


def _identity_payload(identity: Identity) -> dict[str, str]:
    return {"resource_type": identity[0], "external_id": identity[1]}


def _normalized_resources(resources: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    parties: list[dict[str, Any]] = []
    for raw in resources.get("parties") or []:
        party = dict(raw)
        party["external_id"] = str(party["external_id"]).strip()
        party["canonical_name"] = str(party["canonical_name"]).strip()
        party["legal_name"] = str(party.get("legal_name") or "").strip()
        party["roles"] = sorted(str(role) for role in party["roles"])
        party["status"] = str(party["status"])
        successor = party.get("successor_party_external_id")
        if successor is None:
            party.pop("successor_party_external_id", None)
        else:
            party["successor_party_external_id"] = str(successor).strip()
        if not party["external_id"] or not party["canonical_name"]:
            raise ValueError("party external identity and canonical name must contain visible text")
        parties.append(party)

    aliases: list[dict[str, Any]] = []
    for raw in resources.get("party_aliases") or []:
        alias = dict(raw)
        alias["external_id"] = str(alias["external_id"]).strip()
        alias["party_external_id"] = str(alias["party_external_id"]).strip()
        alias["alias"] = str(alias["alias"]).strip()
        alias["status"] = str(alias["status"])
        if not alias["external_id"] or not alias["party_external_id"] or not alias["alias"]:
            raise ValueError("party alias identity, owner, and value must contain visible text")
        aliases.append(alias)

    return {
        "parties": sorted(parties, key=lambda item: item["external_id"]),
        "party_aliases": sorted(aliases, key=lambda item: item["external_id"]),
    }


def _record_index(resources: dict[str, list[dict[str, Any]]]) -> dict[Identity, dict[str, Any]]:
    records: dict[Identity, dict[str, Any]] = {}
    all_external_ids: dict[str, str] = {}
    for resource_type, key in (("party", "parties"), ("party_alias", "party_aliases")):
        for record in resources[key]:
            external_id = str(record["external_id"])
            if external_id in all_external_ids:
                raise ValueError("external identities must be unique across the complete bundle")
            all_external_ids[external_id] = resource_type
            records[(resource_type, external_id)] = record
    return records


def _mapping_index(conn: sqlite3.Connection, source_id: str) -> dict[str, sqlite3.Row]:
    return {
        str(row["external_id"]): row
        for row in conn.execute(
            "SELECT * FROM external_records WHERE source_id=? ORDER BY id",
            (source_id,),
        )
    }


def _party_row(conn: sqlite3.Connection, entity_id: int) -> sqlite3.Row:
    row = conn.execute(
        "SELECT id,canonical_name,legal_name,status,successor_party_id FROM parties WHERE id=?",
        (entity_id,),
    ).fetchone()
    if row is None:
        raise ValueError("external party mapping points to a missing resource")
    return row


def _party_reference(
    conn: sqlite3.Connection,
    *,
    external_id: str,
    records: dict[Identity, dict[str, Any]],
    mappings: dict[str, sqlite3.Row],
    require_active: bool,
) -> tuple[str, int | None]:
    bundled = records.get(("party", external_id))
    mapping = mappings.get(external_id)
    if bundled is None and mapping is None:
        raise ValueError("bundle references an unknown party external identity")
    if mapping is not None and mapping["resource_type"] != "party":
        raise ValueError("bundle party reference belongs to a different resource type")
    if require_active and bundled is not None and bundled["status"] != "active":
        raise ValueError("party successor references must resolve to an active party")
    if mapping is not None:
        row = _party_row(conn, int(mapping["entity_id"]))
        if require_active and row["status"] != "active":
            raise ValueError("party successor references must resolve to an active party")
        return "bundle" if bundled is not None else "existing", int(mapping["entity_id"])
    return "bundle", None


def _dependency_graph(
    conn: sqlite3.Connection,
    *,
    records: dict[Identity, dict[str, Any]],
    mappings: dict[str, sqlite3.Row],
) -> tuple[dict[str, Any], tuple[Identity, ...]]:
    successor_edges = {
        identity[1]: str(record["successor_party_external_id"])
        for identity, record in records.items()
        if identity[0] == "party" and record.get("successor_party_external_id")
    }
    for start in successor_edges:
        visited: set[str] = set()
        current = start
        while current in successor_edges:
            if current in visited:
                raise ValueError("master-data bundle dependency graph contains a cycle")
            visited.add(current)
            current = successor_edges[current]

    dependencies: dict[Identity, set[Identity]] = {identity: set() for identity in records}
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

    for identity in sorted(records, key=lambda item: (RESOURCE_ORDER[item[0]], item[1])):
        resource_type, external_id = identity
        record = records[identity]
        nodes.append(_identity_payload(identity))
        if resource_type == "party":
            target = record.get("successor_party_external_id")
            if not target:
                continue
            if target == external_id:
                raise ValueError("a party cannot succeed itself")
            scope, entity_id = _party_reference(
                conn,
                external_id=target,
                records=records,
                mappings=mappings,
                require_active=True,
            )
            target_identity = ("party", target)
            if target_identity in records:
                dependencies[identity].add(target_identity)
            edges.append(
                {
                    "from": _identity_payload(identity),
                    "relation": "successor",
                    "to": _identity_payload(target_identity),
                    "resolution": scope,
                    "resolved_entity_id": entity_id,
                }
            )
        else:
            target = str(record["party_external_id"])
            scope, entity_id = _party_reference(
                conn,
                external_id=target,
                records=records,
                mappings=mappings,
                require_active=False,
            )
            target_identity = ("party", target)
            if target_identity in records:
                dependencies[identity].add(target_identity)
            edges.append(
                {
                    "from": _identity_payload(identity),
                    "relation": "owner",
                    "to": _identity_payload(target_identity),
                    "resolution": scope,
                    "resolved_entity_id": entity_id,
                }
            )

    remaining = {identity: set(values) for identity, values in dependencies.items()}
    ordered: list[Identity] = []
    while remaining:
        ready = sorted(
            (identity for identity, values in remaining.items() if not values),
            key=lambda item: (RESOURCE_ORDER[item[0]], item[1]),
        )
        if not ready:
            raise ValueError("master-data bundle dependency graph contains a cycle")
        for identity in ready:
            ordered.append(identity)
            remaining.pop(identity)
        for values in remaining.values():
            values.difference_update(ready)

    graph = {
        "nodes": nodes,
        "edges": sorted(
            edges,
            key=lambda item: (
                RESOURCE_ORDER[item["from"]["resource_type"]],
                item["from"]["external_id"],
                item["relation"],
            ),
        ),
        "topological_order": [_identity_payload(identity) for identity in ordered],
    }
    graph["digest"] = payload_digest(graph)
    return graph, tuple(ordered)


def _resolved_party_ids(
    conn: sqlite3.Connection,
    mappings: dict[str, sqlite3.Row],
) -> dict[str, int]:
    resolved: dict[str, int] = {}
    for external_id, mapping in mappings.items():
        if mapping["resource_type"] != "party":
            continue
        _party_row(conn, int(mapping["entity_id"]))
        resolved[external_id] = int(mapping["entity_id"])
    return resolved


def _validate_name_conflicts(
    conn: sqlite3.Connection,
    *,
    records: dict[Identity, dict[str, Any]],
    mappings: dict[str, sqlite3.Row],
) -> None:
    new_parties = [
        (identity, record)
        for identity, record in records.items()
        if identity[0] == "party" and identity[1] not in mappings
    ]
    new_aliases = [
        (identity, record)
        for identity, record in records.items()
        if identity[0] == "party_alias" and identity[1] not in mappings
    ]
    existing_parties = [dict(row) for row in conn.execute(
        "SELECT id,canonical_name,status,successor_party_id FROM parties ORDER BY id"
    )]
    existing_aliases = [dict(row) for row in conn.execute(
        "SELECT id,party_id,alias,normalized_alias,status FROM party_aliases ORDER BY id"
    )]
    resolved_ids = _resolved_party_ids(conn, mappings)

    new_canonical: dict[str, tuple[Identity, dict[str, Any]]] = {}
    for identity, party in new_parties:
        normalized = normalize_alias(str(party["canonical_name"]))
        if not normalized:
            raise ValueError("party canonical identity must contain visible text")
        if normalized in new_canonical:
            raise ValueError("party canonical identity already exists within the bundle")
        if any(normalize_alias(str(row["canonical_name"])) == normalized for row in existing_parties):
            raise ValueError("party canonical identity already exists")
        new_canonical[normalized] = (identity, party)

    for normalized, (identity, party) in new_canonical.items():
        matching_existing_aliases = [
            row for row in existing_aliases if str(row["normalized_alias"]) == normalized
        ]
        if matching_existing_aliases:
            successor = party.get("successor_party_external_id")
            successor_id = resolved_ids.get(str(successor)) if successor else None
            permitted = (
                party["status"] == "deprecated"
                and successor_id is not None
                and all(int(row["party_id"]) == successor_id for row in matching_existing_aliases)
            )
            if not permitted:
                raise ValueError("party canonical identity conflicts with an existing alias")

    combined_canonical: list[dict[str, Any]] = [
        {
            "normalized": normalize_alias(str(row["canonical_name"])),
            "status": str(row["status"]),
            "entity_id": int(row["id"]),
            "external_id": None,
            "successor_entity_id": int(row["successor_party_id"])
            if row["successor_party_id"] is not None
            else None,
            "successor_external_id": None,
        }
        for row in existing_parties
    ]
    combined_canonical.extend(
        {
            "normalized": normalized,
            "status": str(party["status"]),
            "entity_id": None,
            "external_id": identity[1],
            "successor_entity_id": resolved_ids.get(str(party.get("successor_party_external_id"))),
            "successor_external_id": party.get("successor_party_external_id"),
        }
        for normalized, (identity, party) in new_canonical.items()
    )

    new_alias_names: dict[str, list[tuple[Identity, dict[str, Any]]]] = {}
    for identity, alias in new_aliases:
        normalized = normalize_alias(str(alias["alias"]))
        if not normalized:
            raise ValueError("alias must contain visible text")
        owner_external_id = str(alias["party_external_id"])
        owner_id = resolved_ids.get(owner_external_id)
        for canonical in combined_canonical:
            if canonical["normalized"] != normalized:
                continue
            same_owner = (
                (owner_id is not None and canonical["entity_id"] == owner_id)
                or (canonical["external_id"] == owner_external_id)
            )
            if same_owner:
                raise ValueError("alias duplicates its canonical resource identity")
            successor_matches = (
                alias["status"] == "active"
                and canonical["status"] == "deprecated"
                and (
                    (owner_id is not None and canonical["successor_entity_id"] == owner_id)
                    or canonical["successor_external_id"] == owner_external_id
                )
            )
            if not successor_matches:
                raise ValueError("alias conflicts with a different canonical resource")

        matching_existing = [
            row for row in existing_aliases if str(row["normalized_alias"]) == normalized
        ]
        if owner_id is not None and any(int(row["party_id"]) == owner_id for row in matching_existing):
            raise ValueError("alias already exists for the canonical resource")
        if alias["status"] == "active" and any(row["status"] == "active" for row in matching_existing):
            raise ValueError("active alias already belongs to a different canonical resource")
        new_alias_names.setdefault(normalized, []).append((identity, alias))

    for aliases in new_alias_names.values():
        owners = [str(alias["party_external_id"]) for _, alias in aliases]
        if len(owners) != len(set(owners)):
            raise ValueError("alias already exists for the canonical resource within the bundle")
        if sum(1 for _, alias in aliases if alias["status"] == "active") > 1:
            raise ValueError("active alias already belongs to a different canonical resource within the bundle")

    for normalized, (identity, party) in new_canonical.items():
        matching_new_aliases = new_alias_names.get(normalized, [])
        if not matching_new_aliases:
            continue
        successor = party.get("successor_party_external_id")
        permitted = (
            party["status"] == "deprecated"
            and successor is not None
            and all(
                alias["status"] == "active" and alias["party_external_id"] == successor
                for _, alias in matching_new_aliases
            )
        )
        if not permitted:
            raise ValueError("party canonical identity conflicts with a bundle alias")


def _desired_action_payload(
    *,
    source_id: str,
    identity: Identity,
    record: dict[str, Any],
    resolved_party_ids: dict[str, int],
) -> tuple[str, Any, dict[str, Any]]:
    resource_type, external_id = identity
    if resource_type == "party":
        successor = record.get("successor_party_external_id")
        if successor and successor not in resolved_party_ids:
            raise ValueError("party successor has not been resolved before use")
        data = {
            "source_id": source_id,
            "external_id": external_id,
            "canonical_name": record["canonical_name"],
            "legal_name": record["legal_name"],
            "roles": record["roles"],
            "status": record["status"],
            "successor_party_id": resolved_party_ids.get(str(successor)) if successor else None,
        }
        action = "create_party"
    else:
        owner = str(record["party_external_id"])
        if owner not in resolved_party_ids:
            raise ValueError("party alias owner has not been resolved before use")
        data = {
            "source_id": source_id,
            "external_id": external_id,
            "party_id": resolved_party_ids[owner],
            "alias": record["alias"],
            "status": record["status"],
        }
        action = "create_party_alias"
    if action not in ACTION_MODELS:
        raise RuntimeError("bundle action model is unavailable")
    model = _validated(action, data)
    return action, model, _payload(model)


def _verify_existing(
    conn: sqlite3.Connection,
    *,
    identity: Identity,
    mapping: sqlite3.Row,
    desired_payload: dict[str, Any],
) -> None:
    resource_type, _ = identity
    if mapping["resource_type"] != resource_type:
        raise ValueError("bundle external identity belongs to a different resource type")
    if mapping["payload_digest"] != payload_digest(desired_payload):
        raise ValueError("external identity already exists with different content")
    entity_id = int(mapping["entity_id"])
    if resource_type == "party":
        readback = party_readback(conn, entity_id)
        current = {
            "source_id": desired_payload["source_id"],
            "external_id": desired_payload["external_id"],
            "canonical_name": readback["canonical_name"],
            "legal_name": readback["legal_name"],
            "roles": sorted(readback["roles"]),
            "status": readback["status"],
        }
        if readback["successor_party_id"] is not None:
            current["successor_party_id"] = int(readback["successor_party_id"])
    else:
        readback = alias_readback(conn, resource_type, entity_id)
        current = {
            "source_id": desired_payload["source_id"],
            "external_id": desired_payload["external_id"],
            "party_id": int(readback["party_id"]),
            "alias": readback["alias"],
            "status": readback["status"],
        }
    if current != desired_payload:
        raise ValueError("external mapping digest disagrees with current resource readback")


def analyze_bundle(
    conn: sqlite3.Connection,
    *,
    source_id: str,
    resources: dict[str, Any],
) -> BundleAnalysis:
    normalized_source = str(source_id).strip()
    if not normalized_source:
        raise ValueError("bundle source_id must contain visible text")
    normalized = _normalized_resources(resources)
    records = _record_index(normalized)
    mappings = _mapping_index(conn, normalized_source)
    for identity in records:
        mapping = mappings.get(identity[1])
        if mapping is not None and mapping["resource_type"] != identity[0]:
            raise ValueError("bundle external identity belongs to a different resource type")
    graph, topological_order = _dependency_graph(
        conn,
        records=records,
        mappings=mappings,
    )
    _validate_name_conflicts(conn, records=records, mappings=mappings)

    resolved_party_ids = _resolved_party_ids(conn, mappings)
    operations: list[dict[str, Any]] = []
    for identity in topological_order:
        record = records[identity]
        mapping = mappings.get(identity[1])
        desired_record_digest = payload_digest(
            {"resource_type": identity[0], "source_id": normalized_source, **record}
        )
        operation = {
            **_identity_payload(identity),
            "operation": "already_satisfied" if mapping is not None else "create",
            "desired_record_digest": desired_record_digest,
        }
        if mapping is not None:
            action, _, desired_payload = _desired_action_payload(
                source_id=normalized_source,
                identity=identity,
                record=record,
                resolved_party_ids=resolved_party_ids,
            )
            _verify_existing(
                conn,
                identity=identity,
                mapping=mapping,
                desired_payload=desired_payload,
            )
            operation.update(
                {
                    "action": action,
                    "entity_id": int(mapping["entity_id"]),
                    "payload_digest": str(mapping["payload_digest"]),
                }
            )
            if identity[0] == "party":
                resolved_party_ids[identity[1]] = int(mapping["entity_id"])
        else:
            operation["action"] = "create_party" if identity[0] == "party" else "create_party_alias"
        operations.append(operation)

    input_payload = {"source_id": normalized_source, "resources": normalized}
    identities = [_identity_payload(identity) for identity in sorted(
        records, key=lambda item: (RESOURCE_ORDER[item[0]], item[1])
    )]
    input_summary = {
        "bundle_digest": payload_digest(input_payload),
        "identity_digest": payload_digest(identities),
        "resource_counts": {
            "party": len(normalized["parties"]),
            "party_alias": len(normalized["party_aliases"]),
        },
        "total_records": len(records),
    }
    return BundleAnalysis(
        source_id=normalized_source,
        resources=normalized,
        input_summary=input_summary,
        dependency_graph=graph,
        operations=operations,
        topological_order=topological_order,
    )


def _token_payload(analysis: BundleAnalysis, version: int, expires_at: int) -> dict[str, Any]:
    return {
        "contract": BUNDLE_PREVIEW_CONTRACT,
        "source_id": analysis.source_id,
        "bundle_digest": analysis.input_summary["bundle_digest"],
        "dependency_graph_digest": analysis.dependency_graph["digest"],
        "operations_digest": analysis.operations_digest,
        "state_version": version,
        "expires_at": expires_at,
    }


def preview_master_data_bundle(
    conn: sqlite3.Connection,
    *,
    source_id: str,
    resources: dict[str, Any],
) -> dict[str, Any]:
    analysis = analyze_bundle(conn, source_id=source_id, resources=resources)
    version = state_version(conn)
    expires_at = int(time.time()) + PREVIEW_TTL_SECONDS
    token = _encode_token(_token_payload(analysis, version, expires_at))
    create_count = sum(item["operation"] == "create" for item in analysis.operations)
    return {
        "schema_version": BUNDLE_PREVIEW_CONTRACT,
        "status": "ready" if create_count else "already_satisfied",
        "source_id": analysis.source_id,
        "input_summary": analysis.input_summary,
        "dependency_graph": analysis.dependency_graph,
        "state_version": version,
        "operations": {
            "create_count": create_count,
            "already_satisfied_count": len(analysis.operations) - create_count,
            "digest": analysis.operations_digest,
            "items": analysis.operations,
        },
        "preview_token": token,
        "expires_at": expires_at,
    }


def _mapping_readback(conn: sqlite3.Connection, source_id: str, external_id: str) -> dict[str, Any]:
    row = conn.execute(
        "SELECT id,source_id,external_id,resource_type,entity_id,payload_digest,created_at,"
        "COALESCE(updated_at,created_at) AS updated_at FROM external_records "
        "WHERE source_id=? AND external_id=?",
        (source_id, external_id),
    ).fetchone()
    if row is None:
        raise ValueError("bundle external mapping readback is missing")
    return dict(row)


def _exact_readback(
    conn: sqlite3.Connection,
    *,
    analysis: BundleAnalysis,
) -> list[dict[str, Any]]:
    records = _record_index(analysis.resources)
    mappings = _mapping_index(conn, analysis.source_id)
    resolved_party_ids = _resolved_party_ids(conn, mappings)
    items: list[dict[str, Any]] = []
    for identity in analysis.topological_order:
        record = records[identity]
        mapping = mappings.get(identity[1])
        if mapping is None:
            raise ValueError("bundle external mapping readback is missing")
        _, _, desired_payload = _desired_action_payload(
            source_id=analysis.source_id,
            identity=identity,
            record=record,
            resolved_party_ids=resolved_party_ids,
        )
        _verify_existing(
            conn,
            identity=identity,
            mapping=mapping,
            desired_payload=desired_payload,
        )
        entity_id = int(mapping["entity_id"])
        resource = (
            party_readback(conn, entity_id)
            if identity[0] == "party"
            else alias_readback(conn, identity[0], entity_id)
        )
        references: dict[str, Any] = {}
        if identity[0] == "party" and record.get("successor_party_external_id"):
            successor = str(record["successor_party_external_id"])
            references["successor"] = {
                "source_id": analysis.source_id,
                "external_id": successor,
                "entity_id": resolved_party_ids[successor],
            }
            if resource["successor_party_id"] != resolved_party_ids[successor]:
                raise ValueError("bundle successor readback does not match its external identity")
        if identity[0] == "party_alias":
            owner = str(record["party_external_id"])
            references["owner"] = {
                "source_id": analysis.source_id,
                "external_id": owner,
                "entity_id": resolved_party_ids[owner],
            }
            if resource["party_id"] != resolved_party_ids[owner]:
                raise ValueError("bundle alias owner readback does not match its external identity")
        items.append(
            {
                "external_identity": {
                    "source_id": analysis.source_id,
                    "external_id": identity[1],
                },
                "resource_type": identity[0],
                "entity_id": entity_id,
                "resource": resource,
                "external_mapping": _mapping_readback(conn, analysis.source_id, identity[1]),
                "resolved_references": references,
            }
        )
    return items


def apply_master_data_bundle(
    conn: sqlite3.Connection,
    *,
    source_id: str,
    resources: dict[str, Any],
    preview_token: str,
    actor: str,
    review_note: str,
) -> dict[str, Any]:
    token = _decode_token(preview_token)
    applied_audit_ids: list[int] = []
    try:
        conn.execute("BEGIN IMMEDIATE")
        analysis = analyze_bundle(conn, source_id=source_id, resources=resources)
        version_before = state_version(conn)
        expected = _token_payload(analysis, version_before, int(token.get("expires_at") or 0))
        for key, value in expected.items():
            if token.get(key) != value:
                raise ValueError(
                    "master-data bundle preview token does not match the current input, dependency graph, or state"
                )

        records = _record_index(analysis.resources)
        mappings = _mapping_index(conn, analysis.source_id)
        resolved_party_ids = _resolved_party_ids(conn, mappings)
        created = 0
        for identity in analysis.topological_order:
            mapping = mappings.get(identity[1])
            if mapping is not None:
                if identity[0] == "party":
                    resolved_party_ids[identity[1]] = int(mapping["entity_id"])
                continue
            action, model, desired_payload = _desired_action_payload(
                source_id=analysis.source_id,
                identity=identity,
                record=records[identity],
                resolved_party_ids=resolved_party_ids,
            )
            _validate_action(conn, action, model)
            resource_type, entity_id, resource_readback = _execute(conn, action, model)
            if resource_type != identity[0]:
                raise RuntimeError("bundle action returned an unexpected resource type")
            _record_external(conn, model, desired_payload, resource_type, entity_id)
            mapping_readback = _mapping_readback(conn, analysis.source_id, identity[1])
            _audit(
                conn,
                action=f"import:master_data_bundle:{action}",
                entity_type=resource_type,
                entity_ref=f"{resource_type}:{entity_id}",
                after={
                    "resource": resource_readback,
                    "external_mapping": mapping_readback,
                    "bundle_identity": _identity_payload(identity),
                },
                actor=actor,
                review_note=review_note,
            )
            applied_audit_ids.append(int(conn.execute("SELECT last_insert_rowid()").fetchone()[0]))
            mappings[identity[1]] = conn.execute(
                "SELECT * FROM external_records WHERE source_id=? AND external_id=?",
                (analysis.source_id, identity[1]),
            ).fetchone()
            if identity[0] == "party":
                resolved_party_ids[identity[1]] = entity_id
            created += 1

        version_after = bump_state_version(conn) if created else version_before
        readback = _exact_readback(conn, analysis=analysis)
        audit_events = []
        if applied_audit_ids:
            placeholders = ",".join("?" for _ in applied_audit_ids)
            audit_events = [
                dict(row)
                for row in conn.execute(
                    f"SELECT * FROM audit_events WHERE id IN ({placeholders}) ORDER BY id",
                    tuple(applied_audit_ids),
                )
            ]
            if len(audit_events) != created:
                raise ValueError("bundle audit readback count does not match applied resources")
        conn.execute("COMMIT")
    except Exception:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise

    return {
        "schema_version": BUNDLE_RESULT_CONTRACT,
        "status": "applied" if created else "already_satisfied",
        "source_id": analysis.source_id,
        "input_summary": analysis.input_summary,
        "dependency_graph_digest": analysis.dependency_graph["digest"],
        "operations_digest": analysis.operations_digest,
        "applied_count": created,
        "already_satisfied_count": len(analysis.operations) - created,
        "state_version_before": version_before,
        "state_version": version_after,
        "readback": readback,
        "audit_events": audit_events,
    }
