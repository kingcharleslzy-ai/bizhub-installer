# BizHub Desktop release-gated product candidate

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

Tencent Cloud blocks unregistered wildcard-DNS hostnames before ACME can validate
them, so the initial transport uses the existing US operations VPS through
`nip.io:8443` and a source-IP-restricted origin path. This is a practical
configured checkpoint, not the desired broad-release identity. Replace it with
an owned customer-neutral BizHub domain on standard port 443 before public
distribution; the packaged Ed25519 trust root remains the authority while that
transport URL changes.

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

Descriptor `expires_at` is an admission deadline, not the cloud business
Session lifetime. Desktop revalidates signature, key window, Shell compatibility,
and expiry immediately before every Workspace open. Once the Workspace is open,
its Runtime owns login and Session lifetime, so Descriptor expiry does not close
the running view. After disconnect, the retained expired envelope cannot reopen;
the user must query the directory for a fresh Descriptor.

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

Desktop-R1 uses three separate fail-closed workflows. Synthetic CI contains no
production-secret reference and cannot publish. The protected signed-candidate
workflow produces fixed native Artifacts plus a `desktop.release-plan.v1` and
stops. After the Owner approves that exact plan SHA, the separately protected
publish workflow can download only that source run and publish the same bytes;
it cannot rebuild or re-sign them. The Shell version is not globally frozen:
every later product version receives its own immutable release tag and
Artifacts.

Both native paths also exercise a synthetic previous version, create one formal
Generic Owner record, move to the current version, read it back, reinstall the
prior version, and read back the same data/writer identity. This proves the
installation-level upgrade/rollback boundary; it does not implement automatic
updates.

The macOS release path first verifies the fixed unsigned Runtime Pack, signs
every Runtime Mach-O object with the same Developer ID used for the Shell,
rebuilds a release-specific Manifest/trust record over those signed bytes, then
signs and notarizes the application and DMG. The ZIP and mounted DMG are both
read back through the same Runtime and signature verifier. Windows verifies the
accepted fixed D3 Runtime, signs each previously unsigned PE including
`bizhub-runtime.exe`, regenerates release-specific Manifest/trust over those
bytes, then signs the Shell and Squirrel chain. Packaged and installed checks
require every Runtime PE to be Authenticode `Valid`.

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

Desktop-D1 through D3 and W1/W2 are merged. Desktop-R1 is currently an
implementation candidate, not a formal Release. Its local macOS synthetic path
has proved the signed Pack, hardened application, real packaged account flow,
Generic Owner chain, ZIP, and DMG while retaining zero npm audit findings at
the configured threshold. Synthetic signatures establish build mechanics only;
they are never publisher authority.

Formal publication remains blocked until the project Owner separately provides
an Apple Developer ID/Application notarization identity, a publicly trusted
Windows Authenticode identity, and an owned customer-neutral account-directory
domain on standard HTTPS 443. The current `nip.io:8443` W2 transport is
intentionally rejected by production preflight. No current R1 code path changes
the directory service, account mapping, cloud login, SQLite, migrations,
Profile, Owner, writer, or production data.

Production signing and publication use distinct protected GitHub Environments,
both with required review, self-review prohibited, and `main`-only deployment.
Because the repository currently has only one collaborator, these gates remain
intentionally unapprovable until an independent reviewer is added. No formal
publisher credential is configured by this candidate.
