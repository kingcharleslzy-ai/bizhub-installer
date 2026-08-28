<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";

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
let unsubscribe = () => {};

const connected = computed(() => state.value.status === "connected");
const working = computed(() => (
  state.value.status === "loading"
  || state.value.accountLookupStatus === "resolving"
  || ["resolving", "authenticating"].includes(state.value.autoLoginStatus)
  || ["starting", "initializing"].includes(state.value.localStatus)
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

function syncActiveAccount() {
  if (!form.accountId && state.value.activeAccountId) form.accountId = state.value.activeAccountId;
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

async function selectSaved(account) {
  form.accountId = account.accountId;
  form.password = "";
  if (account.canAutoLogin) state.value = await window.bizhubDesktop.resumeAccount(account.accountId);
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
  state.value = { ...state.value, canCreateLocal: false, pendingLocalAccountId: "", error: "" };
}

onMounted(async () => {
  state.value = await window.bizhubDesktop.getState();
  syncActiveAccount();
  unsubscribe = window.bizhubDesktop.onStateChange((next) => {
    state.value = next;
    syncActiveAccount();
  });
});

onBeforeUnmount(() => unsubscribe());
</script>

<template>
  <div class="desktop-shell">
    <header v-if="!connected" class="shell-bar" :class="{ mac: state.platform === 'darwin' }">
      <div class="identity">
        <span class="mark">BH</span>
        <div><strong>BizHub Desktop</strong><small>通用企业客户端</small></div>
      </div>
      <div class="connection-state">
        <span class="status-dot" :class="state.status"></span><span>{{ statusLabel }}</span>
      </div>
    </header>

    <main v-if="!connected" class="unified-start">
      <section class="login-panel">
        <div class="card-heading">
          <span class="step">BIZHUB WORKSPACES</span>
          <h1>登录 BizHub</h1>
          <p>输入一个账号和密码。客户端会自动识别并进入企业云端或本机 Generic；密码不会保存在电脑上。</p>
        </div>

        <div v-if="state.savedAccounts.length" class="saved-accounts">
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
              <small>{{ account.mode === 'cloud' ? '云端' : '本地' }} · {{ account.canAutoLogin ? '可自动登录' : '需密码' }}</small>
            </button>
          </div>
        </div>

        <form class="unified-form" @submit.prevent="login">
          <label>账号<input v-model="form.accountId" autocomplete="username" maxlength="128" required></label>
          <label>密码<input v-model="form.password" type="password" autocomplete="current-password" maxlength="1024" required></label>
          <label class="remember-login"><input v-model="form.remember" type="checkbox"><span>保持登录，下次自动进入（只保存可撤销令牌）</span></label>
          <button class="primary-button" type="submit" :disabled="working">{{ working ? '正在登录…' : '登录并进入' }}</button>
        </form>

        <section v-if="state.canCreateLocal" class="local-create">
          <div><strong>创建本地 BizHub</strong><p>账号 <b>{{ state.pendingLocalAccountId }}</b> 没有企业云端工作区。这台电脑尚无本地实例，可以创建一个独立 Generic Local。</p></div>
          <form @submit.prevent="createLocal">
            <label>本地企业名称<input v-model="companyName" maxlength="80" placeholder="例如：绿光科技" required></label>
            <div class="form-actions"><button class="secondary-button" type="button" @click="cancelLocalCreation">取消</button><button class="primary-button" type="submit" :disabled="working">明确创建并进入</button></div>
          </form>
        </section>

        <p v-if="errorLabel" class="error-message" role="alert">{{ errorLabel }}</p>
        <p class="boundary-note">企业账号只连接签名云端工作区；本地账号只使用本机单一 SQLite，二者不会互相复制或同步数据。</p>
        <div class="update-row">
          <span>{{ updateLabel }}</span>
          <button v-if="state.updateDownloaded" type="button" :disabled="updateWorking" @click="installUpdate">重启并更新</button>
          <button v-else-if="state.updateStatus === 'available'" type="button" :disabled="updateWorking" @click="downloadUpdate">下载更新</button>
          <button v-else type="button" :disabled="updateWorking" @click="checkUpdate">检查更新</button>
        </div>
      </section>
    </main>
  </div>
</template>
