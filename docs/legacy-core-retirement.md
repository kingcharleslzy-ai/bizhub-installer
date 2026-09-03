# Public legacy core retirement

## Completed state

`app/backend/bizhub` and its dedicated tests were physically retired after the
fixed common-artifact preview passed. Current Docker, Desktop, installer, plugin,
and MCP paths use the vendored `bizhub-common` artifact plus the delivery adapter;
the distribution test now requires the legacy directory to remain absent.

The immutable stable `v0.3.0` tag and image contract remain unchanged. A new
preview failure falls back to that fixed stable release; it does not require
rewriting or deleting stable history.

## Recovery

The old implementation remains reproducible from immutable Git tag `v0.3.0`.
Stable rollback uses that tag; Generic business fixes belong only in the
canonical common source.
