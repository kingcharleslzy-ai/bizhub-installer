# CP-5 public delivery report

## Review object

- repository: `kingcharleslzy-ai/bizhub-installer`;
- branch: `modular/cp-5-common-artifact-20260823`;
- `base_lineage_mode`: `integrated`;
- `main_sha_at_start` / `base_sha`:
  `a08e71afdcb7c016671a84fa48ea00c38cd4fd46`;
- final head and this report's SHA-256 are supplied after commit to avoid
  self-reference.

The public remote main was fetched again before finalization and had not moved.
No production, Shadow, staging, customer database, or private backup was read or
changed.

## Delivered boundary

The release vendors the deterministic 41-file `bizhub-common` artifact with
digest
`sha256:90a43dc622894419c56edabaf4166809f4b557c2dc0ac524d77277e80980bc72`.
The Dockerfile verifies and extracts it, then adds only the delivery adapter for
authentication, company configuration, runtime identity, and delegation into
the common Owners. It does not copy the retained `app/backend/bizhub` business
directory.

The immutable installation plan binds the artifact id, upstream source commit,
allowlist tree digest, artifact digest, public release commit, target
fingerprint, network binding, resource limits, and application digest. Image
labels and runtime health/profile/system-map/identity readbacks expose the same
artifact digest.

## Lifecycle and tests

- public Python suite: 67 passed;
- frontend build: passed;
- checksum verification: 91 files;
- pre-release isolated Ubuntu 24.04 lifecycle: passed;
- complete Generic master-data/procurement/inventory/sales flow: passed;
- backup/manifest restore and restart: passed;
- real update plus explicit verified rollback: passed;
- install/update replay no-op: passed;
- retain-data uninstall and SQLite quick check: passed;
- fixed-tag GitHub Ubuntu workflow: passed on release commit
  `eb36f218977d084817846958909d3c70faff151b`;
- published prerelease: `v0.7.0-preview.1` (`draft=false`,
  `prerelease=true`).

The immutable release evidence is [workflow run 32644597225](https://github.com/kingcharleslzy-ai/bizhub-installer/actions/runs/32644597225)
and the published [v0.7.0-preview.1 prerelease](https://github.com/kingcharleslzy-ai/bizhub-installer/releases/tag/v0.7.0-preview.1).

Detailed evidence is in
[`v070-preview1-common-artifact-release-e2e-2026-08-23.md`](verification/v070-preview1-common-artifact-release-e2e-2026-08-23.md)
and [`cp-5-ubuntu-e2e.json`](verification/cp-5-ubuntu-e2e.json).

## Retained implementation and rollback

The previous public business directory remains in Git and the working tree
because its deletion was not approved. It is inactive in the `v0.7` image and
must receive no new features. Deletion conditions are fixed in
[`legacy-core-retirement.md`](legacy-core-retirement.md).

Stable `v0.3.0` remains the supported fallback. This preview does not authorize
private reference deployment, customer-data migration, or CP-6A.

This checkpoint has stopped and has not entered the next checkpoint. Private
production was not released and formal data was not modified.
