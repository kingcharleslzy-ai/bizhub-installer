#!/usr/bin/env python3
from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import pty
import secrets
import sqlite3
import subprocess
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener


def run(command: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, check=True, text=True, capture_output=True)


def install_with_tty(repo: Path, plan: Path, plan_hash: str, password: str) -> str:
    pid, descriptor = pty.fork()
    if pid == 0:
        os.chdir(repo)
        os.execv(str(repo / "bizhubctl"), [str(repo / "bizhubctl"), "install", "--plan", str(plan), "--approve", plan_hash])
    output = bytearray()
    sent_first = False
    sent_second = False
    while True:
        try:
            chunk = os.read(descriptor, 4096)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
        rendered = output.decode(errors="replace")
        if "Administrator password:" in rendered and not sent_first:
            os.write(descriptor, (password + "\n").encode()); sent_first = True
        if "Repeat administrator password:" in rendered and not sent_second:
            os.write(descriptor, (password + "\n").encode()); sent_second = True
    _, status = os.waitpid(pid, 0)
    os.close(descriptor)
    text = output.decode(errors="replace")
    if password in text:
        raise RuntimeError("TTY unexpectedly echoed the administrator password")
    if os.waitstatus_to_exitcode(status) != 0:
        raise RuntimeError("interactive installation failed: " + text[-4000:])
    return text


class Api:
    def __init__(self, base: str, username: str, password: str):
        self.base = base.rstrip("/")
        self.opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.call("/api/auth/login", {"username": username, "password": password})

    def call(self, path: str, payload: dict | None = None, expected: int = 200):
        body = json.dumps(payload).encode() if payload is not None else None
        request = Request(self.base + path, data=body, method="POST" if body is not None else "GET")
        request.add_header("Accept", "application/json")
        if body is not None:
            request.add_header("Content-Type", "application/json")
            request.add_header("X-BizHub-Request", "1")
        try:
            with self.opener.open(request, timeout=10) as response:
                status = response.status; result = json.loads(response.read())
        except HTTPError as exc:
            status = exc.code; result = json.loads(exc.read())
        if status != expected:
            raise AssertionError(f"{path}: expected {expected}, got {status}: {result}")
        return result

    def apply(self, action: str, data: dict):
        preview = self.call("/api/actions/preview", {"action": action, "data": data})
        return self.call("/api/actions/apply", {"action": action, "data": data, "preview_token": preview["preview_token"], "review_note": "confirmed synthetic E2E action"})


def inventory_quantity(api: Api) -> str:
    return api.call(
        "/api/inventory/balance?product_id=product-1&unit_id=kg&location_id=warehouse-1"
    )["quantity"]


def apply_inventory_inbound(api: Api, key: str, quantity: str) -> dict:
    command = {
        "action": "inbound",
        "idempotency_key": key,
        "product_id": "product-1",
        "unit_id": "kg",
        "quantity": quantity,
        "from_location_id": None,
        "to_location_id": "warehouse-1",
        "target_movement_id": None,
        "actual_quantity": None,
        "occurred_at": "2026-08-23T13:00:00+00:00",
        "source_ref": f"synthetic:{key}",
        "reason": "synthetic lifecycle mutation",
    }
    preview = api.call("/api/inventory/preview", command)
    return api.call("/api/inventory/apply", preview)


