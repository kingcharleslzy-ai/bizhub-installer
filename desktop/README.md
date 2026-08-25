# BizHub Desktop D1 cloud shell

This directory contains the Desktop-D1 implementation candidate. It is a
customer-neutral Electron shell for loading one signed, exact-origin HTTPS
BizHub connection in an isolated `WebContentsView`.

Desktop-D1 does not package or start Python, create SQLite, authenticate a
business account, or contain a customer-private Profile. The target cloud
Runtime owns its login, permissions, UI, API, formal Owner, and database.

The checked-in trust store is intentionally empty. Tests create an ephemeral
Ed25519 key pair. A real trusted public key and signed customer connection file
require a separately reviewed instance-configuration checkpoint.

The signed connection file is a D1 Workspace bootstrap, not the final account
discovery model. Account-driven Workspace discovery and a unified membership
control plane are not implemented.

## Local verification

Use Node 22:

```bash
npm ci
npm test
npm run verify:boundary
npm run audit:runtime
npm run build
npm run smoke:cloud
npm run package -- --platform=darwin --arch=arm64
npm run verify:artifact -- "out/BizHub Desktop-darwin-arm64"
npm run smoke:packaged -- \
  --packaged-executable "out/BizHub Desktop-darwin-arm64/BizHub Desktop.app/Contents/MacOS/BizHub Desktop" \
  --packaged-trust-store "out/BizHub Desktop-darwin-arm64/BizHub Desktop.app/Contents/Resources/trusted-connection-keys.json"
```

`smoke:cloud` creates a temporary Ed25519 key and connection file, opens the
public `https://example.com` origin through the real Electron process, and
deletes the temporary material. It does not contact a BizHub deployment.

The packaged runtime currently has no npm runtime dependencies. The pinned
Forge development tree still reports upstream build-tool audit findings, so D1
is not a release candidate until that build-chain risk is resolved or formally
accepted. See the
[dependency reachability record](../docs/verification/desktop-d1-build-dependency-reachability-2026-08-25.md).

The public
[`desktop-d1-windows.yml`](../.github/workflows/desktop-d1-windows.yml)
workflow repeats clean installation, tests, development and packaged HTTPS
smokes, artifact scanning, residual-process checks, ZIP hashing, and artifact
upload on Windows x64. It does not sign or publish a release.

The packaged prototype is unsigned and is not a release. Automatic update,
Windows packaging, Generic local Runtime, and private cloud-to-local authority
cutover remain later checkpoints.
