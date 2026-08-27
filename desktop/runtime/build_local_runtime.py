"""Build and identity-bind the macOS arm64 Generic Runtime onedir."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path
from typing import Any


RUNTIME_SCHEMA = "bizhub.desktop-runtime-release.v1"
RUNTIME_VERSION = "0.1.0-d2"
ARCHIVE_NAME = f"bizhub-runtime-darwin-arm64-{RUNTIME_VERSION}.zip"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_tree_digest(records: list[dict[str, Any]]) -> str:
    payload = (json.dumps(records, sort_keys=True, separators=(",", ":")) + "\n").encode()
    return hashlib.sha256(payload).hexdigest()


def safe_extract(artifact: Path, target: Path, expected: list[str]) -> None:
    with tarfile.open(artifact, "r:gz") as archive:
        names = archive.getnames()
        if names != expected:
            raise RuntimeError("desktop_common_artifact_member_set_mismatch")
        for member in archive.getmembers():
            member_path = Path(member.name)
            if member_path.is_absolute() or ".." in member_path.parts or not member.isfile():
                raise RuntimeError(f"desktop_common_artifact_member_invalid:{member.name}")
        archive.extractall(target, filter="data")


def verify_common(root: Path, staging_common: Path) -> dict[str, Any]:
    artifact = root / "app" / "vendor" / "bizhub-common.tar.gz"
    manifest_path = root / "app" / "vendor" / "bizhub-common-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if sha256(artifact) != manifest.get("artifact_sha256"):
        raise RuntimeError("desktop_common_artifact_digest_mismatch")
    expected = [str(item["path"]) for item in manifest.get("files") or []]
    if expected != sorted(expected):
        raise RuntimeError("desktop_common_artifact_manifest_order_invalid")
    safe_extract(artifact, staging_common, expected)
    for record in manifest["files"]:
        path = staging_common / str(record["path"])
        if sha256(path) != record["sha256"]:
            raise RuntimeError(f"desktop_common_artifact_file_mismatch:{record['path']}")
    return manifest


def build_frontend(root: Path) -> Path:
    frontend = root / "app" / "frontend"
    npm_name = "npm.cmd" if os.name == "nt" else "npm"
    npm = shutil.which(npm_name)
    if npm is None:
        raise RuntimeError(f"desktop_frontend_npm_missing:{npm_name}")
    if not (frontend / "node_modules" / ".bin" / "vite").exists():
        completed = subprocess.run(
            [npm, "ci", "--ignore-scripts"],
            cwd=frontend,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(f"desktop_frontend_install_failed:{completed.returncode}")
    completed = subprocess.run([npm, "run", "build"], cwd=frontend, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"desktop_frontend_build_failed:{completed.returncode}")
    output = root / "app" / "runtime" / "bizhub" / "static"
    if not (output / "index.html").is_file():
        raise RuntimeError("desktop_frontend_output_missing")
    return output


def normalize_zip_member_order(archive_path: Path) -> None:
    """Rewrite PyInstaller's set-derived base ZIP order deterministically."""
    temporary = archive_path.with_suffix(archive_path.suffix + ".normalized")
    with zipfile.ZipFile(archive_path, "r") as source:
        members = [(copy.copy(info), source.read(info.filename)) for info in source.infolist()]
        comment = source.comment
    with zipfile.ZipFile(temporary, "w", allowZip64=True) as target:
        target.comment = comment
        for info, content in sorted(members, key=lambda item: item[0].filename):
            target.writestr(info, content)
    temporary.replace(archive_path)