def assert_effective_cgroup_limits(plan: Path) -> None:
    approved = json.loads(plan.read_text(encoding="utf-8"))
    limits = approved["instance"]["resource_limits"]
    pid = int(run(["docker", "inspect", "-f", "{{.State.Pid}}", "bizhub"]).stdout.strip())
    memberships = Path(f"/proc/{pid}/cgroup").read_text(encoding="utf-8").splitlines()
    unified = [line.partition("::")[2] for line in memberships if line.startswith("0::")]
    assert len(unified) == 1 and unified[0].startswith("/")
    root = Path("/sys/fs/cgroup").resolve(strict=True)
    group = (root / unified[0].lstrip("/")).resolve(strict=True)
    assert group == root or root in group.parents
    memory = (group / "memory.max").read_text(encoding="utf-8").strip()
    swap = (group / "memory.swap.max").read_text(encoding="utf-8").strip()
    cpu = (group / "cpu.max").read_text(encoding="utf-8").strip().split()
    pids = (group / "pids.max").read_text(encoding="utf-8").strip()
    assert memory == str(limits["memory_mib"] * 1024 * 1024)
    assert swap == str(limits["swap_mib"] * 1024 * 1024)
    assert len(cpu) == 2 and cpu[0] != "max"
    assert int(cpu[0]) * 1000 == int(cpu[1]) * limits["cpu_millicores"]
    assert pids == str(limits["pids_limit"])


def exercise_business_flow(api: Api) -> None:
    drafts = [
        {"resource_kind": "party", "resource_id": "supplier-1", "canonical_name": "Supplier One"},
        {"resource_kind": "party", "resource_id": "customer-1", "canonical_name": "Customer One"},
        {"resource_kind": "product", "resource_id": "product-1", "canonical_name": "Product One"},
        {"resource_kind": "unit", "resource_id": "kg", "canonical_name": "Kilogram"},
        {"resource_kind": "location", "resource_id": "warehouse-1", "canonical_name": "Warehouse One"},
    ]
    catalog_preview = api.call("/api/master-data/catalog/preview", {"drafts": drafts})
    catalog = api.call("/api/master-data/catalog/apply", catalog_preview)
    assert catalog["owner_ref"] == "master_data:catalog-owner"
    assert api.call("/api/master-data/catalog/apply", catalog_preview)["disposition"] == "idempotent_noop"

    def apply_typed(path: str, command: dict) -> tuple[dict, dict]:
        preview = api.call(f"{path}/preview", command)
        return preview, api.call(f"{path}/apply", preview)

    _, purchase = apply_typed("/api/procurement", {
        "action": "create", "idempotency_key": "po-create", "order_id": "po-1",
        "supplier_party_id": "supplier-1", "ordered_at": "2026-08-23T08:00:00+00:00",
        "lines": [{"line_id": "po-line-1", "product_id": "product-1", "unit_id": "kg", "quantity": "10", "receive_location_id": "warehouse-1"}],
        "source_ref": "synthetic:procurement", "evidence_refs": ["evidence:po-1"],
    })
    assert purchase["owner_ref"] == "procurement:order-owner"
    _, received = apply_typed("/api/procurement", {
        "action": "receive", "idempotency_key": "po-receive", "order_id": "po-1",
        "target_line_id": "po-line-1", "quantity": "10", "occurred_at": "2026-08-23T09:00:00+00:00",
        "source_ref": "synthetic:procurement", "evidence_refs": ["evidence:po-1"],
    })
    assert received["order"]["status"] == "received"

    _, sale = apply_typed("/api/sales", {
        "action": "create", "idempotency_key": "so-create", "order_id": "so-1",
        "customer_party_id": "customer-1", "ordered_at": "2026-08-23T10:00:00+00:00",
        "lines": [{"line_id": "so-line-1", "product_id": "product-1", "unit_id": "kg", "quantity": "10", "ship_from_location_id": "warehouse-1"}],
        "source_ref": "synthetic:sales", "evidence_refs": ["evidence:so-1"],
    })
    assert sale["owner_ref"] == "sales:order-owner"
    shipped_preview, shipped = apply_typed("/api/sales", {
        "action": "fulfill", "idempotency_key": "so-ship", "order_id": "so-1",
        "target_line_id": "so-line-1", "quantity": "6", "occurred_at": "2026-08-23T11:00:00+00:00",
        "source_ref": "synthetic:sales", "evidence_refs": ["evidence:so-1"],
    })
    assert shipped["order"]["status"] == "partially_fulfilled"
    _, returned = apply_typed("/api/sales", {
        "action": "return", "idempotency_key": "so-return", "order_id": "so-1",
        "target_line_id": "so-line-1", "quantity": "2", "occurred_at": "2026-08-23T12:00:00+00:00",
        "source_ref": "synthetic:sales", "evidence_refs": ["evidence:so-1"],
    })
    assert returned["order"]["status"] == "partially_returned"
    assert api.call("/api/sales/apply", shipped_preview)["disposition"] == "idempotent_noop"
    assert inventory_quantity(api) == "6"


