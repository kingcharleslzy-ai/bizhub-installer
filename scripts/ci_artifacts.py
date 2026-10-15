#!/usr/bin/env python3
"""Runner-local, source-bound CI records. No GitHub artifact/cache storage."""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def record_path(root: Path, commit: str, run_id: str, attempt: str, name: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("ci_record_commit_invalid")
    if not all(re.fullmatch(r"[1-9][0-9]*", value) for value in (run_id, attempt)):
        raise ValueError("ci_record_run_invalid")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,100}", name):
        raise ValueError("ci_record_name_invalid")
    return root / commit / f"{run_id}-{attempt}" / name


def verify(directory: Path, args: argparse.Namespace) -> dict:
    manifest = directory / "ci-record.json"
    if manifest.is_symlink() or not manifest.is_file():
        raise ValueError("ci_record_manifest_invalid")
    if digest(manifest) != args.digest:
        raise ValueError("ci_record_manifest_digest_mismatch")
    data = json.loads(manifest.read_text())
    for key, value in (("schema_version", "bizhub.ci-record.v1"), ("repository", args.repository),
                       ("commit", args.commit), ("run_id", args.run_id),
                       ("attempt", args.attempt), ("name", args.name)):
        if data.get(key) != value:
            raise ValueError(f"ci_record_identity_mismatch:{key}")
    expected = {"ci-record.json"}
    for item in data["files"]:
        name = item["name"]
        if Path(name).name != name or any(c in name for c in "\\/:\0") or name in expected or name in (".", ".."):
            raise ValueError("ci_record_file_name_invalid")
        expected.add(name)
        target = directory / name
        if target.is_symlink() or not target.is_file() or target.stat().st_size != item["bytes"] or digest(target) != item["sha256"]:
            raise ValueError(f"ci_record_file_digest_mismatch:{name}")
    if not data["files"] or {p.name for p in directory.iterdir()} != expected:
        raise ValueError("ci_record_file_set_mismatch")
    return data


def windows_read_request(command: str) -> argparse.Namespace:
    # OpenSSH forced-command entry: no shell, paths, writes, or other repos.
    match = re.fullmatch(r"read ([0-9a-f]{40}) ([1-9][0-9]*) ([1-9][0-9]*) (internal-windows|signed-windows) ([0-9a-f]{64})", command)
    if not match:
        raise ValueError("ci_record_read_request_invalid")
    return argparse.Namespace(commit=match[1], run_id=match[2], attempt=match[3], name=match[4],
                              digest=match[5], repository="kingcharleslzy-ai/bizhub-installer")


def serve_windows() -> None:
    args = windows_read_request(os.environ.get("SSH_ORIGINAL_COMMAND", ""))
    root = Path("D:/bizhub-installer-ci-records")
    directory = record_path(root, args.commit, args.run_id, args.attempt, args.name)
    for part in (*reversed(directory.parents), directory, *directory.iterdir()):
        if part.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError("ci_record_reparse_point_refused")
    data = verify(directory, args)
    # tarfile only reads the verified flat file set. Never accept a client path.
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        for name in ["ci-record.json", *(item["name"] for item in data["files"])]:
            archive.add(directory / name, arcname=name, recursive=False)


