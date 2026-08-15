<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

type Json = Record<string, any>;
type Page = "home" | "master" | "sales" | "purchase" | "inventory" | "import" | "audit" | "system";

const user = ref<string | null>(null);
const username = ref("admin");
const password = ref("");
const page = ref<Page>("home");
const busy = ref(false);
const message = ref("");
const profile = ref<Json>({});
const catalog = ref<Json>({ parties: [], products: [], units: [], locations: [] });
const sales = ref<Json[]>([]);
const purchases = ref<Json[]>([]);
const inventory = ref<Json>({ balances: [], movements: [] });
const audit = ref<Json[]>([]);
const health = ref<Json>({});
const systemMap = ref<Json>({ modules: [] });

const partyForm = ref({ canonical_name: "", legal_name: "", roles: ["customer"] });
const productForm = ref({ canonical_name: "", sku: "", unit_id: "" });
const unitForm = ref({ code: "pcs", display_name: "件", dimension: "count" });
const locationForm = ref({ code: "MAIN", display_name: "主仓" });
const orderForm = ref({ order_no: "", party_id: "", product_id: "", unit_id: "", quantity: "1", unit_price: "", order_date: new Date().toISOString().slice(0, 10) });
const fulfillmentForm = ref({ order_type: "purchase", order_id: "", line_id: "", location_id: "", quantity: "1", business_date: new Date().toISOString().slice(0, 10) });
const adjustmentForm = ref({ product_id: "", unit_id: "", location_id: "", quantity_delta: "", business_date: new Date().toISOString().slice(0, 10), note: "" });
const reversalForm = ref({ movement_id: "", business_date: new Date().toISOString().slice(0, 10), note: "" });
const cancelForm = ref({ order_id: "", note: "" });
const importForm = ref({ resource: "party", source_id: "customer-import", text: "", records: [] as Json[], token: "" });

const customerParties = computed(() => catalog.value.parties.filter((item: Json) => item.roles.includes("customer")));
const supplierParties = computed(() => catalog.value.parties.filter((item: Json) => item.roles.includes("supplier")));

async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("X-BizHub-Request", "1");
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail || body));
  return body;
}

async function login() {
  busy.value = true;
  try {
    const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: username.value, password: password.value }) });
    user.value = result.username;
    password.value = "";
    await refresh();
  } catch (error: any) { message.value = error.message; }
  finally { busy.value = false; }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  user.value = null;
}

async function refresh() {
  const [newProfile, newCatalog, newSales, newPurchases, newInventory, newAudit, newHealth, newSystemMap] = await Promise.all([
    api("/api/profile"), api("/api/resources/catalog"), api("/api/orders/sale"), api("/api/orders/purchase"),
    api("/api/inventory"), api("/api/audit?limit=100"), api("/api/health"), api("/api/system/modules"),
  ]);
  profile.value = newProfile; catalog.value = newCatalog; sales.value = newSales; purchases.value = newPurchases;
  inventory.value = newInventory; audit.value = newAudit; health.value = newHealth; systemMap.value = newSystemMap;
}

async function action(name: string, data: Json, note: string) {
  busy.value = true; message.value = "";
  try {
    const preview = await api("/api/actions/preview", { method: "POST", body: JSON.stringify({ action: name, data }) });
    if (preview.status === "already_satisfied") { message.value = "该外部记录已经存在，无需重复写入。"; return; }
    if (!window.confirm(`确认执行 ${name}？\n\n${JSON.stringify(preview.normalized, null, 2)}`)) return;
    await api("/api/actions/apply", { method: "POST", body: JSON.stringify({ action: name, data, preview_token: preview.preview_token, review_note: note }) });
    message.value = "写入完成，并已回读验证。";
    await refresh();
  } catch (error: any) { message.value = error.message; }
  finally { busy.value = false; }
}

