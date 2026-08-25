# Desktop-D3 Windows x64 verification — 2026-08-26

## Result

Desktop-D3 is a native Windows x64 external-review candidate. It is not a
Release. The customer-neutral Desktop Shell packages one fixed Generic Runtime,
installs through Squirrel.Windows, and preserves the same cloud/local and sole
Owner boundaries accepted for Desktop-D2.

No customer-private Profile, account, endpoint, rule, production key, real
business data, deployment, synchronization, migration, or writer switch was
used. All installation and Owner state was synthetic on a disposable GitHub
Windows runner.

## Source and fixed identities

- public `main` base:
  `84c234fb0d2727e87d2dd0b30cd212b3cd658ad6`;
- verified D3 head:
  `a7f568edf0a8819a13c6ca98ff321b59271e2bdb`;
- Runtime Profile: `generic-kernel-smoke`;
- common artifact digest:
  `sha256:90a43dc622894419c56edabaf4166809f4b557c2dc0ac524d77277e80980bc72`;
- fixed Runtime archive SHA-256:
  `7948cdd1fac6bb330320bd3b08cee8b00630e4e47d300ce441626c670054fb27`;
- fixed Runtime archive size: `16247269` bytes;
- Runtime release manifest SHA-256:
  `3ecd816daa1c1760eef243e3c447a030aa411e9059803db346bd1f6006997fbc`;
- final onedir file count: `131`;
- final onedir tree digest:
  `22c38e64c1a022994674c58d0a8cfc9650580db61317e3c3826516e793169ea0`;
- Runtime source tree digest:
  `1cd9a1fc11a054bcdecb1384a1fcd360b4d0f6ff90f0cb2591d2ec4a340acaa0`.

The fixed Runtime is unsigned and independently trust-bound. Electron Packager
and Squirrel use one serializable signing hook that skips the complete
`resources/bizhub-runtime` subtree, so installation preserves all 131 fixed
bytes and hashes.

## Windows Artifact identity

GitHub Actions run
[`32869710838`](https://github.com/kingcharleslzy-ai/bizhub-installer/actions/runs/32869710838)
completed successfully on `windows-2022` with Node `22.22.2` and Python
`3.12.10`.

- signing mode: `synthetic-ci`;
- Setup name: `BizHub-Desktop-Setup-x64.exe`;
- Setup size: `168856328` bytes;
- Setup SHA-256:
  `cf385b58101f98d0192eb201c437e1fe397af4d32aceccf8b1727af2e51a257f`;
- full package: `bizhub_desktop-0.1.0-full.nupkg`;
- full package size: `168157950` bytes;
- full package SHA-256:
  `6b619833eecfa99eba173c78f2a0b5e5b09829a908d9a367585ea05c69c074ba`;
- `RELEASES` SHA-256:
  `704ed4ce917501ca5abd0928d06f59be6c0a451ba37eecff18725319f4d5bd33`;
- Actions Artifact id: `9571694257`;
- Actions Artifact size: `336767691` bytes;
- Actions Artifact digest:
  `sha256:8d7aae83761379db734691368eca16dd10a8f15719dc7e67294b5f18e8cfa61f`;
- Artifact expiry: `2026-09-08T16:08:26Z`.

The Setup, packaged Shell, and installed Shell all reported Authenticode
`Valid` against the same ephemeral synthetic certificate. The fixed Runtime
sidecar reported `NotSigned` by design and remained byte-identical.

## Native Windows acceptance

The clean runner proved:

- two Windows Runtime builds produced the same Manifest, tree, source, file
  count, and archive identity;
- the checked-in fixed archive matched an independent platform trust record;
- coordinated Runtime file and Manifest tamper was rejected before start;
- installation created Chromium operational state but no BizHub
  `local-instance` or formal SQLite database;
- explicit local setup created one synthetic instance through the Generic
  Runtime only;
- Generic Owner preview, apply, readback, idempotent replay, failure-zero-write,
  backup, restart, and recovery checks passed;
- the installed Shell started the exact fixed Runtime on a random loopback
  origin and stopped it cleanly;
- silent uninstall removed the installed executable but preserved the formal
  synthetic SQLite database outside the installation root;
- no Electron, Desktop, or Runtime process remained after the test;
- the packaged cloud smoke used only `https://example.com` and did not create a
  local instance;
- the package scanner found no SQLite, source maps, trusted enterprise keys, or
  customer-private marker.

## Additional machine checks

```text
npm test
  30 passed, 0 failed

PYTHONPATH=app/backend python -m pytest -q app/backend/tests tests
  67 passed, 2 subtests passed

npm run verify:boundary
  scanned_text_files=44
  python_source_files=4
  sqlite_files=0
  trusted_connection_keys=0
  private_markers=0

npm audit --omit=dev
  0 vulnerabilities

PowerShell PSScriptAnalyzer
  0 error/warning findings

install source checksums
  153 files verified
```

## Retained blockers

The Actions certificate is generated only for CI mechanics, trusted only on the
disposable runner, and deleted after the job. It is not a publisher identity.
The fixed Runtime sidecar is intentionally unsigned because signing it after
trust capture would change the independent Pack identity. A production release
therefore requires an approved real Authenticode identity and an approved
signed-Runtime trust design or equivalently reviewed publisher binding.

The complete Forge development dependency audit still reports 25 upstream
build-chain findings: 3 low, 21 high, and 1 critical. Those findings, the
synthetic signer, the unsigned sidecar, and pending external code review block
merge/publication of D3. No GitHub Release was created.
