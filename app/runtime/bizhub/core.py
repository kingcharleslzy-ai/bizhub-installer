from __future__ import annotations

from backend.generic_kernel.migrations import (
    ensure_generic_database,
    migrations_for_modules,
    readback_database,
    retained_migrations_for_database,
)
from backend.generic_kernel.onboarding import initialize_workspace_onboarding
from backend.generic_kernel.profile import get_generic_registry

from .config import common_root, company_profile, database_path


def registry():
    return get_generic_registry(common_root())


def module_ids() -> set[str]:
    return {
        str(item["module_id"])
        for item in registry().payload.get("modules", [])
    }


def active_migrations():
    return migrations_for_modules(module_ids())


def database_migrations():
    return retained_migrations_for_database(database_path(), active_migrations())


def initialize_database() -> None:
    ensure_generic_database(database_path(), migrations=database_migrations())
    profile = company_profile()
    initialize_workspace_onboarding(
        database_path(),
        workspace_id=str(profile["data_identity"]),
        display_name=str(profile["display_name"]),
        data_authority_mode=str(profile["data_authority_mode"]),
        enabled_module_ids=module_ids(),
    )


def database_state() -> dict[str, object]:
    return readback_database(database_path(), migrations=database_migrations())
