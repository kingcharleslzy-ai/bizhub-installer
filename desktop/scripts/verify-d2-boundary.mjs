import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(ROOT, "..");
const SKIP = new Set([".runtime-venv", "dist", "node_modules", "out", "runtime-build", "runtime-dist"]);
const TEXT_EXTENSIONS = new Set([".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".py", ".txt"]);

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(target));
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const files = await filesUnder(ROOT);
const relativeFiles = files.map((value) => path.relative(ROOT, value).replaceAll("\\", "/"));
const pythonFiles = relativeFiles.filter((value) => value.endsWith(".py"));
assert.deepEqual(pythonFiles.sort(), [
  "runtime/bizhub_runtime_entry.py",
  "runtime/bizhub_runtime_entry_windows.py",
  "runtime/build_local_runtime.py",
  "runtime/build_windows_runtime.py",
]);
assert.deepEqual(
  relativeFiles.filter((value) => /\.(?:db|sqlite|sqlite3)$/i.test(value)),
  [],
);

const inspected = files.filter((value) => (
  path.basename(value) !== "package-lock.json"
  && TEXT_EXTENSIONS.has(path.extname(value).toLowerCase())
));
const combined = (await Promise.all(inspected.map((value) => readFile(value, "utf8")))).join("\n");
for (const term of [
  "daz" + "heng",
  "123" + "crystal.com",
  "K" + "TP",
  "L" + "BO",
  "高" + "意",
  "腾" + "讯云",
]) {
  assert.ok(!combined.toLocaleLowerCase().includes(term.toLocaleLowerCase()), term);
}

const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
const preload = await readFile(path.join(ROOT, "electron", "preload.cjs"), "utf8");
const localRuntime = await readFile(path.join(ROOT, "electron", "local-runtime.cjs"), "utf8");
const windowsRuntimeBuilder = await readFile(path.join(ROOT, "runtime", "build_windows_runtime.py"), "utf8");
const runtimeEntry = await readFile(path.join(ROOT, "runtime", "bizhub_runtime_entry_windows.py"), "utf8");
const runtimePreparer = await readFile(path.join(ROOT, "scripts", "prepare-runtime-pack.mjs"), "utf8");
for (const required of [
  "bootstrapLocalInstance",
  "startLocalRuntime",
  "stopLocalRuntime",
  "backupLocalInstance",
  "127.0.0.1",
  "persist:local-generic",
  "localRequestAllowed",
]) {
  assert.ok(`${main}\n${localRuntime}`.includes(required), required);
}
for (const prohibited of ["better" + "-sqlite3", "sql" + ".js", "0.0.0.0"] ) {
  assert.ok(!`${main}\n${preload}\n${localRuntime}`.includes(prohibited), prohibited);
}
assert.ok(!main.includes("node:" + "child_process"));
assert.ok(!preload.includes("node:" + "child_process"));
assert.ok(localRuntime.includes("node:" + "child_process"));
assert.ok(runtimePreparer.includes('path.join(ROOT, "scripts", "expand-runtime-archive.ps1")'));
assert.ok(runtimePreparer.includes('spawn("/usr/bin/ditto"'));
assert.ok(!runtimePreparer.includes("powershell.exe"));
for (const required of ["OpenProcess", "GetExitCodeProcess", "CloseHandle"]) {
  assert.ok(runtimeEntry.includes(required), required);
}
for (const required of [
  'build_environment["SOURCE_DATE_EPOCH"]',
  'build_environment["PYTHONHASHSEED"]',
  "env=build_environment",
  'newline="\\n"',
]) {
  assert.ok(windowsRuntimeBuilder.includes(required), required);
}
for (const api of [
  "lookupAccount",
  "resetAccountLookup",
  "connectEnterpriseWorkspace",
  "disconnectWorkspace",
  "prepareLocal",
  "setupLocal",
  "loginLocal",
  "backupLocal",
  "stopLocal",
  "getState",
  "onStateChange",
]) {
  assert.ok(preload.includes(`${api}:`), api);
}

const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
assert.equal(packageJson.dependencies, undefined);
assert.equal(packageJson.devDependencies.pyinstaller, undefined);
assert.equal(packageJson.devDependencies["@electron-forge/maker-squirrel"], "7.11.2");
assert.equal(packageJson.devDependencies["@electron/windows-sign"], "1.2.2");
assert.equal(packageJson.devDependencies["extract-zip"], "file:vendor/extract-zip-safe");
const safeExtractor = await readFile(
  path.join(ROOT, "vendor", "extract-zip-safe", "index.js"),
  "utf8",
);
for (const required of [
  "extract_zip_entry_path_invalid",
  "extract_zip_symlink_target_escape",
  "extract_zip_total_size_invalid",
  'flags: "wx"',
]) {
  assert.ok(safeExtractor.includes(required), required);
}
const forgeConfig = await readFile(path.join(ROOT, "forge.config.cjs"), "utf8");
for (const required of [
  "windowsSign",
  "hookModulePath",
  "windows-sign-hook.cjs",
]) {
  assert.ok(forgeConfig.includes(required), required);
}
const windowsSignHook = await readFile(path.join(ROOT, "scripts", "windows-sign-hook.cjs"), "utf8");
for (const required of ["preservesFixedRuntime", "runtimeResourceSegment", "@electron/windows-sign"]) {
  assert.ok(windowsSignHook.includes(required), required);
}
const trustStore = JSON.parse(await readFile(path.join(ROOT, "config", "trusted-connection-keys.json"), "utf8"));
assert.equal(trustStore.schema_version, "bizhub.desktop-trust-store.v1");
assert.equal(trustStore.keys.length, 1);
assert.equal(trustStore.keys[0].algorithm, "Ed25519");
assert.equal(trustStore.keys[0].key_id, "bizhub-workspace-2026-08");
assert.match(trustStore.keys[0].public_key_pem, /^-----BEGIN PUBLIC KEY-----/);
assert.ok(!trustStore.keys[0].public_key_pem.includes("PRIVATE KEY"));
const accountDirectory = JSON.parse(
  await readFile(path.join(ROOT, "config", "account-directory.json"), "utf8"),
);
assert.deepEqual(accountDirectory, {
  schema_version: "bizhub.desktop-account-directory.v1",
  resolve_url: "https://bizhub-account-directory.38.49.54.254.nip.io:8443/v1/desktop/workspaces/resolve",
});
const runtimeTrust = JSON.parse(await readFile(path.join(ROOT, "config", "generic-runtime-trust.json"), "utf8"));
const commonManifestBytes = await readFile(path.join(REPO, "app", "vendor", "bizhub-common-manifest.json"));
const commonManifest = JSON.parse(commonManifestBytes.toString("utf8"));
const commonArtifact = await readFile(path.join(REPO, "app", "vendor", "bizhub-common.tar.gz"));
const runtimeArchiveName = "bizhub-runtime-darwin-arm64-0.1.0-d2.zip";
const runtimeArchive = await readFile(path.join(ROOT, "runtime", "vendor", runtimeArchiveName));
const runtimeArchiveChecksum = (
  await readFile(path.join(ROOT, "runtime", "vendor", "bizhub-runtime-darwin-arm64-0.1.0-d2.sha256"), "utf8")
).trim();
assert.equal(sha256(commonArtifact), commonManifest.artifact_sha256);
assert.equal(runtimeArchiveChecksum, `${sha256(runtimeArchive)}  ${runtimeArchiveName}`);
assert.equal(runtimeTrust.profile_id, "generic-kernel-smoke");
assert.equal(runtimeTrust.platform, "darwin");
assert.equal(runtimeTrust.architecture, "arm64");
assert.equal(runtimeTrust.artifact_id, commonManifest.artifact_id);
assert.equal(runtimeTrust.core_artifact_digest, commonManifest.core_artifact_digest);
assert.equal(runtimeTrust.core_source_commit, commonManifest.source_commit);
assert.equal(runtimeTrust.allowlist_tree_digest, commonManifest.allowlist_tree_digest);
assert.match(runtimeTrust.runtime_manifest_sha256, /^[0-9a-f]{64}$/);
assert.match(runtimeTrust.runtime_pack_tree_digest, /^[0-9a-f]{64}$/);
assert.ok(Number.isSafeInteger(runtimeTrust.runtime_pack_file_count));
assert.ok(runtimeTrust.runtime_pack_file_count > 0);

const windowsRuntimeTrust = JSON.parse(
  await readFile(path.join(ROOT, "config", "generic-runtime-trust.win32-x64.json"), "utf8"),
);
const windowsRuntimeArchiveName = "bizhub-runtime-win32-x64-0.1.0-d3.zip";
const windowsRuntimeArchive = await readFile(
  path.join(ROOT, "runtime", "vendor", windowsRuntimeArchiveName),
);
const windowsRuntimeArchiveChecksum = (
  await readFile(
    path.join(ROOT, "runtime", "vendor", "bizhub-runtime-win32-x64-0.1.0-d3.sha256"),
    "utf8",
  )
).trim();
assert.equal(
  windowsRuntimeArchiveChecksum,
  `${sha256(windowsRuntimeArchive)}  ${windowsRuntimeArchiveName}`,
);
assert.equal(windowsRuntimeTrust.profile_id, "generic-kernel-smoke");
assert.equal(windowsRuntimeTrust.platform, "win32");
assert.equal(windowsRuntimeTrust.architecture, "x64");
assert.equal(windowsRuntimeTrust.artifact_id, commonManifest.artifact_id);
assert.equal(windowsRuntimeTrust.core_artifact_digest, commonManifest.core_artifact_digest);
assert.equal(windowsRuntimeTrust.core_source_commit, commonManifest.source_commit);
assert.equal(windowsRuntimeTrust.allowlist_tree_digest, commonManifest.allowlist_tree_digest);
assert.match(windowsRuntimeTrust.runtime_manifest_sha256, /^[0-9a-f]{64}$/);
assert.match(windowsRuntimeTrust.runtime_pack_tree_digest, /^[0-9a-f]{64}$/);
assert.ok(Number.isSafeInteger(windowsRuntimeTrust.runtime_pack_file_count));
assert.ok(windowsRuntimeTrust.runtime_pack_file_count > 0);

process.stdout.write(`${JSON.stringify({
  status: "ok",
  scanned_text_files: inspected.length,
  python_source_files: pythonFiles.length,
  sqlite_files: 0,
  trusted_connection_keys: trustStore.keys.length,
  runtime_profile_id: runtimeTrust.profile_id,
  core_artifact_digest: runtimeTrust.core_artifact_digest,
  runtime_pack_file_count: runtimeTrust.runtime_pack_file_count,
  runtime_archive_sha256: sha256(runtimeArchive),
  windows_runtime_pack_file_count: windowsRuntimeTrust.runtime_pack_file_count,
  windows_runtime_archive_sha256: sha256(windowsRuntimeArchive),
  private_markers: 0,
})}\n`);
