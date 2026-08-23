# Changelog

## 0.7.0-preview.1 — 2026-08-23

- Replace the preview image's copied public business implementation with the
  deterministic `bizhub-common` artifact exported from the canonical dual-Profile
  source. The image verifies the exact artifact SHA-256 before extraction.
- Bind artifact id, source commit, tree digest, and `core_artifact_digest` into
  every installation plan, image label, health/profile/system-map readback, and
  derived-image check.
- Deliver the Generic master-data, inventory, procurement, and sales Owners from
  that artifact, with a thin public authentication/configuration adapter rather
  than a second set of business writers.
- Add explicit verified rollback to the installer. Backup, restore, update,
  rollback, restart, no-op replay, resource limits, MCP readback, and retained-data
  uninstall are covered by the Ubuntu 24.04 release workflow.
- Retain the previous public business directory for an independently approved
  retirement step, but exclude it from the new container build and runtime import
  path. Stable `v0.3.0` remains unchanged.
- This preview does not deploy or switch the private reference production system.

Older release evidence remains under [`docs/verification/`](docs/verification/).
