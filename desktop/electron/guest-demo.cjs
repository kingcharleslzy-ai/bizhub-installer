const DEMO_COMPANY_NAME = "星河新材料样板间";
const DEMO_USERNAME = "bizhub-guest";

function isoAt(daysAgo, hour) {
  const value = new Date();
  value.setUTCHours(hour, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() - daysAgo);
  return value.toISOString();
}

function demoCatalogDrafts() {
  return [
    ["party", "demo-supplier-a", "华北原料供应商（演示）", { roles: ["supplier"] }],
    ["party", "demo-supplier-b", "海湾包装供应商（演示）", { roles: ["supplier"] }],
    ["party", "demo-customer-a", "远航设备客户（演示）", { roles: ["customer"] }],
    ["party", "demo-customer-b", "新辰科技客户（演示）", { roles: ["customer"] }],
    ["product", "demo-product-crystal", "标准晶体组件（演示）", { sku: "DEMO-CRYSTAL" }],
    ["product", "demo-product-holder", "精密安装座（演示）", { sku: "DEMO-HOLDER" }],
    ["product", "demo-product-powder", "光学原料粉（演示）", { sku: "DEMO-POWDER" }],
    ["unit", "demo-unit-piece", "件", { code: "PCS" }],
    ["unit", "demo-unit-kilogram", "千克", { code: "KG" }],
    ["location", "demo-location-main", "样板总仓", { kind: "warehouse" }],
    ["location", "demo-location-production", "生产备料区", { kind: "workshop" }],
  ].map(([resource_kind, resource_id, canonical_name, attributes]) => ({
    resource_kind,
    resource_id,
    canonical_name,
    source_id: "demo-fixture",
    external_id: resource_id,
    alias: "",
    attributes,
  }));
}

function demoOwnerCommands() {
  return [
    ["/api/procurement", {
      action: "create",
      idempotency_key: "demo:procurement:create:001",
      order_id: "DEMO-PO-001",
      supplier_party_id: "demo-supplier-a",
      ordered_at: isoAt(4, 2),
      lines: [{
        line_id: "DEMO-PO-001-L1",
        product_id: "demo-product-crystal",
        unit_id: "demo-unit-piece",
        quantity: "120",
        receive_location_id: "demo-location-main",
      }],
      source_ref: "demo://purchase-contract/001",
      evidence_refs: ["demo://purchase-contract/001"],
    }],
    ["/api/procurement", {
      action: "receive",
      idempotency_key: "demo:procurement:receive:001",
      order_id: "DEMO-PO-001",
      target_line_id: "DEMO-PO-001-L1",
      quantity: "80",
      occurred_at: isoAt(2, 3),
      source_ref: "demo://warehouse-receipt/001",
      evidence_refs: ["demo://warehouse-receipt/001"],
      reason: "游客样板间模拟收货",
    }],
    ["/api/procurement", {
      action: "create",
      idempotency_key: "demo:procurement:create:002",
      order_id: "DEMO-PO-002",
      supplier_party_id: "demo-supplier-b",
      ordered_at: isoAt(1, 2),
      lines: [{
        line_id: "DEMO-PO-002-L1",
        product_id: "demo-product-powder",
        unit_id: "demo-unit-kilogram",
        quantity: "500",
        receive_location_id: "demo-location-production",
      }],
      source_ref: "demo://purchase-contract/002",
      evidence_refs: ["demo://purchase-contract/002"],
    }],
    ["/api/sales", {
      action: "create",
      idempotency_key: "demo:sales:create:001",
      order_id: "DEMO-SO-001",
      customer_party_id: "demo-customer-a",
      ordered_at: isoAt(2, 5),
      lines: [{
        line_id: "DEMO-SO-001-L1",
        product_id: "demo-product-crystal",
        unit_id: "demo-unit-piece",
        quantity: "50",
        ship_from_location_id: "demo-location-main",
      }],
      source_ref: "demo://sales-contract/001",
      evidence_refs: ["demo://sales-contract/001"],
    }],
    ["/api/sales", {
      action: "fulfill",
      idempotency_key: "demo:sales:fulfill:001",
      order_id: "DEMO-SO-001",
      target_line_id: "DEMO-SO-001-L1",
      quantity: "32",
      occurred_at: isoAt(1, 6),
      source_ref: "demo://shipment/001",
      evidence_refs: ["demo://shipment/001"],
      reason: "游客样板间模拟发货",
    }],
    ["/api/sales", {
      action: "create",
      idempotency_key: "demo:sales:create:002",
      order_id: "DEMO-SO-002",
      customer_party_id: "demo-customer-b",
      ordered_at: isoAt(0, 2),
      lines: [{
        line_id: "DEMO-SO-002-L1",
        product_id: "demo-product-holder",
        unit_id: "demo-unit-piece",
        quantity: "20",
        ship_from_location_id: "demo-location-production",
      }],
      source_ref: "demo://sales-contract/002",
      evidence_refs: ["demo://sales-contract/002"],
    }],
    ["/api/inventory", {
      action: "inbound",
      idempotency_key: "demo:inventory:inbound:001",
      product_id: "demo-product-holder",
      unit_id: "demo-unit-piece",
      quantity: "25",
      from_location_id: null,
      to_location_id: "demo-location-production",
      target_movement_id: null,
      actual_quantity: null,
      occurred_at: isoAt(3, 4),
      source_ref: "demo://opening-balance/001",
      reason: "游客样板间模拟期初库存",
    }],
  ];
}

