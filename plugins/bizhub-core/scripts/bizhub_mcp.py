#!/usr/bin/env python3
"""Small stdio MCP bridge for one configured BizHub instance."""

from __future__ import annotations

import http.cookiejar
import ipaddress
import json
import os
import platform
import shutil
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener

SERVER_INFO = {"name": "bizhub-mcp", "version": "0.7.0-preview.2"}
REPOSITORY_URL = "https://github.com/kingcharleslzy-ai/bizhub-installer"
RELEASE_TAG = "v0.7.0-preview.2"
PROTOCOL_VERSION = "2024-11-05"
ACTION_NAMES = ["master_data", "inventory", "procurement", "sales"]
STATUS = {
    "maturity": "implementation_preview",
    "repository": REPOSITORY_URL,
    "release": RELEASE_TAG,
    "deployment_model": "one_company_one_instance",
    "supported_target": "Ubuntu 24.04 with Docker Engine",
    "production_install_requires": [
        "pinned_release_verification", "target_preflight", "approved_plan_hash",
        "successful_install_verify", "verified_backup_and_restore",
    ],
    "arbitrary_shell": False,
    "arbitrary_url": False,
    "database_direct_write": False,
    "secret_values_in_tool_arguments": False,
}
QUESTION_STAGES: dict[str, dict[str, Any]] = {
    "deployment": {
        "questions": [
            {"id": "installation_goal", "question": "Is this a new installation or a migration?", "choices": ["new_install", "migration"]},
            {"id": "target", "question": "Will the Ubuntu 24.04 host be a cloud server or a 24/7 local Linux host?", "choices": ["cloud", "local_24x7"]},
        ],
        "next_stage": "access",
    },
    "access": {
        "questions": [
            {"id": "access", "question": "Use loopback-only access, a private address, an HTTPS domain, or Cloudflare Tunnel?", "choices": ["loopback", "private", "domain", "cloudflare"]},
        ],
        "next_stage": "company",
    },
    "company": {
        "questions": [
            {"id": "company", "question": "Provide legal/display name, timezone, currency, brand mark, and administrator username. Do not provide the password in chat."},
            {"id": "first_data", "question": "Which CSV, JSON, ERP, or API source should be mapped first after verification?"},
        ],
        "next_stage": None,
    },
}


def annotations(read_only: bool) -> dict[str, bool]:
    return {"readOnlyHint": read_only, "destructiveHint": False, "idempotentHint": read_only, "openWorldHint": False}


TOOLS = [
    {"name": "bizhub_bootstrap_status", "description": "Return the fixed release boundary and required deployment gates.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}, "annotations": annotations(True)},
    {"name": "bizhub_bootstrap_questions", "description": "Return one short stage of the BizHub setup interview.", "inputSchema": {"type": "object", "properties": {"stage": {"type": "string", "enum": list(QUESTION_STAGES)}}, "required": ["stage"], "additionalProperties": False}, "annotations": annotations(True)},
    {"name": "bizhub_target_preflight", "description": "Return non-sensitive facts about this host before running bizhubctl preflight on the deployment target.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}, "annotations": annotations(True)},
    {"name": "bizhub_instance_health", "description": "Read health from the one BizHub instance configured in the MCP environment.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}, "annotations": annotations(True)},
    {"name": "bizhub_resource_query", "description": "Read one bounded common-core projection or identity map from the configured BizHub instance.", "inputSchema": {"type": "object", "properties": {"resource": {"type": "string", "enum": ["locations", "sales", "procurement", "inventory", "system_map", "profile"]}, "limit": {"type": "integer", "minimum": 1, "maximum": 500}}, "required": ["resource"], "additionalProperties": False}, "annotations": annotations(True)},
    {"name": "bizhub_action_preview", "description": "Preview one typed common-core Owner action without writing state.", "inputSchema": {"type": "object", "properties": {"action": {"type": "string", "enum": ACTION_NAMES}, "data": {"type": "object"}}, "required": ["action", "data"], "additionalProperties": False}, "annotations": annotations(True)},
    {"name": "bizhub_action_apply", "description": "Apply exactly one typed common-core preview and return Owner readback.", "inputSchema": {"type": "object", "properties": {"action": {"type": "string", "enum": ACTION_NAMES}, "preview": {"type": "object"}}, "required": ["action", "preview"], "additionalProperties": False}, "annotations": annotations(False)},
]


def tool_result(payload: Any, *, is_error: bool = False) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, sort_keys=True)}], "structuredContent": payload, "isError": is_error}


def error_result(code: str, **details: Any) -> dict[str, Any]:
    return tool_result({"error": code, **details}, is_error=True)


def validate_arguments(arguments: dict[str, Any], allowed: set[str], required: set[str] | None = None) -> dict[str, Any] | None:
    unexpected = sorted(set(arguments) - allowed)
    if unexpected:
        return error_result("unexpected_arguments", fields=unexpected)
    missing = sorted((required or set()) - set(arguments))
    if missing:
        return error_result("missing_arguments", fields=missing)
    return None


def target_preflight() -> dict[str, Any]:
    release: dict[str, str] = {}
    path = Path("/etc/os-release")
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            key, marker, value = line.partition("=")
            if marker:
                release[key] = value.strip().strip('"')
    return {
        "scope": "mcp_host_only",
        "os_family": platform.system().lower(),
        "os_release": {key: release.get(key, "") for key in ("ID", "VERSION_ID")},
        "architecture": platform.machine().lower(),
        "python_version": platform.python_version(),
        "disk_free_bytes": shutil.disk_usage(".").free,
        "docker_executable_present": shutil.which("docker") is not None,
        "target_verified": False,
        "next_action": "Run the pinned ./bizhubctl preflight on the actual Ubuntu target over the user's approved SSH session.",
    }


