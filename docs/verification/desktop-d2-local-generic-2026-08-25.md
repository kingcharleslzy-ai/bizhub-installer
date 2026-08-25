# Desktop-D2 local Generic verification — 2026-08-25

## Result

Desktop-D2 is a locally verified implementation candidate for macOS arm64. It
is not a release. The same customer-neutral Electron shell can still open a
signed enterprise HTTPS Workspace and can now, only after an explicit local
choice, start one fixed Generic Python Runtime with one synthetic local SQLite
database and one first administrator.

No customer-private code or data, BizHub production system, enterprise account,
real model, mail or messaging channel, deployment, cloud/local authority
switch, or production signing key was accessed. All local acceptance state was
synthetic and created under temporary directories that were removed after each
run.

## Fixed identities

- D2 base public `main`:
  `e4f56b13e0e73c5cb0fd7c5c6ee4376a59ed1d23`;
- Runtime Profile: `generic-kernel-smoke`;
- common artifact id: `bizhub-common`;
- common artifact digest:
  `sha256:90a43dc622894419c56edabaf4166809f4b557c2dc0ac524d77277e80980bc72`;
- common source commit: `0c05a44a22dc049ef4760173307a6b4af5a3dfad`;
- common allowlist tree digest:
  `3c2770526b509439f4a1a3b2226066b3b86456b7595f462fead848e8ae98211d`;
- Runtime source tree digest:
  `943dac1b5207b36091e1754951108197e11cc5973a6ba35dee1567b13ca4a879`;
- final onedir file count: `126`;
- final onedir tree digest:
  `d1044138d529048dcd95163ec50c4ff1b17d6257f5f0b870e81c8277116f5ffe`.

The final unsigned internal ZIP candidate is:

```text
desktop/out/make/zip/darwin/arm64/BizHub Desktop-darwin-arm64-0.1.0.zip
size: 143451476 bytes
sha256: 7e9248d46af6d4d78c3b9adbc47a6abd41250bf3ee14c15039bbc32be7a1cd8d
```

The ZIP is ignored by Git and has not been uploaded or published.

## Authority and failure boundaries

The D2 local path is:

```text
explicit setup
-> staging directory + one-use bootstrap token
-> fixed Generic onedir verification
-> first administrator + synthetic SQLite
-> atomic local-instance promotion
-> random 127.0.0.1 port + per-launch token
-> local administrator authentication
-> Generic Owner preview -> apply -> readback
```

The synthetic instance records a unique `data_identity`, an
`authority_epoch` of `1`, and a unique `writer_instance_id`. These describe an
independent local data authority; they do not move, synchronize, cache, or
replace any cloud data.

The acceptance proved:

- an invalid setup request leaves the formal local-instance path absent;
- installation and cloud mode do not create a local SQLite database;
- an unknown local username receives `401` and creates no new instance;
- direct loopback access without the per-launch token receives `403`;
- only the exact random `http://127.0.0.1:<port>` origin is allowed;
- master-data apply reports Owner `master_data:catalog-owner`;
- exact replay returns `idempotent_noop`;
- a tampered apply returns `409`, while exact readback stays unchanged;
- online backup plus manifest validates successfully;
- stopping and restarting the Runtime preserves the formal readback;
- development, packaged-directory, and final-ZIP local smokes leave zero
  Runtime processes;
- packaged cloud smoke still connects only to `https://example.com` and does
  not start local mode.

## Machine checks

Executed on Apple Silicon macOS with Node `22.22.2`, Python `3.12.13`, Electron
`44.0.0`, Forge `7.11.2`, and PyInstaller `6.22.1`:

```text
npm test
  13 passed, 0 failed

npm run verify:boundary
  status=ok
  python_source_files=2, sqlite_files=0
  trusted_connection_keys=0, private_markers=0

PYTHONPATH=app/backend .venv/bin/pytest -q app/backend/tests tests
  67 passed

uv pip check --python desktop/.runtime-venv/bin/python
  22 packages checked, all compatible

npm run smoke:local
  owner_ref=master_data:catalog-owner
  apply_disposition=applied
  replay_disposition=idempotent_noop
  failure_zero_write=true
  backup_status=valid
  restart_readback_locations=1
  residual_runtime_processes=0

packaged directory and final ZIP extraction scans
  runtime_profile_id=generic-kernel-smoke
  runtime_pack_files=126
  python_files=36, sqlite_files=0, source_maps=0
  trusted_connection_keys=0, private_markers=0

development, packaged-directory, and final-ZIP local shell smokes
  status=connected, mode=local
  origin_kind=random_loopback
  residual_runtime_processes=0

packaged cloud smoke
  status=connected, origin=https://example.com

npm audit --omit=dev
  0 vulnerabilities
```

The scanner reads `.cjs`, `.mjs`, Python, JSON, HTML, CSS, JS, XML and YAML
text, verifies the exact ASAR Electron runtime files against the checked-out
source, verifies every Runtime manifest entry including bounded internal
symlinks, and rejects SQLite data, source maps, private keys, customer-private
markers, a non-empty enterprise trust store, or a different Generic identity.

## Retained blockers and exclusions

The complete Forge development dependency audit still reports 24 upstream
build-chain findings: 3 low, 20 high, and 1 critical. The application and Python
sidecar are ad-hoc/unsigned; the application is not notarized. Those facts block
formal publication and are not waived by D2.

D2 does not include Windows local Runtime, customer-private Runtime, production
trust keys, real business data, cloud/local migration or synchronization,
mail/WeChat collectors, models, background operating-system services, automatic
update, Runtime plugins, or Module Creator. A further checkpoint requires new
authorization after external review of the fixed D2 head and evidence.
