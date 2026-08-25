import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["dist", "node_modules", "out"]);

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

const files = await filesUnder(ROOT);
const relativeFiles = files.map((value) => path.relative(ROOT, value));
for (const relative of relativeFiles) {
  assert.ok(!/\.(?:db|sqlite|sqlite3|py)$/i.test(relative), relative);
}

const inspected = files.filter((value) => !value.endsWith("package-lock.json"));
const texts = await Promise.all(inspected.map((value) => readFile(value, "utf8")));
const combined = texts.join("\n");
const forbiddenCustomerTerms = [
  "daz" + "heng",
  "123" + "crystal.com",
  "K" + "TP",
  "L" + "BO",
  "高" + "意",
  "腾" + "讯云",
];
for (const term of forbiddenCustomerTerms) {
  assert.ok(!combined.toLocaleLowerCase().includes(term.toLocaleLowerCase()), term);
}

const runtimePaths = [
  "config/trusted-connection-keys.json",
  "electron/connection-profile.cjs",
  "electron/main.cjs",
  "electron/network-policy.cjs",
  "electron/preload.cjs",
  "forge.config.cjs",
  "package.json",
  "shell-frontend/index.html",
  "shell-frontend/src/App.vue",
  "shell-frontend/src/main.js",
  "shell-frontend/src/style.css",
  "vite.config.mjs",
];
const runtimeText = (await Promise.all(
  runtimePaths.map((value) => readFile(path.join(ROOT, value), "utf8")),
)).join("\n");
for (const prohibited of [
  "node:" + "child_process",
  "better" + "-sqlite3",
  "sqlite" + "3",
  "sql" + ".js",
]) {
  assert.ok(!runtimeText.includes(prohibited), prohibited);
}

const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
assert.equal(packageJson.dependencies, undefined);
const trustStore = JSON.parse(
  await readFile(path.join(ROOT, "config", "trusted-connection-keys.json"), "utf8"),
);
assert.deepEqual(trustStore, {
  schema_version: "bizhub.desktop-trust-store.v1",
  keys: [],
});

process.stdout.write(`${JSON.stringify({
  status: "ok",
  scanned_files: inspected.length,
  python_files: 0,
  sqlite_files: 0,
  trusted_connection_keys: 0,
})}\n`);
