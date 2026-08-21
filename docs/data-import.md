# Data import contracts

Supported CSV resources are `party`, `product`, `unit`, `location`,
`opening_inventory`, `sales_order`, and `purchase_order`. Download the exact
CSV header from `/api/imports/template/{resource}`. JSON accepts those resources
plus `party_alias` and `unit_alias`.

Every record must contain a customer-chosen `external_id`; every batch has one
`source_id`. Their pair is the permanent idempotency identity. Reusing the pair
with changed content is rejected.

Party and unit JSON records may include `status: active|deprecated`. The
ordinary single-resource JSON contract accepts a deprecated party's numeric
`successor_party_id` only when the active successor already exists. Alias JSON
records use `alias`, the same status values, and the canonical owner's integer
`party_id` or `unit_id`.

For a complete party snapshot, use
`POST /api/imports/master-data-bundle/preview` then
`POST /api/imports/master-data-bundle/apply`. Its strict `resources` object
contains `parties` and `party_aliases`. A deprecated party may declare
`successor_party_external_id`; every party alias declares
`party_external_id`. Both resolve inside the same `source_id` to either a party
in the complete bundle or an exact existing external mapping. Preview validates
the whole bundle without writes and returns its input/identity summaries,
dependency graph and topological order, expected create/replay operations,
current state generation, and one signed token. Apply accepts only that same
input, graph, operation set, and state, writes every new resource/mapping/audit
row in one transaction, and returns exact resource, relationship, mapping,
state, and audit readback. A failed record rolls back the entire bundle.

Circular references, unknown owners/successors, cross-resource or duplicate
external identities, inactive successors, canonical/alias conflicts, content
drift, token tamper, and concurrent state changes fail closed. Exact replay is
a no-op: it returns the same readback without a state bump or duplicate audit.
An active alias may reuse a deprecated predecessor's canonical name only when
its external owner is that exact declared successor.

Adapters that use the ordinary resource-by-resource contract can still query
authenticated `GET /api/external-records?source_id=...&resource_type=...` to
resolve external IDs to BizHub entity IDs.
The endpoint is cursor-paginated with `after_id` and a maximum `limit` of 500;
the existing `bizhub_resource_query(resource=external_mappings)` tool exposes
the same bounded readback.

The fixed flow is:

1. submit CSV text or JSON records;
2. stage and validate strict fields, references, units, quantities, stock, and
   duplicate identities;
3. review counts/errors and the returned preview;
4. confirm the same records with the preview token;
5. apply one atomic batch;
6. read back catalog, orders, inventory, and audit.

Unknown fields, unknown references, non-positive order quantities, unit
mismatch, insufficient inventory, changed input, expired/stale tokens, and
concurrent catalog changes fail closed. Correct imported formal history with a
new reversing movement; do not delete or edit movement rows.

The ordinary import contract remains create-or-replay: changed content is still
rejected there and must not be worked around by inventing a second external ID.
For `party`, `unit`, `party_alias`, and `unit_alias`, use the separate
`POST /api/imports/reconcile/preview` then
`POST /api/imports/reconcile/apply` contract. Every reconcile record requires an
existing mapping and explicit status. Preview returns the exact before/after
field diff, current state generation, mapping digests, and a signed token. Apply
accepts only the same input/diff/generation, writes one atomic batch, appends an
audit event, and verifies both entity and mapping readback.

Reconcile fails closed for a missing or wrong-type external identity, duplicate
business key, canonical/alias collision, token tamper, concurrent state change,
mapping/entity drift, unsafe role removal, and a unit code/dimension change after
business use. Product, location, order, inventory, and other resources do not
have reconcile semantics in this candidate.

Sales and purchase CSV lines use `lines_json`, for example:

```json
[{"product_id":1,"unit_id":1,"quantity":"10","unit_price":"12.50"}]
```

An external ERP/API adapter should only transform source records into these
contracts. Keep its credentials and customer-specific interpretation in the
customer's private environment.
