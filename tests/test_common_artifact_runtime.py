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
