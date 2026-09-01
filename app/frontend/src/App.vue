<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";

type Json = Record<string, any>;
type Page = "start" | "overview" | "master" | "procurement" | "sales" | "inventory" | "settings";

const page = ref<Page>("start");
const user = ref("");
const busy = ref(false);
const notice = ref("");
const error = ref("");
const profile = ref<Json>({});
const health = ref<Json>({});
const onboarding = ref<Json>({ stage: "loading", revision: 0 });
const overview = ref<Json>({});
const catalog = ref<Json>({ parties: [], products: [], units: [], locations: [] });
const procurement = ref<Json[]>([]);
const sales = ref<Json[]>([]);
const inventory = ref<Json>({ balances: [], movements: [] });
const settings = ref<Json>({});

const masterForm = reactive({ resource_kind: "party", resource_id: "", canonical_name: "", attributes: "{}" });
const orderForm = reactive({ order_id: "", party_id: "", line_id: "", product_id: "", unit_id: "", quantity: "1", location_id: "", ordered_at: new Date().toISOString().slice(0, 10), evidence_ref: "" });
const receiveForm = reactive({ order_id: "", line_id: "", quantity: "1", occurred_at: new Date().toISOString().slice(0, 16), evidence_ref: "" });
const movementForm = reactive({ action: "inbound", product_id: "", unit_id: "", quantity: "1", location_id: "", occurred_at: new Date().toISOString().slice(0, 16), reason: "手工业务调整" });
const passwordForm = reactive({ currentPassword: "", newPassword: "", confirmPassword: "", remember: true });

const activeParties = computed(() => catalog.value.parties.filter((item: Json) => item.status === "active"));
const activeProducts = computed(() => catalog.value.products.filter((item: Json) => item.status === "active"));
const activeUnits = computed(() => catalog.value.units.filter((item: Json) => item.status === "active"));
const activeLocations = computed(() => catalog.value.locations.filter((item: Json) => item.status === "active"));
const navigationItems = computed<Array<[Page, string]>>(() => {
  const items: Array<[Page, string]> = [["start", "开始使用"]];
  if (onboarding.value.stage === "enterprise_context_ready") {
    items.push(
      ["overview", "概览"],
      ["master", "基础资料"],
      ["procurement", "采购"],
      ["sales", "销售"],
      ["inventory", "库存"],
      ["settings", "设置"],
    );
  }
  return items;
});
const title = computed(() => ({
  start: "开始使用",
  overview: "经营概览",
  master: "基础资料",
  procurement: "采购",
  sales: "销售",
  inventory: "库存",
  settings: "设置",
})[page.value]);
const activeTradeKind = computed<"procurement" | "sales">(() => (
  page.value === "sales" ? "sales" : "procurement"
));

async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET") headers.set("X-BizHub-Request", "1");
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body.detail === "string" ? body.detail : body.detail?.code || body.detail?.message;
    throw new Error(detail || `request_failed:${response.status}`);
  }
  return body;
}

async function refresh() {
  const [nextProfile, nextHealth, nextOnboarding] = await Promise.all([
    api("/api/profile"),
    api("/api/health"),
    api("/api/workspace-onboarding/state"),
  ]);
  profile.value = nextProfile;
  health.value = nextHealth;
  onboarding.value = nextOnboarding;
  if (nextOnboarding.stage !== "enterprise_context_ready") return;
  const [nextOverview, nextCatalog, nextProcurement, nextSales, nextInventory] = await Promise.all([
    api("/api/delivery/overview"),
    api("/api/delivery/catalog"),
    api("/api/delivery/procurement/orders"),
    api("/api/delivery/sales/orders"),
    api("/api/delivery/inventory"),
  ]);
  overview.value = nextOverview;
  catalog.value = nextCatalog;
  procurement.value = nextProcurement.items;
  sales.value = nextSales.items;
  inventory.value = nextInventory;
}

async function enterEnterpriseContext() {
  busy.value = true;
  error.value = "";
  try {
    onboarding.value = await api("/api/workspace-onboarding/enter", {
      method: "POST",
      body: JSON.stringify({
        schema_version: "bizhub.workspace-onboarding-state.v1",
        expected_revision: onboarding.value.revision,
        idempotency_key: `desktop:${crypto.randomUUID()}`,
      }),
    });
    notice.value = "企业空间已准备好。你可以从一件小事开始。";
    await refresh();
  } catch (caught: any) {
    error.value = caught.message;
  } finally {
    busy.value = false;
  }
}

