<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api, ApiError, type Json } from "./api";

type SourceStatus = "received" | "prepared" | "needs_clarification" | "not_covered" | "applied";
type Disposition = "create_order" | "fulfill" | "needs_clarification" | "not_covered";
type StepState = "" | "done" | "current" | "stopped";

interface SourcePayload {
  source_ref: string;
  text: string;
  business_at: string;
  extra: unknown;
}

interface Proposal {
  disposition: Disposition;
  command: Json | null;
  command_digest: string | null;
  unsupported_details: Array<{ detail: string; handling: string }>;
  clarifications: string[];
  not_covered_reason: string;
}

interface SourceState extends SourcePayload {
  source_id: string;
  received_at: string;
  evidence_ref: string;
  status: SourceStatus;
  proposal: Proposal | null;
  preview: Json | null;
  preview_error: { code: string; message: string } | null;
  applied: Json | null;
}

interface SourceSummary {
  source_id: string;
  business_at: string;
  received_at: string;
  disposition: Disposition | null;
}

interface Balance {
  product_id: string;
  unit_id: string;
  location_id: string;
  quantity: string;
}

interface Issue {
  text: string;
  code: string;
}

const props = defineProps<{ catalog: Json }>();
const emit = defineEmits<{ refresh: [] }>();

const MAX_TEXT = 20000;
const SOURCES_PATH = "/api/sales/agent/sources";
const STEPS: Array<[string, string]> = [
  ["贴上原文", "说法乱一点也可以"],
  ["助手整理", "只整理，不入账"],
  ["你来确认", "看清楚再点"],
  ["入账并读回", "显示系统里的结果"],
];
const ORDER_STATUS: Record<string, string> = {
  open: "还没发货",
  partially_fulfilled: "部分已发货",
  fulfilled: "已全部发货",
  partially_returned: "部分退货",
  returned: "已退货",
  cancelled: "已取消",
};
const KIND_LABEL: Record<string, string> = {
  create_order: "新订单",
  fulfill: "发货",
  needs_clarification: "需补问",
  not_covered: "暂未入账",
};

const form = reactive({ text: "", label: "", receivedAt: localNow() });
const attempt = ref<SourcePayload | null>(null);
const sourceId = ref("");
const detail = ref<SourceState | null>(null);
const busy = ref(false);
const submitting = ref(false);
const issue = ref<Issue | null>(null);
const stale = ref(false);
const confirmSent = ref(false);
const readback = ref<{ order: Json | null; balances: Balance[] } | null>(null);
const sources = ref<SourceSummary[]>([]);
const sourcesError = ref("");

