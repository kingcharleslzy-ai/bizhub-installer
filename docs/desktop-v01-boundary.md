# BizHub Desktop v0.1 boundary decision

Status: accepted; Desktop-D1 implementation candidate, not released

Date: 2026-08-25

## Decision

BizHub Desktop v0.1 uses one customer-neutral installer with two explicit entry
paths:

```text
BizHub Desktop
├── enterprise cloud login -> the enterprise HTTPS Runtime
└── local login/setup      -> one local Generic Runtime
```

The desktop package is a delivery mechanism, not a third business Profile. It
must not contain customer-private routes, rules, prompts, credentials, Profile
Locks, adapters, collectors, names, accounts, or endpoints.

Cloud business behavior comes from the cloud Runtime. Local business behavior
comes from one fixed Generic Runtime built from the canonical public artifact.
Electron and Vue connect to a backend API; they never open SQLite.

Desktop-D0 was approved on 2026-08-25. The current authorization covers only
the Desktop-D1 customer-neutral cloud-shell implementation and local unsigned
packaging proof. It does not authorize Desktop-D2, installation, publication,
production access, migration, or a writer switch.

## Installer

The v0.1 target contains:

- a minimal Electron shell and shell UI;
- the fixed Generic business UI;
- one platform-specific Generic Python Runtime in PyInstaller one-folder form;
- the fixed Generic Profile Lock and release manifest;
- local Runtime start, stop, health, log, and recovery orchestration.

A cloud-only user installs the same package, but the Generic Runtime stays
stopped and no formal local database is created.

The current `generic-kernel-smoke` artifact proves the common-source and Profile
boundary. It is not yet claimed to be a complete desktop-ready Generic Runtime.

## Accounts and connection

The first screen exposes two actions:

1. **Enterprise cloud** — use an approved connection profile, then authenticate
   directly with that enterprise Runtime.
2. **Local BizHub** — authenticate locally, or explicitly initialize the first
   local instance when none exists.

No global IAM or Workspace membership platform is required in v0.1.

An enterprise code resolver may return a signed connection profile containing
only an exact HTTPS origin, Profile ID, shell compatibility, expiry, key ID, and
signature. It receives no password and stores no business data or account
membership. The target Runtime remains the authentication and permission owner.

A failed cloud login never creates a local account or database. An unknown local
username never self-registers. The first local setup requires explicit user
confirmation.

One installation owns at most one local company instance, one SQLite database,
and one first administrator in v0.1. A username does not select or create a
database.

## Runtime and data authority

Cloud mode:

```text
HTTPS cloud Runtime -> cloud Owner -> cloud SQLite
```

- no Generic Python process starts locally;
- no formal local SQLite is created as fallback or cache;
- a cloud outage remains visible and never creates a local writer.

Local mode:

```text
explicit setup
-> one-use bootstrap secret
-> Generic Runtime on random 127.0.0.1 port
-> one local SQLite + first administrator
-> migration + health + system map + Owner readback
```

Cloud and local instances have independent data identities and unique Owners.
There is no synchronization, replication, failover, shared formal database, or
automatic authority switch. Logging in never moves existing data.

Moving an existing customer-private system from cloud to local is excluded. It
would require a separately approved private Runtime, stop-write, backup,
transfer, integrity verification, authority cutover, health, system map, and
Owner readback.

## Security and lifecycle

The desktop boundary requires:

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and
  `webSecurity: true` for business content;
- exact approved HTTPS origins and no privileged IPC for cloud pages;
- local API binding only to `127.0.0.1` on a random port;
- Runtime-owned authentication and formal writes;
- operating-system credential storage for secrets;
- graceful local Runtime shutdown and visible abnormal-exit recovery.

The v0.1 local Runtime may stop with the desktop/tray. Background work after
desktop exit requires a separate LaunchAgent, LaunchDaemon, or Windows Service
checkpoint.

## Excluded from v0.1

- global IAM, organization hierarchy, membership, invitation, SSO, billing, or
  device-management platforms;
- multiple local companies or one database per username;
- customer-private local Runtime Packs;
- cloud/local migration, synchronization, writer leases, or authority switching;
- background operating-system services;
- hot-installed modules or runtime Profile changes;
- automatic production migrations or database rollback.

## Checkpoints and evidence

Each checkpoint requires separate authorization:

1. **Desktop-D0:** accepted on 2026-08-25; no executable change.
2. **Desktop-D1:** implementation candidate completed locally on 2026-08-25;
   prove the public shell can open an approved cloud Runtime without starting
   Python or creating SQLite. See the
   [local verification record](verification/desktop-d1-cloud-shell-2026-08-25.md).
3. **Desktop-D2:** on macOS arm64 with synthetic data, prove Generic local setup,
   authentication, Owner preview/apply/readback, idempotent replay, restart,
   backup, and failure-zero-write behavior.
4. **Desktop-D3:** repeat the fixed release on Windows x64 with signing and
   installer evidence.
5. **Desktop-D4/D5:** background service or private cloud-to-local cutover only
   after a new business decision and authorization.

Machine evidence must also prove that the public package contains no
customer-private material, a failed login never initializes another mode, an
unknown username never creates another database, Electron contains no SQLite
writer, and shutdown leaves no active local writer.