async function runOwner(path: string, command: Json, success: string) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const preview = await api(`${path}/preview`, { method: "POST", body: JSON.stringify(command) });
    if (!window.confirm(`确认执行？\n\n${JSON.stringify(preview, null, 2)}`)) return;
    await api(`${path}/apply`, { method: "POST", body: JSON.stringify(preview) });
    notice.value = success;
    await refresh();
  } catch (caught: any) {
    error.value = caught.message;
  } finally {
    busy.value = false;
  }
}

async function createMasterData() {
  busy.value = true;
  error.value = "";
  try {
    const draft = {
      resource_kind: masterForm.resource_kind,
      resource_id: masterForm.resource_id.trim(),
      canonical_name: masterForm.canonical_name.trim(),
      source_id: "desktop-ui",
      external_id: "",
      alias: "",
      attributes: JSON.parse(masterForm.attributes || "{}"),
    };
    const preview = await api("/api/master-data/catalog/preview", { method: "POST", body: JSON.stringify({ drafts: [draft] }) });
    if (!window.confirm(`确认保存这条基础资料？\n\n${JSON.stringify(preview, null, 2)}`)) return;
    await api("/api/master-data/catalog/apply", { method: "POST", body: JSON.stringify(preview) });
    notice.value = "基础资料已保存并核对。";
    masterForm.resource_id = "";
    masterForm.canonical_name = "";
    await refresh();
  } catch (caught: any) {
    error.value = caught.message;
  } finally {
    busy.value = false;
  }
}

function createOrder(kind: "procurement" | "sales") {
  const command: Json = {
    action: "create",
    idempotency_key: `desktop:${crypto.randomUUID()}`,
    order_id: orderForm.order_id.trim(),
    ordered_at: new Date(`${orderForm.ordered_at}T00:00:00`).toISOString(),
    lines: [{
      line_id: orderForm.line_id.trim(),
      product_id: orderForm.product_id,
      unit_id: orderForm.unit_id,
      quantity: orderForm.quantity,
      [kind === "sales" ? "ship_from_location_id" : "receive_location_id"]: orderForm.location_id,
    }],
    source_ref: "desktop-ui",
    evidence_refs: [orderForm.evidence_ref.trim()],
  };
  command[kind === "sales" ? "customer_party_id" : "supplier_party_id"] = orderForm.party_id;
  runOwner(`/api/${kind}`, command, `${kind === "sales" ? "销售" : "采购"}订单已保存并核对。`);
}

function fulfillOrder(kind: "procurement" | "sales") {
  runOwner(`/api/${kind}`, {
    action: kind === "sales" ? "fulfill" : "receive",
    idempotency_key: `desktop:${crypto.randomUUID()}`,
    order_id: receiveForm.order_id.trim(),
    target_line_id: receiveForm.line_id.trim(),
    quantity: receiveForm.quantity,
    occurred_at: new Date(receiveForm.occurred_at).toISOString(),
    source_ref: "desktop-ui",
    evidence_refs: [receiveForm.evidence_ref.trim()],
  }, kind === "sales" ? "销售发货已保存并核对。" : "采购收货已保存并核对。");
}

function postMovement() {
  runOwner("/api/inventory", {
    action: movementForm.action,
    idempotency_key: `desktop:${crypto.randomUUID()}`,
    product_id: movementForm.product_id,
    unit_id: movementForm.unit_id,
    quantity: movementForm.quantity,
    from_location_id: movementForm.action === "outbound" ? movementForm.location_id : null,
    to_location_id: movementForm.action === "inbound" ? movementForm.location_id : null,
    occurred_at: new Date(movementForm.occurred_at).toISOString(),
    source_ref: "desktop-ui",
    reason: movementForm.reason,
  }, "库存变动已保存并核对。");
}

async function loadSettings() {
  if (!window.bizhubLocalDesktop) return;
  settings.value = await window.bizhubLocalDesktop.getSettings();
  passwordForm.remember = Boolean(settings.value.remembered);
}

async function createBackup() {
  busy.value = true;
  try { settings.value.lastBackup = (await window.bizhubLocalDesktop.createBackup()).path; notice.value = "一致性备份已创建并验证。"; }
  catch (caught: any) { error.value = caught.message; }
  finally { busy.value = false; }
}

