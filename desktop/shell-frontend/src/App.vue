<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";

const state = ref({
  mode: "none",
  status: "idle",
  displayName: "",
  profileId: "",
  applicationOrigin: "",
  error: "",
  localInitialized: false,
  localStatus: "stopped",
  localError: "",
  localLastBackup: "",
  accountLookupStatus: "idle",
  accountNotFound: false,
  enterpriseWorkspaces: [],
  rememberedLoginAvailable: false,
  autoLoginStatus: "idle",
});
const setupRequested = ref(false);
const accountForm = reactive({ accountId: "", password: "", remember: true });
const setupForm = reactive({ companyName: "", username: "admin", password: "" });
const loginForm = reactive({ username: "admin", password: "" });
let unsubscribe = () => {};

const connected = computed(() => state.value.status === "connected");
const working = computed(() => (
  state.value.status === "loading"
  || state.value.accountLookupStatus === "resolving"
  || ["resolving", "authenticating"].includes(state.value.autoLoginStatus)
  || ["starting", "initializing"].includes(state.value.localStatus)
));
const localLogin = computed(() => (
  state.value.mode === "local"
  && state.value.localInitialized
  && ["awaiting_login", "error"].includes(state.value.localStatus)
));
const showSetup = computed(() => !state.value.localInitialized && setupRequested.value);
const accountResolved = computed(() => (
  state.value.accountLookupStatus === "resolved"
  || state.value.accountLookupStatus === "not_found"
));
const statusLabel = computed(() => {
  if (state.value.autoLoginStatus === "resolving") return "正在自动查找工作区";
  if (state.value.autoLoginStatus === "authenticating") return "正在自动登录云端";
  if (state.value.accountLookupStatus === "resolving") return "正在查找账号工作区";
  if (state.value.mode === "cloud" && state.value.status === "loading") return "正在连接云端";
  if (state.value.mode === "cloud" && connected.value) return "企业云端已连接";
  if (state.value.mode === "local" && state.value.localStatus === "initializing") return "正在初始化本地实例";
  if (state.value.mode === "local" && state.value.localStatus === "starting") return "正在启动本地 Runtime";
  if (state.value.mode === "local" && state.value.localStatus === "awaiting_login") return "等待本地登录";
  if (state.value.mode === "local" && connected.value) return "本地 Generic 已连接";
  if (state.value.status === "error") return "操作未完成";
  return "选择工作区并登录";
});
const errorLabel = computed(() => {
  const value = state.value.localError || state.value.error;
  if (!value) return "";
  const known = {
    desktop_admin_password_invalid: "管理员密码至少需要 12 个字符。",
    desktop_company_name_invalid: "请输入 2 至 80 个字符的本地企业名称。",
    desktop_local_instance_already_exists: "这台电脑已经初始化过一个本地实例。",
    desktop_local_instance_not_initialized: "请先明确创建本地实例。",
    desktop_local_login_failed: "本地管理员账号或密码不正确。",
    desktop_local_setup_in_progress: "本地初始化正在进行，请稍候。",
    desktop_connection_failed: "连接配置无法使用。",
    desktop_account_id_invalid: "账号格式无效，请使用 3 至 128 位字母、数字或 . _ @ + -。",
    desktop_account_lookup_shape_invalid: "账号查询请求无效。",
    desktop_account_directory_not_configured: "当前构建尚未配置正式账号目录，不能查找企业云端。",
    desktop_account_directory_timeout: "账号目录响应超时，请稍后重试。",
    desktop_account_directory_unreachable: "账号目录暂时不可达；不会因此创建本地数据库。",
    desktop_account_directory_response_size_invalid: "账号目录响应超出安全范围。",
    desktop_account_directory_response_json_invalid: "账号目录返回了无效数据。",
    desktop_account_directory_response_shape_invalid: "账号目录响应结构无效。",
    desktop_account_directory_response_invalid: "账号目录响应版本或工作区数量无效。",
    desktop_account_workspace_duplicate: "账号目录返回了重复工作区。",
    desktop_account_multiple_workspaces: "该账号对应多个工作区，当前简化登录暂不支持自动选择。",
    desktop_cloud_login_shape_invalid: "登录请求格式无效。",
    desktop_cloud_password_invalid: "请输入云端密码。",
    desktop_cloud_login_invalid: "账号或云端密码不正确。",
    desktop_cloud_login_rate_limited: "登录尝试过多，请稍后再试。",
    desktop_cloud_login_unavailable: "企业云端认证暂不可用，请稍后重试。",
    desktop_cloud_login_failed: "无法完成云端登录，请检查网络后重试。",
    desktop_secure_storage_unavailable: "本机系统加密存储暂不可用；请取消“记住账号和密码”后登录。",
    desktop_remembered_login_file_invalid: "本机保存的登录信息已损坏，请重新输入。",
    desktop_remembered_login_decrypt_failed: "本机保存的登录信息无法解密，请重新输入。",
    desktop_workspace_connection_failed: "企业工作区无法使用。",
    desktop_workspace_selection_shape_invalid: "企业工作区选择无效。",
    desktop_workspace_not_resolved_for_account: "该工作区不属于本次账号查询，请重新查找账号。",
    desktop_profile_file_size_invalid: "连接文件大小或类型无效。",
    profile_envelope_shape_invalid: "企业工作区文件结构无效。",
    profile_envelope_identity_invalid: "企业工作区文件版本或身份无效。",
    profile_cloud_authority_invalid: "企业工作区没有声明唯一云端数据权威。",
    profile_expired: "企业连接文件已过期，请取得新文件。",
    profile_signature_mismatch: "企业连接文件签名校验失败。",
    profile_signing_key_unknown: "客户端尚未信任该连接签发者。",
    profile_signing_key_inactive: "连接签发密钥当前无效。",
    profile_expiry_exceeds_signing_key: "企业工作区有效期超过签发密钥有效期。",
    profile_shell_version_unsupported: "客户端版本过低，请先更新 BizHub Desktop。",
  };
  if (known[value]) return known[value];
  if (value.startsWith("desktop_local_login_failed:401")) return "本地管理员账号或密码不正确。";
  if (value.startsWith("desktop_account_directory_http_")) return "账号目录暂时无法完成查询；不会自动切换到本地。";
  if (value.startsWith("workspace_load_failed:")) return "企业云端页面加载失败，请检查网络后重试。";
  if (value.startsWith("local_workspace_load_failed:")) return "本地页面加载失败，可停止后重新打开。";
  return "操作未通过安全校验，请查看本机诊断日志。";
});

