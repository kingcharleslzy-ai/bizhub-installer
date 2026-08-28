# Desktop-U1 internal update contract

Desktop-U1 is a customer-neutral Desktop Shell mechanism. It does not own a
business capability, database, migration, Profile, Owner, writer, customer
mapping, or cloud authentication rule.

## Product flow

The packaged app checks the public repository's versioned `desktop-v*` GitHub
Releases after startup. Development and synthetic smoke processes never contact
the update service. A user can also check from the native application menu or
the combined login screen. That login flow owns exactly one visible client-update
status area; it does not duplicate the compatible frontend hot-refresh state.
The native menu remains available while either a cloud or Generic workspace is
open.

```text
versioned GitHub Release
-> bounded desktop-update.json
-> platform/architecture match
-> background download
-> exact byte count + SHA-256
-> user chooses restart
-> Generic Local verified backup (when present)
-> stop local Runtime
-> native installation handoff
-> relaunch
```

The release list is limited to non-draft tags beginning with `desktop-v`. The
manifest and downloads must use HTTPS and one of the public hosts in
`desktop/config/update-channel.json`. The release list, manifest, artifact size,
filename, version, bundle identity, byte count, and SHA-256 all fail closed.

macOS expands the verified ZIP into private application data, verifies
`com.bizhub.desktop` and the expected bundle version, then atomically keeps the
old app bundle as a rollback point while starting the new bundle. The new app
removes that rollback point only after its main window loads. Windows starts the
existing Squirrel Setup after the local Runtime has stopped.

The currently installed `0.1.0` app predates this updater, so moving to `0.1.1`
requires one final external installation. Every later package built with this
contract can update from inside BizHub Desktop.

Compatible frontend resources use the shared web lifecycle and may activate and
refresh silently without a Desktop binary update. This does not authorize hot
replacement of Electron, the Generic Local Python Runtime, Profile, migration,
Owner, writer, or local data; those remain versioned Desktop or server releases.

Closing the Desktop window is not logout or process exit. On macOS and Windows
it hides the existing window while retaining the connected cloud or Generic
Local Workspace. Dock activation, the Windows tray, or another launch request
restores that same Session. Only an explicit application quit stops the process
and Generic Local Runtime.

## Internal release

`Desktop Internal Update` is a manual GitHub workflow. The project Owner starts
it explicitly; it runs native tests, builds macOS arm64 and Windows x64, creates
`desktop-update.json`, and publishes one prerelease whose immutable tag begins
with `desktop-v`. The advanced R1 production signing workflows remain frozen
and are not called by U1.

Internal macOS and Windows artifacts are not broad-public publisher authority.
Formal Apple notarization and stable Windows Authenticode can be added later
without changing the product flow.
