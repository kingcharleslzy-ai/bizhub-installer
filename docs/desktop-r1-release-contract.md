# Desktop-R1 release contract

Status: implementation candidate; no formal Desktop Release exists

Date: 2026-08-26

## Scope

Desktop-R1 packages the already accepted customer-neutral Desktop product for
macOS arm64 and Windows x64. It is deployment/instance release configuration,
not a business module. It does not change the account-directory service,
deployment-private mappings, cloud authentication, SQLite, migrations,
Profiles, Owners, writers, or formal data.

The same installer remains Generic. Customer-private behavior arrives only
after account lookup returns a signed cloud Workspace and that Runtime performs
its own login.

## Mutable version, immutable release

BizHub Desktop is expected to continue changing. R1 does not freeze the product
at `0.1.0`; it freezes only one published release identity:

```text
package.json version X.Y.Z
-> desktop-vX.Y.Z
or desktop-vX.Y.Z-preview.N
-> exact public main commit
-> one macOS arm64 ZIP + DMG
-> one Windows x64 Setup + Squirrel update set
-> SHA256SUMS
```

An existing tag is never overwritten. The next Desktop version changes
`package.json` and produces another immutable release.

## Three isolated workflows

`Desktop R1 Synthetic` runs on review/main changes with read-only repository
permission. It contains no `secrets.*` expression, production Environment, tag,
or release command. Ad-hoc/self-signed identities prove product, Owner,
packaging, installation, vN to vN+1 to rollback, and cleanup mechanics only.

`Desktop R1 Signed Candidate` is manual, exact-main-only, and binds both native
signing jobs to `desktop-production-signing`. It produces fixed signed products
and a deterministic `desktop.release-plan.v1`, prints the plan SHA-256, and
stops. It has no contents-write permission and cannot create a Release.

`Desktop R1 Publish` is separately manual and binds its only job to
`desktop-production-publish`. It accepts only `source_run_id`,
`release_plan_sha256`, `release_commit`, and `release_tag`; verifies Actions
Artifact IDs/digests and every inner SHA; and publishes those existing bytes.
It contains no build, package, sign, notarize, or production-secret step.

Synthetic identities are not publisher identities and are never uploaded as a
formal Release.

## GitHub control plane

Both production Environments require a reviewer, prohibit self-review, and
allow only `main`. Publisher credentials may exist only as signing-Environment
secrets, never repository secrets. The publish Environment contains no
publisher credential. Public `main` is protected by a no-bypass ruleset that
rejects deletion and non-fast-forward updates, requires pull requests, and
requires both Desktop R1 synthetic platform checks.

The repository must have immutable releases enabled before publication. The
publish workflow fails before creating a draft if that setting is absent and,
after publication, requires REST readback of `draft=false`, `immutable=true`,
the exact tag, exact target commit, exact tag ref, and exact downloaded bytes.

The repository currently has only one collaborator. Configuring that person as
required reviewer while prohibiting self-review intentionally leaves production
jobs fail-closed until a second independent reviewer is added. This document
does not invent or grant that role. GitHub's Environment REST configuration
does not expose a separate administrator-bypass switch here; the personal
repository owner therefore remains an explicitly recorded administrative
exception. The `main` ruleset itself has an empty bypass-actor list, and any
out-of-band Environment bypass is outside and cannot be inferred from these
workflows.

## Signed candidate gate

Production is available only through a manual dispatch on public `main`. Every
condition below must be true:

1. `release_commit` is the current exact 40-character public `main` SHA.
2. `release_tag` matches the current package version.
3. The packaged account directory is an owned, customer-neutral HTTPS hostname
   on standard port 443. Literal IP, `nip.io`, `sslip.io`, custom port, query,
   fragment, or credential-bearing URL is rejected.
4. macOS receives a Developer ID Application identity, Team ID, temporary
   isolated keychain, and App Store Connect API key. The fixed Runtime and Shell
   are signed by the same publisher; application and DMG are notarized and
   stapled.
5. Windows receives a publicly trusted Authenticode identity. The Squirrel
   Setup and installed Shell must have the expected thumbprint and production
   timestamp.
6. Both platform jobs pass and upload fixed identities and products from the
   same commit.
7. Each platform proves one synthetic prior version can create Generic Owner
   data, the current version reads it back, and reinstalling the prior version
   reads back the same data and writer identity.
8. The release-plan binds the directory/trust configuration, common artifact,
   publisher identities, Runtime trust, test identities, Actions Artifact
   IDs/digests, and inner install-file hashes.

Only after the project Owner approves that exact plan SHA may the independent
publish workflow consume the same run's Artifacts. A second signing run cannot
substitute different timestamped bytes for the approved candidate.

## macOS Runtime trust

Code signing changes Mach-O bytes, so the unsigned fixed Runtime Manifest
cannot be reused as if those bytes were unchanged. R1 performs:

```text
verify fixed unsigned Pack against reviewed trust
-> sign every Runtime Mach-O/framework
-> rebuild a release-specific Manifest and trust record
-> verify signed Pack against that independent record
-> package without re-signing the prepared Runtime subtree
-> sign/notarize Shell
-> verify Shell, every Runtime Mach-O, ZIP, mounted DMG, and exact trust bytes
```

The release-specific trust preserves the reviewed runtime ID, Profile,
artifact digest, source commit, allowlist digest, and source-tree digest. It
changes only the byte identities necessarily changed by signing. It does not
rebuild business code or create another Runtime.

## Windows Runtime trust

R1 verifies the fixed Windows Pack, detects every PE by its binary header,
signs only PEs without an Authenticode certificate table (including
`bizhub-runtime.exe`), then regenerates the release-specific Manifest and trust
from those signed bytes. Packaging deliberately skips that finalized subtree.
Packaged and installed verification requires every Runtime PE to report
Authenticode `Valid`; publisher-signed PEs must match the approved thumbprint,
and production signatures must have a timestamp.

## Current blockers

The implementation intentionally cannot create a production Release today:

- this repository has no macOS Developer ID/notarization secrets;
- this repository has no production Windows Authenticode secrets;
- the current W2 directory uses a temporary `nip.io:8443` transport rather
  than an owned neutral hostname on port 443.

Resolving those prerequisites changes external publisher/deployment state and
requires a separate project Owner decision. A second independent GitHub
reviewer is also needed before the protected Environments can approve a real
run. The R1 candidate itself does not configure credentials, domain, reviewer
membership, tag, or Release.
