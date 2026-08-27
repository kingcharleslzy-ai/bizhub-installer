import { spawnSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = path.resolve(
  process.env.BIZHUB_MACOS_PACKAGED_APP
    || path.join(ROOT, "out", "BizHub Desktop-darwin-arm64", "BizHub Desktop.app"),
);
const runtimeRoot = path.join(appPath, "Contents", "Resources", "bizhub-runtime");
const entitlements = {
  default: path.join(ROOT, "config", "entitlements.macos.synthetic-app.plist"),
  plugin: path.join(ROOT, "config", "entitlements.macos.plugin.plist"),
};

function fail(code) {
  throw new Error(code);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    fail(`desktop_macos_synthetic_sign_command_failed:${path.basename(command)}:${result.status}:${output.trim().slice(0, 4096)}`);
  }
  return output;
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function entriesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (isInside(runtimeRoot, target)) continue;
    if (entry.isDirectory()) {
      output.push({ path: target, type: "directory" });
      output.push(...await entriesUnder(target));
    } else if (entry.isFile()) {
      output.push({ path: target, type: "file" });
    } else if (!entry.isSymbolicLink()) {
      fail(`desktop_macos_synthetic_sign_entry_type_invalid:${target}`);
    }
  }
  return output;
}

function entitlementFor(target) {
  if (target.includes("(Plugin).app")) return entitlements.plugin;
  return entitlements.default;
}

function sign(target) {
  run("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    "--timestamp=none",
    "--entitlements",
    entitlementFor(target),
    "--generate-entitlement-der",
    target,
  ]);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail("desktop_macos_synthetic_sign_host_invalid");
}
if (process.env.BIZHUB_MACOS_SIGNING_MODE !== "synthetic-ci") {
  fail("desktop_macos_synthetic_sign_mode_invalid");
}
if (!(await lstat(appPath)).isDirectory() || !appPath.endsWith(".app")) {
  fail("desktop_macos_synthetic_sign_app_invalid");
}
if (!(await lstat(runtimeRoot)).isDirectory()) {
  fail("desktop_macos_synthetic_sign_runtime_missing");
}

const entries = await entriesUnder(appPath);
const bundleMainExecutable = /\.app\/Contents\/MacOS\/[^/]+$/;
const machOFiles = [];
for (const entry of entries.filter((value) => value.type === "file")) {
  if (!bundleMainExecutable.test(entry.path) && run("/usr/bin/file", ["-b", entry.path]).includes("Mach-O")) {
    machOFiles.push(entry.path);
  }
}
machOFiles.sort((left, right) => (
  right.split(path.sep).length - left.split(path.sep).length
  || left.localeCompare(right)
));
for (const target of machOFiles) sign(target);

const frameworks = entries
  .filter((value) => value.type === "directory" && value.path.endsWith(".framework"))
  .map((value) => value.path)
  .sort((left, right) => (
    right.split(path.sep).length - left.split(path.sep).length
    || left.localeCompare(right)
  ));
for (const target of frameworks) sign(target);

const nestedApps = entries
  .filter((value) => value.type === "directory" && value.path.endsWith(".app"))
  .map((value) => value.path)
  .sort((left, right) => (
    right.split(path.sep).length - left.split(path.sep).length
    || left.localeCompare(right)
  ));
for (const target of nestedApps) sign(target);
sign(appPath);

run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
process.stdout.write(`${JSON.stringify({
  status: "ok",
  schema_version: "bizhub.desktop-macos-synthetic-signing.v1",
  signing_mode: "synthetic-ci",
  signed_macho_file_count: machOFiles.length,
  signed_framework_count: frameworks.length,
  signed_nested_app_count: nestedApps.length,
})}\n`);
