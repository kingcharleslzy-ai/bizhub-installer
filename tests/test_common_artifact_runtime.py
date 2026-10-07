from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tarfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_vendored_common_artifact_matches_manifest_and_has_safe_paths() -> None:
    artifact = ROOT / "app/vendor/bizhub-common.tar.gz"
    manifest = json.loads(
        (ROOT / "app/vendor/bizhub-common-manifest.json").read_text(encoding="utf-8")
    )
    assert hashlib.sha256(artifact.read_bytes()).hexdigest() == manifest["artifact_sha256"]
    assert manifest["core_artifact_digest"] == f"sha256:{manifest['artifact_sha256']}"
    assert manifest["deterministic_rebuild_equal"] is True
    with tarfile.open(artifact, "r:gz") as archive:
        names = archive.getnames()
    assert names == sorted(names)
    assert all(not Path(name).is_absolute() and ".." not in Path(name).parts for name in names)


def test_current_common_and_delivery_runtime_contain_no_private_profile_identity() -> None:
    findings: list[str] = []
    with tarfile.open(ROOT / "app/vendor/bizhub-common.tar.gz", "r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            extracted = archive.extractfile(member)
            assert extracted is not None
            text = extracted.read().decode("utf-8")
            if "daz" + "heng" in text.casefold():
                findings.append(member.name)
    for path in sorted((ROOT / "app/runtime").rglob("*.py")):
        if "daz" + "heng" in path.read_text(encoding="utf-8").casefold():
            findings.append(str(path.relative_to(ROOT)))
    assert findings == []


def test_public_delivery_runs_the_vendored_common_owner(tmp_path: Path) -> None:
    common = tmp_path / "common"
    common.mkdir()
    with tarfile.open(ROOT / "app/vendor/bizhub-common.tar.gz", "r:gz") as archive:
        archive.extractall(common, filter="data")
    manifest_path = tmp_path / "bizhub-common-manifest.json"
    manifest_path.write_bytes((ROOT / "app/vendor/bizhub-common-manifest.json").read_bytes())
    config = tmp_path / "config"
    data = tmp_path / "data"
    config.mkdir()
    data.mkdir()
    (config / "company.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "profile_id": "synthetic-public",
                "legal_name": "Synthetic Company",
                "display_name": "Synthetic",
                "brand_mark": "S",
                "timezone": "UTC",
                "currency": "USD",
                "data_identity": "deployment:synthetic-public",
                "data_authority_mode": "cloud",
                "authority_epoch": 1,
                "writer_instance_id": "deployment-writer:synthetic-public",
            }
        ),
        encoding="utf-8",
    )
    (config / "secret-key").write_text("s" * 64, encoding="utf-8")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    environment = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join([str(ROOT / "app/runtime"), str(common)]),
        "BIZHUB_COMMON_ROOT": str(common),
        "BIZHUB_COMMON_MANIFEST": str(manifest_path),
        "BIZHUB_CORE_ARTIFACT_DIGEST": manifest["core_artifact_digest"],
        "BIZHUB_GENERIC_DATABASE_PATH": str(data / "bizhub.db"),
        "BIZHUB_ADMIN_CONFIG": str(data / "admin.json"),
        "BIZHUB_COMPANY_CONFIG": str(config / "company.json"),
        "BIZHUB_SECRET_KEY_FILE": str(config / "secret-key"),
        "BIZHUB_COOKIE_SECURE": "0",
    }
    for name in ("BIZHUB_GENERIC_AI_BASE_URL", "BIZHUB_GENERIC_AI_MODEL", "OPENAI_API_KEY"):
        environment.pop(name, None)
    script = r'''
from fastapi.testclient import TestClient
from bizhub.main import app
from bizhub.manage import initialize_admin, verify

initialize_admin("admin", "correct horse battery staple")
with TestClient(app) as client:
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["profile_id"] == "generic-kernel-smoke"
    assert health.json()["company_profile_id"] == "synthetic-public"
    assert health.json()["core_artifact_digest"].startswith("sha256:")
    assert client.get("/api/system-map").status_code == 401
    assert client.get("/api/sales/agent/sources").status_code == 401
    login = client.post(
        "/api/auth/login",
        headers={"X-BizHub-Request": "1"},
        json={"username": "admin", "password": "correct horse battery staple"},
    )
    assert login.status_code == 200
    system_map = client.get("/api/system-map").json()
    assert system_map["profile_id"] == "generic-kernel-smoke"
    assert system_map["core_artifact_digest"] == health.json()["core_artifact_digest"]
    onboarding = client.get("/api/workspace-onboarding/state")
    assert onboarding.status_code == 200
    assert onboarding.json()["workspace_id"] == "deployment:synthetic-public"
    assert onboarding.json()["stage"] == "workspace_ready"
    assert onboarding.json()["accepts_business_material"] is False
    blocked = client.get("/api/delivery/overview")
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "workspace_onboarding_required"
    cobuild_blocked = client.get("/api/workspace-cobuild/state")
    assert cobuild_blocked.status_code == 409
    assert cobuild_blocked.json()["detail"]["code"] == "workspace_onboarding_required"
    agent_blocked = client.get("/api/sales/agent/sources")
    assert agent_blocked.status_code == 409
    assert agent_blocked.json()["detail"]["code"] == "workspace_onboarding_required"
    entered = client.post(
        "/api/workspace-onboarding/enter",
        headers={"X-BizHub-Request": "1"},
        json={
            "schema_version": "bizhub.workspace-onboarding-state.v1",
            "expected_revision": 1,
            "idempotency_key": "synthetic-public-enter-0001",
        },
    )
    assert entered.status_code == 200
    assert entered.json()["stage"] == "enterprise_context_ready"
    assert entered.json()["accepts_business_material"] is True
    cobuild = client.get("/api/workspace-cobuild/state")
    assert cobuild.status_code == 200
    assert cobuild.json()["next_question"]["question_id"] == "priority_goal"
    assert cobuild.json()["system_candidate"]["status"] == "collecting"
    assert set(cobuild.json()["system_candidate"]["safety"].values()) == {False}
    answer = client.post(
        "/api/workspace-cobuild/answers",
        headers={"X-BizHub-Request": "1"},
        json={
            "schema_version": "bizhub.workspace-cobuild-state.v1",
            "expected_revision": 0,
            "question_id": "priority_goal",
            "text": "先整理销售订单和库存遗漏",
            "answer_kind": "answered",
            "actor_ref": "desktop:authenticated-admin",
            "idempotency_key": "synthetic-public-answer-0001",
        },
    )
    assert answer.status_code == 200
    assert answer.json()["first_value_candidate"]["business_write_authorized"] is False
    assert answer.json()["first_value_candidate"]["module_activation_authorized"] is False
    assert {
        item["capability_id"]
        for item in answer.json()["system_candidate"]["reusable_capabilities"]
    } >= {"order-flow-foundation", "inventory-and-warehouse"}
    remaining = [
        ("available_material", "每天使用的订单表格"),
        ("actual_process", "销售接单后交给仓库发货，负责人检查完成"),
        ("main_exception", "客户名称不一致时容易匹配错"),
        ("responsible_role", "销售负责人最终确认"),
    ]
    for revision, (question_id, text) in enumerate(remaining, start=1):
        response = client.post(
            "/api/workspace-cobuild/answers",
            headers={"X-BizHub-Request": "1"},
            json={
                "schema_version": "bizhub.workspace-cobuild-state.v1",
                "expected_revision": revision,
                "question_id": question_id,
                "text": text,
                "answer_kind": "answered",
                "actor_ref": "desktop:authenticated-admin",
                "idempotency_key": f"synthetic-public-answer-{revision + 1:04d}",
            },
        )
        assert response.status_code == 200
    material = client.post(
        "/api/workspace-cobuild/materials",
        headers={"X-BizHub-Request": "1"},
        json={
            "schema_version": "bizhub.workspace-cobuild-state.v1",
            "expected_revision": 5,
            "material_kind": "spreadsheet",
            "display_name": "日常订单表.xlsx",
            "summary": "表格包含客户、商品、数量、库存和发货日期。",
            "source_ref": "desktop:synthetic-public-material-0001",
            "provided_by": "desktop:authenticated-admin",
            "idempotency_key": "synthetic-public-material-0001",
        },
    )
    assert material.status_code == 200
    system_candidate = material.json()["system_candidate"]
    assert system_candidate["status"] == "candidate_review_required"
    assert all(item["status"] == "ready" for item in system_candidate["requirements"])
    assert set(system_candidate["safety"].values()) == {False}
    handoff = client.get("/api/workspace-cobuild/handoff")
    assert handoff.status_code == 200
    assert handoff.json()["read_only"] is True
    assert handoff.json()["system_candidate"] == system_candidate
    assert handoff.json()["successor_must_revalidate"] == [
        "workspace", "profile", "release", "permissions", "evidence_refs"
    ]
    drafts = [
        {"resource_kind": "party", "resource_id": "supplier-1", "canonical_name": "Supplier One"},
        {"resource_kind": "party", "resource_id": "customer-1", "canonical_name": "Customer One"},
        {"resource_kind": "product", "resource_id": "product-1", "canonical_name": "Product One"},
        {"resource_kind": "unit", "resource_id": "kg", "canonical_name": "Kilogram"},
        {"resource_kind": "location", "resource_id": "warehouse-1", "canonical_name": "Warehouse One"},
    ]
    preview = client.post(
        "/api/master-data/catalog/preview",
        headers={"X-BizHub-Request": "1"},
        json={"drafts": drafts},
    ).json()
    applied = client.post(
        "/api/master-data/catalog/apply",
        headers={"X-BizHub-Request": "1"},
        json=preview,
    ).json()
    assert applied["owner_ref"] == "master_data:catalog-owner"
    replay = client.post(
        "/api/master-data/catalog/apply",
        headers={"X-BizHub-Request": "1"},
        json=preview,
    ).json()
    assert replay["disposition"] == "idempotent_noop"
    agent_headers = {"X-BizHub-Request": "1"}
    source_text = "客户 Customer One 订 3 kg Product One，从 Warehouse One 发货，外箱要贴标签。"
    source_extra = {
        "channel": "synthetic",
        "attachments": [
            {"name": "label-preview.png", "meta": {"unfamiliar_field": [1, 2, {"x": None}]}}
        ],
    }
    source_payload = {
        "source_ref": "synthetic-public-sales-source-0001",
        "text": source_text,
        "business_at": "2026-10-07T09:00:00+00:00",
        "extra": source_extra,
    }
    unprepared = client.post("/api/sales/agent/sources", headers=agent_headers, json=source_payload)
    assert unprepared.status_code == 503, unprepared.text
    assert unprepared.json()["detail"]["code"] == "sales_agent_ai_unavailable"
    agent_source_id = unprepared.json()["detail"]["source_id"]
    assert agent_source_id
    source_state = client.get(f"/api/sales/agent/sources/{agent_source_id}")
    assert source_state.status_code == 200, source_state.text
    assert source_state.json()["source_id"] == agent_source_id
    assert source_state.json()["status"] == "received"
    assert source_state.json()["source_ref"] == source_payload["source_ref"]
    assert source_state.json()["text"] == source_text
    assert source_state.json()["extra"] == source_extra
    assert source_state.json()["proposal"] is None
    sources_listed = client.get("/api/sales/agent/sources")
    assert sources_listed.status_code == 200
    assert [item["source_id"] for item in sources_listed.json()["items"]] == [agent_source_id]
    resent = client.post("/api/sales/agent/sources", headers=agent_headers, json=source_payload)
    assert resent.status_code == 503, resent.text
    assert resent.json()["detail"]["source_id"] == agent_source_id
    assert (
        client.get(f"/api/sales/agent/sources/{agent_source_id}").json()["status"] == "received"
    )
    procurement_command = {
        "action": "create",
        "idempotency_key": "public-runtime-procurement-write-0001",
        "order_id": "po-public-0001",
        "supplier_party_id": "supplier-1",
        "ordered_at": "2026-10-07T08:00:00+00:00",
        "lines": [
            {
                "line_id": "po-public-0001-l1",
                "product_id": "product-1",
                "unit_id": "kg",
                "quantity": "5",
                "receive_location_id": "warehouse-1",
            }
        ],
        "target_line_id": "",
        "quantity": "",
        "occurred_at": "",
        "source_ref": "synthetic-public-manual-procurement",
        "evidence_refs": ["manual:po-public-0001"],
        "reason": "",
    }
    procurement_preview = client.post(
        "/api/procurement/preview", headers=agent_headers, json=procurement_command
    )
    assert procurement_preview.status_code == 200, procurement_preview.text
    procurement_applied = client.post(
        "/api/procurement/apply", headers=agent_headers, json=procurement_preview.json()
    )
    assert procurement_applied.status_code == 200, procurement_applied.text
    procurement_replay = client.post(
        "/api/procurement/apply", headers=agent_headers, json=procurement_preview.json()
    )
    assert procurement_replay.json()["disposition"] == "idempotent_noop"
    sales_command = {
        "action": "create",
        "idempotency_key": "public-runtime-sales-write-0001",
        "order_id": "so-public-0001",
        "customer_party_id": "customer-1",
        "ordered_at": "2026-10-07T08:30:00+00:00",
        "lines": [
            {
                "line_id": "so-public-0001-l1",
                "product_id": "product-1",
                "unit_id": "kg",
                "quantity": "3",
                "ship_from_location_id": "warehouse-1",
            }
        ],
        "target_line_id": "",
        "quantity": "",
        "occurred_at": "",
        "source_ref": "synthetic-public-manual-sale",
        "evidence_refs": ["manual:so-public-0001"],
        "reason": "",
    }
    sales_preview = client.post("/api/sales/preview", headers=agent_headers, json=sales_command)
    assert sales_preview.status_code == 200, sales_preview.text
    sales_applied = client.post("/api/sales/apply", headers=agent_headers, json=sales_preview.json())
    assert sales_applied.status_code == 200, sales_applied.text
    sales_replay = client.post("/api/sales/apply", headers=agent_headers, json=sales_preview.json())
    assert sales_replay.json()["disposition"] == "idempotent_noop"
    sales_orders_listed = client.get("/api/sales/orders")
    assert sales_orders_listed.status_code == 200
    assert [order["order_id"] for order in sales_orders_listed.json()["items"]] == ["so-public-0001"]
assert verify()["status"] == "ok"
'''
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout


def test_container_activates_delivery_adapter_without_legacy_core() -> None:
    dockerfile = (ROOT / "app/Dockerfile").read_text(encoding="utf-8")
    assert "COPY vendor/bizhub-common.tar.gz" in dockerfile
    assert "COPY runtime/bizhub ./bizhub" in dockerfile
    assert "COPY backend/bizhub" not in dockerfile
    assert not (ROOT / "app/backend/bizhub").exists()
