# v0.5.0-preview.1 release E2E — 2026-08-21

## Result

`v0.5.0-preview.1` passed its fixed-tag release workflow and was published as a
GitHub prerelease. Stable remains `v0.3.0`.

- release: <https://github.com/kingcharleslzy-ai/bizhub-installer/releases/tag/v0.5.0-preview.1>;
- workflow: <https://github.com/kingcharleslzy-ai/bizhub-installer/actions/runs/32465067912>;
- annotated tag object: `e16f43c70db9a05a1ae710378baf0fb34f95a9c6`;
- release commit: `899762718587d5d703ce80341074b5cae2499e9c`;
- runner: disposable GitHub-hosted `ubuntu-24.04`;
- published at: `2026-08-21T08:52:04Z`.

The workflow created the Release page only after every preceding gate passed.

## Clean Ubuntu gates

1. Resolved the annotated tag to the exact commit and verified all 70 release
   checksums.
2. Installed hash-locked Python dependencies, passed 58 public tests, built the
   Vue application, and reported zero high-level npm audit findings.
3. Installed exactly one `bizhub-core@bizhub-public` from the 40-character
   commit and read back one `bizhub-bootstrap`, one `bizhub-mcp`, seven bounded
   tools, and version `0.5.0-preview.1`.
4. Passed Ubuntu and Docker preflight, generated an exact-hash plan, created the
   synthetic administrator through a TTY, and installed one application
   container.
5. Verified the synthetic purchase, receipt, sale, shipment, non-negative
   inventory, reversal, invalid-unit, stale-preview, tamper, and idempotent
   import contracts.
6. Imported an externally identified party, previewed its changed name, legal
   name, and roles, rejected a tampered reconcile apply, applied the original
   preview atomically, read back the resource, identity mapping, and audit, and
   verified replay as already satisfied.
7. Created and restored an online SQLite backup, proved both inventory and the
   reconciled master data survived restore and container restart, and rechecked
   effective cgroup v2 resource limits.
8. Repeated install and update returned no-op. Uninstall removed the container
   while retaining the database and backup, and SQLite quick-check remained
   `ok`.

## Fresh-Agent forward test

A new temporary `CODEX_HOME` installed the public marketplace at the exact
release commit and read back exactly one enabled plugin at version
`0.5.0-preview.1`. A fresh ephemeral read-only Agent task loaded the installed
Skill and directly called `bizhub_bootstrap_status` and
`bizhub_bootstrap_questions(stage=deployment)` through the registered MCP.

It reported `maturity=implementation_preview`, two first-stage questions, no
host-mutation authority from the Release URL, and stop-on-failure behavior. It
did not clone, deploy, connect to a server, request credentials, or mutate a
workspace. A negative-control run with the host's `--ignore-user-config` option
correctly did not mount the plugin MCP; the standard new-task flow passed.

The plugin and marketplace were then removed. The installed cache, temporary
authentication copy, and temporary test directory were removed and read back as
absent.

## Boundaries still closed

- This prerelease used synthetic data only and does not authorize customer-data
  migration or a formal writer switch.
- It did not deploy to or modify the private reference production system.
- A real customer still needs a separately approved plan, final access-path
  verification, and backup/restore evidence before customer data enters.
