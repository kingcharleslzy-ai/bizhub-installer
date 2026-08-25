# Desktop-D1 cloud shell local verification — 2026-08-25

## Result

Desktop-D1 is a locally verified implementation candidate, not a release. The
same public Electron shell can consume a signed, customer-neutral connection
envelope and load only its approved HTTPS origins in an isolated
`WebContentsView`.

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
- The boundary scanner inspected 18 source files and found zero Python files,
  SQLite files, trusted connection keys, or customer-private markers.

## Machine checks

Executed from `desktop/`:

```text
npm test
  11 passed, 0 failed

npm run verify:boundary
  status=ok, scanned_files=18, trusted_connection_keys=0

npm run audit:runtime
  found 0 vulnerabilities

npm run smoke:cloud
  status=connected, origin=https://example.com

npm run package -- --platform=darwin --arch=arm64
  package completed

packaged executable launch
  process remained healthy until the bounded test terminated it
```

The final unsigned local ZIP candidate is:

```text
desktop/out/make/zip/darwin/arm64/BizHub Desktop-darwin-arm64-0.1.0.zip
size: 127603604 bytes
sha256: e3e87059a741d53e41244afdad068b188bac5974dfd0e06658d8d436a28d4620
```

The artifact is ignored by Git and has not been uploaded or published.

## Retained risks and next checkpoint

The complete development dependency audit reports 24 upstream Forge build-chain
findings (3 low, 20 high, and 1 critical) even though the packaged runtime
dependency audit is clean. The current ZIP is ad-hoc/unsigned and not notarized.
Neither risk may be hidden or waived by this local proof.

Desktop-D2 remains separately gated. It must package only the fixed Generic
Runtime and use synthetic data to prove explicit local initialization,
authentication, unique Owner preview/apply/readback, idempotency, restart,
backup, and failure-zero-write behavior. This record does not authorize that
work, customer-private runtime inclusion, production connection configuration,
or publication.
