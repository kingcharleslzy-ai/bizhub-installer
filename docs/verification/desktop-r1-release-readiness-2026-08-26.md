# Desktop-R1 release-control verification — 2026-08-26

## Result

Desktop-R1 is a narrow release-control implementation candidate. It separates
synthetic testing, production signing, exact-Artifact approval, and publication;
signs the missing Windows Runtime PEs before rebinding trust; and adds native
cross-version data readback. It has not been merged, signed with a real
publisher, tagged, published, notarized, or distributed.

No private repository, directory service, account mapping, real login, SQLite
schema, migration, Profile, Owner, writer, formal data, or production deployment
was changed.

## Source identities

- public `main` base:
  `1cc8f33dd6198da41e7b6d16520430690944bbf3`;
- previous accepted R1 mechanics head:
  `93efbefcff15c3b05c02766e48d8ec42110d93f0`;
- previous report-only head:
  `ddb6797a189879bbc1b241e9330ed40b030d4f61`;
- narrow-fix implementation head:
  `d10622f219c640d8a7af8ab856fd36269c9c5a01`;
- report-only evidence head: the commit containing the final evidence update;
  its own SHA is intentionally not written into this report.

## Release-control evidence

The implementation defines three disjoint workflows:

1. `Desktop R1 Synthetic` has `contents: read`, contains no production secret
   reference or production Environment, and cannot create a tag or Release.
2. `Desktop R1 Signed Candidate` is manual and exact-main-only. Its macOS and
   Windows jobs use `desktop-production-signing`, create fixed production
   Artifacts, generate `desktop.release-plan.v1` plus SHA-256, then stop.
3. `Desktop R1 Publish` uses `desktop-production-publish` and requires the exact
   source run, plan SHA, commit, and tag. It downloads only the prior run's
   Artifacts, verifies Actions IDs/digests and inner hashes, contains no build or
   signing step, and requires immutable-release readback.

Both protected Environments require review, prohibit self-review, and allow
only `main`. Public `main` rejects deletion/non-fast-forward changes, requires a
pull request, and requires both native synthetic checks. Repository-level
Actions Secrets remain empty; future publisher credentials belong only in the
signing Environment.

The 2026-08-26 REST readback fixed the following control-plane identity:

```text
desktop-production-signing: required reviewer kingcharleslzy-ai,
  prevent_self_review=true, custom branch policy main only, secrets=0,
  can_admins_bypass=true
desktop-production-publish: required reviewer kingcharleslzy-ai,
  prevent_self_review=true, custom branch policy main only, secrets=0,
  can_admins_bypass=true
repository Actions secrets: 0
main ruleset: 21569023, active, bypass_actors=[],
  current_user_can_bypass=never, deletion/non-fast-forward/PR rules,
  strict required checks desktop-r1-synthetic-macos-arm64 and
  desktop-r1-synthetic-windows-x64
immutable releases: enabled=true, enforced_by_owner=false
```

The repository currently has one collaborator. That collaborator is the
configured required reviewer, so `prevent_self_review=true` deliberately makes
a self-triggered production run unapprovable. A second independent reviewer is
required before real signing. This is a fail-closed prerequisite, not an
exception or inferred approval. The personal-repository owner remains the
explicitly recorded GitHub Environment administrative exception because the
Environment REST configuration exposes no administrator-bypass switch; the
`main` ruleset itself has no bypass actor.

Immutable releases are enabled at repository scope. The publish workflow also
checks that setting before it creates a draft and afterwards requires the REST
release to report `draft=false` and `immutable=true`, with exact tag,
`target_commitish`, tag ref, release-plan SHA, and downloaded install bytes.

## Windows Runtime publisher binding

The accepted fixed Windows Runtime is still the only Runtime input. R1 verifies
it against the independent baseline trust, detects PEs by binary header, signs
only files without an Authenticode certificate table, and requires the baseline
`bizhub-runtime.exe` to be in that set. It then regenerates a release-specific
Manifest and trust record from the signed bytes. Forge skips this finalized
subtree rather than changing it again.

Packaged and installed verification enumerates every Runtime PE and requires
Authenticode `Valid`. PEs signed by the BizHub publisher must match the expected
thumbprint; production signatures must also contain a timestamp. Evidence binds
PE count, publisher-signed paths, main executable subject/thumbprint, Runtime
Manifest/tree/trust, source-tree digest, and common artifact digest.

## Cross-version data readback

Both native workflows derive a distinct semantic prior version from the current
package version and build actual platform applications/installers for both.
The test sequence is:

```text
install/copy vN
-> create Generic party/product/unit/location through Owner
-> install/copy vN+1
-> health and formal location readback
-> uninstall/replace and reinstall/copy vN
-> repeat readback
-> assert same data identity and writer instance
```

All state lives in an OS temporary root and is removed after the test. It never
uses a production account or database. This proves the installation-level
upgrade/rollback boundary only; no automatic updater is introduced.

## Machine evidence

