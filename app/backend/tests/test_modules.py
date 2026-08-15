from __future__ import annotations

import importlib
import sys
from types import ModuleType

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient

from bizhub.extensions import load_extension_modules
from bizhub.modules import (
    BUILTIN_MODULES,
    KERNEL_CAPABILITIES,
    ModuleManifest,
    list_module_manifests,
    register_extension_manifests,
    reset_runtime_modules,
    system_map,
)


def test_builtin_module_graph_is_closed_and_acyclic():
    modules = {module.module_id: module for module in BUILTIN_MODULES}
    assert len(modules) == len(BUILTIN_MODULES)
    assert set(KERNEL_CAPABILITIES) >= {
        "single_company_profile",
        "sqlite_transaction_boundary",
        "preview_apply_readback",
        "immutable_audit_log",
        "module_registry",
    }

    visited: set[str] = set()
    active: set[str] = set()

    def visit(module_id: str):
        assert module_id not in active
        if module_id in visited:
            return
        active.add(module_id)
        for dependency in modules[module_id].dependencies:
            assert dependency in modules
            visit(dependency)
        active.remove(module_id)
        visited.add(module_id)

    for module_id in modules:
        visit(module_id)


def test_system_map_exposes_governed_build_time_modules(monkeypatch):
    monkeypatch.setenv("BIZHUB_CORE_COMMIT", "development")
    payload = system_map()
    assert payload["schema_version"] == "bizhub.system-map.v1"
    assert payload["architecture"] == "stable_kernel_with_build_time_modules"
    assert payload["core_identity"] == {"version": payload["application_version"], "source_commit": "development"}
    assert payload["modules"] == list_module_manifests()
    assert payload["extension_policy"] == {
        "customer_code_location": "customer_private_repository",
        "activation": "build_time_only",
        "hot_install_or_unload": False,
        "may_override_kernel": False,
        "formal_writes": "module_owner_preview_apply_readback",
        "first_external_stage": "read_only_build_time_module",
        "mcp_direct_sql": False,
        "production_self_modification": False,
    }
    for module in payload["modules"]:
        assert module["governance"]["preview_required"] is (module["governance"]["formal_writer"] != "none")
        assert module["governance"]["readback_required"] is True
        assert module["governance"]["direct_sql_via_mcp"] is False


def test_authenticated_module_map_api(api):
    response = api("get", "/api/system/modules")
    assert response.status_code == 200
    payload = response.json()
    assert [module["module_id"] for module in payload["modules"]] == [
        "master_data",
        "inventory",
        "sales",
        "procurement",
        "data_import",
    ]


def extension_manifest(**overrides):
    value = {
        "schema_version": "bizhub.module-manifest.v1",
        "module_id": "customer.sample.reference",
        "display_name": "Reference status",
        "module_version": "0.1.0",
        "source": "customer_private",
        "kind": "experience",
        "api_prefix": "/api/extensions/reference",
        "dependencies": ["master_data"],
        "provides_capabilities": ["reference_status"],
        "requires_capabilities": ["party_catalog"],
        "owns_entities": [],
        "ui_sections": [],
        "read_apis": ["/api/extensions/reference/status"],
        "actions": [],
        "import_resources": [],
        "governance": {
            "formal_writer": "none",
            "preview_required": False,
            "readback_required": True,
            "direct_sql_via_mcp": False,
            "runtime_activation": "build_time",
        },
    }
    value.update(overrides)
    return value


def extension_module(name: str, *, method: str = "get", manifest=None) -> ModuleType:
    module = ModuleType(name)
    module.get_manifest = lambda: manifest or extension_manifest()

    def build_router():
        router = APIRouter()

        async def status():
            return {"status": "ok", "formal_business_data_connected": False}

        getattr(router, method)("/api/extensions/reference/status")(status)
        return router

    module.build_router = build_router
    return module


def test_extension_loader_accepts_one_manifest_bound_read_only_router(monkeypatch):
    module = extension_module("test_reference_extension")
    monkeypatch.setitem(sys.modules, module.__name__, module)
    loaded = load_extension_modules(module.__name__)
    assert len(loaded) == 1
    assert loaded[0].manifest.module_id == "customer.sample.reference"
    assert [route.path for route in loaded[0].router.routes] == ["/api/extensions/reference/status"]


def test_extension_loader_rejects_mutation_route(monkeypatch):
    module = extension_module("test_write_extension", method="post")
    monkeypatch.setitem(sys.modules, module.__name__, module)
    with pytest.raises(RuntimeError, match="only GET or HEAD"):
        load_extension_modules(module.__name__)


def test_read_only_manifest_rejects_owned_entities():
    with pytest.raises(ValueError, match="cannot own writes"):
        ModuleManifest.model_validate(extension_manifest(owns_entities=["private_fact"]))


def test_registry_rejects_overlapping_extension_prefixes():
    first = ModuleManifest.model_validate(extension_manifest())
    second = ModuleManifest.model_validate(
        extension_manifest(
            module_id="customer.sample.reference_detail",
            api_prefix="/api/extensions/reference/detail",
            provides_capabilities=["reference_detail_status"],
            read_apis=["/api/extensions/reference/detail/status"],
        )
    )
    try:
        with pytest.raises(RuntimeError, match="API prefixes overlap"):
            register_extension_manifests((first, second))
    finally:
        reset_runtime_modules()


def test_main_mounts_extension_behind_core_authentication(client, monkeypatch):
    module = extension_module("test_mounted_extension")
    monkeypatch.setitem(sys.modules, module.__name__, module)
    monkeypatch.setenv("BIZHUB_EXTENSION_MODULES", module.__name__)

    import bizhub.main as main_module

    reloaded = importlib.reload(main_module)
    with TestClient(reloaded.app) as extension_client:
        assert extension_client.get("/api/extensions/reference/status").status_code == 401
        login = extension_client.post(
            "/api/auth/login",
            headers={"X-BizHub-Request": "1"},
            json={"username": "admin", "password": "correct horse battery staple"},
        )
        assert login.status_code == 200
        status = extension_client.get("/api/extensions/reference/status")
        assert status.status_code == 200
        assert status.json()["formal_business_data_connected"] is False
        module_map = extension_client.get("/api/system/modules").json()
        assert module_map["modules"][-1]["module_id"] == "customer.sample.reference"

    monkeypatch.delenv("BIZHUB_EXTENSION_MODULES")
    importlib.reload(main_module)
