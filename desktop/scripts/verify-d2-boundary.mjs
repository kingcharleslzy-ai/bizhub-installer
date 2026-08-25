import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(ROOT, "..");
const SKIP = new Set([".runtime-venv", "dist", "node_modules", "out", "runtime-build", "runtime-dist"]);
const TEXT_EXTENSIONS = new Set([".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".py", ".txt"]);

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
  "runtime/build_local_runtime.py",
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
for (const api of [
  "chooseConnectionProfile",
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
const trustStore = JSON.parse(await readFile(path.join(ROOT, "config", "trusted-connection-keys.json"), "utf8"));
assert.deepEqual(trustStore, {
  schema_version: "bizhub.desktop-trust-store.v1",
  keys: [],
});
const runtimeTrust = JSON.parse(await readFile(path.join(ROOT, "config", "generic-runtime-trust.json"), "utf8"));
const commonManifestBytes = await readFile(path.join(REPO, "app", "vendor", "bizhub-common-manifest.json"));
const commonManifest = JSON.parse(commonManifestBytes.toString("utf8"));
const commonArtifact = await readFile(path.join(REPO, "app", "vendor", "bizhub-common.tar.gz"));
assert.equal(sha256(commonArtifact), commonManifest.artifact_sha256);
assert.equal(runtimeTrust.profile_id, "generic-kernel-smoke");
assert.equal(runtimeTrust.platform, "darwin");
assert.equal(runtimeTrust.architecture, "arm64");
assert.equal(runtimeTrust.artifact_id, commonManifest.artifact_id);
assert.equal(runtimeTrust.core_artifact_digest, commonManifest.core_artifact_digest);
assert.equal(runtimeTrust.core_source_commit, commonManifest.source_commit);
assert.equal(runtimeTrust.allowlist_tree_digest, commonManifest.allowlist_tree_digest);

process.stdout.write(`${JSON.stringify({
  status: "ok",
  scanned_text_files: inspected.length,
  python_source_files: pythonFiles.length,
  sqlite_files: 0,
  trusted_connection_keys: 0,
  runtime_profile_id: runtimeTrust.profile_id,
  core_artifact_digest: runtimeTrust.core_artifact_digest,
  private_markers: 0,
})}\n`);
