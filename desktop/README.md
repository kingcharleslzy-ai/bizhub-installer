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
```

`smoke:cloud` creates a temporary Ed25519 key and connection file, opens the
public `https://example.com` origin through the real Electron process, and
deletes the temporary material. It does not contact a BizHub deployment.

The packaged runtime currently has no npm runtime dependencies. The pinned
Forge development tree still reports upstream build-tool audit findings, so D1
is not a release candidate until that build-chain risk is resolved or formally
accepted.

The packaged prototype is unsigned and is not a release. Automatic update,
Windows packaging, Generic local Runtime, and private cloud-to-local authority
cutover remain later checkpoints.