def assert_reconciled_master_data(api: Api) -> None:
    catalog = api.call("/api/resources/catalog")
    party = next(item for item in catalog["parties"] if item["canonical_name"] == "Reconciled E2E Party")
    assert party["legal_name"] == "Reconciled E2E Party Limited"
    assert party["roles"] == ["customer", "supplier"]
    assert party["status"] == "active"
    mappings = api.call(
        "/api/external-records?source_id=e2e-master-data&resource_type=party&limit=10"
    )["items"]
    mapping = next(item for item in mappings if item["external_id"] == "party-1")
    assert mapping["entity_id"] == party["id"]
    assert len(mapping["payload_digest"]) == 64

    successor = next(item for item in catalog["parties"] if item["canonical_name"] == "Current E2E Successor")
    predecessor = next(item for item in catalog["parties"] if item["canonical_name"] == "Former E2E Identity")
    assert predecessor["status"] == "deprecated"
    assert predecessor["successor_party_id"] == successor["id"]
    assert successor["aliases"] == [{"id": 1, "alias": "Former E2E Identity", "status": "active"}]


def master_data_bundle_payload() -> dict:
    return {
        "source_id": "e2e-master-data-bundle",
        "resources": {
            "parties": [
                {
                    "external_id": "party:bundle-current",
                    "canonical_name": "Bundle Current E2E Party",
                    "roles": ["customer"],
                    "status": "active",
                },
                {
                    "external_id": "party:bundle-former",
                    "canonical_name": "Bundle Former E2E Party",
                    "roles": ["customer"],
                    "status": "deprecated",
                    "successor_party_external_id": "party:bundle-current",
                },
            ],
            "party_aliases": [
                {
                    "external_id": "party_alias:bundle-former",
                    "party_external_id": "party:bundle-current",
                    "alias": "Bundle Former E2E Party",
                    "status": "active",
                }
            ],
        },
    }


def assert_bundled_master_data(api: Api) -> None:
    mappings = api.call(
        "/api/external-records?source_id=e2e-master-data-bundle&limit=20"
    )["items"]
    assert len(mappings) == 3
    by_external_id = {item["external_id"]: item for item in mappings}
    catalog = api.call("/api/resources/catalog")
    current = next(item for item in catalog["parties"] if item["canonical_name"] == "Bundle Current E2E Party")
    former = next(item for item in catalog["parties"] if item["canonical_name"] == "Bundle Former E2E Party")
    assert by_external_id["party:bundle-current"]["entity_id"] == current["id"]
    assert by_external_id["party:bundle-former"]["entity_id"] == former["id"]
    assert former["successor_party_id"] == current["id"]
    assert any(item["alias"] == "Bundle Former E2E Party" for item in current["aliases"])


