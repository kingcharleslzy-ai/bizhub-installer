from __future__ import annotations

import hashlib
import secrets
import sqlite3
import time
from datetime import UTC, datetime, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from .db import utc_now


SESSION_TTL = timedelta(days=7)
PASSWORD_HASHER = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)
LOGIN_WINDOW_SECONDS = 5 * 60
LOGIN_LOCK_SECONDS = 15 * 60
LOGIN_MAX_FAILURES = 5


def password_hash(password: str) -> str:
    if len(password) < 12:
        raise ValueError("administrator password must contain at least 12 characters")
    return PASSWORD_HASHER.hash(password)


def password_matches(encoded: str, password: str) -> bool:
    try:
        return PASSWORD_HASHER.verify(encoded, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def login_failure_key(client: str, username: str) -> str:
    return hashlib.sha256(f"{client}|{username.casefold()}".encode()).hexdigest()


def login_allowed(conn: sqlite3.Connection, key: str) -> bool:
    current = int(time.time())
    row = conn.execute("SELECT * FROM auth_login_failures WHERE failure_key=?", (key,)).fetchone()
    if row is None:
        return True
    if int(row["locked_until"]) > current:
        return False
    if current - int(row["window_started"]) > LOGIN_WINDOW_SECONDS:
        conn.execute("DELETE FROM auth_login_failures WHERE failure_key=?", (key,))
    return True


def record_login_failure(conn: sqlite3.Connection, key: str) -> None:
    current = int(time.time())
    row = conn.execute("SELECT * FROM auth_login_failures WHERE failure_key=?", (key,)).fetchone()
    count = 1 if row is None or current - int(row["window_started"]) > LOGIN_WINDOW_SECONDS else int(row["failure_count"]) + 1
    started = current if row is None or current - int(row["window_started"]) > LOGIN_WINDOW_SECONDS else int(row["window_started"])
    locked_until = current + LOGIN_LOCK_SECONDS if count >= LOGIN_MAX_FAILURES else 0
    conn.execute(
        "INSERT INTO auth_login_failures(failure_key,failure_count,window_started,locked_until) VALUES(?,?,?,?) "
        "ON CONFLICT(failure_key) DO UPDATE SET failure_count=excluded.failure_count,window_started=excluded.window_started,locked_until=excluded.locked_until",
        (key, count, started, locked_until),
    )


def clear_login_failures(conn: sqlite3.Connection, key: str) -> None:
    conn.execute("DELETE FROM auth_login_failures WHERE failure_key=?", (key,))


def create_session(conn: sqlite3.Connection, user_id: int) -> tuple[str, datetime]:
    token = secrets.token_urlsafe(48)
    now = datetime.now(UTC)
    expires = now + SESSION_TTL
    conn.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now.isoformat(),))
    conn.execute(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
        (token_hash(token), user_id, expires.isoformat(), now.isoformat()),
    )
    conn.execute("UPDATE admin_users SET last_login_at=? WHERE id=?", (utc_now(), user_id))
    return token, expires


def authenticated_user(conn: sqlite3.Connection, token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    now = datetime.now(UTC).isoformat()
    return conn.execute(
        "SELECT u.* FROM auth_sessions s JOIN admin_users u ON u.id=s.user_id "
        "WHERE s.token_hash=? AND s.expires_at>? AND u.active=1",
        (token_hash(token), now),
    ).fetchone()


def revoke_session(conn: sqlite3.Connection, token: str | None) -> None:
    if token:
        conn.execute("DELETE FROM auth_sessions WHERE token_hash=?", (token_hash(token),))