class InstanceClient:
    def __init__(self) -> None:
        raw = os.getenv("BIZHUB_INSTANCE_URL", "").strip().rstrip("/")
        parsed = urlparse(raw)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("BIZHUB_INSTANCE_URL must be a fixed origin without credentials or path")
        if parsed.scheme == "http":
            try:
                address = ipaddress.ip_address(parsed.hostname)
            except ValueError as exc:
                raise ValueError("plain HTTP is allowed only for an explicit private or loopback IP") from exc
            if not (address.is_private or address.is_loopback):
                raise ValueError("plain HTTP is forbidden for public instance addresses")
        self.base = raw + "/"
        self.username = os.getenv("BIZHUB_ADMIN_USERNAME", "").strip()
        self.password_file = Path(os.getenv("BIZHUB_ADMIN_PASSWORD_FILE", ""))
        self.opener = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.authenticated = False

    def request(self, path: str, payload: dict[str, Any] | None = None, *, authenticate: bool = True) -> Any:
        if not path.startswith("/api/") or "://" in path:
            raise ValueError("MCP endpoint is outside the fixed BizHub API")
        if authenticate and not self.authenticated:
            if not self.username or not self.password_file.is_file() or self.password_file.is_symlink():
                raise ValueError("instance username and password file must be configured outside tool arguments")
            if os.name == "posix" and self.password_file.stat().st_mode & 0o077:
                raise ValueError("instance password file must not be readable by group or other users")
            password = self.password_file.read_text(encoding="utf-8").rstrip("\r\n")
            self.request("/api/auth/login", {"username": self.username, "password": password}, authenticate=False)
            self.authenticated = True
        body = json.dumps(payload).encode() if payload is not None else None
        request = Request(urljoin(self.base, path.lstrip("/")), data=body, method="POST" if body is not None else "GET")
        request.add_header("Accept", "application/json")
        if body is not None:
            request.add_header("Content-Type", "application/json")
            request.add_header("X-BizHub-Request", "1")
        try:
            with self.opener.open(request, timeout=15) as response:
                return json.loads(response.read())
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:4000]
            raise ValueError(f"BizHub API rejected the request ({exc.code}): {detail}") from exc
        except (URLError, OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"BizHub instance request failed: {exc}") from exc


_CLIENT: InstanceClient | None = None


def instance_client() -> InstanceClient:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = InstanceClient()
    return _CLIENT


def handle_tool_call(params: Any) -> dict[str, Any]:
    if not isinstance(params, dict):
        return error_result("params_must_be_object")
    name = params.get("name")
    arguments = params.get("arguments") or {}
    if not isinstance(arguments, dict):
        return error_result("arguments_must_be_object")
    try:
        if name == "bizhub_bootstrap_status":
            error = validate_arguments(arguments, set())
            return error or tool_result(STATUS)
        if name == "bizhub_bootstrap_questions":
            error = validate_arguments(arguments, {"stage"}, {"stage"})
            if error:
                return error
            stage = arguments["stage"]
            return tool_result({"stage": stage, **QUESTION_STAGES[stage]}) if stage in QUESTION_STAGES else error_result("unknown_stage")
        if name == "bizhub_target_preflight":
            error = validate_arguments(arguments, set())
            return error or tool_result(target_preflight())
        if name == "bizhub_instance_health":
            error = validate_arguments(arguments, set())
            return error or tool_result(instance_client().request("/api/health", authenticate=False))
        if name == "bizhub_resource_query":
            error = validate_arguments(arguments, {"resource", "limit"}, {"resource"})
            if error:
                return error
            limit = int(arguments.get("limit", 100))
            endpoints = {
                "locations": "/api/master-data/locations",
                "sales": f"/api/sales/orders?limit={limit}",
                "procurement": f"/api/procurement/orders?limit={limit}",
                "inventory": f"/api/inventory/movements?limit={limit}",
                "system_map": "/api/system-map",
                "profile": "/api/profile",
            }
            endpoint = endpoints.get(arguments["resource"])
            return tool_result(instance_client().request(endpoint)) if endpoint else error_result("unknown_resource")
        if name in {"bizhub_action_preview", "bizhub_action_apply"}:
            required = {"action", "data"} if name.endswith("preview") else {"action", "preview"}
            error = validate_arguments(arguments, required, required)
            if error:
                return error
            body_key = "data" if name.endswith("preview") else "preview"
            if arguments["action"] not in ACTION_NAMES or not isinstance(arguments[body_key], dict):
                return error_result("invalid_action_input")
            bases = {
                "master_data": "/api/master-data/catalog",
                "inventory": "/api/inventory",
                "procurement": "/api/procurement",
                "sales": "/api/sales",
            }
            suffix = "preview" if name.endswith("preview") else "apply"
            return tool_result(instance_client().request(f"{bases[arguments['action']]}/{suffix}", arguments[body_key]))
        return error_result("unknown_tool", requested_tool=name, allowed_tools=[tool["name"] for tool in TOOLS])
    except (KeyError, TypeError, ValueError) as exc:
        return error_result("operation_failed", detail=str(exc))


def dispatch(message: Any) -> dict[str, Any] | None:
    if not isinstance(message, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}}
    method = message.get("method")
    request_id = message.get("id")
    if request_id is None:
        return None
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {"listChanged": False}}, "serverInfo": SERVER_INFO}}
    if method == "ping":
        result: dict[str, Any] = {}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        result = handle_tool_call(message.get("params") or {})
    else:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def main() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            response = dispatch(json.loads(line))
        except (TypeError, ValueError) as exc:
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": f"Invalid JSON-RPC message: {exc}"}}
        if response is not None:
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
