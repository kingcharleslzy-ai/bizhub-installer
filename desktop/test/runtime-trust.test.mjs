import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { verifyRuntimePack } = require("../electron/local-runtime.cjs");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalDigest(records) {
  return sha256(Buffer.from(`${JSON.stringify(records)}\n`));
}

async function writeManifest(root, manifest) {
  const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(root, "runtime-release-manifest.json"), raw);
  return sha256(raw);
}

async function createSyntheticPack(temporaryRoot) {
  const packRoot = path.join(temporaryRoot, "pack");
  const trustPath = path.join(temporaryRoot, "trust.json");
  await mkdir(packRoot);
  const executable = Buffer.from("#!/bin/sh\nexit 0\n");
  await writeFile(path.join(packRoot, "bizhub-runtime"), executable);
  await chmod(path.join(packRoot, "bizhub-runtime"), 0o755);
  const files = [{
    link_target: null,
    path: "bizhub-runtime",
    sha256: sha256(executable),
    size: executable.length,
    type: "file",
  }];
  const runtimeSourceFiles = [{
    path: "desktop/runtime/bizhub_runtime_entry.py",
    sha256: "1".repeat(64),
  }];
  const manifest = {
    schema_version: "bizhub.desktop-runtime-release.v1",
    runtime_id: "bizhub-generic-local",
    runtime_version: "0.1.0-d2",
    profile_id: "generic-kernel-smoke",
    platform: "darwin",
    architecture: "arm64",
    executable: "bizhub-runtime",
    artifact_id: "bizhub-common",
    core_artifact_digest: `sha256:${"2".repeat(64)}`,
    core_source_commit: "3".repeat(40),
    allowlist_tree_digest: "4".repeat(64),
    runtime_source_tree_digest: canonicalDigest(runtimeSourceFiles),
    runtime_source_files: runtimeSourceFiles,
    pack_tree_digest: canonicalDigest(files),
    files,
  };
  const trust = {
    schema_version: "bizhub.desktop-runtime-trust.v1",
    runtime_manifest_schema: manifest.schema_version,
    runtime_id: manifest.runtime_id,
    runtime_version: manifest.runtime_version,
    profile_id: manifest.profile_id,
    platform: manifest.platform,
    architecture: manifest.architecture,
    artifact_id: manifest.artifact_id,
    core_artifact_digest: manifest.core_artifact_digest,
    core_source_commit: manifest.core_source_commit,
    allowlist_tree_digest: manifest.allowlist_tree_digest,
    runtime_source_tree_digest: manifest.runtime_source_tree_digest,
    runtime_manifest_sha256: await writeManifest(packRoot, manifest),
    runtime_pack_tree_digest: manifest.pack_tree_digest,
    runtime_pack_file_count: manifest.files.length,
  };
  await writeFile(trustPath, `${JSON.stringify(trust, null, 2)}\n`);
  return { manifest, packRoot, trust, trustPath };
}

test("fixed trust accepts the exact synthetic Runtime Pack", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-runtime-trust-"));
  try {
    const fixture = await createSyntheticPack(temporaryRoot);
    const verified = await verifyRuntimePack(fixture.packRoot, fixture.trustPath);
    assert.equal(verified.manifest.pack_tree_digest, fixture.trust.runtime_pack_tree_digest);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("coordinated file and manifest tamper still fails against independent trust", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-runtime-tamper-"));
  try {
    const fixture = await createSyntheticPack(temporaryRoot);
    const executablePath = path.join(fixture.packRoot, "bizhub-runtime");
    const tamperedExecutable = Buffer.concat([await readFile(executablePath), Buffer.from("# tampered\n")]);
    await writeFile(executablePath, tamperedExecutable);
    await chmod(executablePath, 0o755);
    fixture.manifest.files[0].sha256 = sha256(tamperedExecutable);
    fixture.manifest.files[0].size = tamperedExecutable.length;
    fixture.manifest.pack_tree_digest = canonicalDigest(fixture.manifest.files);
    await writeManifest(fixture.packRoot, fixture.manifest);

    await assert.rejects(
      verifyRuntimePack(fixture.packRoot, fixture.trustPath),
      /desktop_runtime_manifest_digest_mismatch/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Runtime source records must remain strictly sorted and canonically bound", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-runtime-source-"));
  try {
    const fixture = await createSyntheticPack(temporaryRoot);
    fixture.manifest.runtime_source_files = [
      { path: "z-source.py", sha256: "5".repeat(64) },
      { path: "a-source.py", sha256: "6".repeat(64) },
    ];
    fixture.manifest.runtime_source_tree_digest = canonicalDigest(
      fixture.manifest.runtime_source_files,
    );
    fixture.trust.runtime_source_tree_digest = fixture.manifest.runtime_source_tree_digest;
    fixture.trust.runtime_manifest_sha256 = await writeManifest(
      fixture.packRoot,
      fixture.manifest,
    );
    await writeFile(fixture.trustPath, `${JSON.stringify(fixture.trust, null, 2)}\n`);

    await assert.rejects(
      verifyRuntimePack(fixture.packRoot, fixture.trustPath),
      /desktop_runtime_source_record_invalid:a-source.py/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
