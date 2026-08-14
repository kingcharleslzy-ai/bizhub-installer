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

    def send_raw(self, payload):
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())


class BizHubMcpTests(unittest.TestCase):
    def test_initialize_and_list_tools(self) -> None:
        with McpSession() as session:
            initialized = session.request(
                1,
                "initialize",
                {
                    "protocolVersion": "2099-01-01",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            )
            self.assertEqual(initialized["result"]["serverInfo"]["name"], "bizhub-mcp")
            self.assertEqual(
                initialized["result"]["protocolVersion"],
                "2024-11-05",
            )

            listed = session.request(2, "tools/list")
            names = [tool["name"] for tool in listed["result"]["tools"]]
            self.assertEqual(
                names,
                [
                    "bizhub_bootstrap_status",
                    "bizhub_bootstrap_questions",
                    "bizhub_discover_local_host",
                    "bizhub_build_draft_plan",
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
            self.assertTrue(payload["local_host_discovery"])
            self.assertTrue(payload["draft_plan_generation"])

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

            access = session.request(
                2,
                "tools/call",
                {
                    "name": "bizhub_bootstrap_questions",
                    "arguments": {"stage": "access"},
                },
            )["result"]["structuredContent"]
            self.assertEqual(len(access["questions"]), 1)
            self.assertIsNone(access["next_stage"])
            self.assertEqual(access["next_action"], "build_draft_plan")

    def test_local_discovery_excludes_identifiers_and_secrets(self) -> None:
        with McpSession() as session:
            response = session.request(
                1,
                "tools/call",
                {"name": "bizhub_discover_local_host", "arguments": {}},
            )
            payload = response["result"]["structuredContent"]
            self.assertEqual(payload["scope"], "agent_host_only")
            self.assertFalse(payload["target_host_verified"])
            self.assertGreaterEqual(payload["disk_free_bytes"], 0)
            self.assertGreaterEqual(payload["cpu_count"], 0)
            self.assertEqual(
                set(payload["excluded"]),
                {
                    "hostname",
                    "username",
                    "home_directory",
                    "ip_addresses",
                    "environment_variables",
                    "files",
                    "secrets",
                },
            )
            for forbidden in payload["excluded"]:
                self.assertNotIn(forbidden, payload)

    def test_draft_plan_is_deterministic_and_non_executable(self) -> None:
        arguments = {
            "installation_goal": "new_trial",
            "topology": "cloud",
            "access_mode": "domain",
        }
        with McpSession() as session:
            first = session.request(
                1,
                "tools/call",
                {"name": "bizhub_build_draft_plan", "arguments": arguments},
            )["result"]["structuredContent"]
            second = session.request(
                2,
                "tools/call",
                {"name": "bizhub_build_draft_plan", "arguments": arguments},
            )["result"]["structuredContent"]

            self.assertEqual(first["plan_fingerprint"], second["plan_fingerprint"])
            self.assertEqual(first["selection"], arguments)
            self.assertFalse(first["ready_for_apply"])
            self.assertFalse(first["real_customer_data_allowed"])
            self.assertFalse(first["secret_values_accepted"])
            self.assertEqual(first["mutations"], [])
            self.assertIn(
                "run_read_only_remote_target_preflight",
                first["required_followups"],
            )
            self.assertEqual(
                first["steps"][-1]["status"],
                "unavailable_in_preview",
            )

    def test_draft_plan_rejects_incomplete_invalid_or_extra_inputs(self) -> None:
        cases = [
            {
                "installation_goal": "new_trial",
                "topology": "cloud",
            },
            {
                "installation_goal": "new_trial",
                "topology": "unsupported",
                "access_mode": "domain",
            },
            {
                "installation_goal": "new_trial",
                "topology": "cloud",
                "access_mode": "domain",
                "hostname": "not-accepted",
            },
        ]
        with McpSession() as session:
            for request_id, arguments in enumerate(cases, start=1):
                with self.subTest(arguments=arguments):
                    response = session.request(
                        request_id,
                        "tools/call",
                        {
                            "name": "bizhub_build_draft_plan",
                            "arguments": arguments,
                        },
                    )
                    self.assertTrue(response["result"]["isError"])

    def test_draft_plan_followups_match_each_topology(self) -> None:
        cases = {
            "cloud": {"run_read_only_remote_target_preflight"},
            "local_24x7": {"confirm_24x7_power_sleep_backup_and_network"},
            "hybrid": {
                "run_read_only_remote_target_preflight",
                "confirm_24x7_power_sleep_backup_and_network",
            },
        }
        with McpSession() as session:
            for request_id, (topology, expected) in enumerate(cases.items(), start=1):
                response = session.request(
                    request_id,
                    "tools/call",
                    {
                        "name": "bizhub_build_draft_plan",
                        "arguments": {
                            "installation_goal": "new_trial",
                            "topology": topology,
                            "access_mode": "private_network",
                        },
                    },
                )
                followups = set(
                    response["result"]["structuredContent"]["required_followups"]
                )
                self.assertTrue(expected.issubset(followups))

    def test_malformed_request_does_not_stop_server(self) -> None:
        with McpSession() as session:
            invalid = session.send_raw([])
            self.assertEqual(invalid["error"]["code"], -32600)
            ping = session.request(2, "ping")
            self.assertEqual(ping["result"], {})


if __name__ == "__main__":
    unittest.main()
