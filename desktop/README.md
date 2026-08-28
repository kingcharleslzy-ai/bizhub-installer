# BizHub Desktop release-gated product candidate

This directory contains the merged Desktop-D1/D2/D3 cross-platform baseline
plus the current account-to-Workspace product flow. One customer-neutral
Electron shell exposes one login form:

```text
account + password -> exact existing local account -> fixed Generic Runtime -> local SQLite
                   -> otherwise account-only HTTPS directory -> signed cloud Workspace -> direct cloud login
                   -> confirmed unknown + no local instance -> explicit first-time local creation
```

The Shell presents account and password in one form, but the account-directory
request still contains only the normalized account identifier and never the
password. After one signed Workspace is verified, the Shell submits the password
only to that Workspace's same-origin BizHub authentication route and opens the
authenticated application without exposing the intermediate web login page.
After authentication, the cloud Workspace replaces the Desktop chrome and uses
the full content area. On macOS the native controls are inset into the Workspace
surface instead of reserving a separate white title bar. A narrow cloud preload
allows the verified Workspace to read the neutral Desktop version/update state,
request an update check, or return to the account selector; it exposes no
filesystem, shell, credential, token, customer mapping, or business-data API.
Each returned cloud
Workspace is an independently signed, expiring connection envelope bound to
`runtime_mode=cloud` and `data_authority_mode=cloud`. That Workspace Runtime owns
authentication, permissions, UI, Owners, and formal data. A confirmed unknown
account may create the machine's one Generic local instance inline. The combined
login surface also exposes one explicit `创建本地账号` action whenever no local
instance exists; opening it does not query the directory or create data before
confirmation. Confirmation performs a fresh directory lookup and calls bootstrap
only after an explicit `not_found`. An existing cloud Workspace, a registered
account with no Workspace, directory timeout/error, invalid signature/response,
or missing configuration never creates local data or changes a saved cloud
account.

“保持登录” is enabled by default for the private-project experience. Cloud and
local passwords are used once and discarded. Desktop keeps up to eight account
labels and only revocable, expiring Runtime tokens in one bounded `0600`
application-data file; Windows relies on the current user's AppData ACL. It does
not require macOS Keychain or Windows DPAPI. Existing W1 cloud tokens migrate on
first read. Selecting a saved account with a valid token logs in directly;
selecting an expired entry asks for its password. Explicit logout clears that
account's token and returns to the same form.

The local Runtime is a PyInstaller `onedir` built from the existing public
delivery adapter and the exact vendored `bizhub-common` artifact. Its Vue
workspace provides overview, master data, procurement, sales, inventory, and a
small settings page. Bounded delivery read models project existing tables;
formal mutations still submit typed previews to the existing Generic Owners.
Procurement and sales actions require a source-evidence reference supplied by
the user before preview.

Desktop-W2 configures one customer-neutral HTTPS directory transport and one
Ed25519 public trust root. The package still contains no customer-private
Profile, rule, customer endpoint, account mapping, credential, production data,
model, collector, synchronization, background service, or
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
destroys it. If a remembered session token exists, the next launch performs a
fresh directory lookup and opens the cloud application without another password
request; otherwise the user sees the combined login form. Choosing “换一个账号”
closes the active view and uses the selected account's token when available.
Explicit logout clears only the active token, not the account label or local
business data.

Closing the main window on macOS or Windows hides BizHub Desktop in the
background without destroying the connected Workspace or stopping Generic
Local. Clicking the macOS Dock icon, the Windows tray icon, or starting BizHub
Desktop again restores the same Session. Only the explicit operating-system
quit action or Windows tray “退出 BizHub” ends the process and local Runtime.

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

Generic Local is one independent authority per installation and never copies,
synchronizes, or writes enterprise data. Once created, only its exact local
administrator account routes to it; other accounts continue through cloud
discovery and cannot create a second local instance.

The version contract allows the Shell, signed Workspace Descriptor, cloud
Runtime, and local Runtime to evolve independently. `shell_min_version` is a
compatibility floor, not a fixed business version. Each account lookup may
return a newer signed Descriptor; local Runtime changes still require a
separately signed immutable Pack rather than hot-installed modules. Automatic
Shell updates, Runtime Pack download, migration/rollback, and update channels
are not implemented by W1.

The fixed review inputs are
`runtime/vendor/bizhub-runtime-darwin-arm64-0.1.0-d2.zip` (SHA-256
`55d85fbf7a8be3ea2f04abfb79cbd3e59fe71d6314ffd524b1e399346662a95f`) and
`runtime/vendor/bizhub-runtime-win32-x64-0.1.0-d3.zip` (SHA-256
`76462083376acd82b0ca2a303b8250599ce9560f35a7190882da0c697b1f938f`).
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

The existing advanced Desktop-R1 signing/publish workflows remain available but
frozen for a future broad public release. They are not the default private-
project path. Current internal builds run the source tests, build native macOS
and Windows packages, generate checksums, and stop at downloadable test
Artifacts. The Shell version is not globally frozen; each build records its own
commit and Artifact identity.

Both native paths also exercise a synthetic previous version, create one formal
Generic Owner record, move to the current version, read it back, reinstall the
prior version, and read back the same data/writer identity. This proves the
installation-level upgrade/rollback boundary; R1 by itself did not implement
automatic updates.

Desktop-U1 now adds the small private-project update path on top of that proven
boundary: the packaged Shell checks only versioned `desktop-v*` GitHub Releases,
downloads the matching macOS arm64 or Windows x64 artifact, enforces its declared
size and SHA-256, and offers one restart action. Generic Local creates a verified
backup and stops its Runtime before the installer starts. The update entry is in
the native application menu and exactly one status area beside the combined login
flow; available and downloaded versions are emphasized without blocking account
authentication. Compatible cloud/PWA frontend revisions activate and refresh in
their shared web lifecycle without adding a second Desktop update prompt;
it does not restore duplicate Desktop chrome over a connected Workspace. See
[`desktop-u1-update-contract.md`](../docs/desktop-u1-update-contract.md).

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
directory and temporary Ed25519 key. It proves one account/password submission,
zero password bytes in every directory request, password delivery only to the
verified Workspace, direct authenticated launch, zero saved password bytes,
token reuse without a second password request, automatic login after restart,
the absence of duplicate Desktop chrome, Workspace-owned revoking logout, an
explicit unknown-account state, zero fallback database
creation, cross-restart removal of old cloud Cookie/localStorage/cache, and
desktop layout at 1280x820 and the
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

Broad public publication remains blocked until the project Owner separately provides
an Apple Developer ID/Application notarization identity, a publicly trusted
Windows Authenticode identity, and an owned customer-neutral account-directory
domain on standard HTTPS 443. The current `nip.io:8443` W2 transport is
intentionally rejected by production preflight. The unified-login candidate
changes only customer-neutral Shell orchestration and bounded remembered-token
storage; it does not change the directory service, account mapping, cloud
password rule, SQLite, migrations, Profile, Owner, writer, or production data.
No second reviewer is required for private internal builds. No formal publisher
credential is configured or used by this candidate.
