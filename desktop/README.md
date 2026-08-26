# BizHub Desktop configured product-flow candidate

This directory contains the merged Desktop-D1/D2/D3 cross-platform baseline
plus the current account-to-Workspace product-flow candidate. One
customer-neutral Electron shell exposes two explicit paths:

```text
account identifier -> generic HTTPS directory -> signed cloud Workspace -> cloud login
explicit local setup/login                         -> fixed Generic Runtime -> local SQLite
```

The account-directory request contains only a normalized account identifier.
It never contains a password. Each returned cloud Workspace is an independently
signed, expiring connection envelope bound to `runtime_mode=cloud` and
`data_authority_mode=cloud`. After the user selects it, that Workspace Runtime
owns login, permissions, UI, Owners, and formal data. A confirmed unknown
account may be used to prefill the explicit Generic local setup form; a
directory timeout, error, or missing configuration never triggers local setup.

The local Runtime is a PyInstaller `onedir` built from the existing public
delivery adapter and the exact vendored `bizhub-common` artifact. Desktop does
not reimplement master data, inventory, procurement, or sales. Formal writes
remain inside the existing Generic Owners.

Desktop-W2 configures one customer-neutral HTTPS directory transport and one
Ed25519 public trust root. The package still contains no customer-private
Profile, rule, customer endpoint, account mapping, credential, production data,
model, collector, synchronization, background service, automatic update, or
authority switch. Customer names, account hashes, private keys, Profile IDs,
and Workspace URLs stay on the directory deployment and arrive only inside a
short-lived signed envelope.

The initial transport hostname uses the Tencent Cloud fixed public address via
`sslip.io`. This is a practical configured checkpoint, not the desired broad-
release identity. Replace it with an owned customer-neutral BizHub domain before
public distribution; the packaged Ed25519 trust root remains the authority while
that transport URL changes.

Cloud cookies, browser storage, and cache use a non-persistent Session partition
derived from the account identifier hash plus Workspace ID. The raw account
identifier is not used in the partition name. Closing a Workspace in the same
application process may keep that temporary login, while quitting Desktop
destroys it and requires cloud login again after restart. Choosing “换一个账号”
also clears the active temporary Session before returning to account lookup.

The account directory is Workspace discovery, not unified authentication. Its
10-second deadline covers response headers, streaming body receipt, JSON parse,
and signed Workspace validation. The body reader aborts as soon as it exceeds
64 KiB. A main-process lookup generation ensures that only the most recent
account request can atomically replace the active Workspace set; reset makes
every older result stale.

Generic Local is intentionally available to every installation in W1, including
when an enterprise Workspace is present. It is an independent Generic authority
and never copies, synchronizes, or writes enterprise data. A future policy that
restricts Local must use a signed entitlement rather than account-name logic.

The version contract allows the Shell, signed Workspace Descriptor, cloud
Runtime, and local Runtime to evolve independently. `shell_min_version` is a
compatibility floor, not a fixed business version. Each account lookup may
return a newer signed Descriptor; local Runtime changes still require a
separately signed immutable Pack rather than hot-installed modules. Automatic
Shell updates, Runtime Pack download, migration/rollback, and update channels
are not implemented by W1.

The fixed review inputs are
`runtime/vendor/bizhub-runtime-darwin-arm64-0.1.0-d2.zip` (SHA-256
`40d054980ee4f8d22276f5723877e447faec72e9d743f281709dfa9c2137e7eb`) and
`runtime/vendor/bizhub-runtime-win32-x64-0.1.0-d3.zip` (SHA-256
`7948cdd1fac6bb330320bd3b08cee8b00630e4e47d300ce441626c670054fb27`).
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
npm run smoke:account-flow
npm run build:runtime
npm run prepare:runtime
npm run smoke:runtime-tamper
npm run smoke:local
npm run smoke:local-shell
npm run make
npm run verify:artifact -- "out/BizHub Desktop-darwin-arm64"
```

The account-flow smoke starts a real Electron window against a temporary HTTPS
directory and temporary Ed25519 key. It proves an account page with no password,
signed Workspace selection, cloud launch, an explicit unknown-account state,
zero fallback database creation, local-setup entry, cross-restart removal of
cloud Cookie/localStorage/cache, and desktop layout at 1280x820 and the
supported 960x720 minimum.

The local smoke uses temporary synthetic state. It proves explicit bootstrap,
authentication, Profile/data/writer identity, Generic Owner preview/apply/
readback, idempotent replay, tamper failure with zero write, backup validation,
restart readback, interrupted-setup recovery, concurrent-start deduplication,
coordinated Pack tamper rejection, and zero residual Runtime processes. The packaged cloud smoke
continues to use only `https://example.com` and never creates a local instance.

See the [D2 verification record](../docs/verification/desktop-d2-local-generic-2026-08-25.md).
The Windows x64 equivalent runs on `windows-2022` through
`desktop-d3-windows.yml`; see the
[D3 verification record](../docs/verification/desktop-d3-windows-x64-2026-08-26.md).

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

Desktop-D3 is merged to public `main`; its reviewed Windows Artifact remains
evidence rather than a formal public release. The configured W2 candidate does
not authorize publication. Formal release still requires real customer cloud
login validation, an owned neutral directory domain for broad distribution,
macOS signing/notarization, production Windows Authenticode, and resolution of
the retained build-chain audit findings.
