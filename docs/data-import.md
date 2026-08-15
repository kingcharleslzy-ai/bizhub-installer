# Data import contracts

Supported resources are `party`, `product`, `unit`, `location`,
`opening_inventory`, `sales_order`, and `purchase_order`. Download the exact
CSV header from `/api/imports/template/{resource}` or use JSON records.

Every record must contain a customer-chosen `external_id`; every batch has one
`source_id`. Their pair is the permanent idempotency identity. Reusing the pair
with changed content is rejected.

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

Sales and purchase CSV lines use `lines_json`, for example:

```json
[{"product_id":1,"unit_id":1,"quantity":"10","unit_price":"12.50"}]
```

An external ERP/API adapter should only transform source records into these
contracts. Keep its credentials and customer-specific interpretation in the
customer's private environment.
