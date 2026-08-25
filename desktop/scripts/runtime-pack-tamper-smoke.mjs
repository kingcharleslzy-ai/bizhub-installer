import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { verifyRuntimePack } = require("../electron/local-runtime.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const sourcePack = path.join(ROOT, "runtime-dist", "bizhub-runtime");
const trustPath = path.join(ROOT, "config", "generic-runtime-trust.json");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-runtime-coordinated-tamper-"));
const tamperedPack = path.join(temporaryRoot, "bizhub-runtime");

try {
  await cp(sourcePack, tamperedPack, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  const manifestPath = path.join(tamperedPack, "runtime-release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const record = manifest.files.find((item) => item.type === "file" && item.size < 1024 * 1024);
  assert.ok(record, "tamper_target_missing");
  const target = path.join(tamperedPack, record.path);
  const tamperedBytes = Buffer.concat([await readFile(target), Buffer.from("coordinated-tamper")]);
  await writeFile(target, tamperedBytes);
  record.sha256 = sha256(tamperedBytes);
  record.size = tamperedBytes.length;
  manifest.pack_tree_digest = sha256(Buffer.from(`${JSON.stringify(manifest.files)}\n`));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    verifyRuntimePack(tamperedPack, trustPath),
    /desktop_runtime_manifest_digest_mismatch/,
  );
  process.stdout.write(`${JSON.stringify({
    status: "rejected",
    attack: "runtime_file_plus_manifest_coordinated_tamper",
    independent_trust: true,
  })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