async function loginEnterprise() {
  state.value = await window.bizhubDesktop.loginEnterprise({ ...accountForm });
  if (accountForm.accountId.trim()) {
    setupForm.username = accountForm.accountId.trim().toLowerCase();
    loginForm.username = accountForm.accountId.trim().toLowerCase();
  }
  accountForm.password = "";
}

async function changeAccount() {
  setupRequested.value = false;
  accountForm.password = "";
  state.value = await window.bizhubDesktop.resetAccountLookup();
}

async function forgetRememberedLogin() {
  accountForm.accountId = "";
  accountForm.password = "";
  state.value = await window.bizhubDesktop.forgetRememberedLogin();
}

async function beginLocal() {
  if (!state.value.localInitialized) {
    setupRequested.value = true;
    return;
  }
  state.value = await window.bizhubDesktop.prepareLocal();
}

async function setupLocal() {
  state.value = await window.bizhubDesktop.setupLocal({ ...setupForm });
  setupForm.password = "";
}

async function loginLocal() {
  state.value = await window.bizhubDesktop.loginLocal({ ...loginForm });
  loginForm.password = "";
}

async function closeCurrent() {
  state.value = state.value.mode === "local"
    ? await window.bizhubDesktop.stopLocal()
    : await window.bizhubDesktop.disconnectWorkspace();
}

async function backupLocal() {
  state.value = await window.bizhubDesktop.backupLocal();
}

onMounted(async () => {
  state.value = await window.bizhubDesktop.getState();
  unsubscribe = window.bizhubDesktop.onStateChange((next) => {
    state.value = next;
  });
});

onBeforeUnmount(() => unsubscribe());
</script>

