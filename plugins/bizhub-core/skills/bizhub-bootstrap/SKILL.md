---
name: bizhub-bootstrap
description: Safely start the BizHub public installer preview. Use when a user provides the kingcharleslzy-ai/bizhub-installer repository URL, asks to install or evaluate BizHub, or wants the initial deployment and data-source interview. This preview is read-only and must not deploy production services, ingest real customer data, request secret values in chat, or create additional generic Skills.
---

# BizHub Bootstrap

## Overview

Use the single `bizhub-mcp` server to explain the current boundary and guide a
short setup interview. Keep the workflow small; customer-specific Skills belong
to the customer's Agent after handoff.

## Workflow

1. Call `bizhub_bootstrap_status`.
2. Tell the user that this release is preview/read-only and cannot yet perform a
   production install or accept real customer data.
3. Call `bizhub_bootstrap_questions` with `stage: deployment`.
4. Ask no more than three returned questions at a time. Do not ask the user to
   paste passwords, keys, cookies, private keys, or database files.
   Use synthetic labels and role names instead of legal company names, personal
   identities, or internal system identifiers during this preview.
5. Continue through the returned `next_stage` only after the user answers.
6. Summarize the proposed topology and access method. Stop before any host,
   server, DNS, firewall, data, or credential mutation.

## Boundaries

- Use only the tools exposed by the one `bizhub-mcp` instance.
- Do not run arbitrary shell, discover local secrets, access customer files, or
  contact network endpoints.
- Do not infer that an answer authorizes installation, data access, or a later
  deployment step.
- Stop if another BizHub MCP or BizHub-managed bootstrap Skill is already
  active; ask the user to choose one version.
- Do not generate or install more generic BizHub Skills. If a repeated
  customer-specific workflow later needs one, point the customer's Agent to
  `https://github.com/kingcharleslzy-ai/bizhub-installer/blob/v0.1.0-preview.1/docs/customer-skill-extension.md`.

## Expected result

Return a concise interview summary containing deployment topology, intended
access method, unanswered prerequisites, and an explicit statement that no
production action was performed.
