# Desktop-R1 release readiness verification — 2026-08-26

## Result

Desktop-R1 now has one fail-closed, repeatable macOS arm64 and Windows x64
release path. The fixed public implementation candidate passed the complete
synthetic publisher matrix on both native GitHub runners. It has **not** been
merged, tagged, published, notarized, or distributed as a formal Release.

The current `0.1.0` package version identifies this candidate only. BizHub
Desktop versions are expected to keep advancing. Each future Release must bind
one exact package version, tag, Git commit, signed product, container digest,
and checksum set; this does not freeze the application at a global version.

No private repository, customer account mapping, production directory service,
production key, cloud login, SQLite database, migration, Profile, Owner,
writer, business data, or production deployment was modified.

## Fixed source identities

- public `main` base:
  `1cc8f33dd6198da41e7b6d16520430690944bbf3`;
- R1 implementation commit:
  `5abdc7d1bde2eeacba591e69fbfe67afc89a4db7`;
- final fixed R1 candidate head, including the pinned Node 24 Artifact uploader:
  `93efbefcff15c3b05c02766e48d8ec42110d93f0`;
- candidate branch: `codex/desktop-r1-release-20260826`;
- report-only evidence head: the commit containing this report. Its SHA is
  intentionally not copied into the report, avoiding a self-referential
  identity. It must not redefine the fixed implementation candidate above;
- Runtime Profile: `generic-kernel-smoke`;
- common artifact digest:
  `sha256:90a43dc622894419c56edabaf4166809f4b557c2dc0ac524d77277e80980bc72`.

## Release contract proved by code and tests

The new `Desktop R1 Release` workflow has two separate modes:

1. branch pushes run `synthetic-ci`, proving the native packaging, signing,
   installation, product flow, Owner, cleanup, and Artifact mechanics without
   any production credential;
2. `production` is manual, `main`-only, exact-commit-only, exact-tag-only, and
   `publish=true`-only. It additionally requires real publisher credentials,
   notarization, and an owned neutral standard-HTTPS account directory before
   it can create an immutable tag and GitHub Release.

A production request fails before packaging if the release commit is moving,
the tag does not match the current package version, the source is not the exact
public `main`, the account-directory URL uses temporary DNS, a literal IP, a
non-443 port, credentials, or a non-HTTPS origin, or a required publisher
credential is absent. A branch or synthetic run cannot enter the publish job.

macOS uses one prepared Runtime identity, signs the Runtime and Electron app
with a single approved Developer ID identity, applies distinct least-privilege
entitlements, verifies all 63 Runtime Mach-O files, notarizes and staples the
app, creates ZIP and DMG containers, mounts/extracts both, and verifies the
product again. Synthetic mode uses a separate ad-hoc entitlement exception
only because it has no Apple Team ID; production entitlements cannot inherit
that exception.

Windows reuses the accepted fixed D3 Runtime and Squirrel chain, requires a
real Authenticode PFX and password in production, signs the Shell and Setup,
verifies the packaged and installed signatures, runs the installed product,
uninstalls it, and proves that formal local data outside the installation root
is preserved. The fixed Runtime is independently trust-bound and is not
silently replaced or granted a second writer.

Forge remains only the deterministic packager. The renderer still has no Node
or filesystem authority, cloud Sessions remain non-persistent across Desktop
restart, and every business write remains behind the Python Owner path.

## Native GitHub Actions evidence

