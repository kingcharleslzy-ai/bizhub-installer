from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .config import company_profile, cookie_secure, static_dir
from .contracts import (
    ActionApplyRequest,
    ActionPreviewRequest,
    CsvImportPreviewRequest,
    ImportApplyRequest,
    ImportPreviewRequest,
    MasterDataBundleApplyRequest,
    MasterDataBundlePreviewRequest,
    ReconcileApplyRequest,
    ReconcilePreviewRequest,
)
from .bundle_import import apply_master_data_bundle, preview_master_data_bundle
from .db import database, initialize_database, state_version
from .extensions import load_extension_modules
from .imports import apply_import, csv_records, csv_template, preview_import
from .modules import register_extension_manifests, reset_runtime_modules, system_map
from .reconcile import apply_reconcile, preview_reconcile
from .security import (
    authenticated_user,
    clear_login_failures,
    create_session,
    login_allowed,
    login_failure_key,
    password_matches,
    record_login_failure,
    revoke_session,
)
from .service import apply_action, audit_events, catalog, external_mappings, inventory_projection, list_orders, preview_action


SESSION_COOKIE = "bizhub_session"

reset_runtime_modules()
LOADED_EXTENSIONS = load_extension_modules()
register_extension_manifests(tuple(extension.manifest for extension in LOADED_EXTENSIONS))


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoginRequest(StrictModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=1024)


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


app = FastAPI(
    title="BizHub",
    version=__version__,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    )
    return response


@app.exception_handler(ValueError)
async def value_error_handler(_, exc: ValueError):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(sqlite3.IntegrityError)
async def integrity_error_handler(_, exc: sqlite3.IntegrityError):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=409, content={"detail": f"business constraint rejected the write: {exc}"})


def connection() -> Iterator[sqlite3.Connection]:
    with database() as conn:
        yield conn


Db = Annotated[sqlite3.Connection, Depends(connection)]


def current_user(
    conn: Db,
    session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
) -> sqlite3.Row:
    user = authenticated_user(conn, session)
    if user is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return user


User = Annotated[sqlite3.Row, Depends(current_user)]


def mutation_guard(
    marker: Annotated[str | None, Header(alias="X-BizHub-Request")] = None,
) -> None:
    if marker != "1":
        raise HTTPException(status_code=403, detail="missing same-origin mutation marker")


Mutation = Annotated[None, Depends(mutation_guard)]


@app.get("/api/health")
def health(conn: Db) -> dict[str, Any]:
    quick = conn.execute("PRAGMA quick_check").fetchone()[0]
    foreign_violations = conn.execute("PRAGMA foreign_key_check").fetchall()
    admin_ready = conn.execute("SELECT 1 FROM admin_users WHERE id=1 AND active=1").fetchone() is not None
    healthy = quick == "ok" and not foreign_violations and admin_ready
    if not healthy:
        raise HTTPException(
            status_code=503,
            detail={"database": quick, "foreign_key_violations": len(foreign_violations), "admin_ready": admin_ready},
        )
    return {
        "status": "ok",
        "version": __version__,
        "profile_id": company_profile().profile_id,
        "state_version": state_version(conn),
    }


@app.get("/api/version")
def version() -> dict[str, str]:
    return {"version": __version__}


@app.get("/api/profile")
def profile(_: User) -> dict[str, object]:
    return company_profile().public_payload()


@app.get("/api/system/modules")
def modules(_: User) -> dict[str, object]:
    return system_map()


@app.post("/api/auth/login")
def login(payload: LoginRequest, request: Request, response: Response, conn: Db, _: Mutation) -> dict[str, str]:
    key = login_failure_key(request.client.host if request.client else "unknown", payload.username)
    if not login_allowed(conn, key):
        raise HTTPException(status_code=429, detail="too many login attempts; try again later")
    user = conn.execute("SELECT * FROM admin_users WHERE username=? AND active=1", (payload.username,)).fetchone()
    if user is None or not password_matches(user["password_hash"], payload.password):
        record_login_failure(conn, key)
        raise HTTPException(status_code=401, detail="invalid administrator credentials")
    clear_login_failures(conn, key)
    token, expires = create_session(conn, int(user["id"]))
    response.set_cookie(
        SESSION_COOKIE,
        token,
        expires=expires,
        httponly=True,
        secure=cookie_secure(),
        samesite="strict",
        path="/",
    )
    return {"username": user["username"]}


@app.post("/api/auth/logout")
def logout(
    response: Response,
    conn: Db,
    _: Mutation,
    __: User,
    session: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
) -> dict[str, str]:
    revoke_session(conn, session)
    response.delete_cookie(SESSION_COOKIE, path="/", secure=cookie_secure(), httponly=True, samesite="strict")
    return {"status": "signed_out"}


@app.get("/api/auth/me")
def me(user: User) -> dict[str, str]:
    return {"username": user["username"]}