async function changePassword() {
  if (passwordForm.newPassword !== passwordForm.confirmPassword) { error.value = "两次新密码不一致。"; return; }
  busy.value = true;
  try {
    await window.bizhubLocalDesktop.changePassword({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword,
      remember: passwordForm.remember,
    });
    passwordForm.currentPassword = ""; passwordForm.newPassword = ""; passwordForm.confirmPassword = "";
    notice.value = "密码已更新，旧保持登录令牌已失效。";
    await loadSettings();
  } catch (caught: any) { error.value = caught.message; }
  finally { busy.value = false; }
}

async function openBackupFolder() {
  await window.bizhubLocalDesktop.openBackupFolder();
}

async function switchAccount() {
  await window.bizhubLocalDesktop.switchAccount();
}

async function forgetAccount() {
  if (window.confirm("确认退出并清除这个账号的保持登录？")) {
    await window.bizhubLocalDesktop.forgetAccount();
  }
}

async function selectPage(next: Page) {
  page.value = next;
  notice.value = "";
  error.value = "";
  if (next === "settings") await loadSettings();
}

onMounted(async () => {
  try {
    user.value = (await api("/api/auth/me")).username;
    await refresh();
    page.value = "start";
  } catch (caught: any) {
    error.value = caught.message || "请从 BizHub Desktop 打开本地工作区。";
  }
});
</script>

