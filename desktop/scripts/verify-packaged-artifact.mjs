import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asar = require("@electron/asar");
const { verifyRuntimePack } = require("../electron/local-runtime.cjs");
const argv = process.argv.slice(2);
const artifactArgument = argv.shift() || "";
let expectedRuntimeTrustArgument = "";
while (argv.length > 0) {
  const option = argv.shift();
  if (option === "--expected-runtime-trust") {
    expectedRuntimeTrustArgument = argv.shift() || "";
  } else {
    assert.fail(`artifact_verifier_option_unknown:${option}`);
  }
}
const artifactRoot = path.resolve(artifactArgument);
assert.ok(artifactArgument, "artifact_root_required");
assert.ok((await stat(artifactRoot)).isDirectory(), "artifact_root_invalid");

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(target));
    else if (entry.isFile() || entry.isSymbolicLink()) output.push(target);
  }
  return output;
}

const files = await filesUnder(artifactRoot);
const relativeFiles = files.map((value) => path.relative(artifactRoot, value).replaceAll("\\", "/"));
const lowerNames = relativeFiles.map((value) => value.toLowerCase());
const prohibitedExtensions = [".db", ".env", ".map", ".sqlite", ".sqlite3"];
for (const name of lowerNames) {
  assert.ok(!prohibitedExtensions.some((value) => name.endsWith(value)), `prohibited_file:${name}`);
  assert.ok(!/(^|\/)\.env(?:\.|$)/.test(name), `environment_file:${name}`);
}

const runtimeManifests = files.filter(
  (value) => path.basename(value) === "runtime-release-manifest.json",
);
assert.equal(runtimeManifests.length, 1, "runtime_release_manifest_count_invalid");
const runtimeRoot = path.dirname(runtimeManifests[0]);
const runtimeTrustFiles = files.filter(
  (value) => path.basename(value) === "generic-runtime-trust.json",
);
assert.equal(runtimeTrustFiles.length, 1, "runtime_trust_count_invalid");
const packagedRuntimeTrustRaw = await readFile(runtimeTrustFiles[0]);
const packagedRuntimeTrust = JSON.parse(packagedRuntimeTrustRaw.toString("utf8"));
const expectedRuntimeTrustPath = expectedRuntimeTrustArgument
  ? path.resolve(expectedRuntimeTrustArgument)
  : path.join(
      ROOT,
      "config",
      packagedRuntimeTrust.platform === "win32"
        ? "generic-runtime-trust.win32-x64.json"
        : "generic-runtime-trust.json",
    );
const expectedRuntimeTrust = JSON.parse(await readFile(expectedRuntimeTrustPath, "utf8"));
assert.deepEqual(
  packagedRuntimeTrust,
  expectedRuntimeTrust,
  "packaged_runtime_trust_mismatch",
);
const verifiedRuntime = await verifyRuntimePack(runtimeRoot, runtimeTrustFiles[0]);

