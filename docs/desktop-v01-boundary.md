# BizHub Desktop v0.1 boundary decision

Status: accepted boundary; Desktop-D3/W1/W2 merged; Desktop-R1 implementation candidate

Date: 2026-08-26

## Decision

BizHub Desktop v0.1 uses one customer-neutral installer with two explicit entry
paths:

```text
BizHub Desktop
├── account lookup -> signed cloud Workspace -> its HTTPS Runtime login
└── explicit local login/setup               -> one local Generic Runtime
```

The desktop package is a delivery mechanism, not a third business Profile. It
must not contain customer-private routes, rules, prompts, credentials, Profile
Locks, adapters, collectors, names, accounts, or endpoints.

Cloud business behavior comes from the cloud Runtime. Local business behavior
comes from one fixed Generic Runtime built from the canonical public artifact.
Electron and Vue connect to a backend API; they never open SQLite.

Desktop-D0, Desktop-D1, and Desktop-D2 were approved on 2026-08-25. Desktop-D2
was merged to public `main` at
`84c234fb0d2727e87d2dd0b30cd212b3cd658ad6` after the narrow trust/lifecycle
repairs and a successful fixed-head macOS arm64 workflow. Its unsigned Artifact
remains review evidence rather than a distributable release.

Desktop-D3 was separately authorized, externally reviewed, and merged to public
`main` at `cee569717410c45a768e5a144cb1bf7158826513`. Its synthetic signer and
unsigned fixed Runtime remain evidence rather than public-distribution
authority. Desktop-W1 now fills the product-flow gap without changing the D3
Runtime Pack, Windows installer chain, formal data, or writer authority.

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

The first screen exposes two explicit routes:

1. **BizHub account lookup** — submit only an account identifier, select a
   platform-signed cloud Workspace, then authenticate directly with its Runtime.
2. **Local BizHub** — authenticate locally, or explicitly initialize the first
   local instance when none exists.

No global IAM or Workspace membership platform is required in v0.1. Account
lookup is Workspace discovery only; it does not authenticate the account or
grant access to the returned Runtime.

The account directory returns signed connection envelopes containing an exact
HTTPS origin, Profile ID, `runtime_mode=cloud`,
`data_authority_mode=cloud`, shell compatibility, expiry, key ID, and signature.
It receives no password and stores no business data. The target Runtime remains
the authentication and permission owner.

The signed connection file is only the Desktop-D1 Workspace bootstrap used to
prove the shell boundary. Desktop-W1 replaces that manual product step with
account-driven lookup, but deliberately does not add password authentication,
refresh tokens, device sessions, organization management, invitations, SSO, or
billing to the Shell.

Desktop-W2 provisions the platform directory transport and the first production
trust root without turning the Shell into an identity provider. The package
contains only a customer-neutral HTTPS directory address and an Ed25519 public
key. Account mappings, signing private keys, customer display names, Profile
IDs, and Workspace URLs remain deployment-side data and are returned only in a
short-lived signed envelope. The first configured cloud Runtime still owns its
password login, session, permissions, business rules, Owners, and database.

Tencent Cloud blocks unregistered wildcard-DNS hostnames before ACME validation,
so the initial directory transport uses the existing US operations VPS through
`nip.io:8443` and a source-IP-restricted origin path. This avoids embedding a
customer domain in the generic package and is sufficient for the configured
product-flow checkpoint. It is not the preferred long-term release-channel
identity: a separately owned, customer-neutral BizHub domain on standard port
443 should replace it before broad public release. The Ed25519 trust root is
independent of that transport hostname, so changing the directory URL does not
change customer Runtime authority.

Cloud browser sessions are isolated in non-persistent partitions derived from
the hash of account identifier plus Workspace ID. Changing the account clears
the active temporary Workspace storage and cache. Closing a Workspace without
changing account may preserve that session only inside the current Desktop
process; quitting Desktop destroys it, so cloud login is required again after
restart.

The 10-second directory deadline covers fetch, streamed body receipt, JSON
parse, and Workspace validation. Receipt stops immediately above 64 KiB. Only
the latest main-process account lookup generation may atomically replace the
active Workspace set, and reset invalidates every in-flight result.

Descriptor expiry is a connection-admission boundary, not a cloud business
Session expiry. Desktop validates the envelope again immediately before every
Workspace open. A view opened while the Descriptor is valid remains under the
selected Runtime's login and Session policy after that Descriptor expires.
Disconnecting does not refresh authority: reopening with the old expired
envelope fails closed and requires a new account-directory query.

A confirmed directory `404` may expose the existing explicit Generic local
setup action. A directory timeout, invalid response, missing platform key, or
cloud login failure never becomes “account not found” and never creates a local
account or database. The first local setup still requires explicit user
confirmation.

One installation owns at most one local company instance, one SQLite database,
and one first administrator in v0.1. A username does not select or create a
database. The Local action is visible on every installation, but final creation
requires a fresh directory response proving that exact account is `not_found`.
An enterprise Workspace, a registered account without a Workspace, or any
directory failure rejects creation; no customer restriction is inferred from an
account string alone.

