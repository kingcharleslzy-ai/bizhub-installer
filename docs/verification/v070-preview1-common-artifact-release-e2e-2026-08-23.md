# v0.7.0-preview.1 common-artifact release E2E — 2026-08-23

## Scope

This preview replaces the active public business implementation with the exact
deterministic `bizhub-common` artifact produced by the canonical dual-Profile
source. It does not deploy or switch the private reference production system.

Fixed common identity:

- allowlist file count: `41`;
- allowlist tree digest:
  `3c2770526b509439f4a1a3b2226066b3b86456b7595f462fead848e8ae98211d`;
- `core_artifact_digest`:
  `sha256:90a43dc622894419c56edabaf4166809f4b557c2dc0ac524d77277e80980bc72`;
- private-content scan violations: `0`.

## Independent Ubuntu rehearsal

Before publishing the tag, the release lifecycle passed on an isolated Ubuntu
24.04.4 host with Docker 29.1.3 and cgroup v2. The host had no pre-existing
`/etc/bizhub`, `/var/lib/bizhub`, or `/var/backups/bizhub` state. The fixed
pre-release implementation commit was
`0e738d124dca87df4ca452bf1ee7717f0c6eb659`; its approved synthetic plan hash
was `35df485a57aba4cb643cad5a3f0373200e357a3549293e0f03361a8393187738`.

The rehearsal verified:

- checksum, release-source identity, preflight, plan hash, and exact common
  artifact identity;
- TTY-only administrator creation and effective memory/swap/CPU/PID cgroup
  readback;
- master data → procurement receipt → inventory → sales fulfillment → return,
  with final quantity `6`;
- backup plus manifest, mutation, restore to quantity `6`, restart, and health;
- MCP health and bounded inventory movement readback;
- a real resource-plan update, another mutation, and explicit rollback to the
  previous image/plan/database with quantity `6`;
- install/update idempotent no-op replay;
- retain-data uninstall with no container, four retained backup/manifest pairs,
  and `PRAGMA quick_check=ok`.

## Fixed-tag release gate

The immutable tag runs [the release workflow](../../.github/workflows/release-e2e.yml)
again on a disposable GitHub Ubuntu 24.04 runner. The workflow verifies checksums,
all public Python tests, the frontend build/audit, one pinned Codex plugin, seven
bounded MCP tools, clean-host installation, the complete synthetic business
flow, resource limits, backup/restore, update/rollback, idempotency, and
retain-data uninstall before creating the prerelease.

The gate completed successfully as
[workflow run 32644597225](https://github.com/kingcharleslzy-ai/bizhub-installer/actions/runs/32644597225),
bound to release commit
`eb36f218977d084817846958909d3c70faff151b`. It published the non-draft
[v0.7.0-preview.1 prerelease](https://github.com/kingcharleslzy-ai/bizhub-installer/releases/tag/v0.7.0-preview.1)
at `2026-08-23T14:11:20Z`.

Stable remains `v0.3.0`. This preview does not authorize customer-data migration
or private production adoption.