const asarFiles = files.filter((value) => path.basename(value).toLowerCase() === "app.asar");
assert.equal(asarFiles.length, 1, "app_asar_count_invalid");
const asarEntryRecords = asar.listPackage(asarFiles[0]).map((value) => ({
  extractPath: value.replace(/^[/\\]/, ""),
  normalizedPath: value.replaceAll("\\", "/").replace(/^\//, ""),
}));
const asarEntries = asarEntryRecords.map((value) => value.normalizedPath);
const allowedAsarEntry = (value) => (
  value === "dist"
  || value === "dist/renderer"
  || value === "dist/renderer/assets"
  || value === "dist/renderer/index.html"
  || /^dist\/renderer\/assets\/index-[A-Za-z0-9_-]+\.(?:css|js)$/.test(value)
  || value === "electron"
  || [
    "electron/account-directory.cjs",
    "electron/connection-profile.cjs",
    "electron/local-lifecycle.cjs",
    "electron/local-runtime.cjs",
    "electron/main.cjs",
    "electron/network-policy.cjs",
    "electron/preload.cjs",
    "electron/squirrel-startup.cjs",
    "package.json",
  ].includes(value)
);
for (const entry of asarEntries) assert.ok(allowedAsarEntry(entry), `unexpected_asar_entry:${entry}`);

const strongPrivateTerms = [
  "daz" + "heng",
  "123" + "crystal.com",
  "大" + "正",
  "高" + "意",
  "腾" + "讯云",
];
const asarPrivateTerms = [...strongPrivateTerms, "K" + "TP", "L" + "BO"];
const textExtensions = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".mjs", ".py", ".txt", ".xml", ".yml", ".yaml",
]);
const outerTextFiles = files.filter((value) => textExtensions.has(path.extname(value).toLowerCase()));
for (const file of outerTextFiles) {
  const text = await readFile(file, "utf8");
  const lowered = text.toLocaleLowerCase();
  for (const term of strongPrivateTerms) {
    assert.ok(!lowered.includes(term.toLocaleLowerCase()), `private_marker:${term}:${file}`);
  }
  assert.ok(!text.includes("-----BEGIN " + "PRIVATE KEY-----"), `private_key:${file}`);
}
for (const entry of asarEntryRecords.filter(
  (value) => textExtensions.has(path.extname(value.normalizedPath).toLowerCase()),
)) {
  const text = asar.extractFile(asarFiles[0], entry.extractPath).toString("utf8");
  const lowered = text.toLocaleLowerCase();
  for (const term of asarPrivateTerms) {
    assert.ok(
      !lowered.includes(term.toLocaleLowerCase()),
      `private_asar_marker:${term}:${entry.normalizedPath}`,
    );
  }
  assert.ok(
    !text.includes("-----BEGIN " + "PRIVATE KEY-----"),
    `private_asar_key:${entry.normalizedPath}`,
  );
}

const trustStores = files.filter((value) => path.basename(value) === "trusted-connection-keys.json");
assert.equal(trustStores.length, 1, "packaged_trust_store_count_invalid");
const trustStore = JSON.parse(await readFile(trustStores[0], "utf8"));
const expectedTrustStore = JSON.parse(
  await readFile(path.join(ROOT, "config", "trusted-connection-keys.json"), "utf8"),
);
assert.deepEqual(trustStore, expectedTrustStore, "packaged_trust_store_mismatch");
const accountDirectories = files.filter((value) => path.basename(value) === "account-directory.json");
assert.equal(accountDirectories.length, 1, "account_directory_count_invalid");
const accountDirectory = JSON.parse(await readFile(accountDirectories[0], "utf8"));
const expectedAccountDirectory = JSON.parse(
  await readFile(path.join(ROOT, "config", "account-directory.json"), "utf8"),
);
assert.deepEqual(accountDirectory, expectedAccountDirectory, "packaged_account_directory_mismatch");
const packageJson = JSON.parse(asar.extractFile(asarFiles[0], "package.json").toString("utf8"));
assert.equal(packageJson.dependencies, undefined, "runtime_dependencies_present");

for (const sourceName of [
  "account-directory.cjs",
  "connection-profile.cjs",
  "local-lifecycle.cjs",
  "local-runtime.cjs",
  "main.cjs",
  "network-policy.cjs",
  "preload.cjs",
  "squirrel-startup.cjs",
]) {
  const source = await readFile(path.resolve("electron", sourceName));
  const packaged = asar.extractFile(asarFiles[0], `electron/${sourceName}`);
  assert.equal(
    createHash("sha256").update(packaged).digest("hex"),
    createHash("sha256").update(source).digest("hex"),
    `asar_runtime_source_mismatch:${sourceName}`,
  );
}

const pythonFiles = relativeFiles.filter((value) => /\.(?:py|pyc|pyo)$/i.test(value));

process.stdout.write(`${JSON.stringify({
  status: "ok",
  artifact_root: artifactRoot,
  artifact_files: files.length,
  asar_entries: asarEntries.length,
  trusted_connection_keys: trustStore.keys.length,
  python_files: pythonFiles.length,
  sqlite_files: 0,
  source_maps: 0,
  private_markers: 0,
  runtime_profile_id: verifiedRuntime.manifest.profile_id,
  runtime_pack_files: verifiedRuntime.manifest.files.length,
  runtime_pack_tree_digest: verifiedRuntime.manifest.pack_tree_digest,
  runtime_manifest_sha256: createHash("sha256")
    .update(await readFile(runtimeManifests[0]))
    .digest("hex"),
  runtime_trust_sha256: createHash("sha256")
    .update(packagedRuntimeTrustRaw)
    .digest("hex"),
  core_artifact_digest: verifiedRuntime.manifest.core_artifact_digest,
})}\n`);
