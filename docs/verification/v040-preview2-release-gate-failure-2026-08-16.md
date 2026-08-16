# v0.4.0-preview.2 release gate failure

Date: 2026-08-16

The immutable `v0.4.0-preview.2` tag resolved to
`3195d63b1abe9a49af224ddac734aceaf47fef07`. GitHub Actions run
`31938174059` passed checkout, Python/Node setup, checksums, all repository
tests, frontend build, and audit. It then stopped in the plugin step before any
target preflight, Docker install, data creation, or release publication.

The workflow still compared the installed plugin and MCP versions with the
literal old value `0.4.0-preview.1`. The preview.2 package correctly reported
`0.4.0-preview.2`, so the fixed-value assertion failed closed. This was a
release-orchestration defect, not a reason to move or replace the published
tag.

The correction derives the expected version from the immutable tag and the
plugin manifest, then compares every installed/read-back version with that one
value. A distribution test prevents literal preview-version checks from being
reintroduced. The corrected release is assigned a new immutable preview tag.

