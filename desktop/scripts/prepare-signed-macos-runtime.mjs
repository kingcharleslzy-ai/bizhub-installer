import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { verifyRuntimePackIdentity } = require("../electron/local-runtime.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.resolve(process.env.BIZHUB_MACOS_RUNTIME_ROOT || path.join(
  ROOT,
  "runtime-dist",
  "bizhub-runtime",
));
const baselineTrustPath = path.resolve(
  process.env.BIZHUB_MACOS_BASELINE_RUNTIME_TRUST
    || path.join(ROOT, "config", "generic-runtime-trust.json"),
);
const outputTrustPath = path.resolve(
  process.env.BIZHUB_MACOS_SIGNED_RUNTIME_TRUST
    || path.join(ROOT, "runtime-dist", "generic-runtime-trust.json"),
);
const identityOutputPath = path.resolve(
  process.env.BIZHUB_MACOS_RUNTIME_IDENTITY_OUTPUT
    || path.join(ROOT, "out", "desktop-r1-macos-runtime-identity.json"),
);
const signingMode = process.env.BIZHUB_MACOS_SIGNING_MODE || "";
const signingIdentity = process.env.BIZHUB_MACOS_SIGNING_IDENTITY || "";
const expectedTeamId = process.env.BIZHUB_MACOS_TEAM_ID || "";
const signingKeychain = process.env.BIZHUB_MACOS_KEYCHAIN || "";
const syntheticRuntimeEntitlements = path.join(
  ROOT,
  "config",
  "entitlements.macos.synthetic-runtime.plist",
);

function fail(code) {
  throw new Error(code);
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256Buffer(await readFile(filePath));
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    fail(`desktop_macos_signing_command_failed:${path.basename(command)}:${result.status}:${output.trim().slice(0, 4096)}`);
  }
  return output;
}

async function pathsUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push({ path: target, type: "directory" });
      output.push(...await pathsUnder(target));
    } else if (entry.isFile()) {
      output.push({ path: target, type: "file" });
    } else if (entry.isSymbolicLink()) {
      output.push({ path: target, type: "symlink" });
    } else {
      fail(`desktop_macos_runtime_entry_type_invalid:${target}`);
    }
  }
  return output;
}