const proposal = computed(() => detail.value?.proposal ?? null);
const command = computed<Json | null>(() => detail.value?.preview?.command ?? proposal.value?.command ?? null);
const extras = computed(() => (proposal.value?.unsupported_details || []).filter((item) => item.handling === "recorded_not_executed"));
const canSubmit = computed(() => !busy.value && Boolean(form.text.trim()) && form.text.length <= MAX_TEXT);
const canConfirm = computed(() => {
  const state = detail.value;
  return Boolean(
    state
    && state.status === "prepared"
    && state.preview?.preview_digest
    && !state.preview_error
    && (state.proposal?.disposition === "create_order" || state.proposal?.disposition === "fulfill")
    && !confirmSent.value,
  );
});
const retryPayload = computed<SourcePayload | null>(() => {
  const state = detail.value;
  if (state?.status === "received") {
    return { source_ref: state.source_ref, text: state.text, business_at: state.business_at, extra: state.extra };
  }
  return sourceId.value ? null : attempt.value;
});
const steps = computed<StepState[]>(() => {
  const state = detail.value;
  if (submitting.value) return ["done", "current", "", ""];
  if (!sourceId.value) return attempt.value ? ["done", "stopped", "", ""] : ["current", "", "", ""];
  if (!state || state.status === "received") return ["done", "stopped", "", ""];
  if (state.status === "prepared") return canConfirm.value ? ["done", "done", "current", ""] : ["done", "done", "stopped", ""];
  if (state.status === "needs_clarification") return ["done", "done", "stopped", ""];
  if (state.status === "not_covered") return ["done", "done", "", "stopped"];
  return readback.value ? ["done", "done", "done", "done"] : ["done", "done", "done", "current"];
});
const fulfillPlan = computed(() => {
  const preview = detail.value?.preview;
  const inventory = preview?.inventory_preview;
  const movement = inventory?.planned_movements?.[0] ?? inventory?.command;
  if (!movement) return null;
  const before = (inventory.before_balances || []).find((item: Json) => item.location_id === movement.from_location_id)?.quantity;
  return {
    customer: preview?.planned_order?.customer_party_id || "",
    orderedAt: preview?.planned_order?.ordered_at || "",
    product: movement.product_id,
    unit: movement.unit_id,
    location: movement.from_location_id,
    before: before ?? null,
    after: before == null ? null : subtract(before, movement.quantity),
  };
});
const appliedView = computed(() => {
  const state = detail.value;
  if (!state?.applied) return null;
  const isFulfill = state.proposal?.disposition === "fulfill";
  // applied.lines / fulfillments describe the whole order now; pick the parts this source wrote.
  const shipments: Json[] = (state.applied.fulfillments || []).filter((item: Json) => String(item.evidence_refs_json || "").includes(state.evidence_ref));
  return {
    isFulfill,
    order: readback.value?.order ?? state.applied.order ?? {},
    lines: relevantLines(state).map((line): Json => ({
      ...line,
      shipped: shipments.length ? shipments.filter((item) => item.line_id === line.line_id).reduce((sum, item) => sum + Number(item.quantity), 0) : "未读到",
      remaining: subtract(line.quantity, line.fulfilled_quantity),
      balance: readback.value?.balances.find((item) => (
        item.product_id === line.product_id && item.unit_id === line.unit_id && item.location_id === line.ship_from_location_id
      ))?.quantity ?? null,
    })),
  };
});

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function localNow() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// datetime-local is wall-clock time; attach this machine's offset for that date instead of reading it as UTC.
function localIso(value: string) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`
    + `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function formatTime(value: string | null | undefined) {
  if (!value) return "未填写";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function subtract(left: unknown, right: unknown) {
  return String(Number((Number(left) - Number(right || 0)).toFixed(6)));
}

function nameOf(group: "parties" | "products" | "units" | "locations", id: string | null | undefined) {
  if (!id) return "未写明";
  return (props.catalog[group] || []).find((item: Json) => item.id === id)?.canonical_name || id;
}

function sourceLabel(state: SourceState) {
  const extra = state.extra as Json | null;
  return extra && !Array.isArray(extra) && typeof extra.source_label === "string" ? extra.source_label : "";
}

function relevantLines(state: SourceState): Json[] {
  const lines: Json[] = state.applied?.lines || [];
  const target = state.proposal?.disposition === "fulfill" ? state.proposal.command?.target_line_id : "";
  return target ? lines.filter((line) => line.line_id === target) : lines;
}

function failure(caught: unknown, text: string): Issue {
  return { text, code: caught instanceof ApiError ? caught.message : "network_error" };
}

async function loadList() {
  try {
    sources.value = (await api(`${SOURCES_PATH}?limit=50`)).items;
    sourcesError.value = "";
  } catch (caught) {
    sourcesError.value = caught instanceof ApiError ? caught.message : "network_error";
  }
}

async function readBack(state: SourceState) {
  const applied = state.applied || {};
  const orderId = applied.order?.order_id || state.proposal?.command?.order_id;
  const keys = new Map<string, Json>();
  for (const line of relevantLines(state)) {
    keys.set(`${line.product_id}|${line.unit_id}|${line.ship_from_location_id}`, line);
  }
  try {
    const [orders, ...balances] = await Promise.all([
      api("/api/sales/orders?limit=500"),
      ...[...keys.values()].map((line) => api(`/api/inventory/balance?${new URLSearchParams({
        product_id: line.product_id,
        unit_id: line.unit_id,
        location_id: line.ship_from_location_id,
      })}`)),
    ]);
    if (sourceId.value !== state.source_id) return;
    readback.value = { order: orders.items.find((item: Json) => item.order_id === orderId) ?? null, balances };
  } catch {
    // readback stays empty; the page offers "重新读取" instead of claiming success.
  }
}

// Once the server holds the attempted source, the local snapshot and draft are no longer needed.
function settleAttempt(state: SourceState) {
  if (attempt.value?.source_ref !== state.source_ref) return;
  attempt.value = null;
  Object.assign(form, { text: "", label: "", receivedAt: localNow() });
}

async function loadDetail(id: string) {
  const state: SourceState = await api(`${SOURCES_PATH}/${encodeURIComponent(id)}`);
  if (sourceId.value !== id) return;
  settleAttempt(state);
  detail.value = state;
  confirmSent.value = false;
  readback.value = null;
  if (state.status === "applied") await readBack(state);
}

function showSource(id: string) {
  sourceId.value = id;
  detail.value = null;
  readback.value = null;
  stale.value = false;
  confirmSent.value = false;
}

async function submitSource() {
  if (busy.value) return;
  let payload = retryPayload.value;
  if (!payload) {
    if (!canSubmit.value) return;
    const label = form.label.trim();
    payload = {
      source_ref: `ui:${crypto.randomUUID()}`,
      text: form.text,
      business_at: localIso(form.receivedAt),
      extra: label ? { source_label: label } : null,
    };
    attempt.value = payload;
  }
  busy.value = true;
  submitting.value = true;
  issue.value = null;
  try {
    const state: SourceState = await api(SOURCES_PATH, { method: "POST", body: JSON.stringify(payload) });
    settleAttempt(state);
    showSource(state.source_id);
    detail.value = state;
    if (state.status === "applied") await readBack(state);
  } catch (caught) {
    const savedId = caught instanceof ApiError && caught.status === 503 ? (caught.detail as Json | null)?.source_id : "";
    if (savedId) {
      issue.value = failure(caught, "原文已经保存，但助手这次没有整理完成，没有入账。可以稍后用同一条原文重试。");
      if (sourceId.value !== savedId) showSource(savedId);
      try {
        await loadDetail(savedId);
      } catch {
        // Keep the attempt snapshot so the retry still uses the same reference and content.
      }
    } else if (caught instanceof ApiError && caught.status < 500) {
      issue.value = failure(caught, "这条消息没有被接收，也没有入账。");
    } else {
      issue.value = failure(caught, "没有收到完整结果，原文可能已经保存。请用同一份内容重试，不会重复保存。");
    }
  } finally {
    busy.value = false;
    submitting.value = false;
    await loadList();
  }
}

function discardAttempt() {
  attempt.value = null;
  issue.value = null;
}

async function confirmProposal() {
  const state = detail.value;
  if (busy.value || !state || !canConfirm.value) return;
  busy.value = true;
  issue.value = null;
  stale.value = false;
  confirmSent.value = true;
  let rejected: Issue | null = null;
  let unknownCode = "";
  try {
    await api(`${SOURCES_PATH}/${encodeURIComponent(state.source_id)}/apply`, {
      method: "POST",
      body: JSON.stringify({ preview_digest: state.preview?.preview_digest }),
    });
  } catch (caught) {
    if (caught instanceof ApiError && caught.status < 500) {
      rejected = failure(caught, caught.message === "sales_agent_preview_stale"
        ? "内容或库存在你确认前发生了变化，这次没有入账。请重新核对最新内容，没问题再点确认。"
        : "系统没有接受这次确认，没有入账。");
    } else {
      unknownCode = failure(caught, "").code;
    }
  }
  try {
    await loadDetail(state.source_id);
  } catch {
    // confirmSent stays true: the confirm button stays hidden until a fresh read succeeds.
  }
  if (detail.value?.status === "applied") {
    emit("refresh");
  } else if (rejected) {
    issue.value = rejected;
    stale.value = rejected.code === "sales_agent_preview_stale" && !confirmSent.value;
  } else if (!confirmSent.value) {
    issue.value = { text: "这次确认没有成功，系统里还没有入账。请看清下面的内容后再决定。", code: unknownCode || detail.value?.status || "" };
  }
  busy.value = false;
  await loadList();
}

async function reread() {
  if (busy.value || !sourceId.value) return;
  busy.value = true;
  const awaitingConfirm = confirmSent.value;
  try {
    await loadDetail(sourceId.value);
    if (awaitingConfirm && detail.value?.status === "applied") emit("refresh");
  } catch (caught) {
    issue.value = failure(caught, "暂时读不到这条消息，请稍后再读取。");
  } finally {
    busy.value = false;
  }
}

async function openSource(id: string) {
  if (busy.value) return;
  showSource(id);
  issue.value = null;
  await reread();
}

function startNext(prefill = "") {
  showSource("");
  issue.value = null;
  if (prefill && !attempt.value) form.text = prefill;
}

async function refresh() {
  if (busy.value) return;
  await Promise.all([loadList(), sourceId.value ? reread() : undefined]);
}

defineExpose({ refresh });

onMounted(loadList);
</script>

<template>
  <section class="sales-agent">
    <p class="agent-intro">把客户发来的话原样贴进来，助手整理后由你确认，确认后才会入账。</p>
    <ol class="agent-steps">
      <li v-for="(step, index) in STEPS" :key="step[0]" :class="steps[index]"><span>{{ index + 1 }}</span><strong>{{ step[0] }}</strong><small>{{ step[1] }}</small></li>
    </ol>

    <article v-if="!sourceId" class="agent-card">
      <p class="eyebrow">第 1 步</p>
      <h2>客户怎么说的，就怎么贴</h2>
      <p class="agent-lead">不用先整理成表格。改口、口头简称、附带的包装要求都可以留着，助手会按最新说法理解。</p>
      <label class="agent-field">消息原文
        <textarea v-model="form.text" rows="6" :maxlength="MAX_TEXT" :readonly="Boolean(attempt)" placeholder="把聊天、邮件或电话记录里的原话粘贴到这里"></textarea>
        <small>{{ form.text.length }} / {{ MAX_TEXT }}</small>
      </label>
      <div class="agent-field-row">
        <label class="agent-field">这条消息来自哪里（方便以后查找）<input v-model="form.label" maxlength="120" :readonly="Boolean(attempt)" placeholder="例如：微信群、邮件、电话记录"></label>
        <label class="agent-field">收到时间<input v-model="form.receivedAt" type="datetime-local" :readonly="Boolean(attempt)"></label>
      </div>
      <p class="agent-scope"><b>目前能入账的只有两件事：</b>建立一张新的销售订单；给已有订单登记一次实际发货。<br>报价、付款、退货、取消、改单、分多次发货等内容会保存原文，但这次不会入账。</p>
      <p v-if="issue" class="agent-issue">{{ issue.text }}<code>{{ issue.code }}</code></p>
      <div class="agent-actions">
        <button :disabled="busy || (!attempt && !canSubmit)" @click="submitSource">{{ submitting ? '助手正在整理，请稍等…' : attempt ? '用同一份内容重试' : '交给助手整理' }}</button>
        <button v-if="attempt" class="secondary" :disabled="busy" @click="discardAttempt">改为新消息重新编辑</button>
      </div>
      <p class="agent-quiet">目前请复制粘贴文字。直接读文件、连接微信或邮件、语音输入还没有接通。</p>
    </article>

    <article v-else-if="!detail" class="agent-card">
      <p class="eyebrow">读取中</p>
      <h2>{{ busy ? '正在从系统读取这条消息…' : '暂时读不到这条消息' }}</h2>
      <p v-if="issue" class="agent-issue">{{ issue.text }}<code>{{ issue.code }}</code></p>
      <div class="agent-actions">
        <button :disabled="busy" @click="reread">重新读取</button>
        <button class="secondary" :disabled="busy" @click="startNext()">处理下一条消息</button>
      </div>
    </article>

    <div v-else class="agent-review">
      <div class="agent-source">
        <p class="eyebrow">原文（已保存）</p>
        <blockquote>{{ detail.text }}</blockquote>
        <footer>{{ sourceLabel(detail) || '未写来源' }} · 收到时间 {{ formatTime(detail.business_at || detail.received_at) }}<br>原文不会被修改，确认前不会写入订单或库存。</footer>
      </div>

      <article class="agent-card">
        <template v-if="detail.status === 'received'">
          <div class="agent-head"><div><p class="eyebrow">第 2 步 · 助手整理</p><h2>原文已保存，助手还没整理完</h2></div><span class="agent-tag stop">尚未完成</span></div>
          <div class="agent-outcome stop"><strong>本条没有入账</strong>还没有可以确认的内容。可以用同一条原文重新整理，不会重复保存。</div>
          <p v-if="issue" class="agent-issue">{{ issue.text }}<code>{{ issue.code }}</code></p>
          <div class="agent-actions">
            <button :disabled="busy" @click="submitSource">{{ submitting ? '助手正在整理，请稍等…' : '用同一条原文重试' }}</button>
            <button class="secondary" :disabled="busy" @click="startNext()">处理下一条消息</button>
          </div>
        </template>

        <template v-else-if="detail.status === 'prepared' && command">
          <div class="agent-head">
            <div><p class="eyebrow">第 3 步 · 助手的整理</p><h2>{{ proposal?.disposition === 'fulfill' ? '给已有订单登记一次实际发货' : '建立一张新的销售订单' }}</h2></div>
            <span :class="['agent-tag', canConfirm ? 'pending' : 'stop']">{{ canConfirm ? '等你确认' : '暂不能确认' }}</span>
          </div>
          <p v-if="stale" class="agent-issue">{{ issue?.text }}<code>{{ issue?.code }}</code></p>
          <dl v-if="proposal?.disposition === 'create_order'" class="agent-facts">
            <div><dt>客户</dt><dd>{{ nameOf('parties', command.customer_party_id) }}</dd></div>
            <div><dt>下单时间</dt><dd>{{ formatTime(command.ordered_at) }}</dd></div>
            <div v-for="line in command.lines" :key="line.line_id"><dt>商品</dt><dd>{{ nameOf('products', line.product_id) }} · {{ line.quantity }} {{ nameOf('units', line.unit_id) }}<small>从 {{ nameOf('locations', line.ship_from_location_id) }} 出货</small></dd></div>
          </dl>
          <dl v-else class="agent-facts">
            <div><dt>订单</dt><dd>{{ fulfillPlan ? nameOf('parties', fulfillPlan.customer) : '已有订单' }}<small>{{ fulfillPlan?.orderedAt ? `下单 ${formatTime(fulfillPlan.orderedAt)} · ` : '' }}订单号 {{ command.order_id }}</small></dd></div>
            <div v-if="fulfillPlan"><dt>商品</dt><dd>{{ nameOf('products', fulfillPlan.product) }}</dd></div>
            <div><dt>本次发货</dt><dd>{{ command.quantity }} {{ fulfillPlan ? nameOf('units', fulfillPlan.unit) : '' }}</dd></div>
            <div><dt>发货时间</dt><dd>{{ formatTime(command.occurred_at) }}</dd></div>
            <div v-if="fulfillPlan"><dt>从哪里出</dt><dd>{{ nameOf('locations', fulfillPlan.location) }}</dd></div>
          </dl>
          <template v-if="extras.length">
            <p class="agent-subhead">原文里的附加要求（已记录，待人工执行）</p>
            <ul class="agent-extras"><li v-for="(item, index) in extras" :key="index">{{ item.detail }}<small>已记录，待人工执行</small></li></ul>
          </template>
          <p v-if="proposal?.disposition === 'create_order'" class="agent-stock-note"><b>建单不会扣库存。</b>等实际发货时，再贴一条发货消息登记出库。</p>
          <p v-else-if="fulfillPlan" class="agent-stock-note"><b>确认后会出库 {{ command.quantity }} {{ nameOf('units', fulfillPlan.unit) }}。</b>{{ nameOf('locations', fulfillPlan.location) }}现有 {{ fulfillPlan.before ?? '未知' }}<template v-if="fulfillPlan.after !== null">，确认后为 {{ fulfillPlan.after }}</template>。</p>
          <div v-if="detail.preview_error" class="agent-outcome stop"><strong>现在不能确认，没有入账</strong>系统核对没有通过，请人工检查后再处理。<code>{{ detail.preview_error.code }}</code></div>
          <p v-if="issue && !stale" class="agent-issue">{{ issue.text }}<code>{{ issue.code }}</code></p>
          <div v-if="confirmSent" class="agent-outcome stop"><strong>确认请求已提交，读回尚未完成</strong>请先重新读取，不要重复确认。</div>
          <div class="agent-actions">
            <button v-if="canConfirm" :disabled="busy" @click="confirmProposal">{{ busy ? '正在确认…' : proposal?.disposition === 'fulfill' ? '确认登记发货' : '确认建立订单' }}</button>
            <button v-else :disabled="busy" @click="reread">重新读取</button>
            <button class="secondary" :disabled="busy" @click="startNext()">先不入账，处理下一条</button>
          </div>
          <p class="agent-quiet">选“先不入账”只会留下原文，订单和库存都不会变；以后可以在“已保存的消息”里继续。</p>
        </template>

        <template v-else-if="detail.status === 'needs_clarification'">
          <div class="agent-head"><div><p class="eyebrow">第 3 步 · 助手的整理</p><h2>还缺几个信息，暂时不能入账</h2></div><span class="agent-tag stop">需补问</span></div>
          <p class="agent-subhead">需要先问清楚</p>
          <ul class="agent-extras"><li v-for="(question, index) in proposal?.clarifications || []" :key="index">{{ question }}</li></ul>
          <template v-if="extras.length">
            <p class="agent-subhead">原文里的附加要求（已记录，待人工执行）</p>
            <ul class="agent-extras"><li v-for="(item, index) in extras" :key="index">{{ item.detail }}<small>已记录，待人工执行</small></li></ul>
          </template>
          <p class="agent-quiet">这条原文不会被改写。问清楚后，把补齐后的完整说法作为一条新消息提交。</p>
          <div class="agent-actions">
            <button :disabled="busy" @click="startNext(detail.text)">补齐后作为新消息提交</button>
            <button class="secondary" :disabled="busy" @click="startNext()">处理下一条消息</button>
          </div>
        </template>

        <template v-else-if="detail.status === 'not_covered'">
          <div class="agent-head"><div><p class="eyebrow">第 2 步 · 助手的整理</p><h2>这条消息这次不能入账</h2></div><span class="agent-tag stop">未入账</span></div>
          <div class="agent-outcome stop"><strong>原文已保存，本条暂未入账</strong>{{ proposal?.not_covered_reason }}</div>
          <dl class="agent-facts"><div><dt>订单 / 库存</dt><dd>都没有变化</dd></div></dl>
          <template v-if="extras.length">
            <p class="agent-subhead">原文里的其他内容（已记录，待人工执行）</p>
            <ul class="agent-extras"><li v-for="(item, index) in extras" :key="index">{{ item.detail }}<small>已记录，待人工执行</small></li></ul>
          </template>
          <p class="agent-quiet">请人工跟进。如果之后收到下单或发货的消息，再贴进来处理。</p>
          <div class="agent-actions"><button :disabled="busy" @click="startNext()">处理下一条消息</button></div>
        </template>

        <template v-else-if="detail.status === 'applied' && appliedView">
          <div class="agent-head"><div><p class="eyebrow">第 4 步 · 从系统重新读出</p><h2>{{ appliedView.isFulfill ? '发货已登记' : '订单已保存' }}</h2></div><span class="agent-tag saved">已入账</span></div>
          <template v-if="readback">
            <div class="agent-readback">
              <div>
                <span>销售订单</span>
                <b>{{ nameOf('parties', appliedView.order.customer_party_id) }} · {{ ORDER_STATUS[appliedView.order.status] || appliedView.order.status }}</b>
                <small>下单 {{ formatTime(appliedView.order.ordered_at) }} · 订单号 {{ appliedView.order.order_id }}</small>
              </div>
              <div v-for="line in appliedView.lines" :key="line.line_id">
                <span>{{ nameOf('products', line.product_id) }}</span>
                <b v-if="appliedView.isFulfill">本次发货 {{ line.shipped }} {{ nameOf('units', line.unit_id) }}</b>
                <b v-else>订购 {{ line.quantity }} {{ nameOf('units', line.unit_id) }}</b>
                <small>订单 {{ line.quantity }} · 累计已发 {{ line.fulfilled_quantity }} · 剩余 {{ line.remaining }}</small>
                <small>{{ nameOf('locations', line.ship_from_location_id) }}现有 {{ line.balance ?? '未读到' }} {{ nameOf('units', line.unit_id) }}{{ appliedView.isFulfill ? '' : '（建单不扣库存，实际发货后才会减少）' }}</small>
              </div>
            </div>
          </template>
          <div v-else class="agent-outcome stop"><strong>确认请求已提交，读回尚未完成</strong>请点“重新读取”，不要重复建单或发货。</div>
          <template v-if="extras.length">
            <p class="agent-subhead">待人工执行（已随记录保存，系统没有执行）</p>
            <ul class="agent-extras"><li v-for="(item, index) in extras" :key="index">{{ item.detail }}<small>已记录，待人工执行</small></li></ul>
          </template>
          <div class="agent-actions">
            <button :disabled="busy" @click="startNext()">处理下一条消息</button>
            <button v-if="!readback" class="secondary" :disabled="busy" @click="reread">重新读取</button>
          </div>
        </template>

        <template v-else>
          <div class="agent-outcome stop"><strong>暂时不能处理这条消息</strong>没有入账。<code>{{ detail.status }}</code></div>
          <div class="agent-actions"><button :disabled="busy" @click="reread">重新读取</button><button class="secondary" :disabled="busy" @click="startNext()">处理下一条消息</button></div>
        </template>
      </article>
    </div>

    <details class="agent-history">
      <summary>已保存的消息（{{ sources.length }}）</summary>
      <p v-if="sourcesError" class="agent-issue">暂时读不到列表<code>{{ sourcesError }}</code></p>
      <p v-else-if="!sources.length" class="agent-quiet">还没有保存过消息。</p>
      <ul>
        <li v-for="item in sources" :key="item.source_id">
          <button :class="{ active: item.source_id === sourceId }" :disabled="busy" @click="openSource(item.source_id)">
            <span>{{ formatTime(item.business_at || item.received_at) }}</span><small>{{ item.disposition ? KIND_LABEL[item.disposition] : '尚未整理' }}</small>
          </button>
        </li>
      </ul>
      <p class="agent-quiet">选择一条消息，查看原文和处理结果。</p>
    </details>
  </section>
</template>
