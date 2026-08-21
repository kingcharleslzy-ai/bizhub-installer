from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "bizhub-core"
MCP_CONFIG = json.loads((PLUGIN / ".mcp.json").read_text(encoding="utf-8"))["mcpServers"]["bizhub-mcp"]


class McpSession:
    def __init__(self, env: dict[str, str] | None = None):
        self.env = env or {}

    def __enter__(self) -> "McpSession":
        self.process = subprocess.Popen(
            [MCP_CONFIG["command"], *MCP_CONFIG["args"]], cwd=PLUGIN / MCP_CONFIG.get("cwd", "."),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env={**os.environ, **self.env},
        )
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.process.stdin.close()
        self.process.wait(timeout=3)
        stderr = self.process.stderr.read()
        self.process.stdout.close(); self.process.stderr.close()
        if self.process.returncode != 0:
            raise AssertionError(stderr)

    def request(self, request_id: int, method: str, params=None):
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self.process.stdin.write(json.dumps(message) + "\n"); self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())

    def tool(self, request_id: int, name: str, arguments: dict | None = None):
        return self.request(request_id, "tools/call", {"name": name, "arguments": arguments or {}})["result"]


class FakeBizHub(BaseHTTPRequestHandler):
    calls: list[tuple[str, dict]] = []

    def log_message(self, *_):
        return

    def _json(self, status: int, payload: dict | list, cookie: bool = False):
        body = json.dumps(payload).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json")
        if cookie:
            self.send_header("Set-Cookie", "bizhub_session=test; HttpOnly; SameSite=Strict; Path=/")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/health":
            return self._json(200, {"status": "ok", "version": "0.5.0-preview.1"})
        if self.headers.get("Cookie") != "bizhub_session=test":
            return self._json(401, {"detail": "authentication required"})
        endpoints = {
            "/api/resources/catalog": {"products": []},
            "/api/orders/sale": [],
            "/api/orders/purchase": [],
            "/api/inventory": {"balances": []},
            "/api/audit?limit=200": [],
            "/api/system/modules": {"schema_version": "bizhub.system-map.v1", "modules": []},
            "/api/external-records?source_id=synthetic-master-v1&resource_type=party&limit=10": {
                "schema_version": "bizhub.external-mapping-readback.v1",
                "items": [{"external_id": "party:1", "entity_id": 7}],
            },
        }
        return self._json(200, endpoints.get(self.path, {}))

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        self.calls.append((self.path, body))
        if self.path == "/api/auth/login":
            return self._json(200, {"username": "admin"}, cookie=True)
        if self.headers.get("X-BizHub-Request") != "1" or self.headers.get("Cookie") != "bizhub_session=test":
            return self._json(403, {"detail": "rejected"})
        if self.path == "/api/actions/preview":
            return self._json(200, {"status": "ready", "preview_token": "x" * 80})
        if self.path == "/api/actions/apply":
            return self._json(200, {"status": "applied", "readback": {"id": 1}})
        if self.path == "/api/imports/reconcile/preview":
            return self._json(200, {"status": "ready", "preview_token": "r" * 80, "changes": [{"entity_id": 7}]})
        if self.path == "/api/imports/reconcile/apply":
            return self._json(200, {"status": "applied", "entities": [{"entity_id": 7}]})
        return self._json(404, {"detail": "missing"})


