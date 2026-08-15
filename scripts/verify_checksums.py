#!/usr/bin/env python3
from __future__ import annotations

import hashlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHECKSUMS = ROOT / "install/CHECKSUMS.sha256"


def main() -> None:
    failures = []
    for line in CHECKSUMS.read_text(encoding="utf-8").splitlines():
        expected, separator, name = line.partition("  ")
        path = (ROOT / name).resolve()
        if not separator or not path.is_relative_to(ROOT) or not path.is_file():
            failures.append(name or line)
            continue
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            failures.append(name)
    if failures:
        raise SystemExit("checksum verification failed: " + ", ".join(failures))
    print(f"verified {len(CHECKSUMS.read_text(encoding='utf-8').splitlines())} files")


if __name__ == "__main__":
    main()
