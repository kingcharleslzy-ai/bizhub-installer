import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const { sign } = require("@electron/windows-sign");
const { verifyRuntimePackIdentity } = require("../electron/local-runtime.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.resolve(process.env.BIZHUB_WINDOWS_RUNTIME_ROOT || path.join(
  ROOT,
  "runtime-dist",
  "bizhub-runtime",
));
const baselineTrustPath = path.resolve(
  process.env.BIZHUB_WINDOWS_BASELINE_RUNTIME_TRUST
    || path.join(ROOT, "config", "generic-runtime-trust.json"),
);
const outputTrustPath = path.resolve(
  process.env.BIZHUB_WINDOWS_SIGNED_RUNTIME_TRUST
    || path.join(ROOT, "runtime-dist", "generic-runtime-trust.json"),
);
const identityOutputPath = path.resolve(
  process.env.BIZHUB_WINDOWS_RUNTIME_PREP_OUTPUT
    || path.join(ROOT, "out", "desktop-r1-windows-runtime-preparation.json"),
);
const signingMode = process.env.BIZHUB_WINDOWS_SIGNING_MODE || "";
const certificateFile = process.env.BIZHUB_WINDOWS_CERTIFICATE_FILE || "";
const certificatePassword = process.env.BIZHUB_WINDOWS_CERTIFICATE_PASSWORD || "";

function fail(code) {
  throw new Error(code);
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256Buffer(await readFile(filePath));
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]));
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(sortedObject(value), null, 2)}\n`);
}

function certificateTable(buffer, filePath) {
  if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    fail(`desktop_windows_runtime_pe_header_invalid:${filePath}`);
  }
  const optionalHeader = peOffset + 24;
  const magic = buffer.readUInt16LE(optionalHeader);
  const dataDirectory = optionalHeader + (magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1);
  if (dataDirectory < optionalHeader || dataDirectory + 40 > buffer.length) {
    fail(`desktop_windows_runtime_optional_header_invalid:${filePath}`);
  }
  return {
    offset: buffer.readUInt32LE(dataDirectory + 32),
    size: buffer.readUInt32LE(dataDirectory + 36),
  };
}

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(target));
    else if (entry.isFile()) output.push(target);
    else if (!entry.isSymbolicLink()) fail(`desktop_windows_runtime_entry_type_invalid:${target}`);
  }
  return output;
}

function canonicalTreeDigest(records) {
  return sha256Buffer(Buffer.from(`${JSON.stringify(records)}\n`));
}

if (process.platform !== "win32" || process.arch !== "x64") {
  fail("desktop_windows_runtime_signing_host_invalid");
}
if (!new Set(["synthetic-ci", "production"]).has(signingMode)) {
  fail("desktop_windows_runtime_signing_mode_invalid");
}
if (!certificateFile || !certificatePassword) {
  fail("desktop_windows_runtime_signing_credentials_missing");
}
if (baselineTrustPath === outputTrustPath) {
  fail("desktop_windows_signed_trust_must_not_replace_baseline");
}

const baselineTrust = JSON.parse(await readFile(baselineTrustPath, "utf8"));
const baseline = await verifyRuntimePackIdentity(runtimeRoot, baselineTrustPath);
if (baseline.manifest.platform !== "win32" || baseline.manifest.architecture !== "x64") {
  fail("desktop_windows_runtime_target_invalid");
}

const peFiles = [];
const unsignedPeFiles = [];
for (const filePath of await filesUnder(runtimeRoot)) {
  const certificate = certificateTable(await readFile(filePath), filePath);
  if (!certificate) continue;
  peFiles.push(filePath);
  if (certificate.offset === 0 || certificate.size === 0) unsignedPeFiles.push(filePath);
}
if (peFiles.length === 0 || !peFiles.includes(baseline.executable)) {
  fail("desktop_windows_runtime_pe_inventory_invalid");
}
if (!unsignedPeFiles.includes(baseline.executable)) {
  fail("desktop_windows_runtime_main_not_unsigned_at_baseline");
}
await sign({
  files: unsignedPeFiles,
  certificateFile,
  certificatePassword,
  hashes: ["sha256"],
});
for (const filePath of peFiles) {
  const certificate = certificateTable(await readFile(filePath), filePath);
  if (!certificate || certificate.offset === 0 || certificate.size === 0) {
    fail(`desktop_windows_runtime_pe_not_signed:${filePath}`);
  }
}

const records = [];
for (const filePath of await filesUnder(runtimeRoot)) {
  const relative = path.relative(runtimeRoot, filePath).replaceAll("\\", "/");
  if (relative === "runtime-release-manifest.json") continue;
  const metadata = await lstat(filePath);
  records.push({
    link_target: null,
    path: relative,
    sha256: await sha256File(filePath),
    size: metadata.size,
    type: "file",
  });
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

const identity = {
  status: "prepared",
  schema_version: "bizhub.desktop-windows-runtime-preparation.v1",
  signing_mode: signingMode,
  baseline_manifest_sha256: baselineTrust.runtime_manifest_sha256,
  baseline_pack_tree_digest: baselineTrust.runtime_pack_tree_digest,
  signed_manifest_sha256: signedTrust.runtime_manifest_sha256,
  signed_pack_tree_digest: signedTrust.runtime_pack_tree_digest,
  signed_pack_file_count: signedTrust.runtime_pack_file_count,
  pe_file_count: peFiles.length,
  publisher_signed_file_count: unsignedPeFiles.length,
  publisher_signed_files: unsignedPeFiles
    .map((filePath) => path.relative(runtimeRoot, filePath).replaceAll("\\", "/"))
    .sort(),
  main_executable: path.relative(runtimeRoot, baseline.executable).replaceAll("\\", "/"),
  runtime_source_tree_digest: signedTrust.runtime_source_tree_digest,
  core_artifact_digest: signedTrust.core_artifact_digest,
  signed_runtime_trust_sha256: await sha256File(outputTrustPath),
};
await mkdir(path.dirname(identityOutputPath), { recursive: true });
await writeFile(identityOutputPath, jsonBytes(identity));
process.stdout.write(`${JSON.stringify(identity)}\n`);
