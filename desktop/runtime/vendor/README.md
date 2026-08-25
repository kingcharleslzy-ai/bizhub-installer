# Fixed Desktop-D2 Generic Runtime input

`bizhub-runtime-darwin-arm64-0.1.0-d2.zip` is the fixed, unsigned macOS arm64
Generic Runtime Pack used to create the Desktop-D2 external-review Artifact.
It contains the PyInstaller onedir already bound by
`desktop/config/generic-runtime-trust.json`; it contains no customer-private
Profile or business data.

The archive is a review input, not a Release. `prepare-runtime-pack.mjs`
verifies its sidecar SHA-256, extracts it into the ignored `runtime-dist/`
directory, and then verifies the independent Runtime Manifest and every Pack
file before Forge can package it.
