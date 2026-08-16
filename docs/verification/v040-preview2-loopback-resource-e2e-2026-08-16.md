# v0.4.0-preview.2 loopback and resource-limit E2E

Date: 2026-08-16

## Scope

This verification exercised public candidate commit
`f10bbec90c82a22f70c0f99fc8238ce48de93feb` on an isolated Ubuntu 24.04 VPS.
It tested the new loopback-only access mode and plan-bound Docker resource
limits with synthetic company and business data. It did not use Tencent Cloud,
customer data, a private extension, a domain, or a production writer.

This is candidate evidence, not a stable-release claim. The final tagged commit
must still pass the clean tag-triggered release workflow.

## Fixed plan

- bind: `127.0.0.1:18481`;
- access: `loopback`;
- external proxy steps: none;
- memory: 384 MiB;
- memory-swap: 384 MiB;
- CPU: 500 millicores;
- PIDs: 128;
- plan hash:
  `422cfc12a04cb38de41c88c3ddb14aa3aa6e4116eb3856349f812020bdf90855`.

The target preflight passed Ubuntu version, architecture, Docker, disk, and
privilege checks. The generated plan bound the full source commit and tree,
application checksum, target fingerprint, standard paths, loopback address,
resource limits, and TTY-only administrator password source.

## Result

The existing Ubuntu release E2E passed without modification:

1. interactive TTY install with no password echo;
2. health, single-admin authentication, and application verification;
3. synthetic master data, purchase 10 / receive 6, sale 4 / ship 3;
4. insufficient stock, wrong unit, preview tampering, and stale preview
   rejection;
5. idempotent JSON import and immutable movement reversal;
6. online backup, post-backup mutation, restore, and container restart;
7. bounded MCP health and inventory reads;
8. repeated install and update returned no-op;
9. retain-data uninstall left a valid SQLite database and verified backups.

Every install/no-op/verify readback reported the exact Docker values below:

```json
{
  "memory_bytes": 402653184,
  "memory_swap_bytes": 402653184,
  "nano_cpus": 500000000,
  "pids_limit": 128
}
```

The observed values equaled the approved expected values. After retain-data
evidence was read, the synthetic checkout, plan, config, database, backups, and
three test images were removed by their exact paths and image IDs. Final
readback showed no remaining container, image, or test path.

