from __future__ import annotations

import json
import os
import re
import stat
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "bizhub-core"


class DistributionShapeTests(unittest.TestCase):
    def test_agent_install_entrypoint_is_pinned_and_unambiguous(self) -> None:
        marketplace = json.loads(
            (ROOT / ".agents" / "plugins" / "marketplace.json").read_text(encoding="utf-8")
        )
        self.assertEqual(marketplace["name"], "bizhub-public")
        self.assertEqual([item["name"] for item in marketplace["plugins"]], ["bizhub-core"])

        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        bootstrap = (ROOT / "install" / "bootstrap.yaml").read_text(encoding="utf-8")
        self.assertIn("--ref <VERIFIED_COMMIT>", readme)
        self.assertIn("codex plugin add bizhub-core@bizhub-public", readme)
        self.assertNotIn("--ref main", readme)
        self.assertIn("required_ref: verified_40_character_release_commit", bootstrap)
        self.assertIn("plugin_selector: bizhub-core@bizhub-public", bootstrap)

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

    def test_installer_and_mcp_are_executable(self) -> None:
        for path in [ROOT / "bizhubctl", PLUGIN / "scripts" / "bizhub_mcp.py"]:
            self.assertTrue(path.stat().st_mode & stat.S_IXUSR)

    def test_no_extra_plugin_execution_surfaces(self) -> None:
        allowed = {
            PLUGIN / "scripts" / "bizhub_mcp.py",
            PLUGIN / "skills" / "bizhub-bootstrap" / "SKILL.md",
        }
        executable_files = {
            path for path in PLUGIN.rglob("*")
            if path.is_file() and path.stat().st_mode & stat.S_IXUSR
        }
        self.assertEqual(executable_files, {PLUGIN / "scripts" / "bizhub_mcp.py"})

    def test_preview_version_is_consistent_across_delivery_surfaces(self) -> None:
        version = "0.7.0-preview.1"
        plugin = json.loads((PLUGIN / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))
        frontend = json.loads((ROOT / "app/frontend/package.json").read_text(encoding="utf-8"))
        bootstrap = (ROOT / "install/bootstrap.yaml").read_text(encoding="utf-8")
        installer = (ROOT / "bizhubctl").read_text(encoding="utf-8")
        backend = (ROOT / "app/backend/bizhub/__init__.py").read_text(encoding="utf-8")
        mcp = (PLUGIN / "scripts/bizhub_mcp.py").read_text(encoding="utf-8")

        self.assertEqual(plugin["version"], version)
        self.assertEqual(frontend["version"], version)
        self.assertRegex(bootstrap, rf"(?m)^status: implementation_preview$")
        self.assertRegex(bootstrap, rf"(?m)^  release_tag: v{re.escape(version)}$")
        self.assertIn(f'VERSION = "{version}"', installer)
        self.assertIn(f'__version__ = "{version}"', backend)
        self.assertIn(f'RELEASE_TAG = "v{version}"', mcp)
        self.assertIn('"maturity": "implementation_preview"', mcp)

    def test_release_workflow_derives_preview_version_from_the_tag_and_manifest(self) -> None:
        workflow = (ROOT / ".github/workflows/release-e2e.yml").read_text(encoding="utf-8")
        self.assertIn('release_version="${release_tag#v}"', workflow)
        self.assertIn('release/plugins/bizhub-core/.codex-plugin/plugin.json', workflow)
        self.assertNotRegex(workflow, r'test .* = "?\d+\.\d+\.\d+-preview\.\d+')


if __name__ == "__main__":
    unittest.main()
