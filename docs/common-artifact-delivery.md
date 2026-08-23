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

The common manifest contains 41 allowlisted text files. Its generated scan
rejects customer names, private module paths, private frontends, source maps,
credentials, and secret references. Public tests also verify that the container
copies the generated artifact and delivery adapter, not the retained legacy
business directory.

The artifact is generated upstream; it must not be hand-edited in this
repository. Any upstream content change requires a new manifest, digest, public
release, Ubuntu lifecycle run, and external review.
