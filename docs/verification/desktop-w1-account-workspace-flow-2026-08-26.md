# Desktop-W1 account and Workspace flow verification — 2026-08-26

## Result

Desktop-W1 is a verified product-flow candidate for macOS arm64 and Windows
x64. It is not a release. The same customer-neutral Desktop package now starts
from one account identifier and presents only two explicit choices:

1. a platform-signed enterprise cloud Workspace returned for that account; or
2. a new or existing independent Generic local Workspace.

The account lookup does not receive a password. A selected cloud Runtime owns
its password login. A selected local Runtime owns its local administrator
login. Directory failure, an unknown account, and a known account with no
Workspace never start the local Runtime and never create a local SQLite file.

No production directory URL, production trust key, customer account mapping,
customer-private code or data, production login, deployment, installer build,
signing, notarization, release upload, or database write was performed.

## Fixed identities

- public `main` base, including the accepted Desktop-D3 work:
  `cee569717410c45a768e5a144cb1bf7158826513`;
- initial Desktop-W1 implementation head:
  `dd11c4794eed42eb5b7620d964881b39d6b58ac3`;
- pre-review Desktop-W1 implementation head:
  `5ee2071a7acdc68011a5a06ef8fff3bff9d51ec6`;
- narrow-fix Desktop-W1 implementation head:
  `5d556f1740fcf1060cfcd7dde1ecc7445fce7ec6`;
- narrow-fix implementation GitHub Actions run: `32942928506`;
- workflow: `Desktop Workspace Flow`;
- matrix jobs:
  - `product-flow (macos-14, darwin, arm64)`;
  - `product-flow (windows-2022, win32, x64)`.

The Git commit containing this report is a report-only evidence commit. The
report intentionally does not write its own Git SHA and does not redefine the
implementation identity above.

## Product flow

```text
open one generic Desktop package
-> enter account identifier only
-> exact configured HTTPS account-directory lookup
-> validate every returned Workspace against packaged Ed25519 trust
-> choose one signed enterprise cloud Workspace
   -> open only its signed HTTPS origin
   -> that cloud Runtime presents and validates its own password login
or
-> explicitly choose Generic local
   -> create or start one fixed Generic Runtime
   -> that local Runtime presents and validates its own administrator login
```

The client never infers customer identity from an email suffix, display name,
hostname, or local database. It does not contain a Dazheng account list or
customer endpoint. Account switching clears the selected account partition's
remote cookies and cache. Cloud Workspace partitions are non-persistent:
closing a Workspace may retain its temporary login only in the current Desktop
process, while quitting Desktop removes Cookie, localStorage, and cache and
requires cloud login again after restart.

Account lookup is Workspace discovery, not unified identity authentication.
Knowing an account identifier cannot authorize access; the selected cloud
Runtime still owns login and permissions. Generic Local remains an explicit
option for every installation, including when an enterprise Workspace is
available. A future restriction would require a signed entitlement rather than
customer or account-name logic.

The directory request is bounded to:

```json
{"schema_version":"bizhub.desktop-account-lookup.v1","account_id":"..."}
```

It never contains the password. One 10-second deadline covers fetch, streamed
body receipt, JSON parse, and signed Workspace validation. The streaming reader
cancels and aborts immediately above 64 KiB instead of buffering the complete
body first. Responses contain at most eight Workspaces, redirects are rejected,
and every Workspace must declare both `runtime_mode=cloud` and
`data_authority_mode=cloud`. A Workspace cannot outlive its signing key and
cannot require an unsupported Desktop shell version.

Each main-process lookup receives a monotonic generation. Results are built in
a local Map and only the current generation can atomically replace the active
Workspace set and UI state. A later lookup or account reset invalidates every
older success and error result.

## Acceptance evidence

The real Electron smoke used a temporary HTTPS account directory and a
temporary Ed25519 signing key. It exercised both the development app and the
packaged app without weakening the checked-in empty production trust state.
It proved:

- the initial account screen has zero password fields;
- the directory receives five account-only requests and zero passwords;
- a valid signed Workspace is displayed and opens a temporary local HTTPS test
  Runtime;
- changing account removes the active temporary Session state;
- a known account with zero Workspaces creates zero local instances;
- an HTTP `404` unknown account creates zero local instances;
- Generic local setup appears only after the user explicitly chooses it;
- account A writes a test Cookie, localStorage value, and cache entry; after
  application exit, restart, and account B selection, reopening account A sees
  none of the old state and performs a fresh cache request;
- both `1280x820` and minimum `960x720` layouts have no horizontal overflow;
- temporary packaged trust/config substitution is restored before the final
  artifact scan;
- every run leaves zero residual Runtime processes.

The existing Generic local business-path acceptance also remained green:

```text
Owner apply: applied
exact replay: idempotent_noop
tampered failure: zero writes
backup: valid
restart formal readback: 1 record
maximum live Runtime processes: 1
residual Runtime processes: 0
```

Local machine checks:

```text
npm test
  44 passed, 0 failed
  response headers + hanging body: timeout
  streaming body above 64 KiB: aborted before full receipt
  valid response below 64 KiB: accepted
  concurrent A slow / B fast: only B committed
  lookup followed by reset: stale result rejected

npm run smoke:account-flow
  status=passed
  account_screen_password_fields=0
  account_directory_requests=5
  account_directory_passwords=0
  signed_cloud_workspaces=1
  cloud_workspace_connected=true
  known_account_without_workspace_local_instances_created=0
  unknown_account_local_instances_created=0
  local_setup_form_reached=true
  cross_restart_cookie_storage_cache_cleared=true
  cloud_session_persistent=false
  viewports=1280x820,960x720

npm run verify:boundary
  status=ok
  python_source_files=4, sqlite_files=0
  trusted_connection_keys=0, private_markers=0

npm run audit:runtime
  0 vulnerabilities

install checksum verification
  159 files verified
```

The narrow-fix implementation GitHub Actions run independently completed both
matrix jobs with `success`. Each job verified source identity, tests, the
public/private boundary and Runtime dependency audit; prepared the fixed Generic
Runtime; ran the account and local product flows; packaged an unsigned app for
its own platform; repeated the flow against that packaged app; rescanned the
packaged artifact; and confirmed no residual process. The workflow has
read-only permissions and contains no installer maker, signing, Artifact
upload, or Release step.

## Deliberately empty production configuration

The public candidate remains fail-closed:

```text
desktop/config/account-directory.json: resolve_url = null
desktop/config/trusted-connection-keys.json: keys = []
```

Therefore a real enterprise account, including a Dazheng account, cannot yet
resolve from this branch. That is a deployment/configuration gate, not a reason
to embed customer identity in the generic installer.

Before a formal Desktop release, the project Owner must separately approve:

1. one customer-neutral production account-directory HTTPS endpoint;
2. the production public signing key included in the installer, while the
   private signing key remains outside both repositories;
3. the private account-to-Workspace mapping that returns a short-lived signed
   descriptor for `profile_id=dazheng` and the existing official cloud URL;
4. a bounded real-account login/read-only check proving that Dazheng reaches
   cloud and an unrelated account can explicitly create Generic local;
5. the existing formal code-signing, notarization/Authenticode, dependency and
   release approvals.

Those steps must not move, copy, synchronize, or create another writer for the
Dazheng database. Desktop-W1 does not authorize them and does not authorize a
release.

The version contract permits independent Shell, Descriptor, cloud Runtime, and
local Runtime identities. W1 does not implement automatic Shell update,
Runtime Pack download, migration/rollback, or latest/stable channels; those
remain later Release work.
