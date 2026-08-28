<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";

const state = ref({
  appVersion: "",
  mode: "none",
  status: "idle",
  displayName: "",
  profileId: "",
  error: "",
  localInitialized: false,
  localAccountId: "",
  localStatus: "stopped",
  localError: "",
  accountLookupStatus: "idle",
  autoLoginStatus: "idle",
  activeAccountId: "",
  savedAccounts: [],
  canCreateLocal: false,
  pendingLocalAccountId: "",
  updateStatus: "idle",
  updateVersion: "",
  updateProgress: 0,
  updateError: "",
  updateReleaseNotes: "",
  updateDownloaded: false,
  updateLastCheckedAt: "",
});
const form = reactive({ accountId: "", password: "", remember: true });
const companyName = ref("");
const localCreationRequested = ref(false);
const accountEntryExpanded = ref(false);
const accountInput = ref(null);
let unsubscribe = () => {};
let unsubscribePreferences = () => {};

function applyDesktopPreferences(next) {
  if (!next) return;
  document.documentElement.dataset.theme = next.effectiveTheme || "light";
  document.documentElement.dataset.density = next.density || "standard";
  document.documentElement.style.colorScheme = next.effectiveTheme || "light";
}

const connected = computed(() => state.value.status === "connected");
const guestConnected = computed(() => connected.value && state.value.mode === "guest");
const selectedSavedAccount = computed(() => state.value.savedAccounts.find(
  (account) => account.accountId === form.accountId,
) || null);
const working = computed(() => (
  state.value.status === "loading"
  || state.value.accountLookupStatus === "resolving"
  || ["resolving", "authenticating"].includes(state.value.autoLoginStatus)
  || ["starting", "initializing"].includes(state.value.localStatus)
  || state.value.guestDemoStatus === "initializing"
));
const errorCode = computed(() => state.value.localError || state.value.error || "");
const errorLabel = computed(() => {
  const known = {
    desktop_account_id_invalid: "账号格式无效，请检查后重试。",
    desktop_account_not_found: "没有找到这个云端账号；本机已有另一个本地账号，不能再创建第二个本地实例。",
    desktop_account_not_found_can_create_local: "没有找到这个云端账号。你可以用当前账号创建本地 BizHub。",
    desktop_account_no_workspace: "这个账号已登记，但当前没有可登录的企业工作区。",
    desktop_account_directory_not_configured: "当前客户端没有配置账号目录，暂时无法登录云端。",
    desktop_account_directory_timeout: "账号查询超时，请稍后重试。",
    desktop_account_directory_unreachable: "账号目录暂时不可达；不会因此自动创建本地数据。",
    desktop_cloud_login_invalid: "账号或密码不正确。",
    desktop_cloud_login_rate_limited: "登录尝试过多，请稍后再试。",
    desktop_cloud_login_unavailable: "云端登录暂时不可用。",
    desktop_local_instance_already_exists: "这台电脑已经有一个本地 BizHub。",
    desktop_local_creation_cloud_account_exists: "这个账号已有企业云端工作区，不能创建同名本地账号。",
    desktop_local_creation_account_registered: "这个账号已在企业目录登记，不能创建同名本地账号。",
    desktop_local_login_failed: "本地账号或密码不正确。",
    desktop_local_remembered_login_failed: "本地保持登录已失效，请重新输入密码。",
    desktop_saved_account_session_missing: "该账号需要重新输入密码。",
    desktop_company_name_invalid: "本地企业名称需为 2 至 80 个字符。",
    desktop_admin_password_invalid: "本地密码至少需要 12 个字符。",
    desktop_remembered_session_expired: "保持登录已到期，请重新输入密码。",
    desktop_remembered_session_invalid: "保持登录已失效，请重新输入密码。",
  };
  if (known[errorCode.value]) return known[errorCode.value];
  if (errorCode.value.startsWith("desktop_local_login_failed:401")) return "本地账号或密码不正确。";
  if (errorCode.value.startsWith("desktop_account_directory_http_")) return "账号目录暂时无法完成查询。";
  return errorCode.value ? "操作未完成，请检查账号、密码或网络后重试。" : "";
});
const statusLabel = computed(() => {
  if (state.value.guestDemoStatus === "initializing") return "正在准备游客样板间";
  if (state.value.autoLoginStatus === "authenticating") return "正在自动登录";
  if (state.value.accountLookupStatus === "resolving") return "正在识别账号";
  if (state.value.localStatus === "initializing") return "正在创建本地 BizHub";
  if (state.value.localStatus === "starting") return "正在启动本地 BizHub";
  if (working.value) return "正在登录";
  if (errorLabel.value) return "操作未完成";
  return "登录后自动进入云端或本地 BizHub";
});
const updateWorking = computed(() => ["checking", "downloading", "installing"].includes(state.value.updateStatus));
const updateLabel = computed(() => {
  if (state.value.updateStatus === "checking") return "正在检查更新…";
  if (state.value.updateStatus === "downloading") return `正在下载 ${state.value.updateProgress || 0}%`;
  if (state.value.updateStatus === "downloaded") return `新版本 ${state.value.updateVersion} 已下载`;
  if (state.value.updateStatus === "available") return `发现新版本 ${state.value.updateVersion}`;
  if (state.value.updateStatus === "installing") return "正在重启更新…";
  if (state.value.updateStatus === "error") return "暂时无法检查更新";
  if (state.value.updateStatus === "up-to-date") return "已是最新版本";
  return state.value.appVersion ? `客户端 ${state.value.appVersion}` : "BizHub Desktop";
});
const updateAttention = computed(() => (
  ["available", "downloading", "downloaded", "installing"].includes(state.value.updateStatus)
));
const localCreationVisible = computed(() => (
  localCreationRequested.value || state.value.canCreateLocal
));
const localEntryLabel = computed(() => (
  state.value.localInitialized ? "使用本地账号" : "创建本地账号"
));

