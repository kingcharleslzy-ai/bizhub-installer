# Data and action contracts

## Current v0.7 preview boundary

`v0.7.0-preview.1` deliberately stops carrying a second public batch-import
implementation. Customer CSV, JSON, ERP, mail, or browser adapters stay outside
the server and translate source evidence into the four typed common Owner
actions exposed by the one MCP:

- `master_data`: create/replay parties, products, units, and locations through
  the catalog Owner;
- `inventory`: immutable movement, stocktake, and reversal actions;
- `procurement`: order, revise/cancel, and receipt actions;
- `sales`: order, revise/cancel, fulfillment, and return actions.

Every mutation remains:

`typed input → preview → explicit approval → apply → exact readback`

Preview binds the complete action and current state generation. Apply recomputes
the action inside the Owner transaction. Input drift, state drift, missing
dependency, unknown master data, negative stock, over-receipt/fulfillment/return,
or reused idempotency identity with different content fails closed. Exact replay
returns the existing receipt/readback without another write.

The public MCP exposes `bizhub_action_preview` and `bizhub_action_apply` with an
`action` enum of `master_data`, `inventory`, `procurement`, or `sales`. It never
accepts a database path, SQL, arbitrary URL, shell command, or credential value.
Credentials and customer-specific source interpretation remain in the private
adapter environment.

## Historical preview contracts

The immutable `v0.5` and `v0.6` previews demonstrated external-identity
reconcile, successor identity, aliases, and one atomic dependency-aware party
bundle. Those tagged releases and their evidence remain available under
[`docs/verification/`](verification/), but their separate
`/api/imports/*` implementation is not an active endpoint in `v0.7`.

Reintroducing batch import, external mapping, or dependency bundles requires
moving the customer-neutral contract into the canonical common source and
shipping a new common artifact. It must not be restored by adding features to
the retained legacy public directory.
