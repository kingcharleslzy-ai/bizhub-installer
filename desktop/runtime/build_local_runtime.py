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
    ]
    source_records = [
        {"path": path.relative_to(root).as_posix(), "sha256": sha256(path)}
        for path in sorted(source_paths)
    ]
    release = {
        "schema_version": RUNTIME_SCHEMA,
        "runtime_id": "bizhub-generic-local",
        "runtime_version": "0.1.0-d2",
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    python = args.python if args.python.is_absolute() else (Path.cwd() / args.python)
    build(root, python)


if __name__ == "__main__":
    main()
