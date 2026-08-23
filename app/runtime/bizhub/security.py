from __future__ import annotations

import base64
import hashlib
import hmac
import json
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
    return payload


def _secret() -> bytes:
    value = secret_key_path().read_bytes().strip()
    if len(value) < 32:
        raise RuntimeError("secret_key_invalid")
    return value


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def create_session(username: str, *, lifetime_seconds: int = 8 * 60 * 60) -> str:
    body = json.dumps(
        {"username": username, "expires_at": int(time.time()) + lifetime_seconds},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    encoded = _encode(body)
    signature = hmac.new(_secret(), encoded.encode(), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def authenticated_username(token: str | None) -> str | None:
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
    if int(payload.get("expires_at") or 0) <= int(time.time()):
        return None
    username = str(payload.get("username") or "")
    try:
        admin = load_admin()
    except (OSError, RuntimeError, ValueError):
        return None
    return username if username == admin["username"] else None
