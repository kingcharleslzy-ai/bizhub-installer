"""Build and identity-bind the Windows x64 Generic Runtime onedir."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Any

from build_local_runtime import (
    RUNTIME_SCHEMA,
    canonical_tree_digest,
    normalize_zip_member_order,
    sha256,
    verify_common,
)


RUNTIME_VERSION = "0.1.0-d3"
ARCHIVE_NAME = f"bizhub-runtime-win32-x64-{RUNTIME_VERSION}.zip"


def build(root: Path, python: Path) -> Path:
    machine = platform.machine().lower()
    if platform.system() != "Windows" or machine not in {"amd64", "x86_64"}:
        raise RuntimeError("desktop_d3_requires_windows_x64")
    desktop = root / "desktop"
    build_root = desktop / "runtime-build"
    output_root = desktop / "runtime-dist"
    shutil.rmtree(build_root, ignore_errors=True)
    shutil.rmtree(output_root, ignore_errors=True)
    common = build_root / "common"
    common.mkdir(parents=True)
    common_manifest = verify_common(root, common)
    data_separator = os.pathsep

    command = [
        str(python),
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--name",
        "bizhub-runtime",
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
        f"{common}{data_separator}common",
        "--add-data",
        f"{root / 'app' / 'vendor' / 'bizhub-common.tar.gz'}{data_separator}common-artifact",
        "--add-data",
        f"{root / 'app' / 'vendor' / 'bizhub-common-manifest.json'}{data_separator}common-artifact",
        "--add-data",
        f"{common / 'backend' / 'generic_kernel' / 'ui'}{data_separator}backend/generic_kernel/ui",
        "--collect-submodules",
        "uvicorn",
        str(desktop / "runtime" / "bizhub_runtime_entry.py"),
    ]
    completed = subprocess.run(command, cwd=root, check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"desktop_runtime_pyinstaller_failed:{completed.returncode}")

    pack = output_root / "bizhub-runtime"
    executable = pack / "bizhub-runtime.exe"
    if not executable.is_file():
        raise RuntimeError("desktop_runtime_executable_missing")
    normalize_zip_member_order(pack / "_internal" / "base_library.zip")
    records: list[dict[str, Any]] = []
    for file_path in sorted(candidate for candidate in pack.rglob("*") if candidate.is_file()):
        relative = file_path.relative_to(pack).as_posix()
        if relative == "runtime-release-manifest.json":
            continue
        records.append(
            {
                "path": relative,
                "type": "file",
                "link_target": None,
                "sha256": sha256(file_path),
                "size": file_path.stat().st_size,
            }
        )
    source_paths = [
        desktop / "runtime" / "bizhub_runtime_entry.py",
        desktop / "runtime" / "build_local_runtime.py",
        desktop / "runtime" / "build_windows_runtime.py",
        desktop / "runtime" / "requirements-build.in",
        desktop / "runtime" / "requirements-build.windows-x64.lock",
        *sorted((root / "app" / "runtime" / "bizhub").glob("*.py")),
    ]
    source_records = [
        {"path": file_path.relative_to(root).as_posix(), "sha256": sha256(file_path)}
        for file_path in sorted(source_paths)
    ]
    release = {
        "schema_version": RUNTIME_SCHEMA,
        "runtime_id": "bizhub-generic-local",
        "runtime_version": RUNTIME_VERSION,
        "profile_id": "generic-kernel-smoke",
        "platform": "win32",
        "architecture": "x64",
        "executable": "bizhub-runtime.exe",
        "artifact_id": common_manifest["artifact_id"],
        "core_artifact_digest": common_manifest["core_artifact_digest"],
        "core_source_commit": common_manifest["source_commit"],
        "allowlist_tree_digest": common_manifest["allowlist_tree_digest"],
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
        for file_path in sorted(candidate for candidate in pack.rglob("*") if candidate.is_file()):
            relative = (Path("bizhub-runtime") / file_path.relative_to(pack)).as_posix()
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            mode = 0o100755 if file_path.name == "bizhub-runtime.exe" else 0o100644
            info.external_attr = mode << 16
            output.writestr(info, file_path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
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
    trust_path = desktop / "config" / "generic-runtime-trust.win32-x64.json"
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