<template>
  <div class="desktop-shell">
    <header class="shell-bar">
      <div class="identity">
        <span class="mark">BH</span>
        <div>
          <strong>BizHub Desktop</strong>
          <small v-if="state.displayName && state.mode !== 'none'">
            {{ state.displayName }} · {{ state.profileId }}
          </small>
          <small v-else>通用企业客户端</small>
        </div>
      </div>
      <div class="connection-state">
        <span class="status-dot" :class="state.status"></span>
        <span>{{ statusLabel }}</span>
        <button
          v-if="connected && state.mode === 'local'"
          class="quiet-button"
          type="button"
          @click="backupLocal"
        >
          创建备份
        </button>
        <button v-if="state.mode !== 'none'" class="quiet-button" type="button" @click="closeCurrent">
          {{ state.mode === "local" ? "停止本地" : "关闭工作区" }}
        </button>
        <button
          v-if="connected && state.mode === 'cloud' && state.rememberedLoginAvailable"
          class="quiet-button"
          type="button"
          @click="forgetRememberedLogin"
        >
          退出并忘记账号
        </button>
      </div>
    </header>

    <main v-if="!connected" class="start-page">
      <section v-if="localLogin" class="start-card focused-card">
        <div class="card-heading">
          <span class="step">本地 BizHub</span>
          <h1>登录本地 Generic 实例</h1>
          <p>
            Runtime 只监听本次随机的 127.0.0.1 端口。未知账号不会创建数据库，
            云端连接失败也不会切换到这里。
          </p>
        </div>
        <form class="local-form" @submit.prevent="loginLocal">
          <label>
            管理员账号
            <input v-model="loginForm.username" autocomplete="username" maxlength="80" required>
          </label>
          <label>
            密码
            <input
              v-model="loginForm.password"
              type="password"
              autocomplete="current-password"
              maxlength="1024"
              required
            >
          </label>
          <button class="primary-button" type="submit" :disabled="working">登录并打开</button>
        </form>
        <p v-if="errorLabel" class="error-message" role="alert">{{ errorLabel }}</p>
      </section>

      <section v-else-if="showSetup" class="start-card focused-card">
        <div class="card-heading">
          <span class="step">首次本地设置</span>
          <h1>创建一个本地 Generic 实例</h1>
          <p>
            只有提交本表后才会创建本地目录、合成 SQLite 和首位管理员。
            本地实例与任何企业云端数据库互不同步，也不会获得客户私有模块。
          </p>
        </div>
        <form class="local-form" @submit.prevent="setupLocal">
          <label>
            本地企业名称
            <input v-model="setupForm.companyName" maxlength="80" required>
          </label>
          <label>
            首位管理员账号
            <input v-model="setupForm.username" autocomplete="username" maxlength="80" required>
          </label>
          <label>
            管理员密码（至少 12 个字符）
            <input
              v-model="setupForm.password"
              type="password"
              autocomplete="new-password"
              minlength="12"
              maxlength="1024"
              required
            >
          </label>
          <div class="form-actions">
            <button class="secondary-button" type="button" @click="setupRequested = false">返回</button>
            <button class="primary-button" type="submit" :disabled="working">明确创建</button>
          </div>
        </form>
        <p v-if="errorLabel" class="error-message" role="alert">{{ errorLabel }}</p>
      </section>

      <template v-else>
        <section class="start-card">
          <div class="card-heading">
            <span class="step">BIZHUB WORKSPACES</span>
            <h1>{{ accountResolved && !state.enterpriseWorkspaces.length ? "没有可登录的企业工作区" : "登录 BizHub" }}</h1>
            <p>
              输入账号和密码后直接进入对应系统。账号目录只接收账号标识；
              密码仅在签名工作区验证通过后交给对应云端。
            </p>
          </div>
          <form
            v-if="!accountResolved || state.enterpriseWorkspaces.length || state.status === 'error'"
            class="account-lookup login-account-form"
            @submit.prevent="loginEnterprise"
          >
            <label>
              BizHub 账号
              <input
                v-model="accountForm.accountId"
                autocomplete="username"
                maxlength="128"
                placeholder="例如 name@example.com"
                required
              >
            </label>
            <label>
              密码
              <input
                v-model="accountForm.password"
                type="password"
                autocomplete="current-password"
                maxlength="1024"
                placeholder="请输入云端密码"
                required
              >
            </label>
            <label class="remember-login">
              <input v-model="accountForm.remember" type="checkbox">
              <span>记住账号和密码，下次自动登录（使用系统加密存储）</span>
            </label>
            <button class="primary-button" type="submit" :disabled="working">
              {{ working ? "正在登录…" : "登录并进入" }}
            </button>
          </form>
          <div v-else class="empty-workspaces">
            <strong>{{ state.accountNotFound ? "没有找到企业云端工作区" : "该账号当前没有企业云端工作区" }}</strong>
            <span v-if="state.accountNotFound">
              不会自动创建数据库；如需使用 Generic 本地版，请在右侧明确创建。
            </span>
            <span v-else>
              不会自动创建数据库；请确认账号权限，或在右侧明确创建 Generic 本地版。
            </span>
          </div>
          <button
            v-if="accountResolved"
            class="secondary-button add-workspace"
            type="button"
            :disabled="working"
            @click="changeAccount"
          >
            换一个账号
          </button>
        </section>

        <aside class="local-preview enabled">
          <span class="preview-label">GENERIC LOCAL</span>
          <h2>{{ state.localInitialized ? "打开本地 BizHub" : "创建本地 BizHub" }}</h2>
          <p v-if="state.localInitialized">
            已存在一个本地实例。打开后需使用它自己的管理员账号登录，
            正式写入只经过固定 Generic Owner。
          </p>
          <p v-else>
            首次使用需要明确确认。客户端会创建一个独立本地实例，
            不会导入企业云端或客户私有数据。
          </p>
          <button type="button" :disabled="working" @click="beginLocal">
            {{ state.localInitialized ? "启动并登录" : "开始本地设置" }}
          </button>
          <small class="local-boundary">127.0.0.1 随机端口 · 单一本地 SQLite · 不含客户私有模块</small>
        </aside>
        <p v-if="errorLabel" class="error-message page-error" role="alert">{{ errorLabel }}</p>
      </template>
    </main>
  </div>
</template>
