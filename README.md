# BizHub

BizHub is an Agent-installed, single-company business system for private
deployment. Each customer gets one independent application container, one
administrator account, and one SQLite database.

The system covers master data, sales, purchasing, inventory, controlled data
imports, audit, backup, restore, and health readback. It is intentionally small:
it is not a multi-tenant ERP platform or a self-modifying Agent runtime.

## Choose a fixed release

Never install from `main` or another moving branch.

| Channel | Fixed release | Identity | Use |
| --- | --- | --- | --- |
| Stable | [`v0.3.0`](https://github.com/kingcharleslzy-ai/bizhub-installer/releases/tag/v0.3.0) | `1782417f4b05bb8abf657066f217453410128b92` | Supported single-company deployment |
| Preview | [`v0.7.0-preview.1`](https://github.com/kingcharleslzy-ai/bizhub-installer/releases/tag/v0.7.0-preview.1) | Resolve and verify the fixed tag | Same `bizhub-common` artifact used by Generic and the private reference derived-image proof |

The stable release passed a clean Ubuntu 24.04 installation, business-flow
test, backup/restore rehearsal, sensitive-information scan, and fresh-Agent
plugin test. Each real deployment must still verify its private TLS, domain, or
Cloudflare Tunnel before customer data enters.

The preview is a prerelease. It does not replace the stable default and does not
authorize customer-data migration, a production writer switch, or deployment
into an existing private system.

Desktop `0.1.16` packages the Pack A/B/C first-entry, co-build, and
system-candidate implementation for the existing internal update channel. It
is not part of either fixed server release above and does not turn that
prerelease channel into broad-public publisher authority. It keeps an
authenticated user in a plain-language `开始使用` context until they explicitly
enter the one bound company Workspace. After entry, it asks one ordinary
question at a time and projects dialogue, knowledge, pending confirmation,
improvement opportunities, a first inspectable candidate, and a bounded
read-only handoff from the existing Generic Runtime Owner. Once the customer has
provided the minimum confirmed goal, process, responsible role, and one observed
source, the same opportunity view shows a plain-language system plan: reusable
active Generic capabilities first, with an isolated `customer.*` scaffold
candidate only when the current Registry cannot express the need. The upstream
build-time Builder re-verifies trusted Blueprint acceptance and returns an
in-memory, non-executable candidate only; it is not packaged as a Runtime module.
No migration, business table, knowledge database, Profile entry, or writer is
added. Account registration, cloud company provisioning/invitations, arbitrary
file parsing, model inference, code materialization, module installation, and
deployment remain unimplemented.

On macOS, `0.1.16` also finalizes a successful update with Electron's
unpatched filesystem implementation so a verified rollback bundle containing
`app.asar` and its pending marker are removed after exact-version startup. This
changes only updater housekeeping and grants no new application or data
authority.

## Give the release to an Agent

Give the Agent one fixed release URL from the table above and ask it to:

1. resolve the tag to its verified 40-character commit;
2. verify [`install/CHECKSUMS.sha256`](install/CHECKSUMS.sha256) and inspect
   [`install/bootstrap.yaml`](install/bootstrap.yaml);
3. show every plugin, MCP, target-host, network, and filesystem change;
4. install exactly one `bizhub-core` plugin pinned to that commit;
5. start a new task with exactly one `bizhub-bootstrap` Skill and one
   `bizhub-mcp`;
6. run preflight and show the generated plan;
7. mutate the target only after the exact plan hash is approved;
8. verify the running instance, backup, and business readback; preview releases
   also verify their declared resource limits.

After verification, the host-native Codex plugin flow is:

```bash
codex plugin marketplace add kingcharleslzy-ai/bizhub-installer \
  --ref <VERIFIED_COMMIT>
codex plugin add bizhub-core@bizhub-public
codex plugin list --json
```

The final readback must show exactly one enabled `bizhub-core` from
`bizhub-public`, at the version declared by the fixed release. If the host
does not expose these CLI commands, use its Plugins directory to add the same
pinned repository source. Do not copy files into a global Skill directory or
register a second MCP.

Enter the administrator password only in the target host's interactive TTY.
Never send passwords, private keys, tokens, cookies, customer exports, or
databases through chat.

A release URL, README, checksum, or GitHub signature proves provenance. None of
them grants permission to change a machine.

## What is included

- company legal/display name, brand, timezone, and default currency;
- one Argon2-protected administrator with a secure HttpOnly session;
- customers and suppliers, products, units, and inventory locations;
- sales and purchase orders with partial fulfillment and cancellation;
- immutable inventory movements, non-negative stock, and reversal corrections;
- CSV/JSON staging, validation, preview, idempotent apply, and readback;
- audit history, online SQLite backup, verified restore, and system health;
- one FastAPI container with a minimal static shell;
- one `bizhub-mcp` and one `bizhub-bootstrap` Skill.

Not included:

- multi-tenancy, RBAC, employee applications, SSO, or MFA;
- invoices, payments, receivables, accounting, manufacturing, logistics, or
  employee task management;
- PostgreSQL or automatic migration from an arbitrary legacy ERP;
- a general connector SDK or company-specific collection logic;
- runtime-generated SQL, hot-installed business code, or direct Agent access to
  SQLite.

Customer-specific mappings, credentials, source adapters, and private modules
stay in the customer's private environment.

## Safety model

```text
fixed release + checksums
          │
          ▼
one plugin / one Skill / one MCP
          │
          ▼
preflight → immutable plan → exact-hash approval
          │
          ▼
bizhubctl install or update
          │
          ▼
health + business + backup readback
```

The kernel owns authentication, SQLite transactions, migrations, audit,
preview tokens, apply authorization, idempotency, backup/restore, and readback.
Every formal record type has one writer. An Agent or module may propose an
action, but it cannot replace or bypass those boundaries.

All formal writes follow:

`preview → explicit approval → apply → exact readback`

A changed input, dependency, mapping, state generation, or preview token fails
closed and requires a new preview.

## Preview capabilities

The preview history adds bounded contracts without turning BizHub into a
general plugin runtime. `v0.4`–`v0.6` remain immutable historical previews;
`v0.7` starts the same-source common-artifact line and does not carry their
separate legacy `/api/imports/*` implementation:

- `v0.4`: immutable customer-private derived images may add reviewed,
  authenticated read-only routers; mutation routes, lifecycle hooks,
  undeclared paths, durable extension entities, and dependency drift are
  rejected.
- `v0.5`: master-data status, aliases, external-identity mapping readback,
  explicit reconcile, and deprecated-party successor identity are
  preview-gated and audited.
- `v0.6`: one atomic party bundle resolves successor and alias-owner
  references by `source_id + external_id`; preview binds the complete bundle,
  dependency graph, operations, and state generation. Cycles, unknown owners,
  identity conflicts, content drift, and mid-bundle failure produce zero
  partial writes. Exact replay is idempotent.
- `v0.7`: the public image consumes one deterministic `bizhub-common` artifact
  exported from the canonical dual-Profile source. The private reference image
  uses the exact same artifact and public image layers, then adds a non-overlapping
  private layer. The installer binds the artifact digest into the plan and adds
  verified rollback alongside install, update, backup/restore, and retained-data
  uninstall.

These are implementation previews tested with synthetic data. Detailed evidence:

- [`v0.7.0-preview.1` common-artifact release](docs/verification/v070-preview1-common-artifact-release-e2e-2026-08-23.md)
- [`v0.6.0-preview.1` dependency-bundle release](docs/verification/v060-preview1-dependency-bundle-release-e2e-2026-08-21.md)
- [`v0.5.0-preview.2` successor release](docs/verification/v050-preview2-party-successor-release-e2e-2026-08-21.md)
- [`v0.4.0-preview.1` clean-host release baseline](docs/verification/v040-preview1-release-e2e-2026-08-16.md)
- [`v0.4` loopback and resource-limit E2E](docs/verification/v040-preview2-loopback-resource-e2e-2026-08-16.md)
- [retained failed release gate](docs/verification/v040-preview2-release-gate-failure-2026-08-16.md)

See [modular architecture](docs/modular-architecture.md),
[Agent evolution](docs/agent-evolution.md), and the executable
[read-only extension boundary](docs/read-only-extension.md) for the longer-term
build-time module rules. A manifest describes a module; it does not authorize
installation or business writes.

## Supported deployment

The supported target is Ubuntu 24.04 with Docker Engine. Run the `bizhubctl`
from the selected fixed release on the target through the user's approved SSH
session. This example uses the stable `v0.3.0` contract:

```bash
sudo ./bizhubctl preflight

sudo ./bizhubctl plan \
  --access domain \
  --bind-address 127.0.0.1 \
  --hostname bizhub.example.com \
  --profile-id example-company \
  --legal-name "Example Company Ltd." \
  --display-name "Example Company" \
  --brand-mark EX \
  --timezone Asia/Shanghai \
  --currency CNY \
  --admin-username admin \
  --output /tmp/bizhub-install-plan.json

sudo ./bizhubctl install \
  --plan /tmp/bizhub-install-plan.json \
  --approve EXACT_PLAN_HASH

sudo ./bizhubctl verify
sudo ./bizhubctl backup --label initial-restore-test
```

`domain` and `cloudflare` keep the application on loopback behind HTTPS.
`private` requires an explicit private IP; plain HTTP also requires the
conspicuous `--allow-http-private` plan flag.

The preview line additionally supports `loopback` access for SSH forwarding
or bounded Shadow runs and plan-bound memory, additional swap, CPU, and PID
limits. Preview verification checks both Docker metadata and the running
container's cgroup v2 values; an unlimited, unreadable, malformed, or
mismatched kernel value fails closed. Always read `bizhubctl --help` from the
fixed release instead of borrowing flags from `main`.

Fixed host paths:

- configuration: `/etc/bizhub`;
- database and install state: `/var/lib/bizhub`;
- backups: `/var/backups/bizhub`.

Repeated install/update is a no-op when the approved state is already active.
Updates create a verified online backup and rollback point first. `rollback`
requires the exact current plan hash and restores the verified previous image,
plan, resource limits, and database backup. `uninstall` removes only the
container and retains configuration, data, state, and backups. There is no
purge command.

See [operations](docs/operations.md) for update, rollback, restore, private
derived-image, and uninstall procedures.

## Data and adapters

The current common-artifact preview accepts typed master-data, inventory,
procurement, and sales Owner actions. Customer CSV, JSON, ERP, mail, and browser
adapters stay outside the server and must use preview/apply/readback; they do not
receive SQLite access. The older batch-import and dependency-bundle endpoints
remain available only in their immutable `v0.5`/`v0.6` tags. See
[data and action contracts](docs/data-import.md).

## Documentation

| Topic | Document |
| --- | --- |
| Target operations, backup, restore, update, rollback, uninstall | [Operations](docs/operations.md) |
| Current typed Owner actions and historical import boundary | [Data and action contracts](docs/data-import.md) |
| Kernel, modules, capabilities and extraction direction | [Modular architecture](docs/modular-architecture.md) |
| Public Desktop shell, account lookup, and Generic local boundary | [Desktop v0.1 boundary decision](docs/desktop-v01-boundary.md) |
| Desktop cloud/local product flow and configured directory trust | [Desktop implementation](desktop/README.md), [D1 evidence](docs/verification/desktop-d1-cloud-shell-2026-08-25.md), [D2 evidence](docs/verification/desktop-d2-local-generic-2026-08-25.md), and [D3 evidence](docs/verification/desktop-d3-windows-x64-2026-08-26.md) |
| How a customer's Agent chooses config, mapping, Skill, or module | [Agent evolution](docs/agent-evolution.md) |
| Executable private read-only extension boundary | [Read-only extension](docs/read-only-extension.md) |
| Common artifact identity and two-Profile image boundary | [Common artifact delivery](docs/common-artifact-delivery.md) |
| Retired legacy public core and recovery record | [Legacy core retirement](docs/legacy-core-retirement.md) |
| CP-5 public delivery review object and gates | [CP-5 public delivery report](docs/cp-5-public-delivery-report.md) |
| Documentation-only customer Skill guidance | [Customer Skill extension](docs/customer-skill-extension.md) |
| Vulnerability reporting and supported versions | [Security policy](SECURITY.md) |
| Immutable release evidence | [Verification records](docs/verification/) |

## Maintainer verification

These commands execute reviewed repository code:

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python \
  -r app/backend/requirements-dev.lock

python scripts/update_checksums.py
python scripts/verify_checksums.py
.venv/bin/pytest -q tests

npm --prefix app/frontend ci
npm --prefix app/frontend run build
npm --prefix app/frontend audit --audit-level=high
```

Docker verification must use a clean environment without a customer-private
repository on `PYTHONPATH`. Release evidence must distinguish implemented,
locally tested, and clean-Ubuntu-tested facts.

## Licensing

The bootstrap, Agent integration, documentation, and plugin paths listed in
[LICENSE](LICENSE) use MIT. The application core, deployment templates, and
`bizhubctl` use the source-available BizHub Core Private Deployment License.
It permits internal deployment and modification but not redistribution, resale,
or hosted/managed service.