function syncActiveAccount() {
  if (!form.accountId && state.value.activeAccountId) {
    form.accountId = state.value.activeAccountId;
    accountEntryExpanded.value = false;
  } else if (!form.accountId && !state.value.savedAccounts.length) {
    accountEntryExpanded.value = true;
  }
}

async function login() {
  state.value = await window.bizhubDesktop.loginAccount({ ...form });
  if (state.value.status === "connected") form.password = "";
}

async function checkUpdate() {
  await window.bizhubDesktop.checkUpdate();
}

async function downloadUpdate() {
  await window.bizhubDesktop.downloadUpdate();
}

async function installUpdate() {
  await window.bizhubDesktop.installUpdate();
}

async function openGuestDemo() {
  state.value = await window.bizhubDesktop.openGuestDemo();
}

async function exitGuestDemo() {
  state.value = await window.bizhubDesktop.switchAccount();
}

async function selectSaved(account) {
  form.accountId = account.accountId;
  form.password = "";
  accountEntryExpanded.value = false;
  if (account.canAutoLogin) state.value = await window.bizhubDesktop.resumeAccount(account.accountId);
}

async function expandAccountEntry() {
  accountEntryExpanded.value = true;
  localCreationRequested.value = false;
  await nextTick();
  accountInput.value?.focus();
  accountInput.value?.select();
}

function beginLocalEntry() {
  if (state.value.localInitialized) {
    const localAccount = state.value.savedAccounts.find((account) => account.mode === "local");
    form.accountId = localAccount?.accountId || state.value.localAccountId || "";
    form.password = "";
    localCreationRequested.value = false;
    accountEntryExpanded.value = false;
  } else {
    companyName.value = "";
    localCreationRequested.value = true;
    accountEntryExpanded.value = true;
  }
  state.value = {
    ...state.value,
    canCreateLocal: false,
    pendingLocalAccountId: "",
    error: "",
    localError: "",
  };
}

async function createLocal() {
  state.value = await window.bizhubDesktop.setupLocal({
    accountId: state.value.pendingLocalAccountId || form.accountId,
    companyName: companyName.value,
    password: form.password,
    remember: form.remember,
  });
  if (state.value.status === "connected") form.password = "";
}

function cancelLocalCreation() {
  localCreationRequested.value = false;
  accountEntryExpanded.value = !selectedSavedAccount.value;
  state.value = { ...state.value, canCreateLocal: false, pendingLocalAccountId: "", error: "" };
}

onMounted(async () => {
  const [nextState, preferences] = await Promise.all([
    window.bizhubDesktop.getState(),
    window.bizhubDesktop.getPreferences(),
  ]);
  state.value = nextState;
  applyDesktopPreferences(preferences || nextState.preferences);
  syncActiveAccount();
  unsubscribe = window.bizhubDesktop.onStateChange((next) => {
    state.value = next;
    syncActiveAccount();
  });
  unsubscribePreferences = window.bizhubDesktop.onPreferencesChange(applyDesktopPreferences);
});

onBeforeUnmount(() => {
  unsubscribe();
  unsubscribePreferences();
});
</script>

