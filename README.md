# BizHub

BizHub is a small, private business system that a customer's Agent can install
from one fixed public GitHub release. Each company receives one independent
instance, one administrator account, one application container, and one SQLite
database.

> **Release state: `v0.3.0-preview.1` implementation preview.** The application
> and installer are implemented, but this exact release must not be described
> as stable until its Ubuntu clean-host install, Docker end-to-end flow,
> backup/restore rehearsal, sensitive-information scan, and fresh-Agent forward
> test are recorded as passed.

## Give the release to an Agent

Use the immutable release URL once the tag is published:

`https://github.com/kingcharleslzy-ai/bizhub-installer/releases/tag/v0.3.0-preview.1`

Ask the Agent to verify the release and checksums, install the repository's one
plugin, load its one `bizhub-bootstrap` Skill, and follow the staged interview.
The Agent will ask about the Ubuntu target, access mode, company profile,
administrator username, and first data source. Enter the administrator password
only in the target host's interactive TTY.

The Agent must show the generated plan and receive approval for its exact hash
before running installation. A repository link, README, or GitHub signature is
provenance—not permission to change a machine.

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

## Supported deployment

The first supported target is Ubuntu 24.04 with Docker Engine. Run the CLI on
the target through the user's approved SSH session:

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

For `domain` and `cloudflare` access, the application binds only to loopback;
the approved Agent configures HTTPS using the examples in `deploy/`. For
`private` access, the plan requires an explicit private IP. Plain HTTP is
possible only with the conspicuous `--allow-http-private` plan flag and should
be limited to a trusted private network.

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
resale, or hosted/managed service. License text must receive owner/legal review
before a stable release.