@app.get("/api/resources/catalog")
def resources(conn: Db, _: User) -> dict[str, Any]:
    return catalog(conn)


@app.get("/api/external-records")
def external_record_readback(
    conn: Db,
    _: User,
    source_id: str = Query(min_length=1, max_length=80),
    resource_type: str | None = Query(default=None, min_length=1, max_length=80, pattern=r"^[a-z][a-z0-9_]*$"),
    after_id: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=500),
) -> dict[str, Any]:
    return external_mappings(
        conn,
        source_id=source_id,
        resource_type=resource_type,
        after_id=after_id,
        limit=limit,
    )


@app.get("/api/orders/{order_type}")
def orders(order_type: str, conn: Db, _: User) -> list[dict[str, Any]]:
    if order_type not in {"sale", "purchase"}:
        raise HTTPException(status_code=404, detail="unsupported order type")
    return list_orders(conn, order_type)


@app.get("/api/inventory")
def inventory(conn: Db, _: User) -> dict[str, Any]:
    return inventory_projection(conn)


@app.get("/api/audit")
def audit(conn: Db, _: User, limit: int = Query(default=200, ge=1, le=500)) -> list[dict[str, Any]]:
    return audit_events(conn, limit)


@app.post("/api/actions/preview")
def action_preview(payload: ActionPreviewRequest, conn: Db, _: Mutation, __: User) -> dict[str, Any]:
    return preview_action(conn, payload.action, payload.data)


@app.post("/api/actions/apply")
def action_apply(payload: ActionApplyRequest, conn: Db, _: Mutation, user: User) -> dict[str, Any]:
    return apply_action(
        conn,
        action=payload.action,
        data=payload.data,
        preview_token=payload.preview_token,
        actor=user["username"],
        review_note=payload.review_note,
    )


@app.get("/api/imports/template/{resource}")
def import_template(resource: str, _: User) -> Response:
    return Response(content=csv_template(resource), media_type="text/csv")


@app.post("/api/imports/csv/preview")
def csv_import_preview(payload: CsvImportPreviewRequest, conn: Db, _: Mutation, __: User) -> dict[str, Any]:
    records = csv_records(payload.resource, payload.csv_text)
    result = preview_import(conn, resource=payload.resource, source_id=payload.source_id, records=records)
    result["records"] = records
    return result


@app.post("/api/imports/json/preview")
def json_import_preview(payload: ImportPreviewRequest, conn: Db, _: Mutation, __: User) -> dict[str, Any]:
    return preview_import(conn, resource=payload.resource, source_id=payload.source_id, records=payload.records)


@app.post("/api/imports/apply")
def import_apply(payload: ImportApplyRequest, conn: Db, _: Mutation, user: User) -> dict[str, Any]:
    return apply_import(
        conn,
        resource=payload.resource,
        source_id=payload.source_id,
        records=payload.records,
        preview_token=payload.preview_token,
        actor=user["username"],
        review_note=payload.review_note,
    )


@app.post("/api/imports/master-data-bundle/preview")
def master_data_bundle_preview(
    payload: MasterDataBundlePreviewRequest,
    conn: Db,
    _: Mutation,
    __: User,
) -> dict[str, Any]:
    return preview_master_data_bundle(
        conn,
        source_id=payload.source_id,
        resources=payload.resources.model_dump(mode="json"),
    )


@app.post("/api/imports/master-data-bundle/apply")
def master_data_bundle_apply(
    payload: MasterDataBundleApplyRequest,
    conn: Db,
    _: Mutation,
    user: User,
) -> dict[str, Any]:
    return apply_master_data_bundle(
        conn,
        source_id=payload.source_id,
        resources=payload.resources.model_dump(mode="json"),
        preview_token=payload.preview_token,
        actor=user["username"],
        review_note=payload.review_note,
    )


@app.post("/api/imports/reconcile/preview")
def reconcile_preview(payload: ReconcilePreviewRequest, conn: Db, _: Mutation, __: User) -> dict[str, Any]:
    return preview_reconcile(
        conn,
        resource=payload.resource,
        source_id=payload.source_id,
        records=payload.records,
    )


@app.post("/api/imports/reconcile/apply")
def reconcile_apply(payload: ReconcileApplyRequest, conn: Db, _: Mutation, user: User) -> dict[str, Any]:
    return apply_reconcile(
        conn,
        resource=payload.resource,
        source_id=payload.source_id,
        records=payload.records,
        preview_token=payload.preview_token,
        actor=user["username"],
        review_note=payload.review_note,
    )


for extension in LOADED_EXTENSIONS:
    app.include_router(extension.router, dependencies=[Depends(current_user)])


assets = static_dir()
if assets.exists():
    asset_dir = assets / "assets"
    if asset_dir.exists():
        app.mount("/assets", StaticFiles(directory=asset_dir), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        candidate = (assets / path).resolve()
        if path and candidate.is_relative_to(assets.resolve()) and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(assets / "index.html")
