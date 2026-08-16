# Read-only private extension boundary

## Purpose

This is the first concrete bridge between the public BizHub core and a
customer's private repository. It proves that a private derived image is
actually running a fixed public core artifact without first moving formal
business writes or customer data.

It is intentionally not a general plugin system. Private extension code is
trusted, reviewed application code assembled at image build time; Python import
is not a security sandbox. The deployment owner must pin and review both source
commits before building the derived image.

## Runtime contract

Set `BIZHUB_EXTENSION_MODULES` in the derived image to a comma-separated list of
fixed Python import names. File paths, URLs, moving package versions and runtime
installation are not accepted. Each named module exports exactly these public
entry points:

```python
def get_manifest() -> dict: ...
def build_router() -> fastapi.APIRouter: ...
```

For the first external stage, the manifest must:

- use `source=customer_private` and a `customer.*` module id;
- declare a fixed `/api/extensions/...` prefix;
- use `formal_writer=none`, `preview_required=false`, and an empty `actions`,
  `import_resources`, and `owns_entities` set;
- depend only on registered modules and capabilities;
- list every GET path exactly in `read_apis`.

The router may expose only GET/HEAD routes under its prefix. It cannot register
startup/shutdown handlers, WebSockets, mounts, mutation methods or undeclared
paths. The core adds administrator authentication to the entire router. A
validation error fails application import; it never silently disables part of
an extension.

The authenticated system map returns the effective manifest set and:

```json
{
  "core_identity": {
    "version": "0.4.0-preview.2",
    "source_commit": "40-character commit or development"
  }
}
```

Release builds pass the exact planned commit through `BIZHUB_CORE_COMMIT`.
Derived images should repeat that expected commit and their private extension
commit in immutable image labels and expose a bounded status readback. They
must not copy the public core source into the private build context.

## Agent build and verification sequence

1. Resolve and verify the public release commit and build its base image with
   that commit identity.
2. Resolve and review the private extension commit and manifest.
3. Build a Dockerfile whose first runtime line is `FROM` the exact local base
   image; copy only the private extension package.
4. Set the fixed import name and expected core/private commit environment
   values in the derived image.
5. Ask `bizhubctl plan` to inspect the local core and derived images using
   `--candidate-core-image` and `--candidate-image`; retain both immutable IDs.
6. Show image, environment, network and file changes to the user and obtain
   exact-plan approval.
7. Start with synthetic configuration and an empty/synthetic database.
8. Authenticate, read `/api/system/modules`, call every declared extension
   route, and verify the core and private identities.
9. Confirm unauthenticated access is denied and all mutation methods return
   method-not-allowed or are absent.
10. Only after an independent production migration plan may the reference
   deployment begin dual-read comparison. This extension milestone itself does
   not authorize real data access or deployment.

## Stop conditions

Stop rather than adding a workaround when the extension asks for a write,
direct SQLite access, another MCP, lifecycle worker, arbitrary URL, Shell,
runtime package installation, a second authentication system, or a route
outside its declared prefix. Promote a missing generic capability through the
public-core review process instead of bypassing the kernel.
