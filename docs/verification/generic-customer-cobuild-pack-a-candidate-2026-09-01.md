# Generic customer co-build Pack A candidate

Status: `merge_ready_not_released`

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
- Windows Runtime pack tree: `35860274aa5bf71f536d83c5a499b94befbec66e47ec746b14c73e12714ac169`
- Windows Runtime archive: `260bb35720ec12d37ffb389912096bb1430b13f9e184d98bc0ed2facbe82a325`

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

## Isolated runner evidence

The tested product head is
`f589d82819416b679ccfe2c4dee4a016adf34d60`.

- [Desktop Workspace Flow run 18](https://github.com/kingcharleslzy-ai/bizhub-installer/actions/runs/33529844154):
  macOS arm64 and Windows x64 source, packaged-product, account, local Workspace,
  first-entry and cleanup flows passed.
- [Desktop D3 Windows x64 run 24](https://github.com/kingcharleslzy-ai/bizhub-installer/actions/runs/33529844091):
  deterministic Runtime rebuild, fixed-input binding, tamper rejection, Owner
  lifecycle, signed Squirrel package, install/readback/uninstall, residual-process
  checks and evidence publication passed.

The macOS packaged-flow defect found on the preceding head was a smoke timing
race: the assertion ran after the title appeared but before the asynchronous
first-entry state finished loading. The final smoke waits for the entire product
contract without weakening any required state.

## Remaining boundary

The candidate is merge-ready, but it is not a release or production deployment.
Release signing/publication and production adoption remain separately authorized
operations.

No production database, customer payload, production deployment, Shadow,
migration, business table, Profile-specific private rule, or second writer was
touched.
