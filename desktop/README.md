# BizHub Desktop D2 local Generic candidate

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

## Local lifecycle

No local database is created by installation, cloud failure, or an unknown
username. The first local instance is created only after the user explicitly
submits the local setup form. Initialization runs in a staging directory with a
one-use bootstrap token and is atomically promoted only after database, first
administrator, artifact identity, and Owner readback succeed. Failure removes
the staging state and leaves the formal local-instance path absent.

Each launch:

- verifies the fixed Runtime release manifest and every onedir file;
- verifies the original `bizhub-common` tar digest and every extracted common
  file again inside the Python process;
- starts only on a random `127.0.0.1` port with a per-launch cookie token;
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
npm run smoke:local
npm run smoke:local-shell
npm run make
npm run verify:artifact -- "out/BizHub Desktop-darwin-arm64"
```

The local smoke uses temporary synthetic state. It proves explicit bootstrap,
authentication, Profile/data/writer identity, Generic Owner preview/apply/
readback, idempotent replay, tamper failure with zero write, backup validation,
restart readback, and zero residual Runtime processes. The packaged cloud smoke
continues to use only `https://example.com` and never creates a local instance.

See the [D2 verification record](../docs/verification/desktop-d2-local-generic-2026-08-25.md).

## Release status

This candidate is ad-hoc/unsigned and not notarized. The pinned Forge build
dependency tree still contains retained upstream findings even though the npm
runtime dependency audit is clean. D2 is suitable only for internal isolated
technical review. It is not authorized for publication, real business data,
production trust keys, Windows local Runtime, or private cloud-to-local cutover.
