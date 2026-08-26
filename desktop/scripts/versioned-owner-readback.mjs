import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  bootstrapLocalInstance,
  fetchRuntime,
  loadLocalInstance,
  loginLocalRuntime,
  startLocalRuntime,
  stopLocalRuntime,
  verifyRuntimePackIdentity,
} = require("../electron/local-runtime.cjs");

function fail(code) {
  throw new Error(code);
}

function parseArguments(values) {
  const result = {};
  const allowed = new Set(["--mode", "--resources", "--user-data-root", "--application-version"]);
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--")) {
      fail(`desktop_versioned_readback_argument_invalid:${key || "missing"}`);
    }
    result[key.slice(2).replaceAll("-", "_")] = value;
  }
  return result;
}

async function mutation(runtime, pathname, body) {
  return fetchRuntime(runtime, pathname, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BizHub-Request": "1",
    },
    body: JSON.stringify(body),
  });
}

const options = parseArguments(process.argv.slice(2));
if (!new Set(["create", "readback"]).has(options.mode)) {
  fail("desktop_versioned_readback_mode_invalid");
}
if (process.env.BIZHUB_DESKTOP_RELEASE_UPGRADE_SMOKE !== "1") {
  fail("desktop_versioned_readback_not_synthetic");
}
const resources = path.resolve(options.resources || "");
const userDataRoot = path.resolve(options.user_data_root || "");
const temporaryRoot = path.resolve(tmpdir());
if (
  !options.resources
  || !options.user_data_root
  || !options.application_version
  || !userDataRoot.startsWith(`${temporaryRoot}${path.sep}`)
) {
  fail("desktop_versioned_readback_boundary_invalid");
}
const runtimePack = path.join(resources, "bizhub-runtime");
const trustPath = path.join(resources, "generic-runtime-trust.json");
const instanceRoot = path.join(userDataRoot, "local-instance");
const username = "synthetic-upgrade-admin";
const password = "synthetic upgrade rollback password";
let runtime = null;

try {
  const release = await verifyRuntimePackIdentity(runtimePack, trustPath);
  const runtimeManifestSha256 = createHash("sha256")
    .update(await readFile(path.join(runtimePack, "runtime-release-manifest.json")))
    .digest("hex");
  let instance;
  let applyDisposition = null;
  if (options.mode === "create") {
    const created = await bootstrapLocalInstance({
      userDataRoot,
      runtimePack,
      trustPath,
      input: {
        companyName: "Synthetic Upgrade Company",
        username,
        password,
      },
    });
    instance = created.instance;
  } else {
    instance = (await loadLocalInstance(instanceRoot)).payload;
  }

  runtime = await startLocalRuntime({ instanceRoot, runtimePack, trustPath });
  await loginLocalRuntime(runtime, username, password);
  if (options.mode === "create") {
    const drafts = [
      { resource_kind: "party", resource_id: "upgrade-supplier", canonical_name: "Synthetic Upgrade Supplier" },
      { resource_kind: "product", resource_id: "upgrade-product", canonical_name: "Synthetic Upgrade Product" },
      { resource_kind: "unit", resource_id: "upgrade-unit", canonical_name: "Synthetic Upgrade Unit" },
      { resource_kind: "location", resource_id: "upgrade-location", canonical_name: "Synthetic Upgrade Location" },
    ];
    const preview = await mutation(runtime, "/api/master-data/catalog/preview", { drafts });
    assert.equal(preview.response.status, 200);
    const applied = await mutation(runtime, "/api/master-data/catalog/apply", preview.body);
    assert.equal(applied.response.status, 200);
    assert.equal(applied.body.owner_ref, "master_data:catalog-owner");
    assert.equal(applied.body.disposition, "applied");
    applyDisposition = applied.body.disposition;
  }
  const health = await fetchRuntime(runtime, "/api/health");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, "ok");
  const locations = await fetchRuntime(runtime, "/api/master-data/locations");
  assert.equal(locations.response.status, 200);
  const location = locations.body.items.find((item) => item.location_id === "upgrade-location");
  assert.equal(location?.canonical_name, "Synthetic Upgrade Location");

  await stopLocalRuntime(runtime);
  runtime = null;
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    stage: options.mode,
    application_version: options.application_version,
    data_identity: instance.data_identity,
    writer_instance_id: instance.writer_instance_id,
    runtime_manifest_sha256: runtimeManifestSha256,
    runtime_pack_tree_digest: release.manifest.pack_tree_digest,
    owner_ref: "master_data:catalog-owner",
    apply_disposition: applyDisposition,
    readback_location_id: location.location_id,
    readback_canonical_name: location.canonical_name,
    residual_runtime_processes: 0,
  })}\n`);
} finally {
  if (runtime) await stopLocalRuntime(runtime);
}