GitHub Actions run
[`32972549877`](https://github.com/kingcharleslzy-ai/bizhub-installer/actions/runs/32972549877)
is bound exactly to candidate head
`93efbefcff15c3b05c02766e48d8ec42110d93f0` and completed with `success`:

- macOS arm64 job `98189693336`: success in 1m48s;
- Windows x64 job `98189693102`: success in 3m43s;
- `publish-release`: skipped as required for a branch `synthetic-ci` run;
- Node 20 action deprecation warnings: zero;
- final residual Electron/Desktop/Python processes: zero.

### macOS arm64 synthetic evidence

- package version: `0.1.0`;
- ZIP: `BizHub-Desktop-0.1.0-macOS-arm64.zip`;
- ZIP size: `142458117` bytes;
- ZIP SHA-256:
  `26736193e5349084e9a0b833bf0df9d4b78f03987a06e8d57679feac8864daec`;
- DMG: `BizHub-Desktop-0.1.0-macOS-arm64.dmg`;
- DMG size: `159306945` bytes;
- DMG SHA-256:
  `5c51cc45702cfa6344c06b3a1054c2b40f763573c5363c5b34b35dfb338ef139`;
- Actions Artifact id: `9608236964`;
- Actions Artifact size: `297493465` bytes;
- Actions Artifact digest:
  `sha256:719911ede94a424820f3a5db2bebabf2138c13464a8a84639c5e8153bdc2b6a0`;
- signed Runtime Manifest SHA-256:
  `172efb048c71ac0b156216eb25c2294ad9d93e36a57500e52647c8610836c1ec`;
- signed Runtime tree digest:
  `2a5b6086e156de524d044e2c6f656514c331c2415e9b23cbba3e2d0e523c4e8f`;
- release-specific Runtime trust SHA-256:
  `919d6fb7eb6ba2c5d4003eed787425b4ee0476ec7a540f3f3bd76836cc943151`;
- packaged files: `413`; packaged SQLite files: `0`; private markers:
  `0`.

The ZIP and DMG were both opened and the contained application was rescanned
and verified. These are ad-hoc signed synthetic mechanics artifacts: they are
not Developer ID signed or notarized products and must not be distributed as a
formal macOS release.

### Windows x64 synthetic evidence

- Setup: `BizHub-Desktop-Setup-x64.exe`;
- Setup size: `168860936` bytes;
- Setup SHA-256:
  `a80d9e70a879e293de7741ee95cb0bb70268a1743082502c624516a423225e9e`;
- full package: `bizhub_desktop-0.1.0-full.nupkg`;
- full package size: `168162330` bytes;
- full package SHA-256:
  `f78774f83c970e346b1b26e7c2fe5d7a1a54694c6174a9617cd536d49b10313b`;
- `RELEASES` SHA-256:
  `1a9c6291b78e087fcbb57595e4c9a892a4fbab929cfbe12ade36361ddc68d9dc`;
- Actions Artifact id: `9608304957`;
- Actions Artifact size: `336776549` bytes;
- Actions Artifact digest:
  `sha256:a31357451e7f037b92d3e8d023028cc8a6283e73a218c99405c846b0ead87c2e`;
- fixed Runtime archive SHA-256:
  `7948cdd1fac6bb330320bd3b08cee8b00630e4e47d300ce441626c670054fb27`;
- Runtime Manifest SHA-256:
  `3ecd816daa1c1760eef243e3c447a030aa411e9059803db346bd1f6006997fbc`;
- Runtime tree digest:
  `22c38e64c1a022994674c58d0a8cfc9650580db61317e3c3826516e793169ea0`;
- packaged files: `208`; packaged SQLite files: `0`; private markers:
  `0`.

The Setup, packaged Shell, and installed Shell all reported Authenticode
`Valid` against one disposable synthetic certificate. Silent uninstall removed
the application and preserved the formal synthetic local database. The
certificate was removed after the job. It is not a public publisher identity,
so these artifacts must not be distributed as a formal Windows release.

## Product and Owner acceptance

Both platforms proved the same customer-neutral product flow in development
and packaged/installed form:

- account page password fields: `0`;
- account-directory requests contain account identifier only; passwords: `0`;
- one correctly signed cloud Workspace connects;
- an open Workspace survives Descriptor expiry;
- reconnect with the expired Descriptor fails;
- a fresh directory query obtains a new Descriptor and reconnects;
- unknown or known-empty accounts create `0` local instances;
- Generic Local appears only after explicit user choice;
- Cookie, localStorage, and HTTP cache are cleared across Desktop restart;
- cloud Session persistence: `false`;
- tested viewports: `1280x820`, `960x720`, no horizontal overflow;
- Owner apply: `applied`;
- exact replay: `idempotent_noop`;
- failure path: zero writes;
- backup: valid;
- restart formal readback: one record;
- concurrent starts: one Runtime process maximum;
- installation/uninstallation preserves formal local data;
- residual processes: `0`.

The package boundary scanner found one public Ed25519 connection trust root,
zero customer-private markers, zero bundled SQLite databases, zero source maps,
and no Dazheng rule or account mapping.

## Additional machine evidence

```text
install checksum verification
  184 files verified, including this report on the report-only head

desktop Node tests
  59 passed, 0 failed

public/private package boundary
  scanned_text_files=63
  python_source_files=4
  sqlite_files=0
  trusted_connection_keys=1
  private_markers=0

fixed Runtime archive verification
  darwin-arm64=passed
  win32-x64=passed

npm audit --audit-level=moderate
  0 vulnerabilities

npm audit --omit=dev --audit-level=high
  0 vulnerabilities
```

The branch replaces the vulnerable upstream ZIP extraction path with a bounded,
path-confined vendored implementation and exercises traversal, Windows path
ambiguity, and symlink-boundary rejection. The default branch still reports
its pre-R1 dependency alerts until this reviewed candidate is integrated; the
fixed candidate itself produced the zero-audit results above.

## Remaining formal release blockers

The release mechanism is ready for external narrow review, but a formal
Desktop Release remains deliberately blocked by three missing production
identities:

1. no Apple Developer ID Application certificate and notarization API
   credential are configured;
2. no approved public Windows Authenticode publisher certificate is
   configured;
3. the current neutral account-directory URL still uses temporary `nip.io`
   DNS and port `8443`, while production preflight requires an owned neutral
   HTTPS hostname on standard port `443`.

Repository Actions Secrets, Variables, and Environments contained no formal R1
publisher credentials at the time of this verification. Formal credentials
must be added only after Owner approval and must remain outside both source
repositories. The account-directory domain change must preserve the existing
public Ed25519 trust boundary and private account mapping; it does not authorize
changing the directory service, login behavior, Profile, Owner, writer,
migration, or production data.

The next approved production run must rebuild from the exact reviewed public
`main` commit with the real publisher identities. Its signed artifacts will
necessarily have new hashes, so their final identities must be captured from
that production run before the immutable tag and Release are accepted.

## Disposition

Desktop-R1 implementation and synthetic native evidence are ready for one
external code-and-release-gate review. This report does not authorize merge,
credential provisioning, domain changes, a real-account check, a tag, or a
GitHub Release.
