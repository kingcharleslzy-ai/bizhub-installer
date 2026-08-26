import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { verifyRuntimePackIdentity } = require("../electron/local-runtime.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(code) {
  throw new Error(code);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    fail(`desktop_macos_release_command_failed:${path.basename(command)}:${result.status}:${output.trim().slice(0, 4096)}`);
  }
  return output;
}

function parseArguments(values) {
  const result = {};
  const args = [...values];
  while (args.length > 0) {
    const key = args.shift();
    if (!new Set(["--app", "--expected-runtime-trust", "--mode", "--team-id", "--output"]).has(key)) {
      fail(`desktop_macos_release_option_unknown:${key}`);
    }
    const value = args.shift();
    if (!value) fail(`desktop_macos_release_option_value_missing:${key}`);
    result[key.slice(2).replaceAll("-", "_")] = value;
  }
  return result;
}

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(target));
    else if (entry.isFile()) output.push(target);
    else if (!entry.isSymbolicLink()) fail(`desktop_macos_release_entry_type_invalid:${target}`);
  }
  return output;
}

function signatureMetadata(target, mode, expectedTeamId) {
  const output = run("/usr/bin/codesign", ["-dv", "--verbose=4", target]);
  const identifier = /^Identifier=(.+)$/m.exec(output)?.[1]?.trim() || "";
  const rawTeamId = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim() || "";
  const teamId = rawTeamId === "not set" ? "" : rawTeamId;
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim());
  const timestamp = /^Timestamp=(.+)$/m.exec(output)?.[1]?.trim() || "";
  if (mode === "production") {
    if (teamId !== expectedTeamId) fail(`desktop_macos_release_team_id_mismatch:${target}`);
    if (!authorities.some((value) => value.startsWith("Developer ID Application:"))) {
      fail(`desktop_macos_release_developer_id_missing:${target}`);
    }
    if (!timestamp) fail(`desktop_macos_release_timestamp_missing:${target}`);
  }
  return { authorities, identifier, teamId, timestamp };
}

const options = parseArguments(process.argv.slice(2));
const appPath = path.resolve(options.app || "");
const expectedRuntimeTrustPath = path.resolve(options.expected_runtime_trust || "");
const mode = options.mode || "";
const expectedTeamId = options.team_id || "";
const outputPath = path.resolve(
  options.output || path.join(ROOT, "out", "desktop-r1-macos-release-identity.json"),
);
if (!options.app || !options.expected_runtime_trust) fail("desktop_macos_release_argument_missing");
if (!new Set(["synthetic-ci", "production"]).has(mode)) fail("desktop_macos_release_mode_invalid");
if (mode === "production" && !/^[A-Z0-9]{10}$/.test(expectedTeamId)) {
  fail("desktop_macos_release_team_id_invalid");
}
if (!(await lstat(appPath)).isDirectory() || !appPath.endsWith(".app")) {
  fail("desktop_macos_release_app_invalid");
}

run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
const appSignature = signatureMetadata(appPath, mode, expectedTeamId);
if (appSignature.identifier !== "com.bizhub.desktop") {
  fail("desktop_macos_release_bundle_identifier_invalid");
}
const resources = path.join(appPath, "Contents", "Resources");
const runtimeRoot = path.join(resources, "bizhub-runtime");
const packagedRuntimeTrustPath = path.join(resources, "generic-runtime-trust.json");
const expectedRuntimeTrustRaw = await readFile(expectedRuntimeTrustPath);
const packagedRuntimeTrustRaw = await readFile(packagedRuntimeTrustPath);
assert.equal(
  createHash("sha256").update(packagedRuntimeTrustRaw).digest("hex"),
  createHash("sha256").update(expectedRuntimeTrustRaw).digest("hex"),
  "desktop_macos_release_runtime_trust_mismatch",
);
const verifiedRuntime = await verifyRuntimePackIdentity(runtimeRoot, packagedRuntimeTrustPath);

const machOFiles = [];
for (const filePath of await filesUnder(runtimeRoot)) {
  if (run("/usr/bin/file", ["-b", filePath]).includes("Mach-O")) machOFiles.push(filePath);
}
if (machOFiles.length < 2 || !machOFiles.includes(verifiedRuntime.executable)) {
  fail("desktop_macos_release_macho_inventory_invalid");
}
for (const filePath of machOFiles) {
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", filePath]);
  signatureMetadata(filePath, mode, expectedTeamId);
}
if (mode === "production") {
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  run("/usr/bin/xcrun", ["stapler", "validate", appPath]);
}

const identity = {
  status: "ok",
  schema_version: "bizhub.desktop-macos-release-identity.v1",
  signing_mode: mode,
  bundle_identifier: appSignature.identifier,
  publisher_team_id: appSignature.teamId || null,
  runtime_macho_file_count: machOFiles.length,
  runtime_manifest_sha256: createHash("sha256")
    .update(await readFile(path.join(runtimeRoot, "runtime-release-manifest.json")))
    .digest("hex"),
  runtime_pack_tree_digest: verifiedRuntime.manifest.pack_tree_digest,
  runtime_trust_sha256: createHash("sha256").update(packagedRuntimeTrustRaw).digest("hex"),
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(identity, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(identity)}\n`);
