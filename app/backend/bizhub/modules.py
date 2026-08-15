from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .contracts import ACTION_MODELS


MODULE_MANIFEST_VERSION = "bizhub.module-manifest.v1"
SYSTEM_MAP_VERSION = "bizhub.system-map.v1"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ActionBinding(StrictModel):
    action_id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    scope: str = Field(default="all", min_length=1, max_length=80)
    mode: Literal["owner_write"] = "owner_write"


class ModuleGovernance(StrictModel):
    formal_writer: Literal["module_owner", "delegated_owner"]
    preview_required: Literal[True] = True
    readback_required: Literal[True] = True
    direct_sql_via_mcp: Literal[False] = False
    runtime_activation: Literal["build_time"] = "build_time"


class ModuleManifest(StrictModel):
    schema_version: Literal["bizhub.module-manifest.v1"] = MODULE_MANIFEST_VERSION
    module_id: str = Field(pattern=r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
    display_name: str = Field(min_length=1, max_length=80)
    module_version: str = Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$")
    source: Literal["builtin", "customer_private"]
    kind: Literal["business", "integration", "experience"]
    dependencies: tuple[str, ...] = ()
    provides_capabilities: tuple[str, ...] = ()
    requires_capabilities: tuple[str, ...] = ()
    owns_entities: tuple[str, ...] = ()
    ui_sections: tuple[str, ...] = ()
    read_apis: tuple[str, ...] = ()
    actions: tuple[ActionBinding, ...] = ()
    import_resources: tuple[str, ...] = ()
    governance: ModuleGovernance


def _builtin(
    *,
    module_id: str,
    display_name: str,
    kind: Literal["business", "integration", "experience"],
    dependencies: tuple[str, ...] = (),
    provides: tuple[str, ...] = (),
    requires: tuple[str, ...] = (),
    entities: tuple[str, ...] = (),
    ui_sections: tuple[str, ...] = (),
    read_apis: tuple[str, ...] = (),
    actions: tuple[ActionBinding, ...] = (),
    import_resources: tuple[str, ...] = (),
    formal_writer: Literal["module_owner", "delegated_owner"] = "module_owner",
) -> ModuleManifest:
    return ModuleManifest(
        module_id=module_id,
        display_name=display_name,
        module_version=__version__,
        source="builtin",
        kind=kind,
        dependencies=dependencies,
        provides_capabilities=provides,
        requires_capabilities=requires,
        owns_entities=entities,
        ui_sections=ui_sections,
        read_apis=read_apis,
        actions=actions,
        import_resources=import_resources,
        governance=ModuleGovernance(formal_writer=formal_writer),
    )


BUILTIN_MODULES: tuple[ModuleManifest, ...] = (
    _builtin(
        module_id="master_data",
        display_name="Master data",
        kind="business",
        provides=("party_catalog", "product_catalog", "unit_catalog", "location_catalog"),
        entities=("party", "party_role", "product", "unit", "location"),
        ui_sections=("master",),
        read_apis=("/api/resources/catalog",),
        actions=(
            ActionBinding(action_id="create_party"),
            ActionBinding(action_id="create_product"),
            ActionBinding(action_id="create_unit"),
            ActionBinding(action_id="create_location"),
        ),
        import_resources=("party", "product", "unit", "location"),
    ),
    _builtin(
        module_id="inventory",
        display_name="Inventory",
        kind="business",
        dependencies=("master_data",),
        provides=("inventory_movement", "inventory_balance"),
        requires=("product_catalog", "unit_catalog", "location_catalog"),
        entities=("inventory_movement", "inventory_balance"),
        ui_sections=("inventory",),
        read_apis=("/api/inventory",),
        actions=(
            ActionBinding(action_id="post_inventory_adjustment"),
            ActionBinding(action_id="reverse_movement"),
        ),
        import_resources=("opening_inventory",),
    ),
    _builtin(
        module_id="sales",
        display_name="Sales",
        kind="business",
        dependencies=("master_data", "inventory"),
        provides=("sales_order", "sales_fulfillment"),
        requires=("party_catalog", "product_catalog", "inventory_movement"),
        entities=("sales_order", "sales_order_line", "sales_fulfillment"),
        ui_sections=("sales",),
        read_apis=("/api/orders/sale",),
        actions=(
            ActionBinding(action_id="create_sales_order"),
            ActionBinding(action_id="ship_sale"),
            ActionBinding(action_id="cancel_order", scope="sale"),
        ),
        import_resources=("sales_order",),
    ),
    _builtin(
        module_id="procurement",
        display_name="Procurement",
        kind="business",
        dependencies=("master_data", "inventory"),
        provides=("purchase_order", "purchase_receipt"),
        requires=("party_catalog", "product_catalog", "inventory_movement"),
        entities=("purchase_order", "purchase_order_line", "purchase_receipt"),
        ui_sections=("purchase",),
        read_apis=("/api/orders/purchase",),
        actions=(
            ActionBinding(action_id="create_purchase_order"),
            ActionBinding(action_id="receive_purchase"),
            ActionBinding(action_id="cancel_order", scope="purchase"),
        ),
        import_resources=("purchase_order",),
    ),
    _builtin(
        module_id="data_import",
        display_name="Data import",
        kind="integration",
        dependencies=("master_data", "inventory", "sales", "procurement"),
        provides=("csv_import", "json_import", "external_record_idempotency"),
        requires=("party_catalog", "product_catalog", "inventory_movement", "sales_order", "purchase_order"),
        entities=("external_record", "import_preview"),
        ui_sections=("import",),
        read_apis=("/api/imports/template/{resource}",),
        import_resources=("party", "product", "unit", "location", "opening_inventory", "sales_order", "purchase_order"),
        formal_writer="delegated_owner",
    ),
)


KERNEL_CAPABILITIES: tuple[str, ...] = (
    "single_company_profile",
    "single_administrator_authentication",
    "sqlite_transaction_boundary",
    "preview_apply_readback",
    "immutable_audit_log",
    "health_verification",
    "backup_restore",
    "module_registry",
)


def _validate_registry() -> None:
    by_id = {module.module_id: module for module in BUILTIN_MODULES}
    if len(by_id) != len(BUILTIN_MODULES):
        raise RuntimeError("built-in module ids must be unique")
    for module in BUILTIN_MODULES:
        missing = sorted(set(module.dependencies) - set(by_id))
        if missing:
            raise RuntimeError(f"module {module.module_id} has missing dependencies: {missing}")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(module_id: str) -> None:
        if module_id in visiting:
            raise RuntimeError(f"module dependency cycle includes {module_id}")
        if module_id in visited:
            return
        visiting.add(module_id)
        for dependency in by_id[module_id].dependencies:
            visit(dependency)
        visiting.remove(module_id)
        visited.add(module_id)

    for module_id in by_id:
        visit(module_id)

    declared_actions = {binding.action_id for module in BUILTIN_MODULES for binding in module.actions}
    if declared_actions != set(ACTION_MODELS):
        raise RuntimeError("module manifests and supported business actions have drifted")


_validate_registry()


def list_module_manifests() -> list[dict[str, object]]:
    return [module.model_dump(mode="json") for module in BUILTIN_MODULES]


def system_map() -> dict[str, object]:
    return {
        "schema_version": SYSTEM_MAP_VERSION,
        "application_version": __version__,
        "architecture": "stable_kernel_with_build_time_modules",
        "kernel_capabilities": list(KERNEL_CAPABILITIES),
        "modules": list_module_manifests(),
        "extension_policy": {
            "customer_code_location": "customer_private_repository",
            "activation": "build_time_only",
            "hot_install_or_unload": False,
            "may_override_kernel": False,
            "formal_writes": "module_owner_preview_apply_readback",
            "mcp_direct_sql": False,
            "production_self_modification": False,
        },
    }
