import path from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { verifyRuntimePack } = require("../electron/local-runtime.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verified = await verifyRuntimePack(
  path.join(ROOT, "runtime-dist", "bizhub-runtime"),
  path.join(ROOT, "config", "generic-runtime-trust.json"),
);
const trust = JSON.parse(
  await readFile(path.join(ROOT, "config", "generic-runtime-trust.json"), "utf8"),
);

process.stdout.write(`${JSON.stringify({
  status: "trusted",
  runtime_manifest_sha256: trust.runtime_manifest_sha256,
  runtime_pack_tree_digest: verified.manifest.pack_tree_digest,
  runtime_pack_file_count: verified.manifest.files.length,
})}\n`);
