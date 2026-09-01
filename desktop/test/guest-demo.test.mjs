import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  DEMO_COMPANY_NAME,
  DEMO_USERNAME,
  demoCatalogDrafts,
  demoOwnerCommands,
  seedGuestDemo,
} = require("../electron/guest-demo.cjs");

test("guest fixture is customer-neutral and exercises every Generic Owner", () => {
  assert.equal(DEMO_COMPANY_NAME, "星河新材料样板间");
  assert.equal(DEMO_USERNAME, "bizhub-guest");
  const catalog = demoCatalogDrafts();
  assert.deepEqual(
    [...new Set(catalog.map((item) => item.resource_kind))].sort(),
    ["location", "party", "product", "unit"],
  );
  assert.equal(catalog.length, 11);
  const commands = demoOwnerCommands();
  assert.deepEqual(
    [...new Set(commands.map(([basePath]) => basePath))].sort(),
    ["/api/inventory", "/api/procurement", "/api/sales"],
  );
  const keys = commands.map(([, command]) => command.idempotency_key);
  assert.equal(new Set(keys).size, keys.length);
  const text = JSON.stringify({ catalog, commands }).toLocaleLowerCase();
  for (const marker of ["daz" + "heng", "123" + "crystal", "大" + "正", "高" + "意"]) {
    assert.equal(text.includes(marker.toLocaleLowerCase()), false, marker);
  }
});

test("guest seed uses preview apply and validates readback", async () => {
  const requests = [];
  const fetchRuntime = async (_runtime, pathname, options = {}) => {
    requests.push({ pathname, options });
    const response = { ok: true, status: 200 };
    if (pathname === "/api/workspace-onboarding/state") {
      return { response, body: { stage: "workspace_ready", revision: 1 } };
    }
    if (pathname === "/api/delivery/overview") {
      return { response, body: {
        parties: 4,
        products: 3,
        locations: 2,
        procurement_orders: 2,
        sales_orders: 2,
        inventory_movements: 3,
      } };
    }
    if (pathname === "/api/delivery/inventory") {
      return { response, body: { balances: [{ quantity: "48" }, { quantity: "25" }], movements: [] } };
    }
    if (pathname.endsWith("/preview")) {
      const payload = JSON.parse(options.body);
      return { response, body: { ...payload, state_generation: "synthetic", preview_digest: pathname } };
    }
    return {
      response,
      body: {
        owner_ref: pathname.includes("master-data")
          ? "master_data:catalog-owner"
          : `${pathname.split("/")[2]}:owner`,
      },
    };
  };
  const result = await seedGuestDemo({ origin: "http://127.0.0.1:1" }, fetchRuntime);
  assert.equal(result.schema_version, "bizhub.desktop-guest-demo-readback.v1");
  assert.equal(result.overview.inventory_movements, 3);
  assert.equal(result.inventory_balances.length, 2);
  const mutations = requests.filter((item) => item.options.method === "POST");
  assert.equal(mutations.length, 17);
  for (const item of mutations) {
    assert.equal(item.options.headers["X-BizHub-Request"], "1");
  }
  const paths = requests.map((item) => item.pathname);
  assert.deepEqual(paths.slice(0, 2), [
    "/api/workspace-onboarding/state",
    "/api/workspace-onboarding/enter",
  ]);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    schema_version: "bizhub.workspace-onboarding-state.v1",
    expected_revision: 1,
    idempotency_key: "guest-demo-enter-v1",
  });
  for (const basePath of ["/api/master-data/catalog", "/api/procurement", "/api/sales", "/api/inventory"]) {
    assert.ok(paths.includes(`${basePath}/preview`), basePath);
    assert.ok(paths.includes(`${basePath}/apply`), basePath);
  }
});
