# Data import contracts

Supported CSV resources are `party`, `product`, `unit`, `location`,
`opening_inventory`, `sales_order`, and `purchase_order`. Download the exact
CSV header from `/api/imports/template/{resource}`. JSON accepts those resources
plus `party_alias` and `unit_alias`.

Every record must contain a customer-chosen `external_id`; every batch has one
`source_id`. Their pair is the permanent idempotency identity. Reusing the pair
with changed content is rejected.

Party and unit JSON records may include `status: active|deprecated`. A
deprecated party may additionally include `successor_party_id`, which must
refer to an already-created active party. Active parties cannot declare a
successor. Alias JSON
records use `alias`, the same status values, and the canonical owner's integer
`party_id` or `unit_id`. An adapter first imports the canonical resource, then
queries authenticated `GET /api/external-records?source_id=...&resource_type=...`
to resolve its external ID to the BizHub entity ID before previewing aliases.
For a source snapshot, import active successor parties first, resolve their
external IDs, then import deprecated predecessors with `successor_party_id`,
and only then import aliases. An active alias may reuse a deprecated
predecessor's canonical name only when its owner is that exact declared
successor; missing or mismatched links fail closed.
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