def exercise_master_data_bundle(api: Api) -> None:
    payload = master_data_bundle_payload()
    preview = api.call("/api/imports/master-data-bundle/preview", payload)
    assert preview["schema_version"] == "bizhub.master-data-bundle-preview.v1"
    assert preview["status"] == "ready"
    assert preview["input_summary"]["resource_counts"] == {"party": 2, "party_alias": 1}
    assert len(preview["dependency_graph"]["edges"]) == 2
    assert preview["operations"]["create_count"] == 3

    tampered = json.loads(json.dumps(payload))
    tampered["resources"]["party_aliases"][0]["alias"] = "Tampered Bundle Alias"
    api.call(
        "/api/imports/master-data-bundle/apply",
        {
            **tampered,
            "preview_token": preview["preview_token"],
            "review_note": "tampered synthetic bundle",
        },
        expected=409,
    )
    assert api.call(
        "/api/external-records?source_id=e2e-master-data-bundle&limit=20"
    )["items"] == []

    applied = api.call(
        "/api/imports/master-data-bundle/apply",
        {
            **payload,
            "preview_token": preview["preview_token"],
            "review_note": "confirmed synthetic dependency-aware bundle",
        },
    )
    assert applied["status"] == "applied"
    assert applied["applied_count"] == 3
    assert len(applied["readback"]) == 3
    assert len(applied["audit_events"]) == 3
    assert_bundled_master_data(api)

    replay_preview = api.call("/api/imports/master-data-bundle/preview", payload)
    assert replay_preview["status"] == "already_satisfied"
    replay = api.call(
        "/api/imports/master-data-bundle/apply",
        {
            **payload,
            "preview_token": replay_preview["preview_token"],
            "review_note": "confirmed synthetic dependency-aware bundle replay",
        },
    )
    assert replay["status"] == "already_satisfied"
    assert replay["applied_count"] == 0
    assert replay["state_version_before"] == replay["state_version"]
    assert replay["audit_events"] == []


def exercise_master_data_reconcile(api: Api) -> None:
    source_id = "e2e-master-data"
    original = [{
        "external_id": "party-1",
        "canonical_name": "Original E2E Party",
        "legal_name": "Original E2E Party Ltd.",
        "roles": ["customer"],
        "status": "active",
    }]
    imported = api.call(
        "/api/imports/json/preview",
        {"resource": "party", "source_id": source_id, "records": original},
    )
    applied_import = api.call(
        "/api/imports/apply",
        {
            "resource": "party",
            "source_id": source_id,
            "records": original,
            "preview_token": imported["preview_token"],
            "review_note": "confirmed synthetic master-data import",
        },
    )
    assert applied_import["applied_count"] == 1

    desired = [{
        **original[0],
        "canonical_name": "Reconciled E2E Party",
        "legal_name": "Reconciled E2E Party Limited",
        "roles": ["supplier", "customer"],
    }]
    preview = api.call(
        "/api/imports/reconcile/preview",
        {"resource": "party", "source_id": source_id, "records": desired},
    )
    assert preview["schema_version"] == "bizhub.master-data-reconcile-preview.v1"
    assert preview["status"] == "ready" and preview["ready_count"] == 1
    assert {item["field"] for item in preview["changes"][0]["field_diffs"]} == {
        "canonical_name", "legal_name", "roles",
    }

    tampered = [{**desired[0], "canonical_name": "Tampered E2E Party"}]
    api.call(
        "/api/imports/reconcile/apply",
        {
            "resource": "party",
            "source_id": source_id,
            "records": tampered,
            "preview_token": preview["preview_token"],
            "review_note": "tampered synthetic reconcile",
        },
        expected=409,
    )
    reconciled = api.call(
        "/api/imports/reconcile/apply",
        {
            "resource": "party",
            "source_id": source_id,
            "records": desired,
            "preview_token": preview["preview_token"],
            "review_note": "confirmed synthetic master-data reconcile",
        },
    )
    assert reconciled["status"] == "applied"
    assert reconciled["entities"][0]["readback"]["canonical_name"] == "Reconciled E2E Party"
    assert any(item["action"] == "reconcile:party" for item in api.call("/api/audit?limit=200"))
    replay = api.call(
        "/api/imports/reconcile/preview",
        {"resource": "party", "source_id": source_id, "records": desired},
    )
    assert replay["status"] == "already_satisfied"
    assert replay["changes"] == []

    current = [{
        "external_id": "party-successor",
        "canonical_name": "Current E2E Successor",
        "roles": ["customer"],
        "status": "active",
    }]
    current_preview = api.call(
        "/api/imports/json/preview",
        {"resource": "party", "source_id": source_id, "records": current},
    )
    api.call(
        "/api/imports/apply",
        {
            "resource": "party",
            "source_id": source_id,
            "records": current,
            "preview_token": current_preview["preview_token"],
            "review_note": "confirmed synthetic successor",
        },
    )
    mappings = api.call(
        "/api/external-records?source_id=e2e-master-data&resource_type=party&limit=10"
    )["items"]
    successor_id = next(item["entity_id"] for item in mappings if item["external_id"] == "party-successor")
    predecessor = [{
        "external_id": "party-predecessor",
        "canonical_name": "Former E2E Identity",
        "roles": ["customer"],
        "status": "deprecated",
        "successor_party_id": successor_id,
    }]
    predecessor_preview = api.call(
        "/api/imports/json/preview",
        {"resource": "party", "source_id": source_id, "records": predecessor},
    )
    api.call(
        "/api/imports/apply",
        {
            "resource": "party",
            "source_id": source_id,
            "records": predecessor,
            "preview_token": predecessor_preview["preview_token"],
            "review_note": "confirmed synthetic predecessor",
        },
    )
    alias = [{
        "external_id": "party-alias-predecessor",
        "party_id": successor_id,
        "alias": "Former E2E Identity",
        "status": "active",
    }]
    alias_preview = api.call(
        "/api/imports/json/preview",
        {"resource": "party_alias", "source_id": source_id, "records": alias},
    )
    api.call(
        "/api/imports/apply",
        {
            "resource": "party_alias",
            "source_id": source_id,
            "records": alias,
            "preview_token": alias_preview["preview_token"],
            "review_note": "confirmed synthetic predecessor alias",
        },
    )
    assert_reconciled_master_data(api)


