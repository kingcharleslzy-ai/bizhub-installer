# BizHub modular architecture

## Decision

BizHub uses a stable kernel with build-time business modules. A customer's
private deployment must run the same public kernel that other customers use;
customer-specific behavior lives in a separately versioned private module
package and deployment profile.

This is deliberately narrower than an "everything is dynamically replaceable"
framework. An ERP owns durable business facts, so the database transaction
boundary, authentication, audit log, migration ledger, module registry, and
formal write protocol are privileged kernel responsibilities. A module may add
business behavior, but it may not replace or bypass those responsibilities.

The official DeepSeek Harness architecture is a useful reference for named
capabilities, provider/consumer separation, profiles, ordered bundles,
machine-readable effective configuration, and lifecycle cleanup. DeepSeek
Harness currently describes itself as a developer preview with expected
breaking changes, so BizHub borrows those principles rather than taking a
runtime dependency on it.

Primary references:

- <https://github.com/deepseek-ai/deepseek-harness>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>

## Runtime shape

```text
canonical source + explicit allowlist
        -> one bizhub-common artifact @ sha256:C
        -> public Generic image uses C
        -> customer-private derived image uses the same public layers and C
           plus a reviewed, non-overlapping private layer
```

The customer image is assembled before deployment. Production does not install,
unload, generate, or hot-reload executable modules. A changed module produces a
new immutable image, an update plan, a backup, verification, and readback.

## Stable kernel

The kernel owns:

- company-instance binding and the single-administrator boundary;
- SQLite connection, foreign-key enforcement, transaction handling, schema
  ledger, backup, restore, and integrity checks;
- authentication, secure sessions, request guards, and secret references;
- canonical preview tokens, apply authorization, idempotency, and readback;
- immutable audit events and source/external identity;
- module registration, dependency validation, effective system-map readback,
  health, version, and release identity;
- the bounded MCP connection and deployment CLI.

These contracts are not extension points. A module cannot replace them, write
around them, weaken them, or ask an Agent to bypass them.

## Module responsibilities

A module may own:

- its business entities and append-only migrations;
- its server-side validation and one formal writer;
- read APIs and derived projections;
- preview, apply, and readback implementations for its actions;
- its navigation entry and UI bundle;
- import mappings that delegate final writes to the owning module;
- its health checks, evidence references, and bounded Agent context.

Every module declares one `bizhub.runtime-module-manifest.v1`. The current
built-in manifests are returned by authenticated `GET /api/system/modules` and
through the existing `bizhub_resource_query(resource=system_map)` MCP tool.
Their authoritative shape lives with the shared runtime module contract.

The manifest is descriptive and enforceable metadata, not execution authority.
Presence of a manifest never authorizes installation or business writes.

## Capability rules

1. A capability has a stable name and one owning contract.
2. A module depends on capabilities or documented public module APIs, not on a
   provider's private tables or implementation files.
3. Dependencies form an acyclic graph and fail startup when missing.
4. Each formal record type has exactly one writer.
5. Cross-module writes call the owning module's preview/apply/readback contract.
6. Durable facts are corrected by owner-defined reversal or replacement events,
   never by uninstalling a module or deleting history.
7. Disabled modules stop exposing routes, jobs, navigation, and tools but keep
   their retained business data until a separately approved disposition exists.
8. The effective system map is read back after every install and update.

## Three extension forms

BizHub intentionally supports only three forms of customer customization:

### 1. Configuration and mapping

Use company profile, enabled-module profile, field mapping, import templates,
calendar, thresholds, labels, and notification destinations. This is the
default because it adds no executable code.

### 2. Agent-side adapter

Use customer-private code to transform an ERP, spreadsheet, API, email inbox, or
browser result into a stable BizHub import or action contract. The adapter may
retain its own cursor and evidence, but it cannot connect to SQLite or create a
second writer. Repeated Agent instructions may be captured in the customer's
single narrow Skill.

### 3. Server business module

Use a module only when the customer needs a new durable entity, business action,
projection, page, or scheduled owner. It is built into the customer image,
declares dependencies and owned entities, ships tests and migrations, and uses
the kernel's action and audit protocols.

