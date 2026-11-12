<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { api, ApiError, type Json } from "./api";

interface OwnerOptions {
  describe: (preview: Json) => string;
  noop: string;
  verify: () => Promise<string>;
}

const props = defineProps<{
  catalog: Json;
  busy: boolean;
  run: (path: string, command: Json, success: string, options: OwnerOptions) => Promise<void>;
}>();

const PATH = "/api/sales/services";
const MONEY = /^\d+(\.\d{1,2})?$/;

const businessDay = localDate();
const contracts = ref<Json[]>([]);
const loaded = ref(false);
const loadError = ref("");
const formIssue = ref("");
const selectedId = ref("");
const creating = ref(false);
const createForm = reactive({ order_id: "", party_id: "", date: businessDay, service_name: "", quantity: "1", unit_price: "" });
const acceptForm = reactive({ line_id: "", quantity: "1", date: businessDay, evidence: "", accepted_by: "" });

const customers = computed(() => (props.catalog.parties || []).filter((item: Json) => item.status === "active"));
const selected = computed(() => contracts.value.find((item) => item.order_id === selectedId.value) ?? null);
const draftTotal = computed(() => {
  const count = wholeCount(createForm.quantity);
  return count && MONEY.test(createForm.unit_price.trim()) ? lineTotal(createForm.unit_price.trim(), count) : "";
});
const acceptLine = computed(() => selected.value?.lines.find((line: Json) => line.line_id === acceptForm.line_id) ?? null);
const history = computed(() => [...(selected.value?.acceptances || [])].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))));

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A business date is the local calendar day; send local midnight with this machine's offset.
function dateIso(value: string) {
  const offset = -new Date(`${value}T00:00:00`).getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${value}T00:00:00${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function showDate(value: unknown) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? String(value || "未填写") : localDate(date);
}

function sameDay(left: unknown, right: unknown) {
  return showDate(left) === showDate(right);
}

function wholeCount(value: unknown) {
  const text = String(value ?? "").trim();
  return /^\d+(\.0+)?$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0 ? Number.parseInt(text, 10) : 0;
}

function count(value: unknown) {
  return Number.parseInt(String(value ?? "0"), 10) || 0;
}

// Draft estimates use integer cents. Saved amounts come from the contract readback.
function money(text: string) {
  const [whole, fraction = ""] = text.split(".");
  return `${BigInt(whole)}.${fraction.padEnd(2, "0")}`;
}

function lineTotal(price: string, times: number) {
  const cents = BigInt(money(price).replace(".", "")) * BigInt(times);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function currencyLabel(currency: string) {
  return currency === "CNY" ? "元" : currency;
}

function progress(contract: Json) {
  const lines: Json[] = contract.lines || [];
  const total = lines.reduce((sum, line) => sum + count(line.quantity), 0);
  const accepted = lines.reduce((sum, line) => sum + count(line.accepted_quantity), 0);
  return { total, accepted, remaining: lines.reduce((sum, line) => sum + count(line.remaining_quantity), 0) };
}

function stateLabel(contract: Json) {
  const { accepted, remaining } = progress(contract);
  if (!remaining) return "已全部签收";
  return accepted ? "部分已签收" : "未开始签收";
}

function partyName(id: unknown) {
  return (props.catalog.parties || []).find((item: Json) => String(item.id) === String(id))?.canonical_name || `客户 ${id}`;
}

function lineName(contract: Json | null, lineId: unknown) {
  return contract?.lines.find((line: Json) => line.line_id === lineId)?.service_name || "未知服务项目";
}

function pickContract(id: string) {
  selectedId.value = id;
  creating.value = false;
  formIssue.value = "";
  const line = selected.value?.lines.find((item: Json) => count(item.remaining_quantity) > 0) ?? selected.value?.lines[0];
  acceptForm.line_id = line?.line_id ?? "";
}

async function load() {
  try {
    const next: Json[] = (await api(PATH)).contracts || [];
    contracts.value = next;
    loadError.value = "";
    if (!creating.value && !selected.value && next.length) pickContract(next[0].order_id);
    else if (!creating.value && selected.value && !acceptLine.value) pickContract(selectedId.value);
  } catch (caught) {
    // Keep what was last read from Owner on screen; only say that this read failed.
    loadError.value = caught instanceof ApiError ? caught.message : "network_error";
  } finally {
    loaded.value = true;
  }
}

async function reread(orderId: string, check: (contract: Json | null) => string) {
  await load();
  if (loadError.value) return "已提交，但暂时读不回系统里的记录，请点“重新读取”核对，不要换号重做。";
  return check(contracts.value.find((item) => item.order_id === orderId) ?? null);
}

async function submit(command: Json, success: string, options: OwnerOptions) {
  let checked = false;
  await props.run(PATH, command, success, {
    ...options,
    verify: async () => { checked = true; return options.verify(); },
  });
  if (!checked) await load();
}

function startCreate() {
  creating.value = true;
  formIssue.value = "";
}

function createContract() {
  const orderId = createForm.order_id.trim();
  const serviceName = createForm.service_name.trim();
  const unitPrice = createForm.unit_price.trim();
  const times = wholeCount(createForm.quantity);
  formIssue.value = "";
  if (!orderId || !createForm.party_id || !serviceName || !createForm.date) { formIssue.value = "请填写合同号、客户、服务项目和签约日期。"; return; }
  if (!times) { formIssue.value = "服务次数要填正整数。"; return; }
  if (!MONEY.test(unitPrice)) { formIssue.value = "每次单价按金额填写，最多两位小数，例如 450.00。"; return; }
  const customerId = Number(createForm.party_id);
  const command: Json = {
    action: "create",
    idempotency_key: `desktop:${JSON.stringify(["sales-service", "create", orderId])}`,
    order_id: orderId,
    customer_party_id: customerId,
    occurred_at: dateIso(createForm.date),
    currency: "CNY",
    source_ref: orderId,
    lines: [{ line_id: JSON.stringify(["service", orderId, 1]), service_name: serviceName, quantity: times, unit_price: unitPrice }],
  };
  const total = lineTotal(unitPrice, times);
  submit(command, `服务合同 ${orderId} 已保存，并已从系统重新读出。`, {
    noop: `服务合同 ${orderId} 之前已经建立，这次没有重复记录。`,
    describe: (preview) => {
      const c = preview.command ?? command;
      const line = c.lines?.[0] ?? command.lines[0];
      return [
        "确认建立这份服务合同？",
        "",
        `合同号：${c.order_id}`,
        `客户：${partyName(c.customer_party_id)}`,
        `签约日期：${showDate(c.occurred_at)}`,
        `服务项目：${line.service_name}`,
        `服务次数：${line.quantity} 次`,
        `每次单价：${money(line.unit_price)} 元`,
        `合同总额：${lineTotal(String(line.unit_price), count(line.quantity))} 元`,
      ].join("\n");
    },
    verify: () => reread(orderId, (contract) => {
      if (!contract) return `已提交，但重新读取时没有找到合同 ${orderId}，请点“重新读取”核对。`;
      pickContract(orderId);
      const line = contract.lines?.length === 1 ? contract.lines[0] : null;
      const same = line
        && contract.currency === command.currency
        && String(contract.customer_party_id) === String(customerId)
        && sameDay(contract.occurred_at, command.occurred_at)
        && line.service_name === serviceName
        && count(line.quantity) === times
        && line.unit_price === money(unitPrice)
        && contract.total_amount === total;
      return same ? "" : `系统里已有合同号 ${orderId}，但内容和这次填写的不一致，这次填写的内容没有被确认。请核对下面的已有合同。`;
    }),
  });
}

function acceptService() {
  const contract = selected.value;
  const line = acceptLine.value;
  const evidence = acceptForm.evidence.trim();
  const acceptedBy = acceptForm.accepted_by.trim();
  const times = wholeCount(acceptForm.quantity);
  formIssue.value = "";
  if (!contract || !line) { formIssue.value = "请先选择合同和服务项目。"; return; }
  if (!evidence || !acceptedBy || !acceptForm.date) { formIssue.value = "请填写签收凭证号、签收人和签收日期。"; return; }
  if (!times) { formIssue.value = "本次签收次数要填正整数。"; return; }
  const orderId = String(contract.order_id);
  const lineId = String(line.line_id);
  const command: Json = {
    action: "accept",
    idempotency_key: `desktop:${JSON.stringify(["sales-service", "accept", orderId, lineId, evidence])}`,
    order_id: orderId,
    line_id: lineId,
    acceptance_id: JSON.stringify([lineId, evidence]),
    quantity: times,
    occurred_at: dateIso(acceptForm.date),
    source_ref: evidence,
    accepted_by: acceptedBy,
  };
  const customer = partyName(contract.customer_party_id);
  const serviceName = String(line.service_name);
  const remainingBefore = count(line.remaining_quantity);
  submit(command, `签收 ${evidence} 已登记，并已从系统重新读出。`, {
    noop: `签收凭证 ${evidence} 之前已经登记，这次没有重复记录。`,
    describe: (preview) => {
      const c = preview.command ?? command;
      return [
        "确认登记这次服务签收？",
        "",
        `合同号：${c.order_id}`,
        `客户：${customer}`,
        `服务项目：${lineName(contract, c.line_id)}`,
        `本次签收：${c.quantity} 次`,
        `签收日期：${showDate(c.occurred_at)}`,
        `签收凭证：${c.source_ref}`,
        `签收人：${c.accepted_by}`,
        `合同共 ${count(line.quantity)} 次，签收前待办 ${remainingBefore} 次`,
      ].join("\n");
    },
    verify: () => reread(orderId, (fresh) => {
      const row = fresh?.acceptances?.find((item: Json) => item.acceptance_id === command.acceptance_id);
      if (!row) return `已提交，但重新读取时没有找到签收凭证 ${evidence}，请点“重新读取”核对。`;
      const same = row.line_id === lineId
        && count(row.quantity) === times
        && row.accepted_by === acceptedBy
        && row.source_ref === evidence
        && sameDay(row.occurred_at, command.occurred_at);
      if (!same) return `签收凭证 ${evidence} 之前已登记过，但内容和这次填写的不一致，这次填写的内容没有被确认。请核对下面的签收记录。`;
      acceptForm.evidence = "";
      return "";
    }),
  });
}

defineExpose({ refresh: load });

onMounted(load);
</script>

<template>
  <section class="service-desk">
    <p v-if="loadError" class="agent-issue">暂时读不到服务合同，下面是上次读到的内容。<code>{{ loadError }}</code><button class="secondary" :disabled="busy" @click="load">重新读取</button></p>

    <div class="service-layout">
      <div class="service-list">
        <div class="service-list-head"><strong>服务合同（{{ contracts.length }}）</strong><button class="secondary" :disabled="busy" @click="startCreate">新建合同</button></div>
        <p v-if="!loaded" class="empty">正在读取…</p>
        <p v-else-if="!contracts.length" class="empty">还没有服务合同。</p>
        <button v-for="item in contracts" :key="item.order_id" :class="{ active: !creating && item.order_id === selectedId }" @click="pickContract(item.order_id)">
          <span><b>{{ item.order_id }}</b><small>{{ partyName(item.customer_party_id) }}</small></span>
          <span class="service-meter"><i :style="{ width: `${progress(item).total ? progress(item).accepted / progress(item).total * 100 : 0}%` }"></i></span>
          <small>已签 {{ progress(item).accepted }} / {{ progress(item).total }} 次 · 合同总额 {{ item.total_amount }} {{ currencyLabel(item.currency) }}</small>
        </button>
      </div>

      <article v-if="!loaded" class="agent-card"><p class="empty">正在从系统读取服务合同…</p></article>

      <article v-else-if="creating || !selected" class="agent-card">
        <div class="agent-head"><div><p class="eyebrow">新建</p><h2>建立一份服务合同</h2></div></div>
        <form class="service-form" @submit.prevent="createContract">
          <label>合同号<input v-model="createForm.order_id" placeholder="纸质或电子合同上的编号" maxlength="120" required></label>
          <label>客户<select v-model="createForm.party_id" required><option value="">请选择</option><option v-for="item in customers" :key="item.id" :value="String(item.id)">{{ item.canonical_name }}</option></select></label>
          <label class="span">服务项目<input v-model="createForm.service_name" placeholder="例如：上门维护" maxlength="200" required></label>
          <label>服务次数<input v-model="createForm.quantity" type="number" min="1" step="1" required></label>
          <label>每次单价（元）<input v-model="createForm.unit_price" inputmode="decimal" placeholder="450.00" required></label>
          <label>签约日期<input v-model="createForm.date" type="date" required></label>
          <div class="service-total"><span>合同总额</span><b>{{ draftTotal ? `${draftTotal} 元` : '—' }}</b><small>次数 × 每次单价</small></div>
          <p v-if="formIssue" class="agent-issue span">{{ formIssue }}</p>
          <button :disabled="busy">预览并建立合同</button>
        </form>
        <p v-if="!customers.length" class="agent-quiet">客户列表是空的，请先在“基础资料”里添加客户。</p>
      </article>

      <div v-else class="service-detail">
        <article class="agent-card">
          <div class="agent-head">
            <div><p class="eyebrow">服务合同</p><h2>{{ selected.order_id }}</h2></div>
            <span :class="['agent-tag', progress(selected).remaining ? 'pending' : 'saved']">{{ stateLabel(selected) }}</span>
          </div>
          <dl class="service-facts">
            <div><dt>客户</dt><dd>{{ partyName(selected.customer_party_id) }}</dd></div>
            <div><dt>签约日期</dt><dd>{{ showDate(selected.occurred_at) }}</dd></div>
            <div><dt>合同总额</dt><dd>{{ selected.total_amount }} {{ currencyLabel(selected.currency) }}</dd></div>
            <div><dt>签收进度</dt><dd>已签 {{ progress(selected).accepted }} 次 · 待办 {{ progress(selected).remaining }} 次</dd></div>
          </dl>
          <table class="service-table">
            <thead><tr><th>服务项目</th><th>次数</th><th>每次单价</th><th>小计</th><th>已签</th><th>待办</th></tr></thead>
            <tbody><tr v-for="line in selected.lines" :key="line.line_id"><td>{{ line.service_name }}</td><td>{{ count(line.quantity) }}</td><td>{{ line.unit_price }} {{ currencyLabel(selected.currency) }}</td><td>{{ line.amount }} {{ currencyLabel(selected.currency) }}</td><td>{{ count(line.accepted_quantity) }}</td><td><b>{{ count(line.remaining_quantity) }}</b></td></tr></tbody>
          </table>
        </article>

        <article class="agent-card">
          <div class="agent-head"><div><p class="eyebrow">履约</p><h2>登记一次签收</h2></div></div>
          <form class="service-form" @submit.prevent="acceptService">
            <label class="span">服务项目<select v-model="acceptForm.line_id" required><option v-for="line in selected.lines" :key="line.line_id" :value="line.line_id">{{ line.service_name }}（待办 {{ count(line.remaining_quantity) }} 次）</option></select></label>
            <label>本次签收次数<input v-model="acceptForm.quantity" type="number" min="1" step="1" required></label>
            <label>签收日期<input v-model="acceptForm.date" type="date" required></label>
            <label>签收凭证号<input v-model="acceptForm.evidence" placeholder="签收单上的编号" maxlength="120" required></label>
            <label>签收人<input v-model="acceptForm.accepted_by" placeholder="客户方签字的人" maxlength="120" required></label>
            <p v-if="formIssue" class="agent-issue span">{{ formIssue }}</p>
            <button :disabled="busy">预览并登记签收</button>
          </form>
          <p class="agent-quiet">同一张签收凭证只记一次；重复提交不会多记次数。</p>
        </article>

        <article class="agent-card">
          <div class="agent-head"><div><p class="eyebrow">签收记录</p><h2>已登记 {{ history.length }} 次签收</h2></div></div>
          <table v-if="history.length" class="service-table">
            <thead><tr><th>签收日期</th><th>服务项目</th><th>次数</th><th>签收凭证</th><th>签收人</th></tr></thead>
            <tbody><tr v-for="row in history" :key="row.acceptance_id"><td>{{ showDate(row.occurred_at) }}</td><td>{{ lineName(selected, row.line_id) }}</td><td>{{ count(row.quantity) }}</td><td>{{ row.source_ref }}</td><td>{{ row.accepted_by }}</td></tr></tbody>
          </table>
          <p v-else class="empty">还没有签收记录。</p>
        </article>
      </div>
    </div>
  </section>
</template>
