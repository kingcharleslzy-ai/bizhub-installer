# Desktop-D1 cloud shell local verification — 2026-08-25

## Result

Desktop-D1 is a locally verified implementation candidate, not a release. The
same public Electron shell can consume a signed, customer-neutral connection
envelope and load only its approved HTTPS origins in an isolated
`WebContentsView`.

The signed connection file is a temporary D1 Workspace bootstrap. Account login
does not yet discover Workspace membership, and no unified Account/Workspace
membership control plane exists in D1.

No BizHub deployment, customer account, production API, formal database, email,
or messaging channel was accessed. The network smoke target was the public
`https://example.com` origin.

## Boundary evidence

- Electron `44.0.0`, Forge `7.11.2`, Vue `3.5.41`, Vite `8.2.2`, and Node
  `22.22.2` were pinned for this proof.
- The checked-in trust store has zero keys. The smoke test generated one
  temporary Ed25519 key pair and signed connection envelope, then deleted them.
- The shell and cloud view use `nodeIntegration: false`,
  `contextIsolation: true`, `sandbox: true`, and `webSecurity: true`.
- Remote navigation, redirects, requests, secure WebSockets, windows,
  permissions, and downloads are fail-closed against the signed origin set.
- The packaged `app.asar` contains only built renderer assets, four Electron
  source files, and `package.json`; it contains no `node_modules` or build tools.
- The boundary scanner inspected 19 source files and found zero Python files,
  SQLite files, trusted connection keys, or customer-private markers.
- The macOS packaged directory and the application re-extracted from the final
  ZIP both passed artifact scanning. The scan checked filenames, resources,
  `app.asar`, package metadata, source maps, private keys, private markers,
  Python, SQLite, and the restored empty trust store.

## Machine checks

Executed from `desktop/`:

```text
npm test
  11 passed, 0 failed

npm run verify:boundary
  status=ok, scanned_files=19, trusted_connection_keys=0

npm run audit:runtime
  found 0 vulnerabilities

npm run smoke:cloud
  status=connected, origin=https://example.com

npm run package -- --platform=darwin --arch=arm64
  package completed

npm run verify:artifact -- "out/BizHub Desktop-darwin-arm64"
  status=ok, artifact_files=260, asar_entries=12
  python_files=0, sqlite_files=0, source_maps=0, private_markers=0

npm run smoke:packaged
  status=connected, origin=https://example.com

final ZIP extraction and artifact scan
  status=ok, artifact_files=257, asar_entries=12
  trusted_connection_keys=0, private_markers=0

post-smoke process readback
  no packaged or development Electron process remained
```

The final unsigned local ZIP candidate is:

```text
desktop/out/make/zip/darwin/arm64/BizHub Desktop-darwin-arm64-0.1.0.zip
size: 127603731 bytes
sha256: 1ffabeaa1a7d4edd7ad2f7bb51fce7ed58741f05962dc2fd02444b363fb47889
```

The artifact is ignored by Git and has not been uploaded or published.

## Retained risks and next checkpoint

The complete development dependency audit reports 24 upstream Forge build-chain
findings (3 low, 20 high, and 1 critical) even though the packaged runtime
dependency audit is clean. The current ZIP is ad-hoc/unsigned and not notarized.
Neither risk may be hidden or waived by this local proof. See the
[dependency reachability record](desktop-d1-build-dependency-reachability-2026-08-25.md).

Windows x64 is verified by the public `Desktop D1 Windows x64` workflow against
the fixed pushed branch head. That workflow must pass before D1 can enter
external code review; this local record alone does not claim the Windows result.

Desktop-D2 remains separately gated. It must package only the fixed Generic
Runtime and use synthetic data to prove explicit local initialization,
authentication, unique Owner preview/apply/readback, idempotency, restart,
backup, and failure-zero-write behavior. This record does not authorize that
work, customer-private runtime inclusion, production connection configuration,
or publication.
