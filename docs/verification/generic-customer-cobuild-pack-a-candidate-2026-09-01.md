# Generic customer co-build Pack A candidate

Status: `implemented_candidate_not_released`

## User-visible result

- The logged-out screen says what an existing customer and a first-time local
  customer should do without exposing Profile, Runtime, Owner, or Registry terms.
- A newly bound Workspace opens on `开始使用`, explains whether data is on this
  computer or in the company cloud, and contains no fake business rows.
- Before explicit entry only onboarding/identity surfaces are available. After
  entry, existing business pages become available and restart preserves the
  stage.
- The guest sample room enters its disposable Workspace before seeding synthetic
  data and still writes only through existing Owner preview/apply APIs.

## Fixed common/macOS identity

- canonical common source: `a5f01dbf3cec935858fafc33d5c80073745df9c9`
- common artifact: `sha256:5109d59e2443ca86b96db8e3873e4959e9669298099a46e9a6d5360a17096f4f`
- allowlist tree: `8a86f0d67f48d9518287ca0f0324bb7b749d562e70589bfcab3fa3841e586bc6`
- macOS Runtime pack tree: `6b1e106c5527922561e73c0e9740474707e2096ce9b02809e22ecdfcdb2cc882`
- macOS Runtime archive: `db3c92e6c88ae5d7d1dfb6d5e2b0a7cdf86a864e5091ef781d388a1c341765d3`

## Local evidence

- public Python artifact/runtime contract: `24 passed`
- Desktop Node source tests: `103 passed`
- Vue app and Electron shell production builds: passed
- Runtime coordinated-tamper rejection: passed
- macOS local Runtime Owner lifecycle, backup and restart readback: passed
- real Electron local shell: 2 onboarding states x 7 viewports = 14 combinations,
  no document-level horizontal overflow
- real Electron account flow: cloud, local, guest, directory, remembered session,
  logout and cleanup boundaries passed

## Remaining release gate

The Windows Runtime currently binds the prior common artifact
`sha256:90a43dc622894419c56edabaf4166809f4b557c2dc0ac524d77277e80980bc72`.
The public boundary correctly rejects that mixed state. The branch-specific
Windows workflow must deterministically rebuild and capture the Windows x64
Runtime, after which a separate follow-up commit must run the complete dual-
platform gates. Until then this candidate is not merge-ready or released.

No production database, customer payload, production deployment, Shadow,
migration, business table, Profile-specific private rule, or second writer was
touched.
