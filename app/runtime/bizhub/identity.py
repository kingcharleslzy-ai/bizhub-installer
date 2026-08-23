from __future__ import annotations

import json
import os
import re

from .config import common_identity


def runtime_identity() -> dict[str, str]:
    profile_id = os.getenv("BIZHUB_RUNTIME_PROFILE_ID", "generic-kernel-smoke").strip()
    if not re.fullmatch(r"[a-z][a-z0-9.-]{0,63}", profile_id):
        raise RuntimeError("runtime_profile_id_invalid")
    payload = {**common_identity(), "runtime_profile_id": profile_id}
    if profile_id != "generic-kernel-smoke":
        private_commit = os.getenv("BIZHUB_PRIVATE_EXTENSION_COMMIT", "").strip()
        if not re.fullmatch(r"[0-9a-f]{40}", private_commit):
            raise RuntimeError("private_source_commit_invalid")
        payload["private_source_commit"] = private_commit
    elif os.getenv("BIZHUB_PRIVATE_EXTENSION_COMMIT", "").strip():
        raise RuntimeError("private_source_commit_unexpected")
    return payload


def main() -> None:
    print(json.dumps(runtime_identity(), sort_keys=True))


if __name__ == "__main__":
    main()