class BizHubMcpTests(unittest.TestCase):
    def test_exact_bounded_tool_catalog(self):
        with McpSession() as session:
            initialized = session.request(1, "initialize", {"protocolVersion": "2099", "capabilities": {}})
            self.assertEqual(initialized["result"]["protocolVersion"], "2024-11-05")
            listed = session.request(2, "tools/list")["result"]["tools"]
        self.assertEqual([tool["name"] for tool in listed], [
            "bizhub_bootstrap_status", "bizhub_bootstrap_questions", "bizhub_target_preflight",
            "bizhub_instance_health", "bizhub_resource_query", "bizhub_action_preview", "bizhub_action_apply",
        ])
        for tool in listed:
            schema = json.dumps(tool["inputSchema"])
            self.assertNotIn("url", schema.lower())
            self.assertNotIn("shell", schema.lower())
        self.assertFalse(listed[-1]["annotations"]["readOnlyHint"])

    def test_bootstrap_is_short_and_reports_real_boundary(self):
        with McpSession() as session:
            status = session.tool(1, "bizhub_bootstrap_status")["structuredContent"]
            questions = session.tool(2, "bizhub_bootstrap_questions", {"stage": "deployment"})["structuredContent"]
            preflight = session.tool(3, "bizhub_target_preflight")["structuredContent"]
        self.assertEqual(status["deployment_model"], "one_company_one_instance")
        self.assertEqual(status["maturity"], "implementation_preview")
        self.assertLessEqual(len(questions["questions"]), 2)
        self.assertFalse(preflight["target_verified"])
        self.assertEqual(preflight["scope"], "mcp_host_only")

    def test_instance_reads_preview_and_apply_use_only_configured_origin(self):
        FakeBizHub.calls = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), FakeBizHub)
        thread = Thread(target=server.serve_forever, daemon=True); thread.start()
        with tempfile.TemporaryDirectory() as temporary:
            password = Path(temporary) / "password"
            password.write_text("correct horse battery staple\n", encoding="utf-8")
            password.chmod(0o600)
            env = {
                "BIZHUB_INSTANCE_URL": f"http://127.0.0.1:{server.server_port}",
                "BIZHUB_ADMIN_USERNAME": "admin",
                "BIZHUB_ADMIN_PASSWORD_FILE": str(password),
            }
            with McpSession(env) as session:
                health = session.tool(1, "bizhub_instance_health")["structuredContent"]
                catalog = session.tool(2, "bizhub_resource_query", {"resource": "catalog"})["structuredContent"]
                system_map = session.tool(3, "bizhub_resource_query", {"resource": "system_map"})["structuredContent"]
                mappings = session.tool(4, "bizhub_resource_query", {"resource": "external_mappings", "source_id": "synthetic-master-v1", "resource_type": "party", "limit": 10})["structuredContent"]
                preview = session.tool(5, "bizhub_action_preview", {"action": "create_unit", "data": {"code": "pcs", "display_name": "Pieces", "dimension": "count"}})["structuredContent"]
                applied = session.tool(6, "bizhub_action_apply", {"action": "create_unit", "data": {"code": "pcs", "display_name": "Pieces", "dimension": "count"}, "preview_token": preview["preview_token"], "review_note": "confirmed in test"})["structuredContent"]
                reconcile_data = {"resource": "party", "source_id": "synthetic-master-v1", "records": [{"external_id": "party:1", "canonical_name": "Renamed", "roles": ["customer"], "status": "active"}]}
                reconcile_preview = session.tool(7, "bizhub_action_preview", {"action": "reconcile_master_data", "data": reconcile_data})["structuredContent"]
                reconciled = session.tool(8, "bizhub_action_apply", {"action": "reconcile_master_data", "data": reconcile_data, "preview_token": reconcile_preview["preview_token"], "review_note": "confirmed reconcile"})["structuredContent"]
        server.shutdown(); server.server_close(); thread.join(timeout=2)
        self.assertEqual(health["status"], "ok")
        self.assertEqual(catalog, {"products": []})
        self.assertEqual(system_map["schema_version"], "bizhub.system-map.v1")
        self.assertEqual(mappings["items"][0]["external_id"], "party:1")
        self.assertEqual(applied["status"], "applied")
        self.assertEqual(reconciled["entities"][0]["entity_id"], 7)
        self.assertEqual([call[0] for call in FakeBizHub.calls], ["/api/auth/login", "/api/actions/preview", "/api/actions/apply", "/api/imports/reconcile/preview", "/api/imports/reconcile/apply"])
        self.assertEqual(FakeBizHub.calls[-2][1], reconcile_data)
        self.assertEqual(FakeBizHub.calls[-1][1]["preview_token"], "r" * 80)
        self.assertNotIn("correct horse", json.dumps([health, catalog, preview, applied, reconcile_preview, reconciled]))

    def test_missing_or_public_http_configuration_fails_closed(self):
        cases = [
            {},
            {"BIZHUB_INSTANCE_URL": "http://example.com", "BIZHUB_ADMIN_USERNAME": "admin", "BIZHUB_ADMIN_PASSWORD_FILE": "/missing"},
        ]
        for env in cases:
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True), McpSession(env) as session:
                result = session.tool(1, "bizhub_resource_query", {"resource": "catalog"})
                self.assertTrue(result["isError"])


if __name__ == "__main__":
    unittest.main()
