from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from .config import admin_path, secret_key_path


_HASHER = PasswordHasher()


def password_hash(password: str) -> str:
    if len(password) < 12:
        raise ValueError("administrator password must contain at least 12 characters")
    return _HASHER.hash(password)


def password_matches(encoded: str, password: str) -> bool:
    try:
        return _HASHER.verify(encoded, password)
    except (InvalidHashError, VerificationError):
        return False


def load_admin() -> dict[str, Any]:
    payload = json.loads(admin_path().read_text(encoding="utf-8"))
    if payload.get("schema_version") != "bizhub.public-admin.v1":
        raise RuntimeError("administrator_config_invalid")
    if not str(payload.get("username") or "") or not str(payload.get("password_hash") or ""):
        raise RuntimeError("administrator_config_invalid")
    auth_version = payload.get("auth_version", 1)
    if not isinstance(auth_version, int) or isinstance(auth_version, bool) or auth_version < 1:
        raise RuntimeError("administrator_config_invalid")
    payload["auth_version"] = auth_version
    return payload


def write_admin(payload: dict[str, Any]) -> None:
    target = admin_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)


def _secret() -> bytes:
    value = secret_key_path().read_bytes().strip()
    if len(value) < 32:
        raise RuntimeError("secret_key_invalid")
    return value


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _create_token(
    username: str,
    *,
    purpose: str,
    auth_version: int,
    lifetime_seconds: int,
) -> str:
    body = json.dumps(
        {
            "auth_version": auth_version,
            "expires_at": int(time.time()) + lifetime_seconds,
            "purpose": purpose,
            "username": username,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    encoded = _encode(body)
    signature = hmac.new(_secret(), encoded.encode(), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def create_session(username: str, *, lifetime_seconds: int = 8 * 60 * 60) -> str:
    admin = load_admin()
    if username != admin["username"]:
        raise RuntimeError("administrator_config_invalid")
    return _create_token(
        username,
        purpose="session",
        auth_version=admin["auth_version"],
        lifetime_seconds=lifetime_seconds,
    )


def create_remember_token(username: str, *, lifetime_seconds: int = 30 * 24 * 60 * 60) -> str:
    admin = load_admin()
    if username != admin["username"]:
        raise RuntimeError("administrator_config_invalid")
    return _create_token(
        username,
        purpose="remember",
        auth_version=admin["auth_version"],
        lifetime_seconds=lifetime_seconds,
    )


def _authenticated_token(token: str | None, purpose: str) -> dict[str, Any] | None:
    if not token or token.count(".") != 1:
        return None
    encoded, signature = token.split(".", 1)
    expected = hmac.new(_secret(), encoded.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return None
    try:
        payload = json.loads(_decode(encoded))
    except (ValueError, json.JSONDecodeError):
        return None
    if set(payload) != {"auth_version", "expires_at", "purpose", "username"}:
        return None
    if payload.get("purpose") != purpose:
        return None
    expires_at = payload.get("expires_at")
    auth_version = payload.get("auth_version")
    if (
        not isinstance(expires_at, int)
        or isinstance(expires_at, bool)
        or expires_at <= int(time.time())
        or not isinstance(auth_version, int)
        or isinstance(auth_version, bool)
        or auth_version < 1
    ):
        return None
    username = str(payload.get("username") or "")
    try:
        admin = load_admin()
    except (OSError, RuntimeError, ValueError):
        return None
    if username != admin["username"] or auth_version != admin["auth_version"]:
        return None
    return payload


def authenticated_username(token: str | None) -> str | None:
    payload = _authenticated_token(token, "session")
    return str(payload["username"]) if payload else None


def remembered_username(token: str | None) -> str | None:
    payload = _authenticated_token(token, "remember")
    return str(payload["username"]) if payload else None


def change_password(username: str, current_password: str, new_password: str) -> dict[str, Any]:
    admin = load_admin()
    if username != admin["username"] or not password_matches(admin["password_hash"], current_password):
        raise ValueError("invalid administrator credentials")
    updated = {
        "schema_version": "bizhub.public-admin.v1",
        "username": admin["username"],
        "password_hash": password_hash(new_password.rstrip("\r\n")),
        "auth_version": admin["auth_version"] + 1,
    }
    write_admin(updated)
    return updated
