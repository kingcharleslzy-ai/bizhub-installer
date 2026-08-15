# Security policy

## Supported version

Only the newest tagged release is reviewed. Preview releases are implementation
candidates: do not accept real customer data until the exact release has passed
its clean Ubuntu installation, HTTPS/access, backup/restore, sensitive-data
scan, and fresh-Agent forward-test gates.

BizHub's first security boundary is intentionally narrow: one company, one
administrator, one instance. It does not claim RBAC, SSO, MFA, multi-tenancy,
or a hardened public application port. Bind to an explicit private address or
loopback behind HTTPS/Cloudflare access control.

## Reporting a vulnerability

Use this repository's private GitHub Security Advisory reporting flow. Do not
open a public issue containing exploit details, customer data, credentials,
logs, database files, or private infrastructure information.

If a secret was exposed, revoke or rotate it immediately before waiting for a
code fix. A repository signature or digest proves source provenance; it does
not grant permission to install software or access customer systems.

Never place administrator passwords, secret-key files, tunnel credentials,
private keys, customer databases, or backup contents in Git, plans, MCP tool
arguments, command-line arguments, logs, or chat. Use the target TTY and a
host-local password file with restrictive permissions.

The MCP server accepts no arbitrary URL or shell command. Its instance origin
comes only from host configuration, and every formal business mutation still
requires a server-issued preview token and returns readback.