<template>
  <div class="desktop-shell">
    <header v-if="guestConnected" class="guest-banner" :class="{ mac: state.platform === 'darwin' }">
      <span><b>游客样板间</b> · 当前均为模拟数据，退出样板间或彻底退出应用后自动重置；关闭窗口只进入后台。</span>
      <button type="button" @click="exitGuestDemo">退出样板间</button>
    </header>
    <main v-if="!connected" class="unified-start">
      <div class="window-drag-region" :class="{ mac: state.platform === 'darwin' }" aria-hidden="true"></div>

      <div class="workspace-backdrop" aria-hidden="true">
        <aside class="preview-sidebar">
          <div class="preview-brand"><span>BH</span><b>BizHub</b></div>
          <div class="preview-nav-label">业务</div>
          <div class="preview-nav active"><i></i><span>经营概览</span></div>
          <div class="preview-nav"><i></i><span>采购</span></div>
          <div class="preview-nav"><i></i><span>销售</span></div>
          <div class="preview-nav"><i></i><span>库存</span></div>
          <div class="preview-nav"><i></i><span>主数据</span></div>
          <div class="preview-sidebar-foot"><i></i><span>设置</span></div>
        </aside>
        <section class="preview-workspace">
          <header class="preview-toolbar">
            <div><b>经营概览</b><span>业务工作台</span></div>
            <div class="preview-search"></div>
          </header>
          <div class="preview-summary">
            <div><span>本月采购</span><b>128</b><small>待处理 8</small></div>
            <div><span>本月销售</span><b>96</b><small>待发货 5</small></div>
            <div><span>当前库存</span><b>1,842</b><small>库存正常</small></div>
          </div>
          <div class="preview-content">
            <div class="preview-section-title"><b>最近业务</b><span>查看全部</span></div>
            <div class="preview-table-head"><span>单据</span><span>往来单位</span><span>日期</span><span>状态</span></div>
            <div v-for="row in 6" :key="row" class="preview-table-row">
              <span></span><span></span><span></span><span></span>
            </div>
          </div>
        </section>
      </div>
      <div class="workspace-shade" aria-hidden="true"></div>

      <section class="login-panel" aria-labelledby="login-title">
        <div class="brand-lockup">
          <span class="mark">BH</span>
          <strong>BizHub Desktop</strong>
        </div>
        <div class="card-heading">
          <h1 id="login-title">登录 BizHub</h1>
        </div>

        <form class="unified-form" @submit.prevent="login">
          <div v-if="selectedSavedAccount && !accountEntryExpanded" class="selected-account">
            <div>
              <strong>{{ selectedSavedAccount.displayName }}</strong>
              <span>{{ selectedSavedAccount.mode === 'cloud' ? '企业云端' : '本机空间' }}</span>
            </div>
            <button type="button" :disabled="working" @click="expandAccountEntry">切换账号</button>
          </div>

          <div v-if="accountEntryExpanded && state.savedAccounts.length" class="saved-accounts">
            <span>已保存账号</span>
            <div>
              <button
                v-for="account in state.savedAccounts"
                :key="account.accountId"
                type="button"
                :class="{ active: form.accountId === account.accountId }"
                :disabled="working"
                @click="selectSaved(account)"
              >
                <strong>{{ account.displayName }}</strong>
                <small>{{ account.mode === 'cloud' ? '云端' : '本地' }}</small>
              </button>
            </div>
          </div>

          <label v-show="accountEntryExpanded || !selectedSavedAccount" class="form-field">账号<input ref="accountInput" v-model="form.accountId" autocomplete="username" maxlength="128" required></label>
          <label class="form-field">密码<input v-model="form.password" type="password" autocomplete="current-password" maxlength="1024" required></label>
          <label class="remember-login"><input v-model="form.remember" type="checkbox"><span>保持登录</span></label>
          <p class="login-status" aria-live="polite">{{ working ? statusLabel : '' }}</p>
          <div class="login-actions">
            <button class="primary-button" type="submit" :disabled="working">{{ working ? '正在进入…' : '进入 BizHub' }}</button>
            <button class="guest-button" type="button" :disabled="working" @click="openGuestDemo">游客体验</button>
            <button class="local-entry-button" type="button" :disabled="working" @click="beginLocalEntry">{{ localEntryLabel }}</button>
          </div>
        </form>

        <section v-if="localCreationVisible" class="local-create">
          <div>
            <strong>创建本地 BizHub</strong>
            <p v-if="state.pendingLocalAccountId">账号 <b>{{ state.pendingLocalAccountId }}</b> 没有企业云端工作区，可以在本机创建独立空间。</p>
            <p v-else>使用当前账号创建本机独立空间；确认时会先验证它不属于企业云端。</p>
          </div>
          <form @submit.prevent="createLocal">
            <label>本地企业名称<input v-model="companyName" maxlength="80" placeholder="例如：绿光科技" required></label>
            <div class="form-actions"><button class="secondary-button" type="button" @click="cancelLocalCreation">取消</button><button class="primary-button" type="submit" :disabled="working || !form.accountId.trim() || !form.password">明确创建并进入</button></div>
          </form>
        </section>

        <p v-if="errorLabel" class="error-message" role="alert">{{ errorLabel }}</p>

        <div class="update-row" :class="{ attention: updateAttention }" role="status" aria-live="polite">
          <span><strong v-if="updateAttention">客户端更新</strong>{{ updateLabel }}</span>
          <button v-if="state.updateDownloaded" type="button" :disabled="updateWorking" @click="installUpdate">重启并更新</button>
          <button v-else-if="state.updateStatus === 'available'" type="button" :disabled="updateWorking" @click="downloadUpdate">下载更新</button>
          <button v-else type="button" :disabled="updateWorking" @click="checkUpdate">检查更新</button>
        </div>
      </section>
    </main>
  </div>
</template>
