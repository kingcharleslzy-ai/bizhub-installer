# BizHub Desktop D2 merged baseline

This directory contains the Desktop-D1 cloud shell plus the Desktop-D2 macOS
arm64 local-runtime implementation candidate. One customer-neutral Electron
shell now exposes two explicit paths:

```text
signed enterprise connection -> enterprise HTTPS Runtime
explicit local setup/login    -> fixed Generic Python Runtime -> local SQLite
```

The local Runtime is a PyInstaller `onedir` built from the existing public
delivery adapter and the exact vendored `bizhub-common` artifact. Desktop does
not reimplement master data, inventory, procurement, or sales. Formal writes
remain inside the existing Generic Owners.

The checked-in enterprise trust store remains empty. D2 contains no customer
private Profile, rule, endpoint, account, credential, production data, model,
collector, synchronization, background service, automatic update, or authority
switch.

The fixed D2 review input is
`runtime/vendor/bizhub-runtime-darwin-arm64-0.1.0-d2.zip` (SHA-256
`40d054980ee4f8d22276f5723877e447faec72e9d743f281709dfa9c2137e7eb`).
`make` verifies and extracts that exact archive before packaging; it never
regenerates trust from the Runtime it is about to ship.

## Local lifecycle

No local database is created by installation, cloud failure, or an unknown
username. The first local instance is created only after the user explicitly
submits the local setup form. Initialization runs in a staging directory with a
one-use bootstrap token and is atomically promoted only after database, first
administrator, artifact identity, and Owner readback succeed. Failure removes
the staging state and leaves the formal local-instance path absent. A
single-instance startup recovery removes only setup directories whose fixed
marker matches their lock; an unknown or malformed path is preserved and fails
closed.

Each launch:

- verifies the independently pinned Runtime Manifest digest, Pack tree digest,
  file count, canonical source records, and every onedir file;
- verifies the original `bizhub-common` tar digest and every extracted common
  file again inside the Python process;
- starts only on a random `127.0.0.1` port with a per-launch cookie token;
- serializes start/stop/Cloud transitions so only one Python Runtime can exist;
- uses an isolated sandboxed `WebContentsView` with exact-origin network rules;
- stops the Runtime when local mode or the application is stopped;
- lets the Python Owner create and validate online SQLite backups.

## Maintainer verification

Use Node 22 and Python 3.12 on macOS arm64:

```bash
uv venv --python /opt/homebrew/bin/python3.12 .runtime-venv
uv pip sync --python .runtime-venv/bin/python \
  --require-hashes runtime/requirements-build.lock

npm test
npm run verify:boundary
npm run audit:runtime
npm run build:runtime
npm run prepare:runtime
npm run smoke:runtime-tamper
npm run smoke:local
npm run smoke:local-shell
npm run make
npm run verify:artifact -- "out/BizHub Desktop-darwin-arm64"
```

The local smoke uses temporary synthetic state. It proves explicit bootstrap,
authentication, Profile/data/writer identity, Generic Owner preview/apply/
readback, idempotent replay, tamper failure with zero write, backup validation,
restart readback, interrupted-setup recovery, concurrent-start deduplication,
coordinated Pack tamper rejection, and zero residual Runtime processes. The packaged cloud smoke
continues to use only `https://example.com` and never creates a local instance.

See the [D2 verification record](../docs/verification/desktop-d2-local-generic-2026-08-25.md).

## Release status

The D2 source baseline is merged to public `main`, while its macOS Artifact
remains ad-hoc/unsigned and not notarized. The pinned Forge build
dependency tree still contains retained upstream findings even though the npm
runtime dependency audit is clean. D2 is suitable only for internal isolated
technical review. It is not authorized for publication, real business data,
production trust keys, Windows local Runtime, or private cloud-to-local cutover.
The fixed-head `desktop-d2-macos.yml` workflow performed the same tests on a
clean macOS arm64 runner. It separately rebuilds a source candidate, restores
and verifies the fixed review Pack, then uploads an unsigned review Artifact;
it does not sign, notarize, or publish a Release.

Desktop-D3 is implemented on a separate branch. It must add a fixed Windows x64
Runtime, Squirrel.Windows installer, bounded Squirrel lifecycle handling,
Authenticode verification, install/local-Owner/uninstall evidence, formal-data
preservation, and zero residual processes. An ephemeral CI certificate may be
used only to prove the signing mechanics; it is not a production publisher
identity and cannot produce a formal public release.
