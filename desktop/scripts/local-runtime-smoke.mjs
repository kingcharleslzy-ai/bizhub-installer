import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  backupLocalInstance,
  bootstrapLocalInstance,
  fetchRuntime,
  loginLocalRuntime,
  startLocalRuntime,
  stopLocalRuntime,
  verifyRuntimePack,
} = require("../electron/local-runtime.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`desktop_smoke_option_missing:${name}`);
  return path.resolve(value);
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

const runtimePack = option("--runtime-pack", path.join(ROOT, "runtime-dist", "bizhub-runtime"));
const trustPath = option("--trust", path.join(ROOT, "config", "generic-runtime-trust.json"));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-desktop-d2-"));
const userDataRoot = path.join(temporaryRoot, "user-data");
const failedRoot = path.join(temporaryRoot, "failed-user-data");
const username = "synthetic-admin";
const password = "synthetic correct horse battery staple";
let runtime = null;

try {
  const release = await verifyRuntimePack(runtimePack, trustPath);
  assert.equal(release.manifest.profile_id, "generic-kernel-smoke");
  assert.equal(release.manifest.platform, "darwin");
  assert.equal(release.manifest.architecture, "arm64");

  await assert.rejects(
    bootstrapLocalInstance({
      userDataRoot: failedRoot,
      runtimePack,
      trustPath,
      input: { companyName: "Synthetic Failure", username, password: "too-short" },
    }),
    /desktop_admin_password_invalid/,
  );
  await assert.rejects(access(path.join(failedRoot, "local-instance")));

  const created = await bootstrapLocalInstance({
    userDataRoot,
    runtimePack,
    trustPath,
    input: { companyName: "Synthetic Generic Company", username, password },
  });
  assert.equal(created.status, "created");
  assert.equal(created.instance.profile_id, "generic-kernel-smoke");
  assert.equal(created.instance.authority_epoch, 1);
  assert.match(created.instance.data_identity, /^local:/);
  assert.match(created.instance.writer_instance_id, /^desktop:/);
  const instanceRoot = path.join(userDataRoot, "local-instance");

  runtime = await startLocalRuntime({ instanceRoot, runtimePack, trustPath });
  assert.match(runtime.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const untrusted = await fetch(`${runtime.origin}/api/health`);
  assert.equal(untrusted.status, 403);

  const wrongLogin = await mutation(runtime, "/api/auth/login", {
    username: "unknown-user",
    password,
  });
  assert.equal(wrongLogin.response.status, 401);
  await loginLocalRuntime(runtime, username, password);

  const profile = await fetchRuntime(runtime, "/api/profile");
  assert.equal(profile.response.status, 200);
  assert.equal(profile.body.runtime_profile_id, "generic-kernel-smoke");
  assert.equal(profile.body.data_identity, created.instance.data_identity);
  assert.equal(profile.body.writer_instance_id, created.instance.writer_instance_id);
  const systemMap = await fetchRuntime(runtime, "/api/system-map");
  assert.equal(systemMap.response.status, 200);
  assert.equal(systemMap.body.profile_id, "generic-kernel-smoke");
  assert.ok(!JSON.stringify(systemMap.body).toLocaleLowerCase().includes("daz" + "heng"));

  const drafts = [
    { resource_kind: "party", resource_id: "supplier-1", canonical_name: "Synthetic Supplier" },
    { resource_kind: "product", resource_id: "product-1", canonical_name: "Synthetic Product" },
    { resource_kind: "unit", resource_id: "kg", canonical_name: "Kilogram" },
    { resource_kind: "location", resource_id: "warehouse-1", canonical_name: "Synthetic Warehouse" },
  ];
  const preview = await mutation(runtime, "/api/master-data/catalog/preview", { drafts });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.schema_version, "bizhub.master-data-catalog-preview.v1");
  const applied = await mutation(runtime, "/api/master-data/catalog/apply", preview.body);
  assert.equal(applied.response.status, 200);
  assert.equal(applied.body.owner_ref, "master_data:catalog-owner");
  assert.equal(applied.body.disposition, "applied");
  const locations = await fetchRuntime(runtime, "/api/master-data/locations");
  assert.equal(locations.response.status, 200);
  assert.equal(locations.body.items.length, 1);
  assert.equal(locations.body.items[0].location_id, "warehouse-1");

  const replay = await mutation(runtime, "/api/master-data/catalog/apply", preview.body);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.disposition, "idempotent_noop");

  const tampered = structuredClone(preview.body);
  tampered.drafts[3].canonical_name = "Tampered Warehouse";
  const rejected = await mutation(runtime, "/api/master-data/catalog/apply", tampered);
  assert.equal(rejected.response.status, 409);
  const afterFailure = await fetchRuntime(runtime, "/api/master-data/locations");
  assert.equal(afterFailure.body.items.length, 1);
  assert.equal(afterFailure.body.items[0].canonical_name, "Synthetic Warehouse");

  const backup = await backupLocalInstance({ instanceRoot, runtimePack, trustPath });
  assert.equal(backup.status, "created");
  assert.equal(backup.validation.status, "valid");
  const backupManifest = JSON.parse(await readFile(backup.manifest_path, "utf8"));
  assert.equal(backupManifest.profile_id, "generic-kernel-smoke");

  await stopLocalRuntime(runtime);
  assert.ok(runtime.child.exitCode !== null || runtime.child.signalCode !== null);
  runtime = await startLocalRuntime({ instanceRoot, runtimePack, trustPath });
  await loginLocalRuntime(runtime, username, password);
  const restarted = await fetchRuntime(runtime, "/api/master-data/locations");
  assert.equal(restarted.body.items.length, 1);
  assert.equal(restarted.body.items[0].canonical_name, "Synthetic Warehouse");
  await stopLocalRuntime(runtime);
  assert.ok(runtime.child.exitCode !== null || runtime.child.signalCode !== null);
  runtime = null;

  process.stdout.write(`${JSON.stringify({
    status: "ok",
    profile_id: created.instance.profile_id,
    data_identity: created.instance.data_identity,
    writer_instance_id: created.instance.writer_instance_id,
    owner_ref: applied.body.owner_ref,
    apply_disposition: applied.body.disposition,
    replay_disposition: replay.body.disposition,
    failure_zero_write: true,
    backup_status: backup.validation.status,
    restart_readback_locations: restarted.body.items.length,
    runtime_pack_tree_digest: release.manifest.pack_tree_digest,
    core_artifact_digest: release.manifest.core_artifact_digest,
    residual_runtime_processes: 0,
  })}\n`);
} finally {
  if (runtime) await stopLocalRuntime(runtime);
  await rm(temporaryRoot, { recursive: true, force: true });
}