The product does not assume a permanently fixed version. Its contract allows
the Shell version, signed Workspace Descriptor expiry, cloud Runtime release,
and platform-specific local Runtime Pack to carry independent identities.
Account lookup refreshes signed Descriptors; Profile composition remains
build-time and Runtime Pack changes remain complete application releases rather
than per-module hot updates. Desktop-U1 adds the internal update channel: one
versioned release manifest, bounded native download, exact SHA-256, and a user-
confirmed restart. R1 still supplies the installation-level vN to vN+1 and
rollback data/readback proof; U1 does not introduce hot Runtime replacement.
Desktop 0.1.9 adds only a bounded per-device preference schema for appearance,
density, zoom, close behavior, launch at login, and automatic update checks.
These choices cannot contain credentials or business facts and cannot change
Runtime Pack, Profile, migration, Owner, writer, or cloud/local data authority.
Desktop 0.1.10 changes only artifact routing: GitHub is attempted first and one
byte-identical Aliyun `fallback_url` may be retried after a failed download.
Both paths remain bound to the same filename, size, and SHA-256.
Desktop 0.1.11 removes the unauthenticated Shell's wide custom header and uses
an integrated native title area over a bundled, customer-neutral blurred
workbench preview. The preview performs no remote load and contains no customer
or formal business data. A selected saved account collapses the account field
until the user chooses `切换账号`; login, password routing, automatic-login,
guest, Generic Local, update, Runtime, and formal-data boundaries are unchanged.
Desktop 0.1.12 removes the decorative login-card brand lockup and aligns the
logged-out palette with the formal workspace's neutral surfaces, charcoal
actions, and restrained warm accent. It changes no login behavior, account
directory, guest flow, Generic Local lifecycle, Runtime, or data authority.
The next bounded Desktop repair makes the GitHub Release Manifest the sole
update metadata authority while keeping Qilin only as an identical-file
fallback, encrypts cloud and local remembered sessions with Electron
`safeStorage` plus atomic file replacement, and rejects guest writes to device
preferences. It changes no Runtime Pack, SQLite schema, migration, Profile,
Owner, writer, directory mapping, private rule, or formal business data.

Desktop-R1 turns that evolving-version rule into an immutable release rule:
the current `package.json` version determines the only accepted release tag
(`desktop-v<version>` or `desktop-v<version>-preview.N`). A later Desktop update
changes the package version and creates a new tag; it never overwrites an older
release. Production dispatch also binds the exact public `main` commit, so a
moving branch cannot silently change a release candidate.

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
- account lookup sends no password and accepts only signed, unexpired cloud
  Descriptors whose expiry does not outlive the signing key; the same checks run
  immediately before every open, while an already-open Runtime Session is not
  terminated by Descriptor expiry;
- an account-directory error cannot be converted into an unknown-account or
  local-database fallback.

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
3. **Desktop-D2:** completed and merged to public `main` on 2026-08-25;
   on macOS arm64 with synthetic data, proves Generic local setup,
   authentication, Owner preview/apply/readback, idempotent replay, restart,
   backup, failure-zero-write behavior, fixed Pack identity, single Runtime
   lifecycle, and interrupted-setup recovery. Its first external code review
   returned three narrow lifecycle/trust fixes; the repaired fixed head passed
   its clean macOS arm64 workflow before the project Owner authorized the merge.
   See the
   [verification record](verification/desktop-d2-local-generic-2026-08-25.md).
4. **Desktop-D3:** implemented as an external-review candidate on 2026-08-26.
   Its fixed Runtime and Owner chain passed on Windows x64 with Squirrel
   installation, Shell/installer signing mechanics, uninstall data
   preservation, and zero-residual-process evidence. Squirrel is prevented from
   mutating the independently trusted Runtime subtree. Synthetic signing and the
   unsigned fixed sidecar remain review-only; production signing remains a
   separate release gate. See the
   [verification record](verification/desktop-d3-windows-x64-2026-08-26.md).
5. **Desktop-W1:** current account-to-Workspace product-flow candidate. It
   proves account-only lookup, signed cloud authority, explicit cloud/local
   selection, cloud launch, bounded streaming directory receipt, last-lookup
   state ownership, non-persistent cloud Sessions, unknown-account zero-write,
   and entry to local setup with synthetic evidence. It does not provision a
   production directory URL, production trust key, or real account mapping and
   is not a release approval.
6. **Desktop-W2:** configure a customer-neutral HTTPS directory endpoint, one
   production Ed25519 public trust key, and deployment-private account-to-
   Workspace mapping. This does not create Desktop installers or approve a
   Release.
7. **Desktop-R1:** three isolated workflows: secret-free dual-platform
   synthetic CI; protected exact-main signed-candidate generation ending in a
   fixed release-plan SHA; and independently protected publication of only the
   approved existing Artifacts. Windows signs previously unsigned Runtime PEs
   before trust rebinding, and both platforms prove vN to vN+1 to rollback
   Owner readback. Immutable releases and protected `main` are hard gates. The
   mechanism is deployment configuration; it adds no business module or writer.
8. **Desktop-U1:** a simple internal updater checks immutable `desktop-v*`
   releases, downloads and verifies the native package, creates a Generic Local
   backup when present, stops the Runtime, and hands off to macOS bundle swap or
   Windows Squirrel Setup. It changes no business or data authority.
9. **Desktop-D4/D5:** background service or private cloud-to-local cutover only
   after a new business decision and authorization.

Machine evidence must also prove that the public package contains no
customer-private material, a failed login never initializes another mode, an
unknown username never creates another database, Electron contains no SQLite
writer, and shutdown leaves no active local writer.
