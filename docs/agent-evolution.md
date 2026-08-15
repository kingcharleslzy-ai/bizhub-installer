# Customer Agent evolution guide

This document tells a customer's Agent how to extend a deployed BizHub without
turning production into a self-modifying system. The Agent may evolve reviewed
source code and configuration in the customer's private repository; it may not
rewrite a running instance ad hoc.

## Start with the smallest extension

For each request, choose the first level that can fully solve it:

| Level | Use when | Artifact |
| --- | --- | --- |
| 0: configuration | labels, thresholds, enabled modules, calendars or destinations differ | reviewed profile change |
| 1: mapping | an external file/API has different fields but maps to an existing BizHub entity or action | customer-private mapping and fixture |
| 2: one customer Skill | the same Agent workflow repeats and needs consistent discovery or mapping instructions | one narrow private Skill |
| 3: business module | a new durable entity, owner action, projection, page or scheduled job is required | private build-time module |

Do not create a Skill for a single form, a module for a field mapping, or a new
MCP server for a customer workflow. Reuse the one BizHub MCP and its stable
server-side permissions.

## Discovery questions

Before generating anything, the Agent asks only the questions needed for the
current level:

1. What user outcome repeats, and who owns the resulting business fact?
2. Is the target already represented by an existing entity, import resource or
   action in `GET /api/system/modules`?
3. What is the source of truth, its stable external id, and its evidence?
4. Is this configuration, transformation, or genuinely new business behavior?
5. What must preview show before approval?
6. What exact API and record prove readback?
7. What must remain after disable, rollback or uninstall?

If the Agent cannot identify one formal owner and one readback, it stops at a
design proposal and does not generate executable production code.

## Source evolution loop

1. Capture a bounded example and expected result with no secrets or customer
   payload committed to a public repository.
2. Read the effective system map and existing contracts.
3. Select configuration, mapping, Skill, or module using the table above.
4. Generate the smallest private artifact and synthetic fixtures.
5. Run schema, dependency, migration, owner, authorization, idempotency,
   negative-case and readback tests.
6. Build an immutable candidate pinned to the public core commit and private
   extension commit.
7. Show the plan, permissions, database changes, network changes, backup and
   rollback to the customer.
8. Apply only after exact-plan approval, then verify the effective system map,
   health, business readback and audit event.
9. Promote a repeated generic mechanism back to the public core only after it
   has no customer names, credentials, paths, seed data or domain assumptions.

## Mapping contract

A mapping or collector must:

- emit `source_id + external_id` for every external record;
- retain a cursor or replay boundary outside formal business tables;
- preserve raw evidence by reference and digest when required;
- transform into an existing JSON/import/action contract;
- call preview, present errors and counts, then apply with the returned token;
- read back the owning module and audit result;
- be safe to replay without duplicate facts;
- never write SQLite, invent a missing relation, or silently coerce an unknown
  unit, party, product or date.

## Customer Skill contract

Keep at most one active customer workflow Skill until a second one is proven
necessary. It should contain discovery and mapping instructions, not business
authority. The Skill may call the existing MCP, but it cannot:

- override authentication, approval, audit, owner or readback rules;
- add arbitrary shell, arbitrary URL or direct database tools;
- contain credentials, customer exports or mutable production facts;
- register another BizHub MCP or another generic bootstrap Skill;
- approve its own installation or changes.

Merge or delete overlapping instructions before adding another Skill.

## Business module checklist

A generated private module is incomplete unless it has:

- one manifest matching `bizhub.module-manifest.v1`;
- a customer namespace and immutable version;
- declared dependencies and capabilities with no cycle;
- owned entities and append-only migrations;
- one server-side writer per formal record type;
- typed preview, apply and readback contracts;
- idempotency and explicit correction semantics;
- bounded read APIs, health and evidence references;
- navigation metadata and a UI that uses only public module APIs;
- synthetic success, replay, tamper, concurrency, permission, migration,
  rollback and readback tests;
- a derived image and deployment profile pinned to both source commits and
  artifact digests.

Runtime hot-install, hot-unload, generated SQL, and production code mutation are
out of scope. A module update is an ordinary reviewed software release.

## Generic promotion test

Customer code may move into the public core only when all answers are yes:

- At least two plausible companies can use the same contract without renaming
  company concepts.
- The implementation contains no customer identifier, path, credential,
  endpoint, seed row, field formula or named external-system assumption.
- Configuration can express legitimate variation without branching by customer
  name.
- The reference deployment runs the extracted implementation and passes parity
  readback.
- Negative cases fail closed and uninstall retains durable facts.

Otherwise keep it in the customer-private module and improve the documentation.
