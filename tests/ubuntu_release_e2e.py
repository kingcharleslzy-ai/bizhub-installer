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
    balances = api.call("/api/inventory")["balances"]
    assert len(balances) == 1
    return balances[0]["quantity"]


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
    supplier = api.apply("create_party", {"canonical_name": "Supplier E2E", "roles": ["supplier"]})["entity_id"]
    customer = api.apply("create_party", {"canonical_name": "Customer E2E", "roles": ["customer"]})["entity_id"]
    unit = api.apply("create_unit", {"code": "pcs", "display_name": "Pieces", "dimension": "count"})["entity_id"]
    second_unit = api.apply("create_unit", {"code": "kg", "display_name": "Kilogram", "dimension": "weight"})["entity_id"]
    product = api.apply("create_product", {"canonical_name": "Widget", "sku": "WIDGET-1", "unit_id": unit})["entity_id"]
    location = api.apply("create_location", {"code": "MAIN", "display_name": "Main Warehouse"})["entity_id"]

    purchase = api.apply("create_purchase_order", {"source_id": "e2e", "external_id": "po-1", "order_no": "PO-1", "supplier_id": supplier, "order_date": "2026-08-15", "lines": [{"product_id": product, "unit_id": unit, "quantity": "10"}]})
    purchase_line = purchase["readback"]["lines"][0]["id"]
    receipt = api.apply("receive_purchase", {"source_id": "e2e", "external_id": "receipt-1", "order_id": purchase["entity_id"], "location_id": location, "business_date": "2026-08-15", "lines": [{"line_id": purchase_line, "quantity": "6"}]})
    assert receipt["readback"]["lines"][0]["remaining_quantity"] == "4"

    sale = api.apply("create_sales_order", {"source_id": "e2e", "external_id": "so-1", "order_no": "SO-1", "customer_id": customer, "order_date": "2026-08-15", "lines": [{"product_id": product, "unit_id": unit, "quantity": "4"}]})
    sale_line = sale["readback"]["lines"][0]["id"]
    shipment = api.apply("ship_sale", {"source_id": "e2e", "external_id": "shipment-1", "order_id": sale["entity_id"], "location_id": location, "business_date": "2026-08-15", "lines": [{"line_id": sale_line, "quantity": "3"}]})
    assert shipment["readback"]["lines"][0]["remaining_quantity"] == "1"
    assert inventory_quantity(api) == "3"

    api.call("/api/actions/preview", {"action": "create_sales_order", "data": {"order_no": "BAD-UNIT", "customer_id": customer, "order_date": "2026-08-15", "lines": [{"product_id": product, "unit_id": second_unit, "quantity": "1"}]}}, expected=409)
    api.call("/api/actions/preview", {"action": "ship_sale", "data": {"order_id": sale["entity_id"], "location_id": location, "business_date": "2026-08-15", "lines": [{"line_id": sale_line, "quantity": "99"}]}}, expected=409)
    api.call("/api/imports/csv/preview", {"resource": "unit", "source_id": "bad", "csv_text": "code,display_name\npcs,Pieces\n"}, expected=409)

    pending = {"canonical_name": "Pending Product", "sku": "PENDING", "unit_id": unit}
    token = api.call("/api/actions/preview", {"action": "create_product", "data": pending})["preview_token"]
    api.call("/api/actions/apply", {"action": "create_product", "data": {**pending, "sku": "TAMPERED"}, "preview_token": token, "review_note": "tampered"}, expected=409)
    api.apply("create_location", {"code": "SECOND", "display_name": "Second Warehouse"})
    api.call("/api/actions/apply", {"action": "create_product", "data": pending, "preview_token": token, "review_note": "stale"}, expected=409)

    records = [{"external_id": "unit-box", "code": "box", "display_name": "Box", "dimension": "package"}]
    preview = api.call("/api/imports/json/preview", {"resource": "unit", "source_id": "e2e-import", "records": records})
    applied = api.call("/api/imports/apply", {"resource": "unit", "source_id": "e2e-import", "records": records, "preview_token": preview["preview_token"], "review_note": "confirmed synthetic import"})
    assert applied["applied_count"] == 1
    replay = api.call("/api/imports/json/preview", {"resource": "unit", "source_id": "e2e-import", "records": records})
    assert replay["already_satisfied_count"] == 1

    movement_id = shipment["readback"]["movement_ids"][0]
    api.apply("reverse_movement", {"movement_id": movement_id, "business_date": "2026-08-15", "note": "reverse synthetic shipment"})
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
    assert responses[2]["result"]["structuredContent"]["balances"][0]["quantity"] == "6"


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
    exercise_business_flow(api)
    exercise_master_data_reconcile(api)

    backup_result = json.loads(run([str(args.repo / "bizhubctl"), "backup", "--label", "e2e-restore"], cwd=args.repo).stdout)
    backup_path = Path(backup_result["host_path"])
    api.apply("post_inventory_adjustment", {"product_id": 1, "unit_id": 1, "location_id": 1, "quantity_delta": "2", "business_date": "2026-08-15", "note": "post-backup synthetic change"})
    assert inventory_quantity(api) == "8"
    run([str(args.repo / "bizhubctl"), "restore", "--backup", str(backup_path)], cwd=args.repo)
    api = Api(args.instance_url, "admin", password)
    assert inventory_quantity(api) == "6"
    assert_reconciled_master_data(api)
    run(["docker", "restart", "bizhub"])
    run([str(args.repo / "bizhubctl"), "verify"], cwd=args.repo)
    assert_effective_cgroup_limits(args.plan.resolve())
    api = Api(args.instance_url, "admin", password)
    assert inventory_quantity(api) == "6"
    assert_reconciled_master_data(api)

    password_file = Path("/tmp/bizhub-e2e-mcp-password")
    password_file.write_text(password + "\n", encoding="utf-8"); password_file.chmod(0o600)
    try:
        exercise_mcp(args.repo, args.instance_url, password_file)
    finally:
        password_file.unlink(missing_ok=True)

    no_op = json.loads(run([str(args.repo / "bizhubctl"), "install", "--plan", str(args.plan), "--approve", args.plan_hash], cwd=args.repo).stdout)
    assert no_op["status"] == "no_op"
    update = json.loads(run([str(args.repo / "bizhubctl"), "update", "--plan", str(args.plan), "--approve", args.plan_hash], cwd=args.repo).stdout)
    assert update["status"] == "no_op"
    removed = json.loads(run([str(args.repo / "bizhubctl"), "uninstall", "--approve", f"retain-data:{args.plan_hash}"], cwd=args.repo).stdout)
    assert removed["status"] == "uninstalled_data_retained"
    assert Path("/var/lib/bizhub/data/bizhub.db").is_file()
    assert backup_path.is_file()
    connection = sqlite3.connect("/var/lib/bizhub/data/bizhub.db")
    try:
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    finally:
        connection.close()
    print(json.dumps({"status": "passed", "release_commit": run(["git", "rev-parse", "HEAD"], cwd=args.repo).stdout.strip()}))


if __name__ == "__main__":
    main()
