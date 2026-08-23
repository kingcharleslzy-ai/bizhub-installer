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


def test_container_activates_delivery_adapter_not_retained_legacy_core() -> None:
    dockerfile = (ROOT / "app/Dockerfile").read_text(encoding="utf-8")
    assert "COPY vendor/bizhub-common.tar.gz" in dockerfile
    assert "COPY runtime/bizhub ./bizhub" in dockerfile
    assert "COPY backend/bizhub" not in dockerfile
    assert (ROOT / "app/backend/bizhub").is_dir()
