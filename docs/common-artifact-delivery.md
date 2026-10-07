# Common artifact delivery

## Fixed identity

The preview image does not maintain another copy of the Generic business core.
It vendors one generated `app/vendor/bizhub-common.tar.gz` and its manifest from
the canonical dual-Profile source. The tar SHA-256 is the
`core_artifact_digest`.

The Docker build verifies that digest before extraction. `bizhubctl plan` binds
the same artifact id, source commit, allowlist tree digest, and artifact digest
into the immutable plan hash. The running health, profile, system-map, and
`/api/core-identity` readbacks expose the same identity.

## Generic and private reference images

The public image directly consumes the fixed artifact. The reviewed private reference
validation image uses the public image as its base and adds a deterministic
private layer whose paths have zero overlap with the common allowlist. Validation
requires every public filesystem layer to be the exact prefix of the private
image and both runtime identity commands to return the same artifact digest.

This is a build and identity proof, not a private production deployment. The
The private Runtime keeps its existing APIs and writers until a separately
approved staging-adoption checkpoint validates projection parity and the writer
transition.

## Public boundary

The current common manifest contains 45 allowlisted text files. Its generated scan
rejects customer names, private module paths, private frontends, source maps,
credentials, and secret references. Public tests also verify that the container
copies the generated artifact and delivery adapter and that the retired legacy
business directory remains absent.

The artifact is generated upstream; it must not be hand-edited in this
repository. Any upstream content change requires a new manifest, digest, public
release, Ubuntu lifecycle run, and external review.

## Repository change boundaries

The private canonical source repository owns both the common core source and
customer packages. This public repository owns the delivery adapter, generic
client, desktop shell, installer, and the generated common artifact. Common
business behavior has one source authority; fixes must not be implemented a
second time in the public adapter or by editing the tar archive.

| Change | Source and delivery |
| --- | --- |
| Customer rules, private pages, or private integrations | Change and release the customer package upstream; no public artifact update unless common inputs change. |
| Common core or generic business behavior | Review and merge upstream, then export the allowlisted artifact here with its manifest and digest; update the public dependency locks and packaging only if required. |
| Generic client, desktop shell, installer, or delivery adapter | Change here; an upstream change is needed only when the common contract must change. |

An upstream merge proves neither public delivery nor customer usability. A
public update must verify the generated boundary and actual public entrypoints.
Clients already distributed retain their previous core until an immutable
release updates them. A source candidate is not a published installer.

## Generic sales agent sources (2026-10-07 candidate)

The current candidate artifact extends the allowlist to 45 files. It adds the
four generic sales-agent source endpoints (`POST /api/sales/agent/sources`,
list, per-source GET, and digest-bound apply) plus the official
`openai-agents` SDK adapter inside the vendored common code. The public
requirements now pin `openai==2.44.0`, `openai-agents==0.17.7`, and the
SDK-required `pydantic==2.13.3`; the desktop freeze builds copy the
`openai-agents` package metadata because the SDK resolves its version through
`importlib.metadata`, and collect the `agents` package data used by its
import-time prompt loaders.

Supported boundary: without model configuration the receive endpoint returns
503 (`sales_agent_ai_unavailable`) while the verbatim source text, business
time, and unknown nested `extra` payload stay stored and retrievable by
`source_id`, and re-sending the same `source_ref` with the same content maps
to the same `source_id`. Model configuration is supplied only by the external
environment: the standard SDK credential `OPENAI_API_KEY` plus
`BIZHUB_GENERIC_AI_BASE_URL` and `BIZHUB_GENERIC_AI_MODEL`. No credentials are
stored in this repository. Manual catalog, procurement, and sales writes are
unchanged.

The two platform vendor Runtime archives and their trust records are generated
from this candidate through each native builder's `--capture-review-input`.
They are unsigned review inputs, not signed public installers. Previously
published installers are not updated by merging this candidate.
