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

## Synthetic candidate path

A push to the fixed R1 review branch runs macOS and Windows in
`synthetic-ci`. The workflow uses ad-hoc/self-signed identities only to prove
the signing topology, installed application, account Workspace flow, Generic
Owner lifecycle, idempotency/failure safety, uninstall preservation, artifact
scan, and zero residual processes. That path has read-only repository
permission and has no release job.

Synthetic identities are not publisher identities and are never uploaded as a
formal Release.

## Production gate

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
7. `publish=true` is explicitly selected.

Only then may the final job create a new tag and GitHub Release, download all
assets again, and verify `SHA256SUMS`.

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

## Current blockers

The implementation intentionally cannot create a production Release today:

- this repository has no macOS Developer ID/notarization secrets;
- this repository has no production Windows Authenticode secrets;
- the current W2 directory uses a temporary `nip.io:8443` transport rather
  than an owned neutral hostname on port 443.

Resolving those prerequisites changes external publisher/deployment state and
requires a separate project Owner decision. The R1 candidate itself does not
make or infer that decision.