function createOrder(orderType: "sale" | "purchase") {
  const partyKey = orderType === "sale" ? "customer_id" : "supplier_id";
  action(`create_${orderType === "sale" ? "sales" : "purchase"}_order`, {
    order_no: orderForm.value.order_no,
    [partyKey]: Number(orderForm.value.party_id),
    order_date: orderForm.value.order_date,
    lines: [{ product_id: Number(orderForm.value.product_id), unit_id: Number(orderForm.value.unit_id), quantity: orderForm.value.quantity, ...(orderForm.value.unit_price ? { unit_price: orderForm.value.unit_price } : {}) }],
  }, `管理员确认创建${orderType === "sale" ? "销售" : "采购"}订单`);
}

function fulfill() {
  const purchase = fulfillmentForm.value.order_type === "purchase";
  action(purchase ? "receive_purchase" : "ship_sale", {
    order_id: Number(fulfillmentForm.value.order_id), location_id: Number(fulfillmentForm.value.location_id), business_date: fulfillmentForm.value.business_date,
    lines: [{ line_id: Number(fulfillmentForm.value.line_id), quantity: fulfillmentForm.value.quantity }],
  }, purchase ? "管理员确认采购收货" : "管理员确认销售发货");
}

async function previewImport() {
  busy.value = true;
  try {
    const result = await api("/api/imports/csv/preview", { method: "POST", body: JSON.stringify({ resource: importForm.value.resource, source_id: importForm.value.source_id, csv_text: importForm.value.text }) });
    importForm.value.records = result.records; importForm.value.token = result.preview_token;
    message.value = `校验完成：${result.ready_count} 条待写入，${result.already_satisfied_count} 条已存在。`;
  } catch (error: any) { message.value = error.message; }
  finally { busy.value = false; }
}

async function applyImport() {
  if (!importForm.value.token || !window.confirm(`确认导入 ${importForm.value.records.length} 条记录？`)) return;
  busy.value = true;
  try {
    await api("/api/imports/apply", { method: "POST", body: JSON.stringify({ resource: importForm.value.resource, source_id: importForm.value.source_id, records: importForm.value.records, preview_token: importForm.value.token, review_note: "管理员确认批量导入" }) });
    message.value = "导入完成，并已回读验证。"; importForm.value.token = ""; await refresh();
  } catch (error: any) { message.value = error.message; }
  finally { busy.value = false; }
}

async function loadTemplate() {
  const response = await fetch(`/api/imports/template/${importForm.value.resource}`);
  importForm.value.text = await response.text(); importForm.value.token = "";
}

onMounted(async () => {
  try { const result = await api("/api/auth/me"); user.value = result.username; await refresh(); } catch { user.value = null; }
});
</script>