async function requestJson(fetchRuntime, runtime, pathname, options = {}) {
  const result = await fetchRuntime(runtime, pathname, options);
  if (!result.response.ok) {
    const detail = typeof result.body?.detail === "string"
      ? result.body.detail
      : result.body?.detail?.code || result.body?.detail?.message || result.response.status;
    throw new Error(`desktop_guest_demo_seed_failed:${pathname}:${detail}`);
  }
  return result.body;
}

async function applyOwner(fetchRuntime, runtime, basePath, command) {
  const request = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BizHub-Request": "1",
    },
  };
  const preview = await requestJson(fetchRuntime, runtime, `${basePath}/preview`, {
    ...request,
    body: JSON.stringify(command),
  });
  return requestJson(fetchRuntime, runtime, `${basePath}/apply`, {
    ...request,
    body: JSON.stringify(preview),
  });
}

async function seedGuestDemo(runtime, fetchRuntime) {
  const catalogPreview = await requestJson(
    fetchRuntime,
    runtime,
    "/api/master-data/catalog/preview",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BizHub-Request": "1" },
      body: JSON.stringify({ drafts: demoCatalogDrafts() }),
    },
  );
  const catalog = await requestJson(
    fetchRuntime,
    runtime,
    "/api/master-data/catalog/apply",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BizHub-Request": "1" },
      body: JSON.stringify(catalogPreview),
    },
  );
  const owners = [];
  for (const [basePath, command] of demoOwnerCommands()) {
    owners.push(await applyOwner(fetchRuntime, runtime, basePath, command));
  }
  const [overview, inventory] = await Promise.all([
    requestJson(fetchRuntime, runtime, "/api/delivery/overview"),
    requestJson(fetchRuntime, runtime, "/api/delivery/inventory"),
  ]);
  if (
    overview.parties !== 4
    || overview.products !== 3
    || overview.procurement_orders !== 2
    || overview.sales_orders !== 2
    || overview.inventory_movements !== 3
    || inventory.balances?.length !== 2
  ) {
    throw new Error("desktop_guest_demo_readback_invalid");
  }
  return {
    schema_version: "bizhub.desktop-guest-demo-readback.v1",
    catalog_owner: catalog.owner_ref,
    owner_refs: owners.map((item) => item.owner_ref),
    overview,
    inventory_balances: inventory.balances,
  };
}

module.exports = {
  DEMO_COMPANY_NAME,
  DEMO_USERNAME,
  demoCatalogDrafts,
  demoOwnerCommands,
  seedGuestDemo,
};
