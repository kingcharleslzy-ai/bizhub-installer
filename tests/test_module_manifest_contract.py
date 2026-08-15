from __future__ import annotations

import json
from pathlib import Path

from bizhub.modules import ModuleManifest


ROOT = Path(__file__).resolve().parents[1]


def test_customer_module_example_matches_runtime_contract():
    schema = json.loads((ROOT / "schemas" / "module-manifest.v1.schema.json").read_text(encoding="utf-8"))
    example = json.loads((ROOT / "examples" / "customer-quality-module.example.json").read_text(encoding="utf-8"))
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["properties"]["schema_version"]["const"] == "bizhub.module-manifest.v1"
    assert ModuleManifest.model_validate(example).model_dump(mode="json") == example
