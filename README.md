# BizHub

BizHub is a small, private business system that a customer's Agent can install
from one fixed public GitHub release. Each company receives one independent
instance, one administrator account, one application container, and one SQLite
database.

> **Current stable release: `v0.3.0`.** This exact release passed its Ubuntu
> 24.04 clean-host install, Docker business-flow test, backup/restore rehearsal,
> sensitive-information scan, and fresh-Agent plugin forward test. Each customer
> deployment must still verify its final private TLS, domain, or Cloudflare
> Tunnel access path before real customer data enters.

> **Current development preview: `v0.4.0-preview.2`.** It adds the bounded
> customer-private read-only derived-image chain, loopback-only access, and
> plan-bound container resource limits. It must pass the tag-triggered clean
> Ubuntu workflow and fresh-Agent forward test before publication, and it does
> not replace the stable default.

## Give the release to an Agent

Use the immutable release URL once the tag is published:

`https://github.com/kingcharleslzy-ai/bizhub-installer/releases/tag/v0.3.0`

Once the derived-image preview tag is published and verified, use:

`https://github.com/kingcharleslzy-ai/bizhub-installer/releases/tag/v0.4.0-preview.2`

Ask the Agent to verify the release and checksums, install the repository's one
plugin, load its one `bizhub-bootstrap` Skill, and follow the staged interview.
The Agent will ask about the Ubuntu target, access mode, company profile,
administrator username, and first data source. Enter the administrator password
only in the target host's interactive TTY.

The Agent must show the generated plan and receive approval for its exact hash
before running installation. A repository link, README, or GitHub signature is
provenance—not permission to change a machine.

After resolving the release tag to its verified 40-character commit, the Agent
may use the host-native Codex plugin commands below. It must show these host
changes and obtain approval before running them; `<VERIFIED_COMMIT>` is never a
moving branch or an unverified tag:

```bash
codex plugin marketplace add kingcharleslzy-ai/bizhub-installer \
  --ref <VERIFIED_COMMIT>
codex plugin add bizhub-core@bizhub-public
codex plugin list --json
```

The final readback must show exactly one enabled `bizhub-core` from
`bizhub-public`, at the version declared by the fixed release. Start a new Agent
task before using its Skill or MCP tools. If the host does not expose these CLI
commands, use its Plugins directory to add the same pinned repository source
and install `bizhub-core`; do not copy files into a global Skill directory or
register a second MCP as a workaround.

## Product boundary

Included:

- company legal/display name, brand, timezone, and default currency;
- one Argon2-protected administrator with a secure HttpOnly session;
- customers and suppliers, products, units, and inventory locations;
- sales and purchase orders with partial fulfillment and cancellation;
- immutable inventory movements, non-negative stock, and reversal corrections;
- CSV/JSON staging, validation, preview, idempotent apply, and readback;
- audit history, online SQLite backup, verified restore, and system health;
- one FastAPI + built Vue application container;
- one `bizhub-mcp` and one `bizhub-bootstrap` Skill.

Not included:

- multi-tenancy, RBAC, employee applications, SSO, or MFA;
- invoices, payment, receivables, accounting, manufacturing, logistics, or
  employee task management;
- a general connector SDK or any company-specific collection logic;
- PostgreSQL or a claim of automatic migration from an arbitrary legacy ERP.

Customer-specific mapping remains in the customer's private environment. The
documentation-only [extension guide](docs/customer-skill-extension.md) explains
when a customer's Agent may add one narrow Skill later.

## Modular development direction

The long-term deployment shape is one stable public kernel plus build-time
customer-private modules. The private reference deployment must eventually run
the same pinned public core artifact, so its daily business use continuously
tests the generic product. Similar copied code does not count as adoption.

The unreleased modular contract keeps authentication, SQLite transactions,
audit, migrations, action approval and readback in the kernel. Customer modules
may add business entities and owners but cannot replace those boundaries or
self-install in production. See [modular architecture](docs/modular-architecture.md),
[Agent evolution](docs/agent-evolution.md), the implemented
[read-only extension boundary](docs/read-only-extension.md), and the machine-readable
[module manifest schema](schemas/module-manifest.v1.schema.json).

The `v0.4.0-preview.2` candidate implements the first deliberately narrow adoption
step: an immutable derived image may load reviewed customer-private **read-only**
routers by fixed Python import name. The core rejects mutation routes, lifecycle
handlers, undeclared paths, missing dependencies, duplicate capabilities and
extension-owned durable entities. This remains a preview and does not change
the supported `v0.3.0` production path.

