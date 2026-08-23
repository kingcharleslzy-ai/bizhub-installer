from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any


DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


def database_path() -> Path:
    return Path(os.getenv("BIZHUB_GENERIC_DATABASE_PATH", "/data/bizhub.db")).resolve()


def admin_path() -> Path:
    return Path(os.getenv("BIZHUB_ADMIN_CONFIG", "/data/admin.json")).resolve()


def secret_key_path() -> Path:
    return Path(os.getenv("BIZHUB_SECRET_KEY_FILE", "/config/secret-key")).resolve()


def company_config_path() -> Path:
    return Path(os.getenv("BIZHUB_COMPANY_CONFIG", "/config/company.json")).resolve()


def common_root() -> Path:
    return Path(os.getenv("BIZHUB_COMMON_ROOT", "/opt/bizhub")).resolve()


def common_manifest_path() -> Path:
    return Path(
        os.getenv("BIZHUB_COMMON_MANIFEST", "/opt/bizhub/bizhub-common-manifest.json")
    ).resolve()


def company_profile() -> dict[str, Any]:
    return json.loads(company_config_path().read_text(encoding="utf-8"))


def cookie_secure() -> bool:
    return os.getenv("BIZHUB_COOKIE_SECURE", "1").strip().lower() not in {"0", "false", "no"}


def common_identity() -> dict[str, str]:
    manifest = json.loads(common_manifest_path().read_text(encoding="utf-8"))
    digest = os.getenv("BIZHUB_CORE_ARTIFACT_DIGEST", "").strip()
    if not DIGEST_PATTERN.fullmatch(digest):
        raise RuntimeError("core_artifact_digest_invalid")
    if digest != manifest.get("core_artifact_digest"):
        raise RuntimeError("core_artifact_digest_drift")
    if manifest.get("artifact_id") != "bizhub-common":
        raise RuntimeError("core_artifact_id_invalid")
    source_commit = str(manifest.get("source_commit") or "")
    if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
        raise RuntimeError("core_artifact_source_commit_invalid")
    return {
        "artifact_id": "bizhub-common",
        "core_artifact_digest": digest,
        "core_source_commit": source_commit,
        "allowlist_tree_digest": str(manifest["allowlist_tree_digest"]),
    }
