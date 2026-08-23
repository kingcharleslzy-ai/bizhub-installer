from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from backend.generic_kernel.app import create_app as create_common_app
from backend.modules.master_data.contracts import CatalogDraft, CatalogPreview
from backend.modules.master_data.owner import apply_catalog, preview_catalog
from backend.modules.master_data.public import MasterDataError

from . import __version__
from .config import common_identity, common_root, company_profile, cookie_secure, database_path
from .core import database_state, initialize_database, module_ids, registry
from .identity import runtime_identity
from .security import authenticated_username, create_session, load_admin, password_matches


SESSION_COOKIE = "bizhub_session"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoginRequest(StrictModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=1024)


class CatalogDraftRequest(StrictModel):
    resource_kind: str
    resource_id: str
    canonical_name: str
    source_id: str = ""
    external_id: str = ""
    alias: str = ""
    attributes: dict[str, Any] = Field(default_factory=dict)


class CatalogPreviewRequest(StrictModel):
    drafts: list[CatalogDraftRequest]


class CatalogApplyRequest(StrictModel):
    schema_version: Literal["bizhub.master-data-catalog-preview.v1"]
    state_generation: str
    drafts: list[CatalogDraftRequest]
    preview_digest: str


def _drafts(items: list[CatalogDraftRequest]) -> tuple[CatalogDraft, ...]:
    return tuple(CatalogDraft(**item.model_dump()) for item in items)


def create_app() -> FastAPI:
    selected_registry = registry()
    common_app = create_common_app(
        database_path(),
        repo_root=common_root(),
        registry=selected_registry,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        initialize_database()
        load_admin()
        common_identity()
        yield

    app = FastAPI(
        title="BizHub Public Delivery",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.middleware("http")
    async def access_guard(request: Request, call_next):
        path = request.url.path
        public_path = path in {"/", "/api/health", "/api/version", "/api/auth/login"}
        if path.startswith("/api/") and not public_path:
            username = authenticated_username(request.cookies.get(SESSION_COOKIE))
            if username is None:
                return JSONResponse(status_code=401, content={"detail": "authentication required"})
            request.state.username = username
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if request.headers.get("X-BizHub-Request") != "1":
                return JSONResponse(status_code=403, content={"detail": "missing same-origin mutation marker"})
        return await call_next(request)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'"
        )
        return response

    @app.get("/api/health")
    async def health() -> dict[str, object]:
        state = database_state()
        identity = common_identity()
        profile = company_profile()
        admin = load_admin()
        return {
            "status": "ok",
            "version": __version__,
            "profile_id": "generic-kernel-smoke",
            "company_profile_id": profile["profile_id"],
            "admin_ready": bool(admin["username"]),
            **state,
            **identity,
        }

    @app.get("/api/version")
    async def version() -> dict[str, str]:
        return {"version": __version__}

    @app.get("/api/core-identity")
    async def core_identity() -> dict[str, str]:
        return runtime_identity()

    @app.get("/api/profile")
    async def profile() -> dict[str, Any]:
        return {**company_profile(), **common_identity(), "runtime_profile_id": "generic-kernel-smoke"}

    @app.get("/api/system-map")
    async def system_map() -> dict[str, object]:
        return {**selected_registry.effective_system_map(), **common_identity()}

    @app.post("/api/auth/login")
    async def login(payload: LoginRequest, response: Response) -> dict[str, str]:
        admin = load_admin()
        if payload.username != admin["username"] or not password_matches(admin["password_hash"], payload.password):
            raise HTTPException(status_code=401, detail="invalid administrator credentials")
        response.set_cookie(
            SESSION_COOKIE,
            create_session(payload.username),
            httponly=True,
            secure=cookie_secure(),
            samesite="strict",
            path="/",
        )
        return {"username": payload.username}

    @app.post("/api/auth/logout")
    async def logout(response: Response) -> dict[str, str]:
        response.delete_cookie(
            SESSION_COOKIE,
            path="/",
            secure=cookie_secure(),
            httponly=True,
            samesite="strict",
        )
        return {"status": "signed_out"}

    @app.get("/api/auth/me")
    async def me(request: Request) -> dict[str, str]:
        return {"username": str(request.state.username)}

    @app.post("/api/master-data/catalog/preview")
    async def master_data_preview(payload: CatalogPreviewRequest) -> dict[str, object]:
        try:
            return preview_catalog(
                database_path(),
                _drafts(payload.drafts),
                enabled_module_ids=module_ids(),
            ).to_dict()
        except (MasterDataError, TypeError, ValueError) as exc:
            code = getattr(exc, "code", "master_data_request_invalid")
            raise HTTPException(status_code=409, detail={"code": code, "message": str(exc)}) from exc

    @app.post("/api/master-data/catalog/apply")
    async def master_data_apply(payload: CatalogApplyRequest) -> dict[str, object]:
        preview = CatalogPreview(
            state_generation=payload.state_generation,
            drafts=_drafts(payload.drafts),
            preview_digest=payload.preview_digest,
        )
        try:
            return apply_catalog(
                database_path(),
                preview,
                enabled_module_ids=module_ids(),
            )
        except (MasterDataError, TypeError, ValueError) as exc:
            code = getattr(exc, "code", "master_data_request_invalid")
            raise HTTPException(status_code=409, detail={"code": code, "message": str(exc)}) from exc

    app.mount("/", common_app)
    return app


def selected_runtime_app() -> FastAPI:
    profile_id = os.getenv("BIZHUB_RUNTIME_PROFILE_ID", "generic-kernel-smoke").strip()
    if profile_id == "generic-kernel-smoke":
        return create_app()
    if profile_id == "dazheng":
        from backend.main import app as dazheng_app

        dazheng_app.add_api_route(
            "/api/core-identity",
            runtime_identity,
            methods=["GET"],
            include_in_schema=False,
        )
        return dazheng_app
    raise RuntimeError("runtime_profile_id_invalid")


app = selected_runtime_app()
