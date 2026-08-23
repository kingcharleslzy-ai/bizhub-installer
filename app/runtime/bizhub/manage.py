from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from backend.generic_kernel.backup import create_backup, restore_backup
from backend.generic_kernel.migrations import readback_database

from .config import admin_path, common_identity, database_path
from .core import database_state, initialize_database
from .security import load_admin, password_hash


def _write_json_secure(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def initialize_admin(username: str, password: str) -> dict[str, str]:
    normalized = username.strip()
    if not 3 <= len(normalized) <= 80:
        raise ValueError("administrator username must contain 3 to 80 characters")
    initialize_database()
    if admin_path().exists():
        existing = load_admin()
        if existing["username"] != normalized:
            raise ValueError("administrator already exists with a different username")
        return {"status": "already_satisfied", "username": normalized}
    _write_json_secure(
        admin_path(),
        {
            "schema_version": "bizhub.public-admin.v1",
            "username": normalized,
            "password_hash": password_hash(password.rstrip("\r\n")),
        },
    )
    return {"status": "created", "username": normalized}


def verify() -> dict[str, object]:
    initialize_database()
    admin = load_admin()
    return {
        "status": "ok",
        "database": str(database_path()),
        "admin_ready": bool(admin["username"]),
        **database_state(),
        **common_identity(),
    }


def backup(output: Path) -> dict[str, object]:
    initialize_database()
    output = output.resolve()
    if output.exists():
        raise ValueError("backup output already exists")
    manifest = create_backup(database_path(), output)
    return {
        "status": "created",
        "path": str(output),
        "manifest_path": str(manifest),
        "bytes": output.stat().st_size,
    }


def validate_backup(backup_path: Path, manifest_path: Path) -> dict[str, object]:
    temporary = backup_path.with_name(backup_path.name + ".validation.sqlite")
    temporary.unlink(missing_ok=True)
    try:
        state = restore_backup(backup_path, manifest_path, temporary)
        return {"status": "valid", "state": state}
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m bizhub.manage")
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("--username", required=True)
    init.add_argument("--password-stdin", action="store_true", required=True)
    commands.add_parser("verify")
    backup_parser = commands.add_parser("backup")
    backup_parser.add_argument("--output", required=True, type=Path)
    validate = commands.add_parser("validate-backup")
    validate.add_argument("--backup", required=True, type=Path)
    validate.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "init":
        result = initialize_admin(args.username, sys.stdin.readline())
    elif args.command == "verify":
        result = verify()
    elif args.command == "backup":
        result = backup(args.output)
    else:
        result = validate_backup(args.backup, args.manifest)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
