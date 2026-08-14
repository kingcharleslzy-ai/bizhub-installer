#!/usr/bin/env python3
"""Dependency-free, read-only MCP server for the BizHub bootstrap preview."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import sys
from typing import Any


SERVER_INFO = {"name": "bizhub-mcp", "version": "0.2.0-preview.1"}
REPOSITORY_URL = "https://github.com/kingcharleslzy-ai/bizhub-installer"
PROTOCOL_VERSION = "2024-11-05"
RELEASE_TAG = "v0.2.0-preview.1"

INSTALLATION_GOALS = ["new_trial", "migration", "upgrade"]
TOPOLOGIES = ["cloud", "local_24x7", "hybrid"]
ACCESS_MODES = ["domain", "private_network", "managed_tunnel"]

STATUS = {
    "maturity": "preview_read_only",
    "repository": REPOSITORY_URL,
    "release": RELEASE_TAG,
    "local_host_discovery": True,
    "draft_plan_generation": True,
    "production_backend_install": False,
    "production_frontend_deploy": False,
    "real_customer_data_allowed": False,
    "network_access": False,
    "secret_access": False,
    "next_action": "Discover the Agent host, then ask the deployment questions.",
}

QUESTION_STAGES: dict[str, dict[str, Any]] = {
    "deployment": {
        "questions": [
            {
                "id": "installation_goal",
                "question": "Is this a new trial, a migration, or an upgrade?",
                "choices": INSTALLATION_GOALS,
            },
            {
                "id": "topology",
                "question": "Should BizHub run on a cloud server, a 24/7 local computer, or a hybrid setup?",
                "choices": TOPOLOGIES,
            },
        ],
        "next_stage": "access",
        "next_action": "ask_access_questions",
    },
    "access": {
        "questions": [
            {
                "id": "access_mode",
                "question": "Should the site use an existing domain, a private network, or a managed tunnel?",
                "choices": ACCESS_MODES,
            },
        ],
        "next_stage": None,
        "next_action": "build_draft_plan",
    },
}

TOOLS = [
    {
        "name": "bizhub_bootstrap_status",
        "description": "Return the public BizHub bootstrap maturity and safety boundary.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "bizhub_bootstrap_questions",
        "description": "Return one small stage of the read-only BizHub setup interview.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "stage": {
                    "type": "string",
                    "enum": list(QUESTION_STAGES),
                    "default": "deployment",
                }
            },
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "bizhub_discover_local_host",
        "description": "Return a small, non-sensitive profile of the Agent host only.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "bizhub_build_draft_plan",
        "description": "Build a deterministic, non-executable BizHub installation plan preview.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "installation_goal": {
                    "type": "string",
                    "enum": INSTALLATION_GOALS,
                },
                "topology": {
                    "type": "string",
                    "enum": TOPOLOGIES,
                },
                "access_mode": {
                    "type": "string",
                    "enum": ACCESS_MODES,
                },
            },
            "required": ["installation_goal", "topology", "access_mode"],
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "bizhub_repository_info",
        "description": "Return the canonical public repository and tagged preview release.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
]


def tool_result(payload: dict[str, Any], *, is_error: bool = False) -> dict[str, Any]:
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(payload, ensure_ascii=False, sort_keys=True),
            }
        ],
        "structuredContent": payload,
        "isError": is_error,
    }


def error_result(code: str, **details: Any) -> dict[str, Any]:
    return tool_result({"error": code, **details}, is_error=True)


def discover_local_host() -> dict[str, Any]:
    os_family = {
        "darwin": "macos",
        "linux": "linux",
        "windows": "windows",
    }.get(platform.system().lower(), "unknown")
    disk = shutil.disk_usage(".")
    return {
        "schema_version": "bizhub.local_host_discovery.v0",
        "scope": "agent_host_only",
        "os_family": os_family,
        "architecture": platform.machine().strip().lower() or "unknown",
        "python_version": (
            f"{sys.version_info.major}.{sys.version_info.minor}."
            f"{sys.version_info.micro}"
        ),
        "cpu_count": os.cpu_count() or 0,
        "disk_free_bytes": disk.free,
        "disk_scope": "mcp_working_directory_volume",
        "excluded": [
            "hostname",
            "username",
            "home_directory",
            "ip_addresses",
            "environment_variables",
            "files",
            "secrets",
        ],
        "target_host_verified": False,
        "note": "This describes only the computer running the MCP server.",
    }


def build_draft_plan(arguments: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "installation_goal": INSTALLATION_GOALS,
        "topology": TOPOLOGIES,
        "access_mode": ACCESS_MODES,
    }
    unexpected = sorted(set(arguments) - set(allowed))
    if unexpected:
        return error_result("unexpected_arguments", fields=unexpected)

    missing = [field for field in allowed if field not in arguments]
    if missing:
        return error_result("missing_arguments", fields=missing)

    for field, choices in allowed.items():
        if arguments[field] not in choices:
            return error_result(
                "invalid_choice",
                field=field,
                value=arguments[field],
                allowed=choices,
            )

    selection = {field: arguments[field] for field in allowed}
    canonical = json.dumps(
        selection,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")

    followups: list[str] = []
    topology = selection["topology"]
    if topology in {"cloud", "hybrid"}:
        followups.append("run_read_only_remote_target_preflight")
    if topology in {"local_24x7", "hybrid"}:
        followups.append("confirm_24x7_power_sleep_backup_and_network")

    followups.append(
        {
            "domain": "confirm_dns_control_and_https_plan",
            "private_network": "confirm_private_network_users_and_owner",
            "managed_tunnel": "select_tunnel_and_access_policy",
        }[selection["access_mode"]]
    )

    return tool_result(
        {
            "schema_version": "bizhub.install_plan_preview.v0",
            "plan_fingerprint": hashlib.sha256(canonical).hexdigest(),
            "selection": selection,
            "steps": [
                {
                    "id": "target_preflight",
                    "kind": "read_only",
                    "status": "required",
                },
                {
                    "id": "review_installation_plan",
                    "kind": "human_review",
                    "status": "required",
                },
                {
                    "id": "apply_installation",
                    "kind": "mutation",
                    "status": "unavailable_in_preview",
                },
            ],
            "required_followups": followups,
            "blockers": ["production_apply_not_implemented"],
            "mutations": [],
            "ready_for_apply": False,
            "real_customer_data_allowed": False,
            "secret_values_accepted": False,
        }
    )


def handle_tool_call(params: Any) -> dict[str, Any]:
    if not isinstance(params, dict):
        return error_result("params_must_be_object")

    name = params.get("name")
    arguments = params.get("arguments") or {}

    if not isinstance(arguments, dict):
        return error_result("arguments_must_be_object")

    if name == "bizhub_bootstrap_status":
        if arguments:
            return error_result("unexpected_arguments", fields=sorted(arguments))
        return tool_result(STATUS)
    if name == "bizhub_discover_local_host":
        if arguments:
            return error_result("unexpected_arguments", fields=sorted(arguments))
        return tool_result(discover_local_host())
    if name == "bizhub_build_draft_plan":
        return build_draft_plan(arguments)
    if name == "bizhub_repository_info":
        if arguments:
            return error_result("unexpected_arguments", fields=sorted(arguments))
        return tool_result(
            {
                "repository": REPOSITORY_URL,
                "release_tag": RELEASE_TAG,
                "plugin_path": "plugins/bizhub-core",
            }
        )
    if name == "bizhub_bootstrap_questions":
        unexpected = sorted(set(arguments) - {"stage"})
        if unexpected:
            return error_result("unexpected_arguments", fields=unexpected)
        stage = arguments.get("stage", "deployment")
        if not isinstance(stage, str) or stage not in QUESTION_STAGES:
            return error_result(
                "unknown_stage",
                allowed_stages=list(QUESTION_STAGES),
            )
        return tool_result({"stage": stage, **QUESTION_STAGES[stage]})

    return error_result(
        "unknown_tool",
        requested_tool=name,
        allowed_tools=[tool["name"] for tool in TOOLS],
    )


def dispatch(message: Any) -> dict[str, Any] | None:
    if not isinstance(message, dict):
        return {
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32600, "message": "Invalid Request"},
        }

    method = message.get("method")
    request_id = message.get("id")

    if request_id is None:
        return None

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER_INFO,
            },
        }
    if method == "ping":
        result: dict[str, Any] = {}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        result = handle_tool_call(message.get("params") or {})
    else:
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        }

    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def main() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            response = dispatch(message)
        except (TypeError, ValueError) as exc:
            response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Invalid JSON-RPC message: {exc}"},
            }

        if response is not None:
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
