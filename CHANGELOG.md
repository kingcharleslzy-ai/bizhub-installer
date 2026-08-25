# Changelog

## Unreleased

- Add the Desktop-D2 macOS arm64 Generic local implementation candidate. The
  customer-neutral Electron shell explicitly initializes one isolated local
  instance, verifies one fixed PyInstaller onedir and the existing
  `bizhub-common` artifact, binds a random loopback origin and per-launch token,
  and delegates every formal write to the existing Generic Owners.
- Add synthetic local acceptance for first-administrator authentication, Owner
  preview/apply/readback, idempotent replay, tamper failure with zero write,
  online backup validation, restart readback, packaged cloud/local smokes, and
  zero residual sidecar processes. No customer-private Runtime, real data,
  synchronization, background service, Windows local Runtime, signing, or
  publication is authorized.
- Bind the fixed D2 Runtime to an independent raw Manifest SHA-256, Pack tree
  digest, file count, and canonical source-record digest; normalize the
  PyInstaller base ZIP order and reject coordinated file-plus-Manifest tamper.
- Serialize local Runtime start/stop/Cloud transitions behind one lifecycle
  controller, recover only marker-matched interrupted setup state, and add a
  fixed public Generic Runtime archive plus a clean macOS arm64 workflow that
  uploads an unsigned external-review Artifact without regenerating trust.
- Document the proposed BizHub Desktop v0.1 boundary: one customer-neutral
  Electron shell, an explicit enterprise-cloud path, and one new Generic local
  instance without central IAM, customer-private code, direct SQLite access,
  cloud/local synchronization, or an automatic writer switch.
- Add the Desktop-D1 cloud-shell implementation candidate with a hardened
  Electron `WebContentsView`, signed Ed25519 connection envelopes, exact HTTPS
  request origins, isolated persistent sessions, denied permissions/downloads,
  an empty production trust store, and macOS arm64 packaging proof. It contains
  no Python, SQLite, customer-private material, production endpoint, or trusted
  connection key, and it is not published or signed for distribution.
- Add final-package boundary scanning, packaged HTTPS smoke support, and a
  Windows x64 GitHub workflow that verifies the same public shell commit without
  adding a trusted production key or publishing a release. Record the exact
  Forge build-dependency reachability and retain it as a release blocker.

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