def exercise_mcp(repo: Path, instance_url: str, password_file: Path) -> None:
    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "bizhub_instance_health", "arguments": {}}},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "bizhub_resource_query", "arguments": {"resource": "inventory"}}},
    ]
    environment = {**os.environ, "BIZHUB_INSTANCE_URL": instance_url, "BIZHUB_ADMIN_USERNAME": "admin", "BIZHUB_ADMIN_PASSWORD_FILE": str(password_file)}
    process = subprocess.run(["python3", str(repo / "plugins/bizhub-core/scripts/bizhub_mcp.py")], input="\n".join(json.dumps(item) for item in messages) + "\n", text=True, capture_output=True, check=True, env=environment)
    responses = [json.loads(line) for line in process.stdout.splitlines()]
    assert responses[1]["result"]["structuredContent"]["status"] == "ok"
    movements = responses[2]["result"]["structuredContent"]["items"]
    assert len(movements) == 3


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--plan-hash", required=True)
    parser.add_argument("--instance-url", required=True)
    args = parser.parse_args()
    password = secrets.token_urlsafe(30)
    output = install_with_tty(args.repo.resolve(), args.plan.resolve(), args.plan_hash, password)
    assert '"status": "installed"' in output
    run([str(args.repo / "bizhubctl"), "verify"], cwd=args.repo)
    assert_effective_cgroup_limits(args.plan.resolve())
    api = Api(args.instance_url, "admin", password)
    health = api.call("/api/health")
    common_manifest = json.loads(
        (args.repo / "app/vendor/bizhub-common-manifest.json").read_text(encoding="utf-8")
    )
    assert health["core_artifact_digest"] == common_manifest["core_artifact_digest"]
    exercise_business_flow(api)

    backup_result = json.loads(run([str(args.repo / "bizhubctl"), "backup", "--label", "e2e-restore"], cwd=args.repo).stdout)
    backup_path = Path(backup_result["host_path"])
    backup_manifest = Path(backup_result["manifest_host_path"])
    assert backup_manifest.is_file()
    apply_inventory_inbound(api, "post-backup", "2")
    assert inventory_quantity(api) == "8"
    run([str(args.repo / "bizhubctl"), "restore", "--backup", str(backup_path)], cwd=args.repo)
    api = Api(args.instance_url, "admin", password)
    assert inventory_quantity(api) == "6"
    run(["docker", "restart", "bizhub"])
    run([str(args.repo / "bizhubctl"), "verify"], cwd=args.repo)
    assert_effective_cgroup_limits(args.plan.resolve())
    api = Api(args.instance_url, "admin", password)
    assert inventory_quantity(api) == "6"

    password_file = Path("/tmp/bizhub-e2e-mcp-password")
    password_file.write_text(password + "\n", encoding="utf-8"); password_file.chmod(0o600)
    try:
        exercise_mcp(args.repo, args.instance_url, password_file)
    finally:
        password_file.unlink(missing_ok=True)

    host = urlparse(args.instance_url).hostname
    assert host
    original_plan = json.loads(args.plan.read_text(encoding="utf-8"))
    company = original_plan["company_profile"]
    update_plan = Path("/tmp/bizhub-update-plan.json")
    update_command = [
        str(args.repo / "bizhubctl"), "plan",
        "--access", original_plan["instance"]["access"],
        "--bind-address", original_plan["instance"]["bind_address"],
        "--profile-id", company["profile_id"],
        "--legal-name", company["legal_name"],
        "--display-name", company["display_name"],
        "--brand-mark", company["brand_mark"],
        "--timezone", company["timezone"],
        "--currency", company["currency"],
        "--admin-username", original_plan["administrator"]["username"],
        "--port", str(original_plan["instance"]["port"]),
        "--memory-mib", "768",
        "--output", str(update_plan),
    ]
    if original_plan["instance"]["access"] == "private" and not original_plan["instance"]["cookie_secure"]:
        update_command.append("--allow-http-private")
    if original_plan["instance"]["hostname"]:
        update_command.extend(["--hostname", original_plan["instance"]["hostname"]])
    run(update_command, cwd=args.repo)
    update_hash = json.loads(update_plan.read_text(encoding="utf-8"))["plan_hash"]
    updated = json.loads(run([
        str(args.repo / "bizhubctl"), "update",
        "--plan", str(update_plan),
        "--approve", update_hash,
    ], cwd=args.repo).stdout)
    assert updated["status"] == "updated"
    api = Api(args.instance_url, "admin", password)
    assert inventory_quantity(api) == "6"
    apply_inventory_inbound(api, "post-update", "1")
    assert inventory_quantity(api) == "7"
    rolled_back = json.loads(run([
        str(args.repo / "bizhubctl"), "rollback",
        "--approve", f"rollback:{update_hash}",
    ], cwd=args.repo).stdout)
    assert rolled_back["status"] == "rolled_back"
    api = Api(args.instance_url, "admin", password)
    assert inventory_quantity(api) == "6"
    assert_effective_cgroup_limits(args.plan.resolve())

    no_op = json.loads(run([str(args.repo / "bizhubctl"), "install", "--plan", str(args.plan), "--approve", args.plan_hash], cwd=args.repo).stdout)
    assert no_op["status"] == "no_op"
    update = json.loads(run([str(args.repo / "bizhubctl"), "update", "--plan", str(args.plan), "--approve", args.plan_hash], cwd=args.repo).stdout)
    assert update["status"] == "no_op"
    removed = json.loads(run([str(args.repo / "bizhubctl"), "uninstall", "--approve", f"retain-data:{args.plan_hash}"], cwd=args.repo).stdout)
    assert removed["status"] == "uninstalled_data_retained"
    assert Path("/var/lib/bizhub/data/bizhub.db").is_file()
    assert backup_path.is_file()
    assert backup_manifest.is_file()
    connection = sqlite3.connect("/var/lib/bizhub/data/bizhub.db")
    try:
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    finally:
        connection.close()
    print(json.dumps({"status": "passed", "release_commit": run(["git", "rev-parse", "HEAD"], cwd=args.repo).stdout.strip()}))


if __name__ == "__main__":
    main()
