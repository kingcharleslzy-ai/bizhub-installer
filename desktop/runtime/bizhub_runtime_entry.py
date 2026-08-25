"""Bounded command entry point for the fixed Generic Desktop Runtime."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import signal
import socket
import sys
import threading
import time
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any


MAX_BOOTSTRAP_BYTES = 32 * 1024
RUNTIME_COOKIE = "bizhub_desktop_runtime"


def _json_line(payload: dict[str, object]) -> None:
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")), flush=True)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _bundle_root() -> Path:
    frozen = getattr(sys, "_MEIPASS", None)
    if frozen:
        return Path(frozen).resolve()
    override = os.getenv("BIZHUB_DESKTOP_RUNTIME_BUNDLE_ROOT", "").strip()
    if not override:
        raise RuntimeError("desktop_runtime_bundle_root_missing")
    return Path(override).resolve()


def _verify_bundled_common() -> dict[str, Any]:
    bundle = _bundle_root()
    common_root = bundle / "common"
    artifact_root = bundle / "common-artifact"
    artifact = artifact_root / "bizhub-common.tar.gz"
    manifest_path = artifact_root / "bizhub-common-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected_digest = str(manifest.get("artifact_sha256") or "")
    if not hmac.compare_digest(_sha256(artifact), expected_digest):
        raise RuntimeError("desktop_common_artifact_digest_mismatch")
    if manifest.get("core_artifact_digest") != f"sha256:{expected_digest}":
        raise RuntimeError("desktop_common_artifact_identity_invalid")
    if manifest.get("artifact_id") != "bizhub-common":
        raise RuntimeError("desktop_common_artifact_id_invalid")
    expected_paths: set[str] = set()
    for record in manifest.get("files") or []:
        relative = str(record.get("path") or "")
        candidate = (common_root / relative).resolve()
        if not relative or common_root not in candidate.parents:
            raise RuntimeError("desktop_common_artifact_path_invalid")
        if not candidate.is_file() or _sha256(candidate) != record.get("sha256"):
            raise RuntimeError(f"desktop_common_artifact_file_mismatch:{relative}")
        expected_paths.add(relative)
    actual_paths = {
        path.relative_to(common_root).as_posix()
        for path in common_root.rglob("*")
        if path.is_file()
    }
    if actual_paths != expected_paths:
        raise RuntimeError("desktop_common_artifact_file_set_mismatch")
    os.environ.update(
        {
            "BIZHUB_COMMON_ROOT": str(common_root),
            "BIZHUB_COMMON_MANIFEST": str(manifest_path),
            "BIZHUB_CORE_ARTIFACT_DIGEST": str(manifest["core_artifact_digest"]),
            "BIZHUB_RUNTIME_PROFILE_ID": "generic-kernel-smoke",
            "BIZHUB_COOKIE_SECURE": "0",
        }
    )
    return manifest


def _instance_root() -> Path:
    value = os.getenv("BIZHUB_DESKTOP_INSTANCE_ROOT", "").strip()
    if not value:
        raise RuntimeError("desktop_instance_root_missing")
    return Path(value).resolve()


def _require_exact_instance_paths() -> Path:
    root = _instance_root()
    expected = {
        "BIZHUB_GENERIC_DATABASE_PATH": root / "data" / "bizhub.sqlite",
        "BIZHUB_ADMIN_CONFIG": root / "data" / "admin.json",
        "BIZHUB_COMPANY_CONFIG": root / "config" / "company.json",
        "BIZHUB_SECRET_KEY_FILE": root / "config" / "secret-key",
    }
    for name, path in expected.items():
        actual = Path(os.getenv(name, "")).resolve()
        if actual != path:
            raise RuntimeError(f"desktop_instance_path_invalid:{name}")
    return root


def _read_bootstrap() -> dict[str, Any]:
    raw = sys.stdin.buffer.readline(MAX_BOOTSTRAP_BYTES + 1)
    if not raw or len(raw) > MAX_BOOTSTRAP_BYTES or sys.stdin.buffer.read(1):
        raise ValueError("desktop_bootstrap_payload_size_invalid")
    payload = json.loads(raw)
    if set(payload) != {"schema_version", "bootstrap_token", "username", "password"}:
        raise ValueError("desktop_bootstrap_payload_shape_invalid")
    if payload.get("schema_version") != "bizhub.desktop-local-bootstrap.v1":
        raise ValueError("desktop_bootstrap_schema_invalid")
    expected = os.getenv("BIZHUB_DESKTOP_BOOTSTRAP_SHA256", "")
    supplied = hashlib.sha256(str(payload.get("bootstrap_token") or "").encode()).hexdigest()
    if not expected or not hmac.compare_digest(expected, supplied):
        raise ValueError("desktop_bootstrap_token_invalid")
    return payload


def command_bootstrap() -> dict[str, object]:
    _verify_bundled_common()
    root = _require_exact_instance_paths()
    if (root / "data" / "admin.json").exists():
        raise ValueError("desktop_local_instance_already_initialized")
    payload = _read_bootstrap()
    from bizhub.manage import initialize_admin, verify

    result = initialize_admin(str(payload["username"]), str(payload["password"]))
    return {"status": result["status"], "username": result["username"], "readback": verify()}


def command_verify() -> dict[str, object]:
    _verify_bundled_common()
    _require_exact_instance_paths()
    from bizhub.manage import verify

    return verify()


def _bounded_backup_path(value: str) -> Path:
    root = _require_exact_instance_paths()
    candidate = Path(value).resolve()
    backup_root = (root / "backups").resolve()
    if backup_root not in candidate.parents or candidate.suffix != ".sqlite":
        raise ValueError("desktop_backup_path_invalid")
    return candidate


def command_backup(output: str) -> dict[str, object]:
    _verify_bundled_common()
    from bizhub.manage import backup

    return backup(_bounded_backup_path(output))


def command_validate_backup(backup_path: str, manifest_path: str) -> dict[str, object]:
    _verify_bundled_common()
    backup = _bounded_backup_path(backup_path)
    manifest = Path(manifest_path).resolve()
    if manifest != backup.with_suffix(backup.suffix + ".manifest.json"):
        raise ValueError("desktop_backup_manifest_path_invalid")
    from bizhub.manage import validate_backup

    return validate_backup(backup, manifest)


class RuntimeTokenGuard:
    def __init__(self, app: Any, token: str):
        self.app = app
        self.token = token

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") == "http":
            headers = {key.lower(): value for key, value in scope.get("headers") or []}
            cookie = SimpleCookie()
            try:
                cookie.load(headers.get(b"cookie", b"").decode("latin1"))
                supplied = cookie[RUNTIME_COOKIE].value if RUNTIME_COOKIE in cookie else ""
            except Exception:
                supplied = ""
            if not hmac.compare_digest(supplied, self.token):
                body = b'{"detail":"desktop runtime authorization required"}'
                await send(
                    {
                        "type": "http.response.start",
                        "status": 403,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"content-length", str(len(body)).encode()),
                            (b"cache-control", b"no-store"),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)


def _monitor_parent(server: Any, parent_pid: int) -> None:
    while not server.should_exit:
        if os.getppid() != parent_pid:
            server.should_exit = True
            return
        try:
            os.kill(parent_pid, 0)
        except OSError:
            server.should_exit = True
            return
        time.sleep(1)


def command_serve() -> int:
    manifest = _verify_bundled_common()
    _require_exact_instance_paths()
    token = os.getenv("BIZHUB_DESKTOP_RUNTIME_TOKEN", "")
    if len(token) < 43:
        raise RuntimeError("desktop_runtime_token_invalid")
    parent_pid = int(os.getenv("BIZHUB_DESKTOP_PARENT_PID", "0"))
    if parent_pid <= 1 or parent_pid != os.getppid():
        raise RuntimeError("desktop_runtime_parent_invalid")

    from bizhub.main import app as generic_app
    import uvicorn

    guarded_app = RuntimeTokenGuard(generic_app, token)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = int(listener.getsockname()[1])
    config = uvicorn.Config(
        guarded_app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
        server_header=False,
        date_header=False,
    )
    server = uvicorn.Server(config)
    monitor = threading.Thread(target=_monitor_parent, args=(server, parent_pid), daemon=True)
    monitor.start()
    _json_line(
        {
            "status": "ready",
            "origin": f"http://127.0.0.1:{port}",
            "pid": os.getpid(),
            "profile_id": "generic-kernel-smoke",
            "core_artifact_digest": manifest["core_artifact_digest"],
        }
    )
    server.run(sockets=[listener])
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="bizhub-runtime")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("bootstrap")
    commands.add_parser("verify")
    backup = commands.add_parser("backup")
    backup.add_argument("--output", required=True)
    validate = commands.add_parser("validate-backup")
    validate.add_argument("--backup", required=True)
    validate.add_argument("--manifest", required=True)
    commands.add_parser("serve")
    args = parser.parse_args()
    try:
        if args.command == "serve":
            return command_serve()
        if args.command == "bootstrap":
            result = command_bootstrap()
        elif args.command == "verify":
            result = command_verify()
        elif args.command == "backup":
            result = command_backup(args.output)
        else:
            result = command_validate_backup(args.backup, args.manifest)
        _json_line(result)
        return 0
    except Exception as exc:
        _json_line({"status": "error", "error": str(exc)})
        return 1


if __name__ == "__main__":
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    raise SystemExit(main())
