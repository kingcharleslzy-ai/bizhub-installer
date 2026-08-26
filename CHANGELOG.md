# Changelog

## Unreleased

- Split Desktop-R1 into secret-free synthetic CI, a protected production
  signing-candidate workflow, and a separately protected exact-Artifact publish
  workflow. The candidate ends with a deterministic release-plan SHA for Owner
  approval; publication cannot rebuild or re-sign and must read back an
  immutable GitHub Release. Protect `main` with the two native R1 checks.
- Sign every previously unsigned Windows Runtime PE, including
  `bizhub-runtime.exe`, regenerate release-specific Runtime Manifest/trust, and
  require all packaged/installed PE signatures to be valid. Add native macOS
  and Windows vN to vN+1 to rollback Generic Owner data/readback evidence while
  leaving automatic updates out of scope.
- Add the Desktop-R1 fail-closed dual-platform release candidate. macOS verifies
  the fixed Generic Pack, signs its Mach-O contents, rebuilds release-specific
  trust, signs/notarizes the Shell and DMG, and reads back both ZIP and mounted
  DMG. Windows reuses the approved D3 Squirrel/Runtime chain, requires
  Authenticode, and repeats install/Owner/uninstall data-preservation evidence.
  Synthetic branch runs cannot tag or publish; production is manual-only and
  requires exact public `main`, a version-matching immutable tag, real publisher
  credentials, an owned neutral 443 directory, and explicit `publish=true`.
- Replace the vulnerable Forge extraction transitive with a bounded,
  path-confined BSD-compatible implementation and use a bounded PowerShell
  extractor for the fixed Windows Runtime archive. The complete Desktop npm
  audit is now clean at the release threshold without changing the approved
  Runtime Pack or product authority.
- Treat Workspace Descriptor expiry as connection admission only: every cloud
  open still revalidates signature and expiry, but an already-connected Runtime
  Session is no longer closed when the short Descriptor TTL elapses. Disconnect
  plus stale-envelope reopen fails with `profile_expired`; a fresh directory
  lookup can issue a new Descriptor and reconnect. The real Electron account
  flow now proves all four short-TTL states in development and packaged builds.
- Configure Desktop-W2 with one customer-neutral HTTPS account-directory
  transport and one bounded Ed25519 public trust root. Customer account hashes,
  Workspace URL/Profile mapping, and signing private key remain deployment-only;
  the Shell still sends no password and contains no customer identity. The
  initial `nip.io:8443` transport runs on the existing US operations VPS with a
  source-IP-restricted origin path; it is a configured checkpoint and must move
  to an owned neutral domain on standard port 443 before broad public distribution.
- Add the Desktop-W1 account-to-Workspace product-flow candidate. The public
  Shell submits only an account identifier to a generic HTTPS directory,
  verifies returned cloud Workspaces against the packaged Ed25519 trust root,
  requires signed cloud runtime/data authority, and leaves password validation
  to the selected cloud or local Runtime. Confirmed unknown accounts still
  require explicit local setup; directory and cloud failures create no SQLite
  fallback. Production directory, signing keys, real account mapping, merge,
  signing, and publication remain separately gated.
- Bound account-directory receipt itself to one 10-second fetch/body/parse/
  validation deadline and abort streaming bodies above 64 KiB; make only the
  latest main-process lookup generation eligible to replace active Workspaces.
  Use non-persistent cloud Session partitions and prove across a real Electron
  restart that Cookie, localStorage, and cache do not survive. Account lookup
  remains discovery rather than authentication, and Generic Local remains an
  explicit option for every installation.
- Merge the externally repaired Desktop-D2 Generic local Runtime baseline to
  public `main`, and begin the separately authorized Desktop-D3 Windows x64
  checkpoint with a platform-bound PyInstaller Runtime, Squirrel.Windows
  lifecycle, signing gates, and install/uninstall data-preservation evidence.
- Complete the Desktop-D3 Windows x64 external-review candidate with a
  deterministic fixed Runtime, read-only Windows parent probe, portable archive
  verification, bounded Squirrel events, Shell/installer Authenticode mechanics,
  installed Owner lifecycle, uninstall data preservation, and zero residual
  processes. A shared signing hook prevents Squirrel from changing the fixed
  Runtime Pack; the synthetic signer and unsigned sidecar remain release
  blockers rather than production authority.

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