Configuration must not be promoted to code merely for convenience, and a Skill
must not be promoted to a server module merely because it is frequently used.

## Extraction inventory

The production reference system contains more reusable ideas than the first
public release. They should be extracted as small contracts and clean
implementations, not copied as large coupled files.

| Candidate | Generic contract to extract | Keep out of the kernel |
| --- | --- | --- |
| Module registry | manifest, dependencies, capabilities, routes, actions, drift and effective-map readback | company module ids and hard-coded owner paths |
| Formal write ownership | record type, single writer, preview, apply, readback, correction policy | source-specific matching and company formulas |
| Evidence fabric | source ref, immutable digest, media metadata, business link, access policy | customer messages, email accounts, file paths and identities |
| External identity | source id, external id, cursor, idempotency and replay outcome | one vendor's API or browser automation |
| Workflow ledger | definition, run, step, artifact, business link and health state | one collector's schedule and credentials |
| Health and attention | checks, freshness, severity, evidence, recovery and close rule | customer-specific thresholds and executive wording |
| Master data | parties, roles, contacts, identifiers, aliases, products, specs, units and locations | product-family recognition rules and seeded names |
| Inventory | immutable movements, balances, reservations, stocktakes and reversals | material-specific lifecycle and manufacturing formulas |
| Orders | generic sales/purchase lifecycle, partial fulfillment and cancellation | customer pricing, settlement and special-product rules |
| Settlement | invoice, payment and allocation primitives as optional modules | tax-provider collectors and customer-specific reconciliation |
| Message workbench | channel-neutral source item, attachment, task and business link | specific chat groups, mail folders and parsing prompts |
| Agent decision chain | source cluster, candidate, typed command, decision, owner result and review reason | model-specific prompts and domain field semantics |
| Resident operations | observation, action log, recheck plan and formal close evidence | one company's dashboard ranking and notification channel |
| UI shell | module navigation, cards, evidence drawer, status and action preview | company layout assumptions and private branding |

## Extraction order

1. **System map and module contract.** Make the current public core
   self-describing without changing business behavior.
2. **Shared governance contracts.** Extract evidence refs, owner registration,
   workflow health, and action/readback vocabulary with synthetic tests.
3. **Master-data parity.** Add identifiers, contacts, aliases, product specs and
   unit aliases only where the reference deployment proves a real need.
4. **Reference deployment adoption.** Move one low-risk shared capability to the
   public kernel, dual-read it, compare readback, then switch its writer.
5. **Order and inventory parity.** Migrate in bounded slices; preserve historical
   identifiers and use explicit adapters rather than rewriting live history.
6. **Optional generic modules.** Promote settlement, evidence workbench,
   workflow, health, and operations modules only after the reference deployment
   has exercised their generic contracts.
7. **Customer-only modules.** Keep manufacturing semantics, named external
   systems, customer formulas, and company dashboards in the private package.

The private reference deployment becomes proof of the public core only after it
actually pins and runs the public core artifact. Similar code or copied files do
not count.

## Current implementation status

The canonical source now builds a private reference Profile and `generic-kernel-smoke`
through one explicit Registry. Generic owns customer-neutral master data,
inventory, procurement, and sales contracts; the reference Profile adds private modules and
keeps its existing private writers until separately approved adoption.

CP-5 exports the exact Generic implementation as one deterministic
`bizhub-common` artifact. The public image verifies and extracts that artifact;
the private reference validation image inherits every public layer and appends a private
layer with zero common-path overlap. Both image identities read back the same
`core_artifact_digest`. See [common artifact delivery](common-artifact-delivery.md).

The public delivery adapter owns authentication, company configuration,
installation identity, and delegation into the common Owners. It does not copy
or recreate the business writers. The former public business directory has been
physically removed under the documented
[retirement record](legacy-core-retirement.md).

This remains build-time composition, not a general plugin runtime. Production
does not hot-install modules or Agent-generated code. The common-artifact preview
does not deploy or switch the private reference production system; that requires a
separate staging and production-adoption checkpoint.
