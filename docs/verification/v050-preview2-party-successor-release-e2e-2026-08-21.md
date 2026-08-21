# v0.5.0-preview.2 party-successor release E2E — 2026-08-21

## Result

`v0.5.0-preview.2` passed its fixed-tag release workflow and was published as a
GitHub prerelease. Stable remains `v0.3.0`.

- release: <https://github.com/kingcharleslzy-ai/bizhub-installer/releases/tag/v0.5.0-preview.2>;
- workflow: <https://github.com/kingcharleslzy-ai/bizhub-installer/actions/runs/32468603958>;
- annotated tag object: `f0121d47b5e7c17aeffb3784c65bf7baf8831bad`;
- release commit: `a5edf3089582f27fa3bb4c3187ebf3a7b1a6f2b8`;
- release tree: `81a9930a081d54dd41a1d07e8e36c694e4ed36d2`;
- runner: disposable GitHub-hosted `ubuntu-24.04`;
- published at: `2026-08-21T09:36:17Z`.

The Release page was created only after every preceding workflow step passed.

## Gates

1. Verified all `71` release checksums, installed hash-locked Python
   dependencies, passed `59` tests, built the Vue frontend and reported zero
   high-level npm audit findings.
2. Installed exactly one `bizhub-core@bizhub-public` from the release commit,
   read back one Skill, one MCP server, seven bounded tools and version
   `0.5.0-preview.2`.
3. Passed Ubuntu 24.04 and Docker preflight, generated one exact-hash install
   plan and created the synthetic administrator through a TTY.
4. Migrated the empty SQLite database through schema version `3`. A deprecated
   party explicitly linked to an existing active successor; its old canonical
   name was accepted as an active alias only for that exact successor. Active,
   self, inactive and mismatched successor cases remain rejected by tests.
5. Repeated the purchase/receipt, sale/shipment, inventory reversal, invalid
   unit, insufficient stock, stale/tampered preview, external identity,
   changed-record reconcile and idempotent replay contracts.
6. Created and restored an online backup, proved the schema-v3 successor and
   reconciled master data survived restore and container restart, and rechecked
   effective Linux cgroup v2 limits.
7. Repeated install and update returned no-op. Uninstall removed the container
   while retaining the database and backups; SQLite quick-check remained `ok`.

Before the tag, the same commit also passed a full loopback E2E on a separate
Ubuntu 24.04 / Docker 29 VPS. Its synthetic directories, retained database,
backups, checkout and unreferenced test images were removed after readback.

## Boundary

- The release used synthetic data only and did not update the retained Tencent
  Shadow or import the private formal snapshot.
- The successor contract came from an explicit private source field; no name
  match creates or authorizes a successor relationship.
- Formal customer-data staging, preview and apply still require a separate
  target-bound plan. The plan approval cannot replace the later business
  preview token and Owner confirmation.
