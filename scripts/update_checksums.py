#!/usr/bin/env python3
from __future__ import annotations

import hashlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "install/CHECKSUMS.sha256"
SKIP_PARTS = {".git", ".venv", ".pytest_cache", "node_modules", "__pycache__", "static"}


def included(path: Path) -> bool:
    return (
        path.is_file()
        and path != OUTPUT
        and path.name != ".DS_Store"
        and not any(part in SKIP_PARTS for part in path.relative_to(ROOT).parts)
    )


def main() -> None:
    lines = []
    for path in sorted((path for path in ROOT.rglob("*") if included(path)), key=lambda item: item.relative_to(ROOT).as_posix()):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        lines.append(f"{digest}  {path.relative_to(ROOT).as_posix()}")
    OUTPUT.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
