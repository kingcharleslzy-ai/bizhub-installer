const { execFile, spawn } = require("node:child_process");
const { constants } = require("node:fs");
const { access, mkdir, readFile, realpath, rm, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const MAX_PENDING_BYTES = 64 * 1024;

function rollbackFileSystem() {
  if (!process.versions.electron) return { rm };
  const originalFileSystem = require("original-fs");
  if (typeof originalFileSystem.promises?.rm !== "function") {
    throw new Error("desktop_update_original_fs_unavailable");
  }
  return originalFileSystem.promises;
}

function currentMacBundlePath(executablePath) {
  const executable = path.resolve(executablePath);
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const markerIndex = executable.indexOf(marker);
  if (markerIndex < 1) throw new Error("desktop_update_macos_bundle_path_invalid");
  const bundle = executable.slice(0, markerIndex);
  if (!bundle.endsWith(".app")) throw new Error("desktop_update_macos_bundle_path_invalid");
  return bundle;
}

function pendingMacUpdatePath(updateRoot) {
  return path.join(updateRoot, "pending-macos-update.json");
}

async function prepareMacUpdate({ artifactPath, version, updateRoot }) {
  const stagingRoot = path.join(updateRoot, "staged", version);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const { stdout: archiveList } = await execFileAsync("/usr/bin/unzip", ["-Z1", artifactPath], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const entries = archiveList.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > 50_000) {
    throw new Error("desktop_update_macos_archive_entries_invalid");
  }
  for (const entry of entries) {
    const parts = entry.split("/").filter(Boolean);
    if (
      entry.startsWith("/")
      || entry.includes("\\")
      || parts.includes("..")
      || (!entry.startsWith("BizHub Desktop.app/") && !entry.startsWith("__MACOSX/"))
    ) throw new Error("desktop_update_macos_archive_path_invalid");
  }
  await execFileAsync("/usr/bin/ditto", ["-x", "-k", artifactPath, stagingRoot]);
  const stagedBundle = path.join(stagingRoot, "BizHub Desktop.app");
  const resolvedRoot = await realpath(stagingRoot);
  const resolvedBundle = await realpath(stagedBundle);
  if (!resolvedBundle.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("desktop_update_macos_staging_path_invalid");
  }
  const infoPlist = path.join(resolvedBundle, "Contents", "Info.plist");
  const [{ stdout: bundleId }, { stdout: bundleVersion }] = await Promise.all([
    execFileAsync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", infoPlist]),
    execFileAsync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", infoPlist]),
  ]);
  if (bundleId.trim() !== "com.bizhub.desktop" || bundleVersion.trim() !== version) {
    throw new Error("desktop_update_macos_bundle_identity_invalid");
  }
  return resolvedBundle;
}

async function launchMacUpdate({ executablePath, processId, stagedBundle, updateRoot, version }) {
  const destination = currentMacBundlePath(executablePath);
  const backup = `${destination}.bizhub-backup-${version}`;
  const helper = path.join(updateRoot, "install-macos-update.sh");
  await access(path.dirname(destination), constants.W_OK);
  await access(destination, constants.W_OK);
  try {
    await access(backup);
    throw new Error("desktop_update_macos_backup_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const helperSource = `#!/bin/sh
set -eu
old_pid="$1"
staged_bundle="$2"
destination="$3"
backup="$4"
attempt=0
while /bin/kill -0 "$old_pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 240 ]; then exit 2; fi
  /bin/sleep 0.25
done
if [ -e "$backup" ]; then exit 3; fi
/bin/mv "$destination" "$backup"
if /bin/mv "$staged_bundle" "$destination"; then
  /usr/bin/open "$destination"
  exit 0
fi
/bin/mv "$backup" "$destination"
/usr/bin/open "$destination"
exit 4
`;
  await mkdir(updateRoot, { recursive: true, mode: 0o700 });
  await rm(helper, { force: true });
  await writeFile(helper, helperSource, { encoding: "utf8", mode: 0o700 });
  await writeFile(pendingMacUpdatePath(updateRoot), `${JSON.stringify({
    schema_version: "bizhub.desktop-pending-update.v1",
    expected_version: version,
    destination,
    backup,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const child = spawn("/bin/sh", [helper, String(processId), stagedBundle, destination, backup], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function readPendingUpdate(filePath) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_PENDING_BYTES) {
    throw new Error("desktop_update_pending_file_invalid");
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function finalizePendingMacUpdate({ executablePath, currentVersion, updateRoot }) {
  const pendingPath = pendingMacUpdatePath(updateRoot);
  let pending;
  try {
    pending = await readPendingUpdate(pendingPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "none" };
    return { status: "retained" };
  }
  const destination = currentMacBundlePath(executablePath);
  const expectedBackup = `${destination}.bizhub-backup-${currentVersion}`;
  if (
    pending?.schema_version !== "bizhub.desktop-pending-update.v1"
    || pending.expected_version !== currentVersion
    || pending.destination !== destination
    || pending.backup !== expectedBackup
  ) return { status: "retained" };
  // Electron's patched fs treats a real app.asar as a virtual directory. A
  // recursive remove can therefore leave the archive and its parent bundle
  // behind with ENOTEMPTY. original-fs removes the rollback bundle as ordinary
  // files after the exact destination/version checks above have succeeded.
  await rollbackFileSystem().rm(pending.backup, { recursive: true, force: true });
  await rm(pendingPath, { force: true });
  return { status: "finalized" };
}

function launchWindowsUpdate(artifactPath) {
  const child = spawn(artifactPath, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
}

module.exports = {
  currentMacBundlePath,
  finalizePendingMacUpdate,
  launchMacUpdate,
  launchWindowsUpdate,
  pendingMacUpdatePath,
  prepareMacUpdate,
};
