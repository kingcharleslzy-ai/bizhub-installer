# v0.4.0-preview.1 release E2E — 2026-08-16

## Result

`v0.4.0-preview.1` passed its tag-triggered clean Ubuntu release workflow and
was published as a GitHub prerelease. Stable remains `v0.3.0`.

- release: <https://github.com/kingcharleslzy-ai/bizhub-installer/releases/tag/v0.4.0-preview.1>
- workflow run: <https://github.com/kingcharleslzy-ai/bizhub-installer/actions/runs/31894913623>
- annotated tag object: `b492088fb2ef1d8a19947f966db6860b6034da6f`;
- release commit: `604535ec3d4ab1b8b4bad9a876ef2850f564166a`;
- runner: GitHub-hosted disposable `ubuntu-24.04`;
- published at: `2026-08-15T16:14:28Z` (`2026-08-16` Asia/Shanghai).

The workflow published the prerelease only after every preceding gate
succeeded. A failed checkout, test, plugin install, plan, application exercise,
backup/restore, or uninstall would have left the tag without a Release page.

## Clean-runner gates passed

1. Checked out the annotated tag and verified its exact tag/commit plus all 65
   repository checksums.
2. Installed the locked Python dependencies, ran 43 backend/public contract
   tests, built the Vue frontend, and reported zero high-level npm audit
   findings.
3. Installed official npm Codex CLI `0.147.0` on the disposable runner, added
   the public marketplace at the 40-character release commit, and read back
   exactly one enabled `bizhub-core@bizhub-public` version
   `0.4.0-preview.1`.
4. Read back exactly one `bizhub-bootstrap` Skill and one `bizhub-mcp`; started
   the installed MCP from its cache, observed seven bounded tools, and read
   `maturity=implementation_preview`.
5. Passed Ubuntu 24.04/Docker preflight, generated an exact-hash plan, created
   the synthetic administrator through a pseudo-TTY, and installed the single
   application container.
6. Exercised synthetic customer/supplier/product/unit/location setup, purchase
   10 and receipt 6, sale 4 and shipment 3, invalid unit and insufficient stock,
   tampered/stale preview rejection, CSV validation, idempotent JSON replay,
   reversal, audit and inventory readback.
7. Created an online backup at inventory 6, changed inventory to 8, restored
   and read back 6, restarted the container, verified the MCP instance reads,
   and re-ran application verification.
8. Repeated install and update returned `no_op`. Uninstall removed the container
   while retaining the SQLite database and backup; the database quick-check
   remained `ok`.
9. Only then did the workflow create a non-draft GitHub prerelease whose notes
   keep `v0.3.0` as stable.

## Fresh-Agent forward test

After the Release URL existed, a new ephemeral Codex task was started with a
fresh temporary Codex configuration containing only the fixed-commit
`bizhub-core` plugin. It was sandboxed read-only and explicitly forbidden from
cloning, installing, connecting, asking for secrets, or mutating a host.

The Agent loaded the one `bizhub-bootstrap` Skill, called
`bizhub_bootstrap_status` and `bizhub_bootstrap_questions(stage=deployment)` on
the installed MCP, and correctly reported:

- release `v0.4.0-preview.1` and maturity `implementation_preview`;
- exactly two first-stage questions: new install versus migration, and cloud
  versus 24/7 local Ubuntu host;
- repository provenance grants no host authority;
- failed preflight, checksum, fingerprint, plan hash, health, backup, restore,
  HTTPS or readback must stop the workflow rather than weaken a guardrail.

The task made no mutation and requested no secret. Its temporary authentication
copy was overwritten, unlinked, and the entire temporary configuration and
plugin cache were removed after readback.

## Release-linked private derived-image follow-up

The private reference candidate was then rebuilt from the exact published
release commit rather than the earlier development commit:

- public release commit: `604535ec3d4ab1b8b4bad9a876ef2850f564166a`;
- private source commit: `f7d047b67f855ee02db99525a57cd2ac8a5c9071`;
- deterministic private bundle SHA-256:
  `47ba7ea34293620bb9f4516e978bb60a42b5c301bcc0b40bd1e26ec48d83a7f8`;
- core image id:
  `sha256:363657f160f259c03dede2d1120b1e165f601f0c5310d1ef5fbca1bfe7c66da7`;
- derived image id:
  `sha256:a36dd9d39e779a1e5672c5ebb3e16881313922efc37225514b676092d3aad6fe`.

The private builder returned `release_candidate`. On the isolated Ubuntu 24.04
VPS, the unmodified release `bizhubctl` verified the real tag, commit and
checksum, inspected both immutable images, and generated plan hash
`5895e8ab14b32da9a367e444467dbc9ac72ea6e518e8c8da09b00201c3afc4eb`.
That exact plan passed TTY install, six-module and dual-commit readback, the full
synthetic purchase/sales/inventory flow, online backup and restore to inventory
6, install/update no-op, final verify, and retain-data uninstall. The extension
continued to report `formal_business_write_capability=none`.

After the retained database and two `0600` backups were verified, the exact
synthetic directory, containers and images were removed. Docker remained active
with zero containers, images and volumes; no production host or data was used.

## Gates deliberately still open

- This preview does not authorize production deployment or customer-data
  access. No Tencent Cloud service or production SQLite database was touched.
- The disposable runner tested the public single-instance system. The private
  `dazheng_reference` release-derived image passed separately on the existing
  synthetic VPS; it was not imported into the public runner or repository.
- No real customer domain, TLS reverse proxy, Cloudflare Tunnel, migration, or
  production dual-read was exercised.
- Stable promotion requires a separately reviewed decision after a bounded
  private read-only dual-run plan; this workflow does not make that decision.
