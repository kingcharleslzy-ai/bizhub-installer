#!/usr/bin/env python3
"""Dependency-free, read-only MCP server for the BizHub bootstrap preview."""

from __future__ import annotations

import json
import sys
from typing import Any


SERVER_INFO = {"name": "bizhub-mcp", "version": "0.1.0-preview.1"}
REPOSITORY_URL = "https://github.com/kingcharleslzy-ai/bizhub-installer"
PROTOCOL_VERSION = "2024-11-05"

STATUS = {
    "maturity": "preview_read_only",
    "repository": REPOSITORY_URL,
    "release": "v0.1.0-preview.1",
    "production_backend_install": False,
    "production_frontend_deploy": False,
    "real_customer_data_allowed": False,
    "network_access": False,
    "secret_access": False,
    "next_action": "Ask the deployment-stage questions.",
}

QUESTION_STAGES: dict[str, dict[str, Any]] = {
    "deployment": {
        "questions": [
            {
                "id": "installation_goal",
                "question": "Is this a new trial, a migration, or an upgrade?",
                "choices": ["new_trial", "migration", "upgrade"],
            },
            {
                "id": "topology",
                "question": "Should BizHub run on a cloud server, a 24/7 local computer, or a hybrid setup?",
                "choices": ["cloud", "local_24x7", "hybrid"],
            },
        ],
        "next_stage": "access",
    },
    "access": {
        "questions": [
            {
                "id": "access_mode",
                "question": "Should the site use an existing domain, a private network, or a managed tunnel?",
                "choices": ["domain", "private_network", "managed_tunnel"],
            },
            {
                "id": "change_owner",
                "question": "Which role can approve server, DNS, firewall, and host configuration changes? Use a role label, not a person's identity.",
            },
        ],
        "next_stage": "company",
    },
    "company": {
        "questions": [
            {
                "id": "company_profile",
                "question": "Choose a synthetic company label, timezone, and base currency for this preview; do not provide a legal company name.",
            },
            {
                "id": "initial_admin",
                "question": "Which role will own the initial administrator account and access reviews? Do not provide a person's identity.",
            },
        ],
        "next_stage": "data",
    },
    "data": {
        "questions": [
            {
                "id": "data_sources",
                "question": "Which source categories may later provide data (API, database, file, or browser)? Do not name internal systems or files yet.",
            },
            {
                "id": "data_owner",
                "question": "Which role can approve each data source and its retention policy?",
            },
        ],
        "next_stage": "review",
    },
    "review": {
        "questions": [
            {
                "id": "review_only",
                "question": "May the Agent produce a read-only draft plan for review?",
                "choices": ["yes", "no"],
            }
        ],
        "next_stage": None,
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
        "name": "bizhub_repository_info",
        "description": "Return the canonical public repository and pinned preview release.",
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


def handle_tool_call(params: dict[str, Any]) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}

    if name == "bizhub_bootstrap_status":
        return tool_result(STATUS)
    if name == "bizhub_repository_info":
        return tool_result(
            {
                "repository": REPOSITORY_URL,
                "release_tag": "v0.1.0-preview.1",
                "plugin_path": "plugins/bizhub-core",
            }
        )
    if name == "bizhub_bootstrap_questions":
        stage = arguments.get("stage", "deployment")
        if stage not in QUESTION_STAGES:
            return tool_result(
                {
                    "error": "unknown_stage",
                    "allowed_stages": list(QUESTION_STAGES),
                },
                is_error=True,
            )
        return tool_result({"stage": stage, **QUESTION_STAGES[stage]})

    return tool_result(
        {
            "error": "unknown_tool",
            "requested_tool": name,
            "allowed_tools": [tool["name"] for tool in TOOLS],
        },
        is_error=True,
    )


def dispatch(message: dict[str, Any]) -> dict[str, Any] | None:
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