def receive_windows(args: argparse.Namespace) -> None:
    host = "installer-artifacts-windows"
    request = f"read {args.commit} {args.run_id} {args.attempt} {args.name} {args.digest}"
    windows_read_request(request)
    stage = Path(tempfile.mkdtemp(prefix=".ci-read-", dir=args.output.parent))
    try:
        with subprocess.Popen(["ssh", "-F", str(Path.home() / ".ssh/bizhub-installer-artifacts.conf"),
                               "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", host, request],
                              stdout=subprocess.PIPE) as process:
            try:
                with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
                    for item in archive:
                        if not item.isfile() or Path(item.name).name != item.name or any(c in item.name for c in "\\/:\0") or item.name in (".", "..") or (stage / item.name).exists():
                            raise ValueError("ci_record_archive_member_invalid")
                        with archive.extractfile(item) as source, (stage / item.name).open("xb") as target:
                            shutil.copyfileobj(source, target)
                if process.wait() != 0:
                    raise ValueError("ci_record_transport_failed")
            except BaseException:
                process.kill()
                raise
        verify(stage, args)
        stage.rename(args.output)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def emit(name: str, value: str) -> None:
    print(f"{name}={value}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            stream.write(f"{name}={value}\n")


def prune(root: Path) -> None:
    # Only complete records created by this authority are eligible. Incomplete
    # staging directories and unknown files are never recursively removed.
    for manifest in root.glob("*/*/*/ci-record.json"):
        data = json.loads(manifest.read_text())
        if data.get("schema_version") != "bizhub.ci-record.v1":
            continue
        days = 7 if data["name"].startswith("synthetic-") else 30
        if time.time() - data["created_at"] <= days * 86400:
            continue
        expected = record_path(root, data["commit"], data["run_id"], data["attempt"], data["name"])
        if expected == manifest.parent and data["repository"] == "kingcharleslzy-ai/bizhub-installer":
            shutil.rmtree(expected)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("store", "read", "prune", "serve-windows"))
    default_root = "D:/bizhub-installer-ci-records" if os.name == "nt" else str(Path.home() / ".local/share/bizhub-installer/ci-records")
    parser.add_argument("--root", type=Path, default=os.environ.get("BIZHUB_CI_RECORDS_ROOT", default_root))
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", "kingcharleslzy-ai/bizhub-installer"))
    parser.add_argument("--commit", default=os.environ.get("GITHUB_SHA"))
    parser.add_argument("--run-id", default=os.environ.get("GITHUB_RUN_ID"))
    parser.add_argument("--attempt", default=os.environ.get("GITHUB_RUN_ATTEMPT"))
    parser.add_argument("--name")
    parser.add_argument("--digest")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--windows", action="store_true")
    parser.add_argument("files", nargs="*")
    args = parser.parse_args()
    if args.command == "serve-windows":
        serve_windows()
        return
    if args.command == "prune":
        prune(args.root)
        return
    directory = record_path(args.root, args.commit, args.run_id, args.attempt, args.name)
    if args.command == "store":
        directory.parent.mkdir(parents=True, exist_ok=True)
        stage = Path(tempfile.mkdtemp(prefix=".staging-", dir=directory.parent))
        try:
            files = []
            for pattern in args.files:
                matches = sorted(glob.glob(pattern))
                if not matches:
                    raise ValueError(f"ci_record_input_missing:{pattern}")
                for match in matches:
                    source = Path(match)
                    if source.is_symlink() or not source.is_file() or (stage / source.name).exists() or source.name == "ci-record.json":
                        raise ValueError("ci_record_input_invalid")
                    shutil.copyfile(source, stage / source.name)
                    files.append({"name": source.name, "sha256": digest(stage / source.name), "bytes": source.stat().st_size})
            if not files:
                raise ValueError("ci_record_inputs_empty")
            manifest = {"schema_version": "bizhub.ci-record.v1", "repository": args.repository,
                        "commit": args.commit, "run_id": args.run_id, "attempt": args.attempt,
                        "name": args.name, "created_at": time.time(), "files": sorted(files, key=lambda x: x["name"])}
            (stage / "ci-record.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
            args.digest = digest(stage / "ci-record.json")
            verify(stage, args)
            # A same-attempt rerun never silently replaces an approved record.
            stage.rename(directory)
            emit("record-digest", args.digest)
            emit("record-path", str(directory))
            emit("record-attempt", args.attempt)
            prune(args.root)
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    else:
        if not args.digest or not re.fullmatch(r"[0-9a-f]{64}", args.digest):
            raise ValueError("ci_record_expected_digest_required")
        if not args.output:
            raise ValueError("ci_record_output_required")
        if args.output.exists():
            raise ValueError("ci_record_output_exists")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        if args.windows:
            receive_windows(args)
        else:
            verify(directory, args)
            shutil.copytree(directory, args.output)
        verify(args.output, args)


if __name__ == "__main__":
    main()
