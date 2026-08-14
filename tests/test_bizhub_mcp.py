from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "bizhub-core"
MCP_CONFIG = json.loads((PLUGIN / ".mcp.json").read_text(encoding="utf-8"))[
    "mcpServers"
]["bizhub-mcp"]


class McpSession:
    def __enter__(self) -> "McpSession":
        self.process = subprocess.Popen(
            [MCP_CONFIG["command"], *MCP_CONFIG["args"]],
            cwd=PLUGIN / MCP_CONFIG.get("cwd", "."),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        assert self.process.stderr is not None
        self.process.stdin.close()
        self.process.wait(timeout=3)
        stderr = self.process.stderr.read()
        self.process.stdout.close()
        self.process.stderr.close()
        if self.process.returncode != 0:
            raise AssertionError(stderr)

    def request(self, request_id: int, method: str, params=None):
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())


class BizHubMcpTests(unittest.TestCase):
    def test_initialize_and_list_tools(self) -> None:
        with McpSession() as session:
            initialized = session.request(
                1,
                "initialize",
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            )
            self.assertEqual(initialized["result"]["serverInfo"]["name"], "bizhub-mcp")

            listed = session.request(2, "tools/list")
            names = [tool["name"] for tool in listed["result"]["tools"]]
            self.assertEqual(
                names,
                [
                    "bizhub_bootstrap_status",
                    "bizhub_bootstrap_questions",
                    "bizhub_repository_info",
                ],
            )
            self.assertTrue(
                all(
                    tool["annotations"]["readOnlyHint"]
                    for tool in listed["result"]["tools"]
                )
            )

    def test_status_is_explicitly_non_production(self) -> None:
        with McpSession() as session:
            response = session.request(
                1,
                "tools/call",
                {"name": "bizhub_bootstrap_status", "arguments": {}},
            )
            payload = response["result"]["structuredContent"]
            self.assertFalse(payload["production_backend_install"])
            self.assertFalse(payload["production_frontend_deploy"])
            self.assertFalse(payload["real_customer_data_allowed"])

    def test_questions_are_bounded_and_stateless(self) -> None:
        with McpSession() as session:
            response = session.request(
                1,
                "tools/call",
                {
                    "name": "bizhub_bootstrap_questions",
                    "arguments": {"stage": "deployment"},
                },
            )
            payload = response["result"]["structuredContent"]
            self.assertLessEqual(len(payload["questions"]), 3)
            self.assertEqual(payload["next_stage"], "access")


if __name__ == "__main__":
    unittest.main()
