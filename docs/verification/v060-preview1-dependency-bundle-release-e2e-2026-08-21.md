# v0.6.0-preview.1 dependency-bundle release E2E — 2026-08-21

## Result

`v0.6.0-preview.1` passed its fixed-tag release workflow and was published as a
GitHub prerelease. Stable remains `v0.3.0`.

- release: <https://github.com/kingcharleslzy-ai/bizhub-installer/releases/tag/v0.6.0-preview.1>;
- workflow: <https://github.com/kingcharleslzy-ai/bizhub-installer/actions/runs/32485176952>;
- annotated tag object: `50f7868ff9cb37753dad3fa82d8c9d36083d937c`;
- release commit: `ad2455c76cecf0185c2de60b39e00752c57e22d3`;
- release tree: `cbd6dc56ad72718a961169e83ce4191a5ea657da`;
- runner: disposable GitHub-hosted `ubuntu-24.04`;
- published at: `2026-08-21T13:07:57Z`.

The Release page was created only after every preceding workflow step passed.

## Gates

1. Verified all `74` release checksums, installed hash-locked Python
   dependencies, passed `63` tests, built the Vue frontend and reported zero
   high-level npm audit findings.
2. Installed exactly one `bizhub-core@bizhub-public` from the fixed release
   commit and read back one Skill, one MCP server, seven bounded tools and
   version `0.6.0-preview.1`.
3. Passed Ubuntu 24.04 and Docker preflight, generated an exact-hash install
   plan and created the synthetic administrator through a TTY.
4. Previewed one complete party/party-alias bundle whose successor and owner
   dependencies used external identities. The preview bound input, identity,
   dependency-graph, operation and state-generation digests.
5. Rejected a tampered bundle apply with zero matching external mappings, then
   applied the approved bundle atomically and read back every resource,
   external mapping, successor, alias owner, state generation and audit event.
   Exact replay was a no-op without another state bump or audit event.
6. Repeated successor, reconcile, purchase/receipt, sale/shipment, inventory
   reversal, stale/tampered preview, invalid unit and insufficient-stock gates.
7. Created and restored an online backup, proved bundled relationships and
   mappings survived restore and container restart, and rechecked effective
   Linux cgroup v2 limits.
8. Repeated install and update returned no-op. Uninstall removed the container
   while retaining the database and backups; SQLite quick-check remained `ok`.

## Boundary

- The release workflow used synthetic data only. It did not update the retained
  Tencent Shadow, replace its staging snapshot, or call preview/apply there.
- The public bundle supports only parties and party aliases. It does not add a
  connector SDK, customer-specific names/rules, unit mapping, products, orders,
  inventory migration, or formal-system write authority.
- A real snapshot still requires a new plan bound to the public release,
  private derived image, authoritative formal release, service cohort, snapshot
  digest and current Shadow state. Plan approval cannot authorize the later
  business apply, which still requires a fresh preview token and separate Owner
  confirmation.
