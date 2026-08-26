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
- narrow-fix implementation head: to be fixed after the native matrix passes;
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

The final native GitHub Actions run, exact implementation head, job IDs,
Artifact IDs/digests, Windows PE counts, and settings readback will be recorded
here only after the fixed implementation is pushed and both native jobs pass.

Current static evidence:

```text
desktop Node tests: 63 passed, 0 failed
workflow YAML parse: passed
PowerShell parse and PSScriptAnalyzer error-level scan: passed
macOS native upgrade/rollback Owner readback: passed
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

The implementation must pass the macOS arm64 and Windows x64 synthetic matrix,
then receive one report-only evidence update. It must stop for external narrow
review after that update; this report grants no merge or release authority.
