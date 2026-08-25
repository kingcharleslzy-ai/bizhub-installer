import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import extract from "extract-zip";
import { runtimeTarget } from "./runtime-target.mjs";

const require = createRequire(import.meta.url);
const { verifyRuntimePackIdentity } = require("../electron/local-runtime.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(ROOT, "..");

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(process.argv[index + 1], `${name.slice(2)}_argument_missing`);
  return process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const platform = argument("--platform", process.platform);
const architecture = argument("--arch", process.arch);
const target = runtimeTarget(platform, architecture);
const archivePath = path.join(ROOT, "runtime", "vendor", target.archiveName);
const checksumPath = archivePath.replace(/\.zip$/, ".sha256");
const trustPath = path.join(ROOT, "config", target.trustName);
const archive = await readFile(archivePath);
assert.equal(
  (await readFile(checksumPath, "utf8")).trim(),
  `${sha256(archive)}  ${target.archiveName}`,
  "desktop_runtime_archive_checksum_mismatch",
);

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-fixed-runtime-"));
try {
  await extract(archivePath, { dir: temporaryRoot });
  const verified = await verifyRuntimePackIdentity(
    path.join(temporaryRoot, "bizhub-runtime"),
    trustPath,
  );
  assert.equal(verified.manifest.platform, target.platform);
  assert.equal(verified.manifest.architecture, target.architecture);
  for (const source of verified.manifest.runtime_source_files) {
    assert.equal(
      sha256(await readFile(path.join(REPO, source.path))),
      source.sha256,
      `desktop_runtime_source_file_mismatch:${source.path}`,
    );
  }
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    platform: target.platform,
    architecture: target.architecture,
    archive_sha256: sha256(archive),
    runtime_manifest_sha256: sha256(
      await readFile(path.join(temporaryRoot, "bizhub-runtime", "runtime-release-manifest.json")),
    ),
    runtime_pack_tree_digest: verified.manifest.pack_tree_digest,
    runtime_source_tree_digest: verified.manifest.runtime_source_tree_digest,
    runtime_pack_file_count: verified.manifest.files.length,
  })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
