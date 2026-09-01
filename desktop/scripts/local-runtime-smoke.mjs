import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runtimeTarget } from "./runtime-target.mjs";

const require = createRequire(import.meta.url);
const {
  backupLocalInstance,
  bootstrapLocalInstance,
  changeLocalPasswordRuntime,
  fetchRuntime,
  loginLocalRuntime,
  recoverInterruptedLocalSetup,
  resumeLocalRuntime,
  startLocalRuntime,
  stopLocalRuntime,
  verifyRuntimePack,
} = require("../electron/local-runtime.cjs");
const { createLocalRuntimeLifecycle } = require("../electron/local-lifecycle.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = runtimeTarget();

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
const trustPath = option("--trust", path.join(ROOT, "config", target.trustName));
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-desktop-d2-"));
const userDataRoot = path.join(temporaryRoot, "user-data");
const failedRoot = path.join(temporaryRoot, "failed-user-data");
const username = "synthetic-admin";
const password = "synthetic correct horse battery staple";
let runtime = null;
let lifecycle = null;

try {
  const release = await verifyRuntimePack(runtimePack, trustPath);
  assert.equal(release.manifest.profile_id, "generic-kernel-smoke");
  assert.equal(release.manifest.platform, target.platform);
  assert.equal(release.manifest.architecture, target.architecture);

  const interruptedSetupId = randomUUID();
  const interruptedStageName = `.setup-${interruptedSetupId}`;
  const interruptedRecord = {
    schema_version: "bizhub.desktop-local-setup.v1",
    setup_id: interruptedSetupId,
    stage_name: interruptedStageName,
    owner_pid: 987654,
    created_at: "2026-08-25T00:00:00.000Z",
  };
  const interruptedRuntimeRoot = path.join(userDataRoot, "runtime");
  const interruptedStage = path.join(interruptedRuntimeRoot, interruptedStageName);
  await mkdir(interruptedStage, { recursive: true });
  await writeFile(
    path.join(interruptedRuntimeRoot, `${interruptedStageName}.marker.json`),
    `${JSON.stringify(interruptedRecord, null, 2)}\n`,
  );
  await writeFile(
    path.join(interruptedRuntimeRoot, "setup.lock"),
    `${JSON.stringify(interruptedRecord, null, 2)}\n`,
  );
  const recovery = await recoverInterruptedLocalSetup(userDataRoot);
  assert.equal(recovery.status, "recovered");
  assert.equal(recovery.recovered_setups, 1);
  await assert.rejects(access(path.join(userDataRoot, "local-instance")));

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

  let spawnCount = 0;
  let maximumLiveRuntimeCount = 0;
  const liveRuntimePids = new Set();
  lifecycle = createLocalRuntimeLifecycle({
    startRuntime: async () => {
      spawnCount += 1;
      const started = await startLocalRuntime({ instanceRoot, runtimePack, trustPath });
      liveRuntimePids.add(started.child.pid);
      maximumLiveRuntimeCount = Math.max(maximumLiveRuntimeCount, liveRuntimePids.size);
      return started;
    },
    stopRuntime: async (started) => {
      await stopLocalRuntime(started);
      liveRuntimePids.delete(started.child.pid);
    },
  });
  const [firstRuntime, duplicateStart] = await Promise.all([
    lifecycle.start(),
    lifecycle.start(),
  ]);
  assert.equal(firstRuntime, duplicateStart);
  assert.equal(spawnCount, 1);
  assert.equal(maximumLiveRuntimeCount, 1);
  runtime = firstRuntime;
  assert.match(runtime.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const untrusted = await fetch(`${runtime.origin}/api/health`);
  assert.equal(untrusted.status, 403);

  const wrongLogin = await mutation(runtime, "/api/auth/login", {
    username: "unknown-user",
    password,
  });
  assert.equal(wrongLogin.response.status, 401);
  const firstLogin = await loginLocalRuntime(runtime, username, password, { remember: true });
  assert.equal(firstLogin.rememberSession.username, username);
  assert.equal(firstLogin.rememberSession.authVersion, 1);

  const profile = await fetchRuntime(runtime, "/api/profile");
  assert.equal(profile.response.status, 200);
  assert.equal(profile.body.runtime_profile_id, "generic-kernel-smoke");
  assert.equal(profile.body.data_identity, created.instance.data_identity);
  assert.equal(profile.body.writer_instance_id, created.instance.writer_instance_id);
  const systemMap = await fetchRuntime(runtime, "/api/system-map");
  assert.equal(systemMap.response.status, 200);
  assert.equal(systemMap.body.profile_id, "generic-kernel-smoke");
  assert.ok(!JSON.stringify(systemMap.body).toLocaleLowerCase().includes("daz" + "heng"));
  const onboarding = await fetchRuntime(runtime, "/api/workspace-onboarding/state");
  assert.equal(onboarding.response.status, 200);
  assert.equal(onboarding.body.workspace_id, created.instance.data_identity);
  assert.equal(onboarding.body.stage, "workspace_ready");
  assert.equal(onboarding.body.accepts_business_material, false);
  const blockedDelivery = await fetchRuntime(runtime, "/api/delivery/overview");
  assert.equal(blockedDelivery.response.status, 409);
  assert.equal(blockedDelivery.body.detail.code, "workspace_onboarding_required");
  const entered = await mutation(runtime, "/api/workspace-onboarding/enter", {
    schema_version: "bizhub.workspace-onboarding-state.v1",
    expected_revision: onboarding.body.revision,
    idempotency_key: "desktop-smoke-enter-v1",
  });
  assert.equal(entered.response.status, 200);
  assert.equal(entered.body.stage, "enterprise_context_ready");
  assert.equal(entered.body.accepts_business_material, true);
  const emptyDelivery = await fetchRuntime(runtime, "/api/delivery/overview");
  assert.equal(emptyDelivery.response.status, 200);
  assert.equal(emptyDelivery.body.procurement_orders, 0);
  assert.equal(emptyDelivery.body.sales_orders, 0);

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
  const deliveryCatalog = await fetchRuntime(runtime, "/api/delivery/catalog");
  assert.equal(deliveryCatalog.response.status, 200);
  assert.equal(deliveryCatalog.body.locations[0].id, "warehouse-1");

  const inventoryPreview = await mutation(runtime, "/api/inventory/preview", {
    action: "inbound",
    idempotency_key: "desktop-smoke:inventory-opening",
    product_id: "product-1",
    unit_id: "kg",
    quantity: "10",
    from_location_id: null,
    to_location_id: "warehouse-1",
    target_movement_id: null,
    actual_quantity: null,
    occurred_at: "2026-08-28T01:00:00.000Z",
    source_ref: "desktop-ui-smoke",
    reason: "synthetic opening balance",
  });
  assert.equal(inventoryPreview.response.status, 200);
  const inventoryApplied = await mutation(runtime, "/api/inventory/apply", inventoryPreview.body);
  assert.equal(inventoryApplied.response.status, 200);
  assert.equal(inventoryApplied.body.owner_ref, "inventory:movement-owner");
  assert.equal(inventoryApplied.body.disposition, "applied");

  const procurementCreatePreview = await mutation(runtime, "/api/procurement/preview", {
    action: "create",
    idempotency_key: "desktop-smoke:procurement-create",
    order_id: "PO-DESKTOP-1",
    supplier_party_id: "supplier-1",
    ordered_at: "2026-08-28T02:00:00.000Z",
    lines: [{
      line_id: "PO-DESKTOP-1-L1",
      product_id: "product-1",
      unit_id: "kg",
      quantity: "4",
      receive_location_id: "warehouse-1",
    }],
    source_ref: "desktop-ui-smoke",
    evidence_refs: ["synthetic:purchase-order:PO-DESKTOP-1"],
  });
  assert.equal(procurementCreatePreview.response.status, 200, JSON.stringify(procurementCreatePreview.body));
  const procurementCreated = await mutation(
    runtime,
    "/api/procurement/apply",
    procurementCreatePreview.body,
  );
  assert.equal(procurementCreated.response.status, 200);
  assert.equal(procurementCreated.body.owner_ref, "procurement:order-owner");
  const procurementReceivePreview = await mutation(runtime, "/api/procurement/preview", {
    action: "receive",
    idempotency_key: "desktop-smoke:procurement-receive",
    order_id: "PO-DESKTOP-1",
    target_line_id: "PO-DESKTOP-1-L1",
    quantity: "4",
    occurred_at: "2026-08-28T03:00:00.000Z",
    source_ref: "desktop-ui-smoke",
    evidence_refs: ["synthetic:receipt:PO-DESKTOP-1"],
    reason: "synthetic receipt",
  });
  assert.equal(procurementReceivePreview.response.status, 200, JSON.stringify(procurementReceivePreview.body));
  const procurementReceived = await mutation(
    runtime,
    "/api/procurement/apply",
    procurementReceivePreview.body,
  );
  assert.equal(procurementReceived.response.status, 200);
  assert.equal(procurementReceived.body.order.status, "received");

  const salesCreatePreview = await mutation(runtime, "/api/sales/preview", {
    action: "create",
    idempotency_key: "desktop-smoke:sales-create",
    order_id: "SO-DESKTOP-1",
    customer_party_id: "supplier-1",
    ordered_at: "2026-08-28T04:00:00.000Z",
    lines: [{
      line_id: "SO-DESKTOP-1-L1",
      product_id: "product-1",
      unit_id: "kg",
      quantity: "3",
      ship_from_location_id: "warehouse-1",
    }],
    source_ref: "desktop-ui-smoke",
    evidence_refs: ["synthetic:sales-order:SO-DESKTOP-1"],
  });
  assert.equal(salesCreatePreview.response.status, 200, JSON.stringify(salesCreatePreview.body));
  const salesCreated = await mutation(runtime, "/api/sales/apply", salesCreatePreview.body);
  assert.equal(salesCreated.response.status, 200);
  assert.equal(salesCreated.body.owner_ref, "sales:order-owner");
  const salesFulfillPreview = await mutation(runtime, "/api/sales/preview", {
    action: "fulfill",
    idempotency_key: "desktop-smoke:sales-fulfill",
    order_id: "SO-DESKTOP-1",
    target_line_id: "SO-DESKTOP-1-L1",
    quantity: "3",
    occurred_at: "2026-08-28T05:00:00.000Z",
    source_ref: "desktop-ui-smoke",
    evidence_refs: ["synthetic:shipment:SO-DESKTOP-1"],
    reason: "synthetic shipment",
  });
  assert.equal(salesFulfillPreview.response.status, 200, JSON.stringify(salesFulfillPreview.body));
  const salesFulfilled = await mutation(runtime, "/api/sales/apply", salesFulfillPreview.body);
  assert.equal(salesFulfilled.response.status, 200);
  assert.equal(salesFulfilled.body.order.status, "fulfilled");

  const deliveryOverview = await fetchRuntime(runtime, "/api/delivery/overview");
  assert.equal(deliveryOverview.body.procurement_orders, 1);
  assert.equal(deliveryOverview.body.sales_orders, 1);
  assert.equal(deliveryOverview.body.inventory_movements, 3);
  const deliveryProcurement = await fetchRuntime(runtime, "/api/delivery/procurement/orders");
  assert.equal(deliveryProcurement.body.items[0].lines[0].received_quantity, "4");
  const deliverySales = await fetchRuntime(runtime, "/api/delivery/sales/orders");
  assert.equal(deliverySales.body.items[0].lines[0].fulfilled_quantity, "3");
  const deliveryInventory = await fetchRuntime(runtime, "/api/delivery/inventory");
  assert.equal(deliveryInventory.body.balances[0].quantity, "11");

  const backup = await backupLocalInstance({ instanceRoot, runtimePack, trustPath });
  assert.equal(backup.status, "created");
  assert.equal(backup.validation.status, "valid");
  const backupManifest = JSON.parse(await readFile(backup.manifest_path, "utf8"));
  assert.equal(backupManifest.profile_id, "generic-kernel-smoke");

  await lifecycle.stop();
  assert.ok(runtime.child.exitCode !== null || runtime.child.signalCode !== null);
  assert.equal(liveRuntimePids.size, 0);
  runtime = await lifecycle.start();
  await resumeLocalRuntime(runtime, firstLogin.rememberSession.token);
  const restartedOnboarding = await fetchRuntime(runtime, "/api/workspace-onboarding/state");
  assert.equal(restartedOnboarding.body.stage, "enterprise_context_ready");
  const restarted = await fetchRuntime(runtime, "/api/master-data/locations");
  assert.equal(restarted.body.items.length, 1);
  assert.equal(restarted.body.items[0].canonical_name, "Synthetic Warehouse");
  const changedPassword = "synthetic updated horse battery staple";
  const changed = await changeLocalPasswordRuntime(runtime, password, changedPassword, {
    remember: true,
  });
  assert.equal(changed.rememberSession.authVersion, 2);
  await lifecycle.stop();
  assert.ok(runtime.child.exitCode !== null || runtime.child.signalCode !== null);
  assert.equal(liveRuntimePids.size, 0);
  runtime = await lifecycle.start();
  await assert.rejects(
    resumeLocalRuntime(runtime, firstLogin.rememberSession.token),
    /desktop_local_remembered_login_failed:401/,
  );
  await resumeLocalRuntime(runtime, changed.rememberSession.token);
  const passwordChangeReadback = await fetchRuntime(runtime, "/api/auth/me");
  assert.equal(passwordChangeReadback.body.username, username);
  await lifecycle.stop();
  assert.equal(liveRuntimePids.size, 0);
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
    onboarding_gate_before_business: blockedDelivery.body.detail.code,
    onboarding_entered: entered.body.stage,
    onboarding_restart_stage: restartedOnboarding.body.stage,
    delivery_owner_chain: {
      inventory: inventoryApplied.body.owner_ref,
      procurement: procurementCreated.body.owner_ref,
      sales: salesCreated.body.owner_ref,
    },
    delivery_readback: {
      procurement_orders: deliveryOverview.body.procurement_orders,
      sales_orders: deliveryOverview.body.sales_orders,
      inventory_movements: deliveryOverview.body.inventory_movements,
      inventory_balance: deliveryInventory.body.balances[0].quantity,
    },
    interrupted_setup_recovery: recovery.status,
    concurrent_start_spawn_count: 1,
    maximum_live_runtime_processes: maximumLiveRuntimeCount,
    backup_status: backup.validation.status,
    restart_readback_locations: restarted.body.items.length,
    local_remembered_login: true,
    password_change_invalidated_old_token: true,
    runtime_pack_tree_digest: release.manifest.pack_tree_digest,
    core_artifact_digest: release.manifest.core_artifact_digest,
    residual_runtime_processes: 0,
  })}\n`);
} finally {
  if (lifecycle?.current()) await lifecycle.stop();
  else if (runtime) await stopLocalRuntime(runtime);
  await rm(temporaryRoot, { recursive: true, force: true });
}