Local macOS arm64 execution completed the real v`0.0.999` to v`0.1.0` to
v`0.0.999` chain with `upgrade_readback=true`, `rollback_readback=true`, stable
data identity, stable writer identity, and zero residual Runtime processes.

The final synthetic GitHub Actions matrix is run `32983778755`, attempt 1,
triggered by a branch push and bound exactly to implementation head
`d10622f219c640d8a7af8ab856fd36269c9c5a01`. It completed with `success`:

```text
macOS arm64 job 98226616019: success
Windows x64 job 98226615628: success

macOS Actions Artifact:
  ID: 9612589832
  name: desktop-r1-macos-arm64-d10622f219c640d8a7af8ab856fd36269c9c5a01-synthetic-ci
  size: 297268585 bytes
  digest: sha256:2770fd722032433358c08d7847333580f4d529a30d99a77dfcab85f4ece232fd
  ZIP: 142458114 bytes,
    9d01f439d55bd7cc4cdf02e3455f24e2436123058f141634c60eddd38dfa594a
  DMG: 158708694 bytes,
    149324874e288db7607775bc1c23af5f078c0a1de03277efb385db8b3a539946

Windows Actions Artifact:
  ID: 9612699212
  name: desktop-r1-windows-x64-d10622f219c640d8a7af8ab856fd36269c9c5a01-synthetic-ci
  size: 336826142 bytes
  digest: sha256:d92eb06fa29ee84b0b8c08501251874ff6c4613ea675046690815015e81f821c
  Setup: 168885000 bytes,
    ea68c373150d90da61c6bc18b338836b0a102af5925cffdd90483f57842e6d97
  NUPKG: 168186295 bytes,
    6216b383984f4941191c1d80ca8dce26edb21518417f07dcccafe6c526d0999a
  RELEASES:
    7d1d1ee8b4e5c5e08560c5c1f7983888d09e48c5442759de233be8af02407eae
```

The synthetic Windows publisher identity is not a production identity. Its
Runtime evidence enumerated 73 PE files, required all 73 to be Authenticode
`Valid`, and signed the four previously unsigned PEs, including
`bizhub-runtime.exe`. The rebound Runtime identities were:

```text
Manifest SHA-256: 15277478fd60ad2b89e15d9d8933f8dab146a94a4794d5e709ea90f25c31bcd4
pack tree: 5fa26e2b1149d5e44a293944725489838dd133bc0843684cc37ce24472355458
trust SHA-256: 22e81d59db639b37439e04ece0a3fa2bf4e33fb0ec156ab50dbb0bb29fc6df8e
Runtime source tree: 1cd9a1fc11a054bcdecb1384a1fcd360b4d0f6ff90f0cb2591d2ec4a340acaa0
```

The synthetic macOS Runtime evidence counted 63 signed Mach-O files. Its
rebound identities were:

```text
Manifest SHA-256: 172efb048c71ac0b156216eb25c2294ad9d93e36a57500e52647c8610836c1ec
pack tree: 2a5b6086e156de524d044e2c6f656514c331c2415e9b23cbba3e2d0e523c4e8f
trust SHA-256: 919d6fb7eb6ba2c5d4003eed787425b4ee0476ec7a540f3f3bd76836cc943151
Runtime source tree: 6d99bc96edbcb6b48d3a5f115a7ea23575f31b0f1bd097dff526f38ec0cfdedd
```

Both native jobs completed the real v`0.0.999` -> v`0.1.0` -> v`0.0.999`
sequence with `upgrade_readback=true`, `rollback_readback=true`, stable data
identity, stable writer identity, and zero residual Runtime processes. Windows
also reported `runtime_pe_signatures_valid=true`; packaged and installed Shell,
Setup, and sidecar signature checks passed. Both platforms retained the common
core artifact digest
`sha256:90a43dc622894419c56edabaf4166809f4b557c2dc0ac524d77277e80980bc72`,
contained zero SQLite files and zero private markers, and passed the packaged
account/Workspace and Generic Local flows.

Static and native evidence:

```text
desktop Node tests: 63 passed, 0 failed
repository checksum manifest: 194 files verified
workflow YAML parse: passed
PowerShell parse and PSScriptAnalyzer error-level scan: passed
macOS native upgrade/rollback Owner readback: passed
GitHub macOS arm64 native matrix: passed
GitHub Windows x64 native matrix: passed
```

## Remaining formal-release prerequisites

This narrow fix does not authorize or configure:

- Apple Developer ID Application/notarization credentials;
- a public Windows Authenticode publisher credential;
- an owned customer-neutral account-directory hostname on HTTPS 443;
- a second independent GitHub reviewer;
- a real signed-candidate run;
- a tag or GitHub Release.

The current `nip.io:8443` directory remains intentionally rejected by production
preflight. A formal candidate may begin only after the project Owner separately
approves those external identities and configuration.

## Disposition

The implementation passed the macOS arm64 and Windows x64 synthetic matrix and
this is its one report-only evidence update. Work must stop for external narrow
review after the report-only head and its unchanged native matrix are fixed;
this report grants no merge or release authority.
