<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";

type Json = Record<string, any>;
type Page = "start" | "chat" | "knowledge" | "confirmations" | "opportunities" | "overview" | "master" | "procurement" | "sales" | "inventory" | "settings";

const page = ref<Page>("start");
const user = ref("");
const busy = ref(false);
const notice = ref("");
const error = ref("");
const profile = ref<Json>({});
const health = ref<Json>({});
const onboarding = ref<Json>({ stage: "loading", revision: 0 });
const cobuild = ref<Json>({
  revision: 0,
  views: { dialogue: { items: [] }, knowledge: { items: [] }, confirmations: { items: [] }, opportunities: { items: [], experience_cards: [] } },
  next_question: null,
  system_candidate: {
    status: "collecting",
    reusable_capabilities: [],
    private_capability_candidate: null,
    requirements: [],
    review_steps: [],
    safety: {},
  },
});
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
const answerForm = reactive({ text: "" });
const materialForm = reactive({ material_kind: "spreadsheet", display_name: "", summary: "" });

const activeParties = computed(() => catalog.value.parties.filter((item: Json) => item.status === "active"));
const activeProducts = computed(() => catalog.value.products.filter((item: Json) => item.status === "active"));
const activeUnits = computed(() => catalog.value.units.filter((item: Json) => item.status === "active"));
const activeLocations = computed(() => catalog.value.locations.filter((item: Json) => item.status === "active"));
const navigationItems = computed<Array<[Page, string]>>(() => {
  const items: Array<[Page, string]> = [["start", "开始使用"]];
  if (onboarding.value.stage === "enterprise_context_ready") {
    items.push(
      ["chat", "和助手聊聊"],
      ["knowledge", "我们已了解"],
      ["confirmations", "待确认"],
      ["opportunities", "改进机会"],
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
  chat: "和助手聊聊",
  knowledge: "我们已经了解什么",
  confirmations: "还有什么需要确认",
  opportunities: "我发现的改进机会",
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
  const [nextCobuild, nextOverview, nextCatalog, nextProcurement, nextSales, nextInventory] = await Promise.all([
    api("/api/workspace-cobuild/state"),
    api("/api/delivery/overview"),
    api("/api/delivery/catalog"),
    api("/api/delivery/procurement/orders"),
    api("/api/delivery/sales/orders"),
    api("/api/delivery/inventory"),
  ]);
  cobuild.value = nextCobuild;
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
    page.value = "chat";
  } catch (caught: any) {
    error.value = caught.message;
  } finally {
    busy.value = false;
  }
}

async function answerCobuild(answerKind: "answered" | "unknown" | "deferred" | "skipped") {
  if (!cobuild.value.next_question) return;
  if (answerKind === "answered" && !answerForm.text.trim()) {
    error.value = "先用一句话告诉我你的想法；如果暂时不知道，也可以直接跳过。";
    return;
  }
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    cobuild.value = await api("/api/workspace-cobuild/answers", {
      method: "POST",
      body: JSON.stringify({
        schema_version: "bizhub.workspace-cobuild-state.v1",
        expected_revision: cobuild.value.revision,
        question_id: cobuild.value.next_question.question_id,
        text: answerForm.text.trim(),
        answer_kind: answerKind,
        actor_ref: "desktop:authenticated-admin",
        idempotency_key: `desktop:${crypto.randomUUID()}`,
      }),
    });
    answerForm.text = "";
    notice.value = cobuild.value.system_candidate?.status === "candidate_review_required"
      ? "系统方案草案已经整理好，等你检查后再决定是否继续。"
      : cobuild.value.first_value_candidate
      ? "已经整理出一个可检查的候选，没有写入正式业务记录。"
      : "已记住你的选择，接下来只问一个新问题。";
  } catch (caught: any) {
    error.value = caught.message;
  } finally {
    busy.value = false;
  }
}

async function recordMaterial() {
  if (!materialForm.display_name.trim() || !materialForm.summary.trim()) {
    error.value = "请填写资料名称，并粘贴一小段内容或用一句话说明资料里有什么。";
    return;
  }
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    cobuild.value = await api("/api/workspace-cobuild/materials", {
      method: "POST",
      body: JSON.stringify({
        schema_version: "bizhub.workspace-cobuild-state.v1",
        expected_revision: cobuild.value.revision,
        material_kind: materialForm.material_kind,
        display_name: materialForm.display_name.trim(),
        summary: materialForm.summary.trim(),
        source_ref: `desktop:material-${crypto.randomUUID()}`,
        provided_by: "desktop:authenticated-admin",
        idempotency_key: `desktop:${crypto.randomUUID()}`,
      }),
    });
    materialForm.display_name = "";
    materialForm.summary = "";
    notice.value = cobuild.value.system_candidate?.status === "candidate_review_required"
      ? "资料线索已保留来源，系统方案草案已经可以检查。"
      : "资料线索已保存为带来源的候选，没有写入正式业务记录。";
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
          <p>不用先填表，也不用一次讲完整家公司。助手每次只问一个简单问题，先帮你整理出一件能检查的结果。</p>
          <button class="start-cobuild" @click="selectPage('chat')">和助手从一件小事开始</button>
          <p class="quiet-note">可以回答“不知道”、以后再说或直接跳过。关闭后会从同一进度继续。</p>
        </article>
        <article v-else class="onboarding-primary">
          <p class="eyebrow">需要检查</p>
          <h2>企业空间暂时不能进入</h2>
          <p>请先点击右上角“刷新”。如果仍然没有恢复，再把页面上的错误信息发给技术支持。</p>
        </article>
      </section>

      <section v-if="page === 'chat'" class="cobuild-layout">
        <article class="conversation-panel">
          <div class="section-heading"><div><p>一步一步来</p><h2>不用准备完整资料</h2></div><span class="candidate-badge" v-if="cobuild.first_value_candidate">已有可检查候选</span></div>
          <div class="conversation-list">
            <div v-for="message in cobuild.views.dialogue.items" :key="message.message_id" :class="['message', message.role]">
              <small>{{ message.role === 'agent' ? '助手' : '你' }}</small><p>{{ message.text }}</p>
            </div>
          </div>
          <div v-if="cobuild.next_question" class="current-question">
            <p class="question-reason">{{ cobuild.next_question.reason }}</p>
            <h3>{{ cobuild.next_question.prompt }}</h3>
            <div class="question-examples"><span v-for="example in cobuild.next_question.examples" :key="example">{{ example }}</span></div>
            <textarea v-model="answerForm.text" rows="4" placeholder="用平时说话的方式告诉我就行"></textarea>
            <div class="answer-actions">
              <button :disabled="busy" @click="answerCobuild('answered')">发送</button>
              <button class="secondary" :disabled="busy" @click="answerCobuild('unknown')">不知道</button>
              <button class="secondary" :disabled="busy" @click="answerCobuild('deferred')">以后再说</button>
              <button class="secondary" :disabled="busy" @click="answerCobuild('skipped')">先跳过</button>
            </div>
          </div>
          <div v-else class="conversation-complete"><strong>第一轮了解已经完成</strong><p>以后有新情况时仍可以继续补充，不会重新采访你。</p></div>
        </article>

        <article class="material-panel">
          <p class="eyebrow">也可以先给我一份资料</p>
          <h2>从你平时就在用的东西开始</h2>
          <p>粘贴一小段内容，或用一句话说明资料里有什么。这里不接收密码、验证码或登录密钥。</p>
          <form @submit.prevent="recordMaterial">
            <label>资料类型<select v-model="materialForm.material_kind"><option value="spreadsheet">表格</option><option value="chat">聊天记录</option><option value="image">图片</option><option value="screenshot">截图</option><option value="file">其他文件</option><option value="other">其他</option></select></label>
            <label>资料名称<input v-model="materialForm.display_name" placeholder="例如：每天使用的订单表.xlsx" maxlength="180" required></label>
            <label>粘贴一小段内容或说明<textarea v-model="materialForm.summary" rows="7" maxlength="4000" placeholder="例如：里面有客户、产品、数量和交期，客户名称经常有不同写法" required></textarea></label>
            <button :disabled="busy">保存为资料候选</button>
          </form>
          <p class="quiet-note">它只是一份带来源的候选。你确认前不会写入客户、订单、库存或启用任何模块。</p>
        </article>
      </section>

      <section v-if="page === 'knowledge'" class="cobuild-view">
        <div class="view-intro"><p>企业认识</p><h2>这些是目前从你和资料中了解到的内容</h2><span>每一条都保留来源；“待确认”不会被当成事实。</span></div>
        <div class="knowledge-list">
          <article v-for="item in cobuild.views.knowledge.items" :key="item.knowledge_id" class="knowledge-item">
            <div><span :class="['classification', item.classification]">{{ item.classification === 'user_confirmed' ? '你已说明' : item.classification === 'source_observed' ? '资料中看到' : '待确认' }}</span></div>
            <p>{{ item.statement }}</p>
            <footer>已保留来源记录</footer>
          </article>
          <p v-if="!cobuild.views.knowledge.items.length" class="empty-state">还没有企业认识。先和助手聊一句，或提供一份资料线索。</p>
        </div>
      </section>

      <section v-if="page === 'confirmations'" class="cobuild-view">
        <div class="view-intro"><p>少量待确认</p><h2>不知道也没关系，可以以后再补</h2><span>这些事项不会阻止你先拿到第一个有用结果。</span></div>
        <div class="confirmation-list">
          <article v-for="item in cobuild.views.confirmations.items" :key="item.confirmation_id" class="confirmation-item">
            <span>{{ item.status === 'unknown' ? '暂时不知道' : item.status === 'deferred' ? '以后再说' : '已跳过' }}</span>
            <h3>{{ item.title }}</h3><p>{{ item.reason }}</p>
          </article>
          <p v-if="!cobuild.views.confirmations.items.length" class="empty-state">目前没有待确认事项。</p>
        </div>
      </section>

      <section v-if="page === 'opportunities'" class="cobuild-view">
        <div class="view-intro"><p>候选，不是正式变更</p><h2>先看得懂、能检查，再决定要不要继续</h2><span>这里不会自动写业务数据、启用模块或修改系统规则。</span></div>
        <article class="system-candidate-panel">
          <div class="system-candidate-heading">
            <div><p>系统方案草案</p><h2>{{ cobuild.system_candidate?.status === 'candidate_review_required' ? '已经拼出第一版，等你检查' : '我会边了解，边把系统拼起来' }}</h2></div>
            <span :class="['system-status', cobuild.system_candidate?.status === 'candidate_review_required' ? 'ready' : 'collecting']">{{ cobuild.system_candidate?.status === 'candidate_review_required' ? '等你检查' : '资料收集中' }}</span>
          </div>
          <p class="system-summary">{{ cobuild.system_candidate?.summary || '先从一件实际工作开始，缺少的内容以后可以继续补。' }}</p>
          <div class="system-requirements">
            <div v-for="item in cobuild.system_candidate?.requirements || []" :key="item.requirement_id" :class="{ ready: item.status === 'ready' }">
              <span>{{ item.status === 'ready' ? '✓' : '·' }}</span><strong>{{ item.label }}</strong><small>{{ item.status === 'ready' ? '已有' : '还需要了解' }}</small>
            </div>
          </div>
          <div v-if="cobuild.system_candidate?.reusable_capabilities?.length" class="system-capability-section">
            <p>可以直接复用的通用能力</p>
            <div class="system-capability-grid">
              <article v-for="item in cobuild.system_candidate.reusable_capabilities" :key="item.capability_id">
                <span>已有基础</span><h3>{{ item.title }}</h3><p>{{ item.description }}</p><small>{{ item.reason }}</small>
              </article>
            </div>
          </div>
          <article v-if="cobuild.system_candidate?.private_capability_candidate" class="private-candidate">
            <span>需要单独设计</span><div><h3>{{ cobuild.system_candidate.private_capability_candidate.title }}</h3><p>{{ cobuild.system_candidate.private_capability_candidate.description }}</p></div>
          </article>
          <div class="system-review-steps">
            <div v-for="(step, index) in cobuild.system_candidate?.review_steps || []" :key="step.step_id" :class="{ active: step.status === 'ready' }">
              <span>{{ index + 1 }}</span><p>{{ step.label }}</p><small>{{ step.status === 'ready' ? '现在可以做' : '到这一步再确认' }}</small>
            </div>
          </div>
          <p class="system-safety-note">这只是草案，不会自动安装、写入业务数据或上线。</p>
        </article>
        <div class="opportunity-subheading"><p>逐项发现</p><h2>从对话和资料中整理出的候选</h2></div>
        <div class="opportunity-list">
          <article v-for="item in cobuild.views.opportunities.items" :key="item.candidate_id" class="opportunity-item">
            <span>可检查候选</span><h3>{{ item.title }}</h3><p>{{ item.summary }}</p><footer>{{ item.status === 'candidate_requires_confirmation' ? '等你确认后再讨论下一步' : item.status }}</footer>
          </article>
          <p v-if="!cobuild.views.opportunities.items.length" class="empty-state">聊一句或提供一份资料后，这里会出现第一个可检查候选。</p>
        </div>
        <div class="experience-section">
          <div><p>通用经验建议</p><h2>这些只帮助助手更会提问</h2></div>
          <div class="experience-list"><article v-for="card in cobuild.views.opportunities.experience_cards" :key="card.card_id"><span>建议，不是贵公司事实</span><h3>{{ card.title }}</h3><p>{{ card.suggestion }}</p><small>适用时：{{ card.applies_when }}</small></article></div>
        </div>
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
