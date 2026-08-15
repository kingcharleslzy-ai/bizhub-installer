from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    config = tmp_path / "company.json"
    config.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "profile_id": "sample-company",
                "legal_name": "Sample Company Ltd.",
                "display_name": "Sample Company",
                "brand_mark": "SC",
                "timezone": "Asia/Shanghai",
                "currency": "CNY",
            }
        ),
        encoding="utf-8",
    )
    secret = tmp_path / "secret-key"
    secret.write_bytes(b"a" * 48)
    monkeypatch.setenv("BIZHUB_COMPANY_CONFIG", str(config))
    monkeypatch.setenv("BIZHUB_SECRET_KEY_FILE", str(secret))
    monkeypatch.setenv("BIZHUB_DATABASE_PATH", str(tmp_path / "bizhub.db"))
    monkeypatch.setenv("BIZHUB_COOKIE_SECURE", "0")
    monkeypatch.setenv("BIZHUB_STATIC_DIR", str(tmp_path / "missing-static"))
    monkeypatch.delenv("BIZHUB_EXTENSION_MODULES", raising=False)
    monkeypatch.setenv("BIZHUB_CORE_COMMIT", "development")

    from bizhub import config as config_module

    config_module.company_profile.cache_clear()
    from bizhub.manage import initialize_admin

    initialize_admin("admin", "correct horse battery staple")
    import bizhub.main as main_module

    importlib.reload(main_module)
    with TestClient(main_module.app) as test_client:
        response = test_client.post(
            "/api/auth/login",
            headers={"X-BizHub-Request": "1"},
            json={"username": "admin", "password": "correct horse battery staple"},
        )
        assert response.status_code == 200
        yield test_client
    config_module.company_profile.cache_clear()


@pytest.fixture()
def api(client: TestClient):
    def request(method: str, path: str, **kwargs):
        headers = dict(kwargs.pop("headers", {}))
        if method.lower() in {"post", "put", "patch", "delete"}:
            headers["X-BizHub-Request"] = "1"
        return client.request(method, path, headers=headers, **kwargs)

    return request