<template>
  <div class="shell">
    <aside>
      <div class="identity"><span>{{ profile.brand_mark || 'BH' }}</span><div><strong>{{ profile.display_name || 'BizHub' }}</strong><small>企业空间</small></div></div>
      <nav>
        <button v-for="item in navigationItems" :key="item[0]" :class="{ active: page === item[0] }" @click="selectPage(item[0])">{{ item[1] }}</button>
      </nav>
      <div class="account"><strong>{{ user || '本地管理员' }}</strong><small>{{ onboarding.data_authority_mode === 'local' ? '数据保存在这台电脑' : '企业云端空间' }}</small></div>
    </aside>

    <main class="workspace">
      <header><div><p>{{ profile.display_name || 'BIZHUB' }}</p><h1>{{ title }}</h1></div><button class="secondary" :disabled="busy" @click="refresh">刷新</button></header>
      <p v-if="notice" class="notice">{{ notice }}</p><p v-if="error" class="error">{{ error }}</p>

      <section v-if="page === 'start'" class="onboarding-workspace">
        <article v-if="onboarding.stage === 'loading'" class="onboarding-primary">
          <p class="eyebrow">正在准备</p>
          <h2>正在打开你的企业空间…</h2>
          <p>请稍等，不需要重复操作。</p>
        </article>
        <article v-else-if="onboarding.stage === 'workspace_ready'" class="onboarding-primary">
          <p class="eyebrow">首次进入</p>
          <h2>{{ profile.display_name || '企业空间' }} 已经创建好了</h2>
          <p>账号和独立数据空间都已准备好。进入后，系统才会开始接收这家企业的业务资料。</p>
          <dl class="readiness-list">
            <div><dt>账号</dt><dd>已安全登录</dd></div>
            <div><dt>数据位置</dt><dd>{{ onboarding.data_authority_mode === 'local' ? '只保存在这台电脑' : '保存在企业云端空间' }}</dd></div>
            <div><dt>当前资料</dt><dd>还是空的，不会放入演示数据</dd></div>
          </dl>
          <button :disabled="busy" @click="enterEnterpriseContext">进入我的企业空间</button>
        </article>
        <article v-else-if="onboarding.stage === 'enterprise_context_ready'" class="onboarding-primary">
          <p class="eyebrow">从一件小事开始</p>
          <h2>系统现在还是空的，这很正常</h2>
          <p>不用一次整理完全部资料。先选择你现在最想处理的一件事，之后可以随时回来继续。</p>
          <div class="first-task-grid">
            <button class="choice" @click="selectPage('master')"><strong>整理客户、供应商或产品</strong><span>先把最常用的基础资料放进来</span></button>
            <button class="choice" @click="selectPage('procurement')"><strong>记录一笔采购</strong><span>从正在发生的订单开始</span></button>
            <button class="choice" @click="selectPage('sales')"><strong>记录一笔销售</strong><span>先保存客户和订单来源</span></button>
            <button class="choice" @click="selectPage('inventory')"><strong>看看库存怎么记录</strong><span>从一个产品和地点开始</span></button>
          </div>
          <p class="quiet-note">还不确定也没关系。先停在这里，关闭后下次仍会从当前进度继续。</p>
        </article>
        <article v-else class="onboarding-primary">
          <p class="eyebrow">需要检查</p>
          <h2>企业空间暂时不能进入</h2>
          <p>请先点击右上角“刷新”。如果仍然没有恢复，再把页面上的错误信息发给技术支持。</p>
        </article>
      </section>

      <section v-if="page === 'overview'" class="metric-grid">
        <article><span>业务主体</span><strong>{{ overview.parties || 0 }}</strong></article>
        <article><span>产品</span><strong>{{ overview.products || 0 }}</strong></article>
        <article><span>采购订单</span><strong>{{ overview.procurement_orders || 0 }}</strong></article>
        <article><span>销售订单</span><strong>{{ overview.sales_orders || 0 }}</strong></article>
        <article><span>库存变动</span><strong>{{ overview.inventory_movements || 0 }}</strong></article>
        <article><span>实例状态</span><strong class="ok">{{ health.status === 'ok' ? '正常' : '检查中' }}</strong></article>
      </section>

      <section v-if="page === 'master'" class="two-column">
        <article class="panel"><h2>新增基础资料</h2><form @submit.prevent="createMasterData">
          <label>类型<select v-model="masterForm.resource_kind"><option value="party">业务主体</option><option value="product">产品</option><option value="unit">单位</option><option value="location">地点</option></select></label>
          <label>唯一 ID<input v-model="masterForm.resource_id" placeholder="例如 customer-demo" required></label>
          <label>名称<input v-model="masterForm.canonical_name" required></label>
          <label>附加属性 JSON<textarea v-model="masterForm.attributes" rows="4"></textarea></label>
          <button :disabled="busy">预览并写入</button>
        </form></article>
        <article class="panel"><h2>当前目录</h2><div v-for="group in ['parties','products','units','locations']" :key="group" class="catalog-group"><b>{{ group }}</b><span v-for="item in catalog[group]" :key="item.id">{{ item.canonical_name }} <small>{{ item.id }}</small></span></div></article>
      </section>

      <section v-if="page === 'procurement' || page === 'sales'" class="two-column">
        <article class="panel"><h2>新建{{ page === 'sales' ? '销售' : '采购' }}订单</h2><form @submit.prevent="createOrder(activeTradeKind)">
          <label>订单 ID<input v-model="orderForm.order_id" required></label><label>行 ID<input v-model="orderForm.line_id" required></label>
          <label>{{ page === 'sales' ? '客户' : '供应商' }}<select v-model="orderForm.party_id" required><option value="">请选择</option><option v-for="item in activeParties" :value="item.id">{{ item.canonical_name }}</option></select></label>
          <label>产品<select v-model="orderForm.product_id" required><option value="">请选择</option><option v-for="item in activeProducts" :value="item.id">{{ item.canonical_name }}</option></select></label>
          <label>单位<select v-model="orderForm.unit_id" required><option value="">请选择</option><option v-for="item in activeUnits" :value="item.id">{{ item.canonical_name }}</option></select></label>
          <label>地点<select v-model="orderForm.location_id" required><option value="">请选择</option><option v-for="item in activeLocations" :value="item.id">{{ item.canonical_name }}</option></select></label>
          <label>数量<input v-model="orderForm.quantity" type="number" min="0.000001" step="any" required></label><label>日期<input v-model="orderForm.ordered_at" type="date" required></label>
          <label>来源凭证<input v-model="orderForm.evidence_ref" placeholder="合同、邮件或单据编号" required></label>
          <button :disabled="busy">预览并创建</button>
        </form></article>
        <article class="panel"><h2>{{ page === 'sales' ? '确认发货' : '确认收货' }}</h2><form @submit.prevent="fulfillOrder(activeTradeKind)">
          <label>订单 ID<input v-model="receiveForm.order_id" required></label><label>行 ID<input v-model="receiveForm.line_id" required></label>
          <label>数量<input v-model="receiveForm.quantity" type="number" min="0.000001" step="any" required></label><label>发生时间<input v-model="receiveForm.occurred_at" type="datetime-local" required></label>
          <label>来源凭证<input v-model="receiveForm.evidence_ref" placeholder="收货、发货或签收单据编号" required></label>
          <button :disabled="busy">预览并确认</button>
        </form></article>
        <article class="panel wide"><h2>订单进度</h2><div class="order" v-for="order in page === 'sales' ? sales : procurement" :key="order.order_id"><div><strong>{{ order.order_id }}</strong><span>{{ order.party_name }} · {{ order.status }}</span></div><div v-for="line in order.lines" :key="line.line_id"><code>{{ line.line_id }}</code> {{ line.product_name }} · {{ line.quantity }} {{ line.unit_name }} · 已处理 {{ line.fulfilled_quantity ?? line.received_quantity }}</div></div><p v-if="!(page === 'sales' ? sales : procurement).length" class="empty">还没有订单。</p></article>
      </section>

      <section v-if="page === 'inventory'" class="two-column">
        <article class="panel"><h2>手工入库 / 出库</h2><form @submit.prevent="postMovement">
          <label>动作<select v-model="movementForm.action"><option value="inbound">入库</option><option value="outbound">出库</option></select></label>
          <label>产品<select v-model="movementForm.product_id" required><option value="">请选择</option><option v-for="item in activeProducts" :value="item.id">{{ item.canonical_name }}</option></select></label>
          <label>单位<select v-model="movementForm.unit_id" required><option value="">请选择</option><option v-for="item in activeUnits" :value="item.id">{{ item.canonical_name }}</option></select></label>
          <label>地点<select v-model="movementForm.location_id" required><option value="">请选择</option><option v-for="item in activeLocations" :value="item.id">{{ item.canonical_name }}</option></select></label>
          <label>数量<input v-model="movementForm.quantity" type="number" min="0.000001" step="any" required></label><label>发生时间<input v-model="movementForm.occurred_at" type="datetime-local" required></label>
          <label>原因<input v-model="movementForm.reason" minlength="3" required></label><button :disabled="busy">预览并写入</button>
        </form></article>
        <article class="panel"><h2>当前余额</h2><table><thead><tr><th>产品</th><th>地点</th><th>数量</th></tr></thead><tbody><tr v-for="row in inventory.balances"><td>{{ row.product_name }}</td><td>{{ row.location_name }}</td><td>{{ row.quantity }} {{ row.unit_name }}</td></tr></tbody></table><p v-if="!inventory.balances.length" class="empty">暂无库存余额。</p></article>
        <article class="panel wide"><h2>库存变动记录</h2><div class="movement" v-for="row in inventory.movements" :key="row.movement_id"><code>{{ row.movement_id }}</code><span>{{ row.movement_kind }} · {{ row.product_name }} · {{ row.quantity }} {{ row.unit_name }}</span><small>{{ row.occurred_at }}</small></div><p v-if="!inventory.movements.length" class="empty">暂无库存变动。</p></article>
      </section>

      <section v-if="page === 'settings'" class="two-column">
        <article class="panel"><h2>本地数据</h2><dl><dt>账号</dt><dd>{{ settings.accountId }}</dd><dt>客户端</dt><dd>{{ settings.appVersion }}</dd><dt>Runtime</dt><dd>{{ settings.runtimeVersion }}</dd><dt>最近备份</dt><dd>{{ settings.lastBackup || '尚未创建' }}</dd></dl><div class="actions"><button :disabled="busy" @click="createBackup">创建备份</button><button class="secondary" @click="openBackupFolder">打开备份目录</button></div></article>
        <article class="panel"><h2>修改密码</h2><form @submit.prevent="changePassword"><label>当前密码<input v-model="passwordForm.currentPassword" type="password" required></label><label>新密码（至少 12 位）<input v-model="passwordForm.newPassword" type="password" minlength="12" required></label><label>确认新密码<input v-model="passwordForm.confirmPassword" type="password" minlength="12" required></label><label class="check"><input v-model="passwordForm.remember" type="checkbox">继续保持登录</label><button :disabled="busy">更新密码</button></form></article>
        <article class="panel wide"><h2>账号</h2><p>切换账号不会删除本地数据；退出并清除保持登录后，下次需要重新输入密码。</p><div class="actions"><button class="secondary" @click="switchAccount">切换账号</button><button class="danger" @click="forgetAccount">退出并清除保持登录</button></div></article>
      </section>
    </main>
  </div>
</template>
