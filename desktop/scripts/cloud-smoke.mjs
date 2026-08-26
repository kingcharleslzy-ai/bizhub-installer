import { spawn } from "node:child_process";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { signatureInput } = require("../electron/connection-profile.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`desktop_smoke_option_missing:${name}`);
  return path.resolve(value);
}

const packagedExecutable = option("--packaged-executable");
const packagedTrustStore = option("--packaged-trust-store");
if (Boolean(packagedExecutable) !== Boolean(packagedTrustStore)) {
  throw new Error("desktop_smoke_packaged_options_incomplete");
}
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-desktop-smoke-"));
const trustStorePath = path.join(temporaryRoot, "trust.json");
const profilePath = path.join(temporaryRoot, "connection.json");
let originalPackagedTrustStore = null;

try {
  const now = Date.now();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "desktop-smoke-key";
  const envelope = {
    schema_version: "bizhub.desktop-connection-envelope.v1",
    key_id: keyId,
    payload: {
      allowed_origins: ["https://example.com"],
      application_url: "https://example.com/",
      connection_id: "desktop-cloud-smoke",
      data_authority_mode: "cloud",
      display_name: "BizHub Desktop cloud smoke",
      expires_at: new Date(now + 5 * 60_000).toISOString(),
      profile_id: "generic",
      runtime_mode: "cloud",
      shell_min_version: "0.1.0",
    },
    signature: "",
  };
  envelope.signature = sign(null, signatureInput(envelope), privateKey).toString("base64url");
  const trustStore = {
    schema_version: "bizhub.desktop-trust-store.v1",
    keys: [
      {
        algorithm: "Ed25519",
        key_id: keyId,
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
        valid_from: new Date(now - 60_000).toISOString(),
        valid_until: new Date(now + 10 * 60_000).toISOString(),
      },
    ],
  };
  await Promise.all([
    writeFile(profilePath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 }),
    writeFile(trustStorePath, `${JSON.stringify(trustStore, null, 2)}\n`, { mode: 0o600 }),
  ]);

  if (packagedTrustStore) {
    originalPackagedTrustStore = await readFile(packagedTrustStore);
    const existing = JSON.parse(originalPackagedTrustStore.toString("utf8"));
    if (!Array.isArray(existing.keys) || existing.keys.length !== 0) {
      throw new Error("desktop_smoke_packaged_trust_store_not_empty");
    }
    await writeFile(packagedTrustStore, `${JSON.stringify(trustStore, null, 2)}\n`);
  }

  const developmentExecutable = require("electron");
  const executable = packagedExecutable || developmentExecutable;
  const child = spawn(executable, packagedExecutable ? [] : [ROOT], {
    cwd: ROOT,
    env: {
      ...process.env,
      BIZHUB_DESKTOP_SMOKE_EXIT_ON_LOAD: "1",
      BIZHUB_DESKTOP_SMOKE_PROFILE: profilePath,
      BIZHUB_DESKTOP_USER_DATA_ROOT: path.join(temporaryRoot, "user-data"),
      ...(packagedExecutable ? {} : { BIZHUB_DESKTOP_TRUSTED_KEYS: trustStorePath }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("desktop_cloud_smoke_timeout"));
    }, 45_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  const connectedMarker = stdout.includes('"status":"connected"');
  if (exitCode !== 0 || (!packagedExecutable && !connectedMarker)) {
    throw new Error(`desktop_cloud_smoke_failed:${exitCode}:${stderr.trim()}:${stdout.trim()}`);
  }
  process.stdout.write(`${JSON.stringify({
    status: "connected",
    origin: "https://example.com",
    process_marker: connectedMarker,
  })}\n`);
} finally {
  if (packagedTrustStore && originalPackagedTrustStore) {
    await writeFile(packagedTrustStore, originalPackagedTrustStore);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