<template>
  <main v-if="!user" class="login-shell">
    <form class="login-card" @submit.prevent="login">
      <div class="brand">BH</div><p class="eyebrow">PRIVATE BUSINESS SYSTEM</p><h1>BizHub</h1>
      <p class="muted">使用安装时创建的唯一管理员账户登录。</p>
      <label>用户名<input v-model="username" autocomplete="username" /></label>
      <label>密码<input v-model="password" type="password" autocomplete="current-password" /></label>
      <button :disabled="busy">登录</button><p v-if="message" class="error">{{ message }}</p>
    </form>
  </main>
  <div v-else class="shell">
    <aside>
      <div class="identity"><div class="brand">{{ profile.brand_mark || 'BH' }}</div><div><strong>{{ profile.display_name || 'BizHub' }}</strong><small>{{ profile.currency }} · {{ profile.timezone }}</small></div></div>
      <nav><button v-for="item in ([['home','首页'],['master','主数据'],['sales','销售'],['purchase','采购'],['inventory','库存'],['import','数据导入'],['audit','审计'],['system','系统状态']] as const)" :class="{active: page === item[0]}" @click="page = item[0]">{{ item[1] }}</button></nav>
      <button class="quiet" @click="logout">退出 {{ user }}</button>
    </aside>
    <main class="workspace">
      <header><div><p class="eyebrow">BIZHUB OPERATIONS</p><h1>{{ ({home:'经营首页',master:'主数据',sales:'销售订单',purchase:'采购订单',inventory:'库存台账',import:'数据导入',audit:'审计日志',system:'系统状态'} as any)[page] }}</h1></div><button class="secondary" @click="refresh">刷新</button></header>
      <p v-if="message" class="notice">{{ message }}</p>

      <section v-if="page === 'home'" class="cards">
        <article><span>客户 / 供应商</span><strong>{{ customerParties.length }} / {{ supplierParties.length }}</strong></article>
        <article><span>产品</span><strong>{{ catalog.products.length }}</strong></article><article><span>销售 / 采购订单</span><strong>{{ sales.length }} / {{ purchases.length }}</strong></article>
        <article><span>库存组合</span><strong>{{ inventory.balances.length }}</strong></article>
      </section>

      <section v-if="page === 'master'" class="grid2">
        <article class="panel"><h2>业务主体</h2><input v-model="partyForm.canonical_name" placeholder="名称" /><input v-model="partyForm.legal_name" placeholder="法定名称（可选）" /><select v-model="partyForm.roles[0]"><option value="customer">客户</option><option value="supplier">供应商</option></select><button @click="action('create_party', partyForm, '管理员确认创建业务主体')">预览并创建</button></article>
        <article class="panel"><h2>产品</h2><input v-model="productForm.canonical_name" placeholder="产品名称" /><input v-model="productForm.sku" placeholder="SKU" /><select v-model="productForm.unit_id"><option value="">选择基础单位</option><option v-for="u in catalog.units" :value="u.id">{{ u.display_name }}</option></select><button @click="action('create_product', {...productForm, unit_id: Number(productForm.unit_id)}, '管理员确认创建产品')">预览并创建</button></article>
        <article class="panel"><h2>计量单位</h2><input v-model="unitForm.code" placeholder="代码" /><input v-model="unitForm.display_name" placeholder="显示名称" /><select v-model="unitForm.dimension"><option v-for="v in ['count','weight','volume','length','area','package','other']" :value="v">{{ v }}</option></select><button @click="action('create_unit', unitForm, '管理员确认创建单位')">预览并创建</button></article>
        <article class="panel"><h2>库存地点</h2><input v-model="locationForm.code" placeholder="代码" /><input v-model="locationForm.display_name" placeholder="显示名称" /><button @click="action('create_location', locationForm, '管理员确认创建库存地点')">预览并创建</button></article>
        <article class="panel wide"><h2>当前目录</h2><pre>{{ JSON.stringify(catalog, null, 2) }}</pre></article>
      </section>

      <section v-if="page === 'sales' || page === 'purchase'" class="grid2">
        <article class="panel"><h2>新建{{ page === 'sales' ? '销售' : '采购' }}订单</h2><input v-model="orderForm.order_no" placeholder="订单号" /><select v-model="orderForm.party_id"><option value="">选择{{ page === 'sales' ? '客户' : '供应商' }}</option><option v-for="p in page === 'sales' ? customerParties : supplierParties" :value="p.id">{{ p.canonical_name }}</option></select><select v-model="orderForm.product_id"><option value="">选择产品</option><option v-for="p in catalog.products" :value="p.id">{{ p.canonical_name }}</option></select><select v-model="orderForm.unit_id"><option value="">选择单位</option><option v-for="u in catalog.units" :value="u.id">{{ u.display_name }}</option></select><input v-model="orderForm.quantity" type="number" min="0.00000001" step="any" placeholder="数量" /><input v-model="orderForm.unit_price" type="number" min="0" step="any" placeholder="单价（可选）" /><input v-model="orderForm.order_date" type="date" /><button @click="createOrder(page === 'sales' ? 'sale' : 'purchase')">预览并创建</button></article>
        <article class="panel"><h2>{{ page === 'sales' ? '发货' : '收货' }}</h2><input v-model="fulfillmentForm.order_id" type="number" placeholder="订单 ID" /><input v-model="fulfillmentForm.line_id" type="number" placeholder="行 ID" /><select v-model="fulfillmentForm.location_id"><option value="">选择库存地点</option><option v-for="l in catalog.locations" :value="l.id">{{ l.display_name }}</option></select><input v-model="fulfillmentForm.quantity" type="number" min="0.00000001" step="any" placeholder="数量" /><input v-model="fulfillmentForm.business_date" type="date" /><button @click="fulfillmentForm.order_type = page === 'sales' ? 'sale' : 'purchase'; fulfill()">预览并确认</button></article>
        <article class="panel"><h2>取消未履行余量</h2><input v-model="cancelForm.order_id" type="number" placeholder="订单 ID" /><input v-model="cancelForm.note" placeholder="取消原因（至少 3 字符）" /><button @click="action('cancel_order', {order_type: page === 'sales' ? 'sale' : 'purchase', order_id: Number(cancelForm.order_id), note: cancelForm.note}, '管理员确认取消未履行余量')">预览并取消</button></article>
        <article class="panel wide"><h2>订单与履行进度</h2><pre>{{ JSON.stringify(page === 'sales' ? sales : purchases, null, 2) }}</pre></article>
      </section>

      <section v-if="page === 'inventory'" class="grid2">
        <article class="panel wide"><h2>库存余额</h2><table><thead><tr><th>产品</th><th>单位</th><th>地点</th><th>数量</th></tr></thead><tbody><tr v-for="row in inventory.balances"><td>{{ row.product_id }}</td><td>{{ row.unit_id }}</td><td>{{ row.location_id }}</td><td>{{ row.quantity }}</td></tr></tbody></table></article>
        <article class="panel"><h2>库存调整</h2><select v-model="adjustmentForm.product_id"><option value="">选择产品</option><option v-for="p in catalog.products" :value="p.id">{{ p.canonical_name }}</option></select><select v-model="adjustmentForm.unit_id"><option value="">选择单位</option><option v-for="u in catalog.units" :value="u.id">{{ u.display_name }}</option></select><select v-model="adjustmentForm.location_id"><option value="">选择地点</option><option v-for="l in catalog.locations" :value="l.id">{{ l.display_name }}</option></select><input v-model="adjustmentForm.quantity_delta" type="number" step="any" placeholder="正数入库，负数出库" /><input v-model="adjustmentForm.business_date" type="date" /><input v-model="adjustmentForm.note" placeholder="调整原因（至少 3 字符）" /><button @click="action('post_inventory_adjustment', {...adjustmentForm, product_id: Number(adjustmentForm.product_id), unit_id: Number(adjustmentForm.unit_id), location_id: Number(adjustmentForm.location_id)}, '管理员确认库存调整')">预览并调整</button></article>
        <article class="panel"><h2>反向 Movement</h2><input v-model="reversalForm.movement_id" type="number" placeholder="原 Movement ID" /><input v-model="reversalForm.business_date" type="date" /><input v-model="reversalForm.note" placeholder="反向原因（至少 3 字符）" /><button @click="action('reverse_movement', {movement_id: Number(reversalForm.movement_id), business_date: reversalForm.business_date, note: reversalForm.note}, '管理员确认反向库存 Movement')">预览并反向</button></article>
        <article class="panel wide"><h2>不可变 Movement</h2><pre>{{ JSON.stringify(inventory.movements, null, 2) }}</pre></article>
      </section>

      <section v-if="page === 'import'" class="panel"><h2>CSV 导入</h2><div class="inline"><select v-model="importForm.resource" @change="loadTemplate"><option v-for="v in ['party','product','unit','location','opening_inventory','sales_order','purchase_order']" :value="v">{{ v }}</option></select><input v-model="importForm.source_id" placeholder="source_id" /><button class="secondary" @click="loadTemplate">载入模板</button></div><textarea v-model="importForm.text" rows="15" spellcheck="false"></textarea><div class="inline"><button @click="previewImport">校验并预览</button><button :disabled="!importForm.token" @click="applyImport">确认导入</button></div></section>
      <section v-if="page === 'audit'" class="panel"><pre>{{ JSON.stringify(audit, null, 2) }}</pre></section>
      <section v-if="page === 'system'" class="panel"><h2>实例健康</h2><pre>{{ JSON.stringify(health, null, 2) }}</pre><h2>公司绑定</h2><pre>{{ JSON.stringify(profile, null, 2) }}</pre><h2>有效模块</h2><pre>{{ JSON.stringify(systemMap, null, 2) }}</pre></section>
    </main>
  </div>
</template>
