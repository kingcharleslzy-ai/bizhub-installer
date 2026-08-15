from __future__ import annotations

from bizhub.modules import BUILTIN_MODULES, KERNEL_CAPABILITIES, list_module_manifests, system_map


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


def test_system_map_exposes_governed_build_time_modules():
    payload = system_map()
    assert payload["schema_version"] == "bizhub.system-map.v1"
    assert payload["architecture"] == "stable_kernel_with_build_time_modules"
    assert payload["modules"] == list_module_manifests()
    assert payload["extension_policy"] == {
        "customer_code_location": "customer_private_repository",
        "activation": "build_time_only",
        "hot_install_or_unload": False,
        "may_override_kernel": False,
        "formal_writes": "module_owner_preview_apply_readback",
        "mcp_direct_sql": False,
        "production_self_modification": False,
    }
    for module in payload["modules"]:
        assert module["governance"]["preview_required"] is True
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
