import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { verifyRuntimePack } = require("../electron/local-runtime.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveName = "bizhub-runtime-darwin-arm64-0.1.0-d2.zip";
const archivePath = path.join(ROOT, "runtime", "vendor", archiveName);
const checksumPath = path.join(ROOT, "runtime", "vendor", `${archiveName.replace(/\.zip$/, "")}.sha256`);
const outputRoot = path.join(ROOT, "runtime-dist");
const packRoot = path.join(outputRoot, "bizhub-runtime");
const trustPath = path.join(ROOT, "config", "generic-runtime-trust.json");

for (const filePath of [archivePath, checksumPath]) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`desktop_runtime_vendor_input_invalid:${filePath}`);
  }
}
const checksumLine = (await readFile(checksumPath, "utf8")).trim();
const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(checksumLine);
if (!match || match[2] !== archiveName) {
  throw new Error("desktop_runtime_vendor_checksum_shape_invalid");
}
const archiveBytes = await readFile(archivePath);
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
if (archiveSha256 !== match[1]) {
  throw new Error("desktop_runtime_vendor_archive_digest_mismatch");
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
await new Promise((resolve, reject) => {
  const child = spawn("/usr/bin/ditto", ["-x", "-k", archivePath, outputRoot], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => {
    output += chunk.toString("utf8");
    if (Buffer.byteLength(output) > 64 * 1024) {
      child.kill("SIGKILL");
      reject(new Error("desktop_runtime_vendor_extract_output_too_large"));
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error("desktop_runtime_vendor_extract_timeout"));
  }, 30_000);
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("exit", (code) => {
    clearTimeout(timeout);
    if (code === 0) resolve();
    else reject(new Error(`desktop_runtime_vendor_extract_failed:${code}:${output.trim()}`));
  });
});

const verified = await verifyRuntimePack(packRoot, trustPath);
process.stdout.write(`${JSON.stringify({
  status: "prepared",
  runtime_archive_sha256: archiveSha256,
  runtime_manifest_sha256: JSON.parse(await readFile(trustPath, "utf8")).runtime_manifest_sha256,
  runtime_pack_tree_digest: verified.manifest.pack_tree_digest,
  runtime_pack_file_count: verified.manifest.files.length,
})}\n`);
