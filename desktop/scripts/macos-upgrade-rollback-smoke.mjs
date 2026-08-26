import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(code) {
  throw new Error(code);
}

function parseArguments(values) {
  const result = {};
  const allowed = new Set(["--old-app", "--new-app", "--old-version", "--new-version", "--output"]);
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--")) {
      fail(`desktop_macos_upgrade_argument_invalid:${key || "missing"}`);
    }
    result[key.slice(2).replaceAll("-", "_")] = value;
  }
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  if (result.status !== 0) {
    fail(`desktop_macos_upgrade_command_failed:${path.basename(command)}:${result.status}:${`${result.stderr || ""}${result.stdout || ""}`.trim().slice(0, 4096)}`);
  }
  return result.stdout.trim();
}

function readBundleVersion(appPath) {
  return run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    path.join(appPath, "Contents", "Info.plist"),
  ]);
}

function readback(stage, appPath, userDataRoot, applicationVersion) {
  const output = run(process.execPath, [
    path.join(ROOT, "scripts", "versioned-owner-readback.mjs"),
    "--mode", stage,
    "--resources", path.join(appPath, "Contents", "Resources"),
    "--user-data-root", userDataRoot,
    "--application-version", applicationVersion,
  ], {
    env: { ...process.env, BIZHUB_DESKTOP_RELEASE_UPGRADE_SMOKE: "1" },
  });
  return JSON.parse(output.split(/\r?\n/).filter(Boolean).at(-1));
}

const options = parseArguments(process.argv.slice(2));
if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail("desktop_macos_upgrade_host_invalid");
}
for (const key of ["old_app", "new_app", "old_version", "new_version", "output"]) {
  if (!options[key]) fail(`desktop_macos_upgrade_argument_missing:${key}`);
}
const oldApp = path.resolve(options.old_app);
const newApp = path.resolve(options.new_app);
const outputPath = path.resolve(options.output);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-desktop-upgrade-rollback-"));
const installedApp = path.join(temporaryRoot, "Applications", "BizHub Desktop.app");
const userDataRoot = path.join(temporaryRoot, "user-data");

async function replaceApp(source) {
  await rm(installedApp, { recursive: true, force: true });
  await mkdir(path.dirname(installedApp), { recursive: true });
  run("/usr/bin/ditto", [source, installedApp]);
}

try {
  await replaceApp(oldApp);
  assert.equal(readBundleVersion(installedApp), options.old_version);
  const initial = readback("create", installedApp, userDataRoot, options.old_version);

  await replaceApp(newApp);
  assert.equal(readBundleVersion(installedApp), options.new_version);
  const upgraded = readback("readback", installedApp, userDataRoot, options.new_version);

  await replaceApp(oldApp);
  assert.equal(readBundleVersion(installedApp), options.old_version);
  const rolledBack = readback("readback", installedApp, userDataRoot, options.old_version);

  assert.equal(upgraded.data_identity, initial.data_identity);
  assert.equal(rolledBack.data_identity, initial.data_identity);
  assert.equal(upgraded.writer_instance_id, initial.writer_instance_id);
  assert.equal(rolledBack.writer_instance_id, initial.writer_instance_id);
  const identity = {
    status: "ok",
    schema_version: "bizhub.desktop-upgrade-rollback.v1",
    platform: "darwin",
    architecture: "arm64",
    old_version: options.old_version,
    new_version: options.new_version,
    upgrade_readback: true,
    rollback_readback: true,
    data_identity_preserved: true,
    writer_instance_id_preserved: true,
    location_id: "upgrade-location",
    location_canonical_name: "Synthetic Upgrade Location",
    residual_runtime_processes: 0,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(identity, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(identity)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
