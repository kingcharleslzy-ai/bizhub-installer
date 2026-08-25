# Fixed Desktop Generic Runtime inputs

`bizhub-runtime-darwin-arm64-0.1.0-d2.zip` is the fixed, unsigned macOS arm64
Generic Runtime Pack used to create the Desktop-D2 external-review Artifact.

`bizhub-runtime-win32-x64-0.1.0-d3.zip` is the fixed, unsigned Windows x64
Generic Runtime Pack used to create the Desktop-D3 external-review Artifact.

Each archive contains the PyInstaller onedir already bound by its platform
record under `desktop/config/generic-runtime-trust*.json`; neither contains a
customer-private Profile or business data.

The archives are review inputs, not Releases. `prepare-runtime-pack.mjs`
verifies the selected platform sidecar SHA-256, extracts it into the ignored
`runtime-dist/` directory, and then verifies the independent Runtime Manifest
and every Pack file before Forge can package it. Windows signing explicitly
preserves this subtree so installation cannot invalidate the fixed Pack
identity.
