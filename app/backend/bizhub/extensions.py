from __future__ import annotations

import importlib
import os
import re
from dataclasses import dataclass
from types import ModuleType

from fastapi import APIRouter
from fastapi.routing import APIRoute

from .modules import ModuleManifest


EXTENSION_MODULES_ENV = "BIZHUB_EXTENSION_MODULES"
_IMPORT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")


@dataclass(frozen=True)
class LoadedExtension:
    import_name: str
    manifest: ModuleManifest
    router: APIRouter


def configured_extension_names(raw: str | None = None) -> tuple[str, ...]:
    value = os.getenv(EXTENSION_MODULES_ENV, "") if raw is None else raw
    names = tuple(item.strip() for item in value.split(",") if item.strip())
    if len(names) != len(set(names)):
        raise RuntimeError("extension module names must be unique")
    invalid = [name for name in names if not _IMPORT_NAME.fullmatch(name)]
    if invalid:
        raise RuntimeError(f"extension modules must be fixed Python import names: {invalid}")
    return names


def _call(module: ModuleType, name: str):
    value = getattr(module, name, None)
    if not callable(value):
        raise RuntimeError(f"extension {module.__name__} must export callable {name}()")
    return value()


def _validate_read_only_extension(import_name: str, manifest: ModuleManifest, router: APIRouter) -> None:
    if manifest.source != "customer_private" or not manifest.module_id.startswith("customer."):
        raise RuntimeError(f"extension {import_name} must use a customer-private module manifest")
    if manifest.governance.formal_writer != "none" or manifest.governance.preview_required:
        raise RuntimeError(f"extension {manifest.module_id} must be read-only in the first external stage")
    if manifest.actions or manifest.import_resources or manifest.owns_entities:
        raise RuntimeError(f"extension {manifest.module_id} cannot declare write-owned resources")
    if router.on_startup or router.on_shutdown:
        raise RuntimeError(f"extension {manifest.module_id} cannot register lifecycle handlers")

    get_paths: list[str] = []
    for route in router.routes:
        if not isinstance(route, APIRoute):
            raise RuntimeError(f"extension {manifest.module_id} can expose only HTTP API routes")
        methods = route.methods or set()
        if not methods or not methods.issubset({"GET", "HEAD"}):
            raise RuntimeError(f"extension {manifest.module_id} can expose only GET or HEAD routes")
        if route.path != manifest.api_prefix and not route.path.startswith(f"{manifest.api_prefix}/"):
            raise RuntimeError(f"extension route {route.path} escapes {manifest.api_prefix}")
        if "GET" in methods:
            get_paths.append(route.path)
    if len(get_paths) != len(set(get_paths)):
        raise RuntimeError(f"extension {manifest.module_id} contains duplicate GET routes")
    if set(get_paths) != set(manifest.read_apis):
        raise RuntimeError(f"extension {manifest.module_id} routes do not match manifest read_apis")


def load_extension_modules(raw: str | None = None) -> tuple[LoadedExtension, ...]:
    loaded: list[LoadedExtension] = []
    for import_name in configured_extension_names(raw):
        module = importlib.import_module(import_name)
        manifest = ModuleManifest.model_validate(_call(module, "get_manifest"))
        router = _call(module, "build_router")
        if not isinstance(router, APIRouter):
            raise RuntimeError(f"extension {import_name} build_router() must return fastapi.APIRouter")
        _validate_read_only_extension(import_name, manifest, router)
        loaded.append(LoadedExtension(import_name=import_name, manifest=manifest, router=router))
    return tuple(loaded)
