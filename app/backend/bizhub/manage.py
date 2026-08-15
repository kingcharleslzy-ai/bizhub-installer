from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

from .config import company_profile, database_path
from .db import database, initialize_database, utc_now
from .security import password_hash


def initialize_admin(username: str, password: str) -> dict[str, str]:
    normalized = username.strip()
    if not 3 <= len(normalized) <= 80:
        raise ValueError("administrator username must contain 3 to 80 characters")
    initialize_database()
    encoded = password_hash(password.rstrip("\r\n"))
    with database() as conn:
        existing = conn.execute("SELECT username FROM admin_users WHERE id=1").fetchone()
        if existing:
            if existing["username"] != normalized:
                raise ValueError("administrator already exists with a different username")
            return {"status": "already_satisfied", "username": normalized}
        conn.execute(
            "INSERT INTO admin_users(id,username,password_hash,active,created_at) VALUES(1,?,?,1,?)",
            (normalized, encoded, utc_now()),
        )
    return {"status": "created", "username": normalized}


def verify() -> dict[str, object]:
    initialize_database()
    with database() as conn:
        quick = conn.execute("PRAGMA quick_check").fetchone()[0]
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        admin_ready = conn.execute("SELECT 1 FROM admin_users WHERE id=1 AND active=1").fetchone() is not None
    if quick != "ok" or violations or not admin_ready:
        raise RuntimeError("instance verification failed")
    return {
        "status": "ok",
        "profile_id": company_profile().profile_id,
        "database": str(database_path()),
        "admin_ready": admin_ready,
    }


def backup(output: Path) -> dict[str, object]:
    initialize_database()
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError("backup output already exists")
    temporary = output.with_suffix(output.suffix + ".partial")
    if temporary.exists():
        temporary.unlink()
    source = sqlite3.connect(database_path())
    target = sqlite3.connect(temporary)
    try:
        source.backup(target)
        quick = target.execute("PRAGMA quick_check").fetchone()[0]
        if quick != "ok":
            raise RuntimeError(f"backup verification failed: {quick}")
    finally:
        target.close()
        source.close()
    os.chmod(temporary, 0o600)
    temporary.replace(output)
    return {"status": "created", "path": str(output), "bytes": output.stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m bizhub.manage")
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("--username", required=True)
    init.add_argument("--password-stdin", action="store_true", required=True)
    commands.add_parser("verify")
    backup_parser = commands.add_parser("backup")
    backup_parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if args.command == "init":
        result = initialize_admin(args.username, sys.stdin.readline())
    elif args.command == "verify":
        result = verify()
    else:
        result = backup(args.output)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