def build(root: Path, python: Path) -> Path:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("desktop_d2_requires_macos_arm64")
    desktop = root / "desktop"
    build_root = desktop / "runtime-build"
    output_root = desktop / "runtime-dist"
    shutil.rmtree(build_root, ignore_errors=True)
    shutil.rmtree(output_root, ignore_errors=True)
    common = build_root / "common"
    common.mkdir(parents=True)
    manifest = verify_common(root, common)
    frontend = build_frontend(root)

    command = [
        str(python),
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        "bizhub-runtime",
        "--target-arch",
        "arm64",
        "--contents-directory",
        "_internal",
        "--distpath",
        str(output_root),
        "--workpath",
        str(build_root / "work"),
        "--specpath",
        str(build_root / "spec"),
        "--paths",
        str(root / "app" / "runtime"),
        "--paths",
        str(common),
        "--add-data",
        f"{common}:common",
        "--add-data",
        f"{root / 'app' / 'vendor' / 'bizhub-common.tar.gz'}:common-artifact",
        "--add-data",
        f"{root / 'app' / 'vendor' / 'bizhub-common-manifest.json'}:common-artifact",
        "--add-data",
        f"{common / 'backend' / 'generic_kernel' / 'ui'}:backend/generic_kernel/ui",
        "--add-data",
        f"{frontend}:generic-ui",
        "--collect-submodules",
        "uvicorn",
        str(desktop / "runtime" / "bizhub_runtime_entry.py"),
    ]
    completed = subprocess.run(command, cwd=root, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"desktop_runtime_pyinstaller_failed:{completed.returncode}")

    pack = output_root / "bizhub-runtime"
    executable = pack / "bizhub-runtime"
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise RuntimeError("desktop_runtime_executable_missing")
    normalize_zip_member_order(pack / "_internal" / "base_library.zip")
    records: list[dict[str, Any]] = []
    for path in sorted(candidate for candidate in pack.rglob("*") if candidate.is_file() or candidate.is_symlink()):
        relative = path.relative_to(pack).as_posix()
        if relative == "runtime-release-manifest.json":
            continue
        if path.is_symlink():
            link_target = os.readlink(path)
            encoded = link_target.encode()
            records.append(
                {
                    "path": relative,
                    "type": "symlink",
                    "link_target": link_target,
                    "sha256": hashlib.sha256(encoded).hexdigest(),
                    "size": len(encoded),
                }
            )
        else:
            records.append(
                {
                    "path": relative,
                    "type": "file",
                    "link_target": None,
                    "sha256": sha256(path),
                    "size": path.stat().st_size,
                }
            )
    source_paths = [
        root / "desktop" / "runtime" / "bizhub_runtime_entry.py",
        root / "desktop" / "runtime" / "build_local_runtime.py",
        root / "desktop" / "runtime" / "requirements-build.in",
        root / "desktop" / "runtime" / "requirements-build.lock",
        *sorted((root / "app" / "runtime" / "bizhub").glob("*.py")),
        root / "app" / "frontend" / "index.html",
        root / "app" / "frontend" / "package-lock.json",
        root / "app" / "frontend" / "package.json",
        root / "app" / "frontend" / "tsconfig.json",
        root / "app" / "frontend" / "vite.config.ts",
        *sorted((root / "app" / "frontend" / "src").glob("*")),
    ]
    source_records = [
        {"path": path.relative_to(root).as_posix(), "sha256": sha256(path)}
        for path in sorted(source_paths)
    ]
    release = {
        "schema_version": RUNTIME_SCHEMA,
        "runtime_id": "bizhub-generic-local",
        "runtime_version": RUNTIME_VERSION,
        "profile_id": "generic-kernel-smoke",
        "platform": "darwin",
        "architecture": "arm64",
        "executable": "bizhub-runtime",
        "artifact_id": manifest["artifact_id"],
        "core_artifact_digest": manifest["core_artifact_digest"],
        "core_source_commit": manifest["source_commit"],
        "allowlist_tree_digest": manifest["allowlist_tree_digest"],
        "runtime_source_tree_digest": canonical_tree_digest(source_records),
        "runtime_source_files": source_records,
        "pack_tree_digest": canonical_tree_digest(records),
        "files": records,
    }
    (pack / "runtime-release-manifest.json").write_text(
        json.dumps(release, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "status": "built",
                "runtime_pack": str(pack),
                "files": len(records),
                "pack_tree_digest": release["pack_tree_digest"],
                "core_artifact_digest": release["core_artifact_digest"],
            },
            sort_keys=True,
        )
    )
    return pack


def deterministic_archive(pack: Path, archive_path: Path) -> None:
    temporary = archive_path.with_suffix(".zip.pending")
    temporary.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for item in sorted(candidate for candidate in pack.rglob("*") if candidate.is_file() or candidate.is_symlink()):
            relative = (Path("bizhub-runtime") / item.relative_to(pack)).as_posix()
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            if item.is_symlink():
                content = os.readlink(item).encode()
                info.external_attr = 0o120777 << 16
            else:
                content = item.read_bytes()
                mode = 0o100755 if os.access(item, os.X_OK) else 0o100644
                info.external_attr = mode << 16
            output.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    temporary.replace(archive_path)


def capture_review_input(root: Path, pack: Path) -> dict[str, Any]:
    desktop = root / "desktop"
    manifest_path = pack / "runtime-release-manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    trust = {
        "schema_version": "bizhub.desktop-runtime-trust.v1",
        "runtime_manifest_schema": manifest["schema_version"],
        "runtime_id": manifest["runtime_id"],
        "runtime_version": manifest["runtime_version"],
        "profile_id": manifest["profile_id"],
        "platform": manifest["platform"],
        "architecture": manifest["architecture"],
        "artifact_id": manifest["artifact_id"],
        "core_artifact_digest": manifest["core_artifact_digest"],
        "core_source_commit": manifest["core_source_commit"],
        "allowlist_tree_digest": manifest["allowlist_tree_digest"],
        "runtime_source_tree_digest": manifest["runtime_source_tree_digest"],
        "runtime_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "runtime_pack_tree_digest": manifest["pack_tree_digest"],
        "runtime_pack_file_count": len(manifest["files"]),
    }
    trust_path = desktop / "config" / "generic-runtime-trust.json"
    trust_path.write_text(json.dumps(trust, indent=2) + "\n", encoding="utf-8")
    archive_path = desktop / "runtime" / "vendor" / ARCHIVE_NAME
    deterministic_archive(pack, archive_path)
    archive_sha256 = sha256(archive_path)
    checksum_path = archive_path.with_suffix(".sha256")
    checksum_path.write_text(f"{archive_sha256}  {ARCHIVE_NAME}\n", encoding="utf-8")
    result = {
        "status": "captured",
        "archive": ARCHIVE_NAME,
        "archive_bytes": archive_path.stat().st_size,
        "archive_sha256": archive_sha256,
        "runtime_manifest_sha256": trust["runtime_manifest_sha256"],
        "runtime_pack_tree_digest": trust["runtime_pack_tree_digest"],
        "runtime_pack_file_count": trust["runtime_pack_file_count"],
        "runtime_source_tree_digest": trust["runtime_source_tree_digest"],
    }
    print(json.dumps(result, sort_keys=True))
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--capture-review-input", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    python = args.python if args.python.is_absolute() else (Path.cwd() / args.python)
    pack = build(root, python)
    if args.capture_review_input:
        capture_review_input(root, pack)


if __name__ == "__main__":
    main()
