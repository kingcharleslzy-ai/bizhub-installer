---
name: bizhub-bootstrap
description: Safely inspect the Agent host and build a non-executable BizHub installation plan preview. Use when a user provides the kingcharleslzy-ai/bizhub-installer repository URL, asks to evaluate BizHub, or wants the initial cloud, local, or hybrid deployment interview. This preview is read-only and must not connect to target servers, deploy services, ingest real customer data, request secret values in chat, or create additional generic Skills.
---

# BizHub Bootstrap

## Overview

Use the single `bizhub-mcp` server to inspect only the Agent host, ask three
deployment questions, and return a deterministic draft plan.

## Workflow

1. Call `bizhub_bootstrap_status`.
2. Tell the user that this release is preview/read-only and cannot yet perform a
   production install or accept real customer data.
3. Call `bizhub_discover_local_host`. Explain that it describes only the Agent
   host, never a cloud or deployment target.
4. Call `bizhub_bootstrap_questions` for `deployment`, then `access`. Ask
   only the returned questions.
5. Call `bizhub_build_draft_plan` with the three selected values.
6. Show the fingerprint, required follow-ups, and blockers. Stop before any
   host, server, DNS, firewall, data, or credential mutation.

## Boundaries

- Use only the tools exposed by the one `bizhub-mcp` instance.
- Do not run arbitrary shell, discover local secrets, access customer files, or
  contact network endpoints.
- Do not infer that an answer authorizes installation, data access, or a later
  deployment step.
- Do not ask for company identity, employee identity, target hostname, IP,
  username, password, key, token, domain, or data-source identifier.
- Stop if another BizHub MCP or BizHub-managed bootstrap Skill is already
  active; ask the user to choose one version.
- Do not generate or install more generic BizHub Skills. If a repeated
  customer-specific workflow later needs one, point the customer's Agent to
  `https://github.com/kingcharleslzy-ai/bizhub-installer/blob/v0.2.0-preview.1/docs/customer-skill-extension.md`.

## Expected result

Return the local discovery summary and draft plan exactly as read-only evidence.
State that no target was contacted and no production action was performed.