The exact development commit passed an isolated base-image plus derived-image
E2E on an existing Ubuntu 24.04 VPS. This proves the extension seam, identity
readback, business flow, backup/restore, restart and MCP path; it is not yet the
clean-host installer/release gate. See the
[verification record](docs/verification/read-only-extension-ubuntu-e2e-2026-08-15.md).

A later development candidate also passed the narrowed private Git-whitelist
bundle and immutable-image plan lifecycle: install, repeated install no-op,
backup/restore, update, repeated update no-op, verify, and retain-data uninstall.
The preview then passed its clean Ubuntu release workflow and fresh-Agent
bootstrap forward test; the stable promotion gate deliberately remains closed.
See the
[derived-image lifecycle record](docs/verification/derived-image-lifecycle-ubuntu-e2e-2026-08-15.md)
and the
[preview.1 release record](docs/verification/v040-preview1-release-e2e-2026-08-16.md).
The preview.2 loopback and resource-limit candidate also passed a synthetic
[Ubuntu Docker E2E](docs/verification/v040-preview2-loopback-resource-e2e-2026-08-16.md);
the final tag-triggered release gate remains required.

## Supported deployment

The first supported target is Ubuntu 24.04 with Docker Engine. Run the CLI on
the target through the user's approved SSH session:

```bash
sudo ./bizhubctl preflight

sudo ./bizhubctl plan \
  --access loopback \
  --bind-address 127.0.0.1 \
  --profile-id example-company \
  --legal-name "Example Company Ltd." \
  --display-name "Example Company" \
  --brand-mark EX \
  --timezone Asia/Shanghai \
  --currency CNY \
  --admin-username admin \
  --memory-mib 512 \
  --cpu-millicores 1000 \
  --pids-limit 256 \
  --output /tmp/bizhub-install-plan.json

sudo ./bizhubctl install \
  --plan /tmp/bizhub-install-plan.json \
  --approve EXACT_PLAN_HASH
sudo ./bizhubctl verify
sudo ./bizhubctl backup --label initial-restore-test
```

For a reviewed customer-private read-only image, the Agent first builds both
images on the target and supplies their local references while planning:

```bash
sudo ./bizhubctl plan \
  ...same company and access arguments... \
  --candidate-core-image sha256:<PUBLIC_CORE_IMAGE_ID> \
  --candidate-image sha256:<PRIVATE_DERIVED_IMAGE_ID> \
  --output /tmp/bizhub-private-plan.json
```

Both references are resolved immediately to immutable image IDs. Planning and
apply reject a false/missing full commit, layer ancestry drift, changed core
command/health/user/port metadata, invalid extension import name, or a private
runtime identity that differs from its image label. The two local images must
remain available until install/update finishes; a tag alone is never stored as
deployment authority.

`loopback` access binds only to `127.0.0.1`, creates no reverse-proxy step, and
is intended for SSH port-forwarded administration or a bounded shadow run. For
`domain` and `cloudflare` access, the application also binds only to loopback;
the approved Agent configures HTTPS using the examples in `deploy/`. For
`private` access, the plan requires an explicit private IP. Plain HTTP is
possible only with the conspicuous `--allow-http-private` plan flag and should
be limited to a trusted private network.

Every plan records memory, CPU, and PID limits. Install, update, no-op, status,
and verify read back the Docker values and fail closed on drift. The defaults
are 512 MiB, 1000 millicores, and 256 PIDs; a smaller host may use reviewed
values within the CLI's bounded ranges. The memory-swap ceiling equals the
memory ceiling, so a container cannot consume additional host swap.

The CLI uses these fixed host paths:

- configuration: `/etc/bizhub`;
- database and install state: `/var/lib/bizhub`;
- backups: `/var/backups/bizhub`.

Repeated install/update is a no-op when the approved state is already active.
Updates create a verified online backup first. `uninstall` removes only the
container and intentionally retains configuration, data, state, and backups.
There is no purge command.

See [operations](docs/operations.md) and [data import](docs/data-import.md) for
the bounded procedures.

## Local development verification

These commands execute reviewed repository code and are for maintainers:

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r app/backend/requirements-dev.lock
PYTHONPATH=app/backend .venv/bin/pytest -q app/backend/tests tests

cd app/frontend
npm ci
npm run build
npm audit --audit-level=high
```

Docker verification must use a clean environment without the private product
repository on `PYTHONPATH`. The release evidence must distinguish implemented,
locally tested, and clean-Ubuntu-tested facts.

## Licensing

The bootstrap, Agent integration, documentation, and plugin paths listed in
[LICENSE](LICENSE) use MIT. The application core, deployment templates, and
`bizhubctl` use the source-available BizHub Core Private Deployment License,
which permits internal deployment and modification but not redistribution,
resale, or hosted/managed service. The repository owner confirmed this license
text for the `v0.3.0` stable release on 2026-08-15.
