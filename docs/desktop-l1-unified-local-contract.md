# Desktop-L1 unified login and Generic Local contract

Desktop-L1 is a customer-neutral private-project delivery slice. It does not
change any customer-private repository, production service, database migration,
Profile, Owner, writer, account mapping, or signing key.

## One login form

The Shell accepts exactly `accountId`, `password`, and `remember`.

1. If one local instance exists and its administrator name exactly matches the
   normalized account identifier, Desktop starts that Runtime and authenticates
   locally. It does not contact the account directory.
2. Every other account is sent to the account-only HTTPS directory. The password
   is never included in that request.
3. A signed cloud Workspace receives the password only through its same-origin
   BizHub login API after Descriptor verification.
4. When no local instance exists, the same login surface always exposes an
   explicit `创建本地账号` action. It reveals the inline Generic Local form
   without querying the enterprise directory and creates nothing until the user
   submits the confirmation. Final confirmation always performs a fresh lookup
   and may call the existing bootstrap only when that lookup explicitly returns
   `not_found` and the machine still has no local instance. A confirmed directory
   `not_found` may also reveal the same form after a failed cloud login. Cloud,
   registered-without-Workspace, network, configuration, signature, timeout,
   and malformed-response results never create a database or replace a saved
   cloud account.

An installation owns at most one local instance. Local and cloud data never
synchronize, copy, or share a writer.

## Remembered accounts

Desktop never persists a password. It keeps at most eight account labels and an
optional Runtime-issued token in `saved-accounts.v2.json`, restricted to the
current OS user (`0600` where POSIX modes apply). macOS Keychain and Windows
DPAPI are not required. A valid W1 `remembered-session.v1.json` cloud token is
migrated once; malformed or expired tokens fail closed.

Local remember tokens contain only purpose, username, administrator
`auth_version`, and expiry, protected by the existing local secret. Existing
administrator files without `auth_version` read as version 1. Password change
writes version 2 or later and invalidates all older session and remember tokens;
it does not add or modify a SQLite migration.

## Generic Local workspace

The local Runtime serves a Vue workspace with six entries: overview, master
data, procurement, sales, inventory, and settings. The delivery adapter may add
bounded read-only projections for these pages. Master-data, procurement, sales,
and inventory mutations remain on the existing public typed
`preview -> apply -> readback` APIs. Electron and Vue never open or write SQLite
directly. Procurement and sales forms require a user-supplied contract, email,
receipt, shipment, or other source-reference identifier; the UI does not invent
an empty evidence list to bypass the Owner contract.

Settings is intentionally small: create a validated backup, open the backup
folder, change the local password, switch account, clear the active remembered
token, and display Shell/Runtime identity. It contains no module manager,
connector platform, synchronization controls, or release governance.

## Acceptance

Acceptance requires source tests, a real Electron cloud account flow, a real
Electron Generic Local workspace flow, existing Owner lifecycle, idempotency,
failure-zero-write, backup and restart evidence, legacy local-instance read-only
compatibility, public-boundary scanning, and native macOS arm64 plus Windows x64
Runtime/package checks. Synthetic fixtures use isolated application data and
never touch customer production.
