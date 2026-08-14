from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "bizhub-core"


class DistributionShapeTests(unittest.TestCase):
    def test_exactly_one_mcp_server(self) -> None:
        payload = json.loads((PLUGIN / ".mcp.json").read_text(encoding="utf-8"))
        self.assertEqual(list(payload), ["mcpServers"])
        self.assertEqual(list(payload["mcpServers"]), ["bizhub-mcp"])

    def test_exactly_one_bizhub_managed_skill(self) -> None:
        skill_root = PLUGIN / "skills"
        skill_dirs = sorted(path.name for path in skill_root.iterdir() if path.is_dir())
        self.assertEqual(skill_dirs, ["bizhub-bootstrap"])
        skill_files = list(ROOT.rglob("SKILL.md"))
        self.assertEqual(
            skill_files,
            [skill_root / "bizhub-bootstrap" / "SKILL.md"],
        )

    def test_plugin_has_no_hooks_or_apps(self) -> None:
        payload = json.loads(
            (PLUGIN / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
        )
        self.assertNotIn("hooks", payload)
        self.assertNotIn("apps", payload)
        self.assertEqual(payload["skills"], "./skills/")
        self.assertEqual(payload["mcpServers"], "./.mcp.json")

    def test_extension_guide_is_documentation_only(self) -> None:
        guide = ROOT / "docs" / "customer-skill-extension.md"
        self.assertTrue(guide.is_file())
        self.assertFalse((guide.parent / "SKILL.md").exists())


if __name__ == "__main__":
    unittest.main()
