import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const artifactRoot = path.resolve(process.argv[2] || "");
assert.ok(process.argv[2], "artifact_root_required");
assert.ok((await stat(artifactRoot)).isDirectory(), "artifact_root_invalid");

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(target));
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

const files = await filesUnder(artifactRoot);
const relativeFiles = files.map((value) => path.relative(artifactRoot, value).replaceAll("\\", "/"));
const lowerNames = relativeFiles.map((value) => value.toLowerCase());
const prohibitedExtensions = [".db", ".env", ".map", ".py", ".pyc", ".pyo", ".sqlite", ".sqlite3"];
const prohibitedRuntimeNames = [
  /(^|\/)libpython[^/]*$/,
  /(^|\/)python(?:3(?:\.\d+)?)?(?:\.exe)?$/,
  /(^|\/)sqlite3?(?:\.exe|\.dll|\.dylib|\.so)?$/,
];
for (const name of lowerNames) {
  assert.ok(!prohibitedExtensions.some((value) => name.endsWith(value)), `prohibited_file:${name}`);
  assert.ok(!prohibitedRuntimeNames.some((value) => value.test(name)), `prohibited_runtime:${name}`);
  assert.ok(!/(^|\/)\.env(?:\.|$)/.test(name), `environment_file:${name}`);
}

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
    "electron/connection-profile.cjs",
    "electron/main.cjs",
    "electron/network-policy.cjs",
    "electron/preload.cjs",
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
const textExtensions = new Set([".css", ".html", ".js", ".json", ".txt", ".xml", ".yml", ".yaml"]);
const outerTextFiles = files.filter((value) => textExtensions.has(path.extname(value).toLowerCase()));
for (const file of outerTextFiles) {
  const text = await readFile(file, "utf8");
  const lowered = text.toLocaleLowerCase();
  for (const term of strongPrivateTerms) {
    assert.ok(!lowered.includes(term.toLocaleLowerCase()), `private_marker:${term}:${file}`);
  }
  assert.ok(!text.includes("-----BEGIN PRIVATE KEY-----"), `private_key:${file}`);
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
    !text.includes("-----BEGIN PRIVATE KEY-----"),
    `private_asar_key:${entry.normalizedPath}`,
  );
}

const trustStores = files.filter((value) => path.basename(value) === "trusted-connection-keys.json");
assert.equal(trustStores.length, 1, "packaged_trust_store_count_invalid");
const trustStore = JSON.parse(await readFile(trustStores[0], "utf8"));
assert.deepEqual(trustStore, {
  schema_version: "bizhub.desktop-trust-store.v1",
  keys: [],
});
const packageJson = JSON.parse(asar.extractFile(asarFiles[0], "package.json").toString("utf8"));
assert.equal(packageJson.dependencies, undefined, "runtime_dependencies_present");

process.stdout.write(`${JSON.stringify({
  status: "ok",
  artifact_root: artifactRoot,
  artifact_files: files.length,
  asar_entries: asarEntries.length,
  trusted_connection_keys: trustStore.keys.length,
  python_files: 0,
  sqlite_files: 0,
  source_maps: 0,
  private_markers: 0,
})}\n`);