function canonicalTreeDigest(records) {
  return sha256Buffer(Buffer.from(`${JSON.stringify(records)}\n`));
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]),
  );
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(sortedObject(value), null, 2)}\n`);
}

function signingArguments(target) {
  const args = [
    "--force",
    "--sign",
    signingIdentity,
    "--options",
    "runtime",
    "--generate-entitlement-der",
  ];
  if (signingMode === "synthetic-ci" && target === baseline.executable) {
    args.push("--entitlements", syntheticRuntimeEntitlements);
  }
  if (signingKeychain) args.push("--keychain", signingKeychain);
  if (signingMode === "production") args.push("--timestamp");
  else args.push("--timestamp=none");
  args.push(target);
  return args;
}

function signatureMetadata(target) {
  const output = run("/usr/bin/codesign", ["-dv", "--verbose=4", target]);
  const rawTeamId = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim() || "";
  const teamId = rawTeamId === "not set" ? "" : rawTeamId;
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim());
  const timestamp = /^Timestamp=(.+)$/m.exec(output)?.[1]?.trim() || "";
  if (signingMode === "production") {
    if (teamId !== expectedTeamId) fail(`desktop_macos_runtime_team_id_mismatch:${target}`);
    if (!authorities.some((value) => value.startsWith("Developer ID Application:"))) {
      fail(`desktop_macos_runtime_developer_id_missing:${target}`);
    }
    if (!timestamp) fail(`desktop_macos_runtime_timestamp_missing:${target}`);
  }
  return { authorities, teamId, timestamp };
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail("desktop_macos_runtime_signing_host_invalid");
}
if (!new Set(["synthetic-ci", "production"]).has(signingMode)) {
  fail("desktop_macos_signing_mode_invalid");
}
if (
  !signingIdentity
  || signingIdentity.length > 256
  || /[\r\n\0]/.test(signingIdentity)
) {
  fail("desktop_macos_signing_identity_invalid");
}
if (signingMode === "production" && !/^[A-Z0-9]{10}$/.test(expectedTeamId)) {
  fail("desktop_macos_team_id_invalid");
}
if (baselineTrustPath === outputTrustPath) {
  fail("desktop_macos_signed_trust_must_not_replace_baseline");
}

const baselineTrustRaw = await readFile(baselineTrustPath);
const baselineTrust = JSON.parse(baselineTrustRaw.toString("utf8"));
const baseline = await verifyRuntimePackIdentity(runtimeRoot, baselineTrustPath);
if (baseline.manifest.platform !== "darwin" || baseline.manifest.architecture !== "arm64") {
  fail("desktop_macos_runtime_target_invalid");
}

const initialPaths = await pathsUnder(runtimeRoot);
const machOFiles = [];
for (const entry of initialPaths.filter((value) => value.type === "file")) {
  const description = run("/usr/bin/file", ["-b", entry.path]);
  if (description.includes("Mach-O")) machOFiles.push(entry.path);
}
if (machOFiles.length < 2 || !machOFiles.includes(baseline.executable)) {
  fail("desktop_macos_runtime_macho_inventory_invalid");
}
machOFiles.sort((left, right) => (
  right.split(path.sep).length - left.split(path.sep).length
  || left.localeCompare(right)
));
for (const filePath of machOFiles) run("/usr/bin/codesign", signingArguments(filePath));

const frameworkDirectories = initialPaths
  .filter((value) => value.type === "directory" && value.path.endsWith(".framework"))
  .map((value) => value.path)
  .sort((left, right) => right.split(path.sep).length - left.split(path.sep).length);
for (const frameworkPath of frameworkDirectories) {
  run("/usr/bin/codesign", signingArguments(frameworkPath));
}

for (const filePath of machOFiles) {
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", filePath]);
  signatureMetadata(filePath);
}
for (const frameworkPath of frameworkDirectories) {
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", frameworkPath]);
  signatureMetadata(frameworkPath);
}

const finalEntries = await pathsUnder(runtimeRoot);
const records = [];
for (const entry of finalEntries) {
  const relative = path.relative(runtimeRoot, entry.path).replaceAll("\\", "/");
  if (relative === "runtime-release-manifest.json" || entry.type === "directory") continue;
  if (entry.type === "symlink") {
    const linkTarget = await readlink(entry.path);
    const encoded = Buffer.from(linkTarget);
    records.push({
      link_target: linkTarget,
      path: relative,
      sha256: sha256Buffer(encoded),
      size: encoded.length,
      type: "symlink",
    });
  } else {
    const metadata = await lstat(entry.path);
    records.push({
      link_target: null,
      path: relative,
      sha256: await sha256File(entry.path),
      size: metadata.size,
      type: "file",
    });
  }
}
records.sort((left, right) => left.path.localeCompare(right.path));
const signedManifest = {
  ...baseline.manifest,
  files: records,
  pack_tree_digest: canonicalTreeDigest(records),
};
const manifestPath = path.join(runtimeRoot, "runtime-release-manifest.json");
const signedManifestRaw = jsonBytes(signedManifest);
await writeFile(manifestPath, signedManifestRaw);
const signedTrust = {
  ...baselineTrust,
  runtime_manifest_sha256: sha256Buffer(signedManifestRaw),
  runtime_pack_file_count: records.length,
  runtime_pack_tree_digest: signedManifest.pack_tree_digest,
};
await writeFile(outputTrustPath, jsonBytes(signedTrust));
const verifiedSigned = await verifyRuntimePackIdentity(runtimeRoot, outputTrustPath);
assert.equal(verifiedSigned.manifest.pack_tree_digest, signedManifest.pack_tree_digest);

const executableSignature = signatureMetadata(verifiedSigned.executable);
const identity = {
  status: "ok",
  schema_version: "bizhub.desktop-macos-runtime-signing.v1",
  signing_mode: signingMode,
  publisher_team_id: executableSignature.teamId || null,
  baseline_manifest_sha256: baselineTrust.runtime_manifest_sha256,
  baseline_pack_tree_digest: baselineTrust.runtime_pack_tree_digest,
  signed_manifest_sha256: signedTrust.runtime_manifest_sha256,
  signed_pack_tree_digest: signedTrust.runtime_pack_tree_digest,
  signed_pack_file_count: signedTrust.runtime_pack_file_count,
  signed_macho_file_count: machOFiles.length,
  signed_framework_count: frameworkDirectories.length,
  synthetic_library_validation_exception: signingMode === "synthetic-ci",
  runtime_source_tree_digest: signedTrust.runtime_source_tree_digest,
  core_artifact_digest: signedTrust.core_artifact_digest,
  signed_runtime_trust_sha256: await sha256File(outputTrustPath),
};
await mkdir(path.dirname(identityOutputPath), { recursive: true });
await writeFile(identityOutputPath, jsonBytes(identity));
process.stdout.write(`${JSON.stringify(identity)}\n`);
