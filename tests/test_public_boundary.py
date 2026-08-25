from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKIP_PARTS = {
    ".git",
    ".runtime-venv",
    ".venv",
    "__pycache__",
    "dist",
    "node_modules",
    "out",
    "runtime-build",
    "runtime-dist",
    "static",
}


def public_files():
    for path in ROOT.rglob("*"):
        if path.is_file() and path.name != "package-lock.json" and not any(part in SKIP_PARTS for part in path.parts):
            yield path


def test_private_company_terms_are_absent():
    forbidden = [
        "biz" + "-data-hub",
        "123" + "crystal.com",
        "K" + "TP",
        "L" + "BO",
        "高" + "意",
        "腾" + "讯云",
    ]
    findings = []
    for path in public_files():
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for value in forbidden:
            if value.casefold() in text.casefold():
                findings.append(f"{path.relative_to(ROOT)}:{value}")
    assert findings == []


def test_no_likely_secret_material_is_committed():
    patterns = [
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
        re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"),
        re.compile(r"AKIA[0-9A-Z]{16}"),
    ]
    findings = []
    for path in public_files():
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if any(pattern.search(text) for pattern in patterns):
            findings.append(str(path.relative_to(ROOT)))
    assert findings == []


def test_public_core_does_not_import_from_private_paths():
    import_roots = [ROOT / "app", ROOT / "bizhubctl", ROOT / "plugins"]
    text = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for root in import_roots
        for path in ([root] if root.is_file() else root.rglob("*"))
        if path.is_file() and not any(part in SKIP_PARTS for part in path.parts)
    )
    assert "PYTHONPATH" not in text
    assert "master_data_service" not in text
    assert "schema_migrations" not in text
