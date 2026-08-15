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

## Gates deliberately still open

- This preview does not authorize production deployment or customer-data
  access. No Tencent Cloud service or production SQLite database was touched.
- The disposable runner tested the public single-instance system. The private
  `dazheng_reference` derived image has separate synthetic VPS evidence; it was
  not imported into the public runner or repository.
- No real customer domain, TLS reverse proxy, Cloudflare Tunnel, migration, or
  production dual-read was exercised.
- Stable promotion requires a separately reviewed decision after a bounded
  private read-only dual-run plan; this workflow does not make that decision.
