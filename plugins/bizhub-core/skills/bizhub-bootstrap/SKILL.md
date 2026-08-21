---
name: bizhub-bootstrap
description: Install or connect one private BizHub single-company instance from the fixed kingcharleslzy-ai/bizhub-installer release. Use when a user provides this repository URL, asks to deploy BizHub on Ubuntu 24.04, configure the one BizHub MCP, import initial business data, or verify backup and restore. Keep passwords and keys out of chat, require the exact plan hash before mutation, and do not create extra generic Skills.
---

# BizHub Bootstrap

Use the repository's `bizhubctl` as the deployment authority and the single
`bizhub-mcp` as the bounded business interface.

## Workflow

1. Verify the repository, release tag, commit, and `install/CHECKSUMS.sha256`.
   Stop on a moving branch, dirty checkout, checksum mismatch, duplicate
   BizHub MCP, or duplicate BizHub bootstrap Skill. Read back that this Skill
   and MCP came from exactly one enabled `bizhub-core@bizhub-public` installed
   at the verified release commit; provenance does not grant host authority.
2. Call `bizhub_bootstrap_status`, then ask the question stages in order:
   `deployment`, `access`, `company`. Never ask for a password in chat.
3. Connect to the user-approved Ubuntu 24.04 target over their existing SSH
   access. Run `sudo ./bizhubctl preflight` there. Do not install Docker, alter DNS,
   open a firewall, or change a tunnel unless the reviewed plan explicitly
   includes that separately.
4. Run `sudo ./bizhubctl plan` with the confirmed company and access settings. Show
   its source commit, target fingerprint, paths, network binding, CPU/memory/PID
   limits, expected changes, rollback, and plan hash. Use `loopback` only when
   the instance must remain reachable solely through the target host or an SSH
   port forward; do not add a proxy or public route for that mode.
5. Only after the user approves that exact hash, run `sudo ./bizhubctl install
   --plan ... --approve <hash>` in an interactive TTY. The user enters the
   administrator password directly into that TTY.
6. Run `sudo ./bizhubctl verify`, create a backup, and complete a restore
   rehearsal before accepting real customer data. For a domain or Cloudflare
   Tunnel, verify HTTPS and access control through the final URL.
7. Configure this one MCP with `BIZHUB_INSTANCE_URL`,
   `BIZHUB_ADMIN_USERNAME`, and a local `BIZHUB_ADMIN_PASSWORD_FILE`. Never put
   the password in MCP arguments, repository files, plans, logs, or chat.
8. Map the first customer source to a built-in CSV/JSON contract. When party
   successors or party-alias owners are expressed by `source_id + external_id`,
   use the dependency-aware master-data bundle action so one preview binds the
   complete input, dependency graph, state generation, and expected operations.
   Present errors and counts, obtain confirmation, apply with the returned
   token, and read back resources, mappings, relationships, state, and audit.
9. When a later source record keeps the same `source_id + external_id` but its
   party, unit, or alias fields change, use the explicit master-data reconcile
   preview/apply contract. Never turn a changed record into a second identity or
   bypass a missing/conflicting mapping.

## Boundaries

- One company, one administrator, one SQLite database, one application
  container. Do not claim multi-tenancy, RBAC, accounting, manufacturing, or a
  general connector framework.
- Never use direct SQL or an arbitrary shell/URL through MCP.
- Every formal business write is `preview -> explicit confirmation -> apply ->
  readback`. A stale or changed preview must be generated again.
- `uninstall` retains config, data, and backups. This release provides no purge
  operation.
- Create no additional generic BizHub Skills. If a repeated customer workflow
  needs one later, point the customer's Agent to the documentation-only
  `docs/customer-skill-extension.md` in the same fixed release.

## Stop conditions

Stop and report the exact blocker if preflight, checksum, target fingerprint,
plan hash, resource-limit readback, health, backup, restore, HTTPS, or readback verification fails. Do
not work around a failed gate by exposing port 8080 publicly, disabling
authentication, editing SQLite, or deleting existing data.
