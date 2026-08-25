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
});
const setupRequested = ref(false);
const setupForm = reactive({ companyName: "", username: "admin", password: "" });
const loginForm = reactive({ username: "admin", password: "" });
let unsubscribe = () => {};

const connected = computed(() => state.value.status === "connected");
const working = computed(() => (
  state.value.status === "loading"
  || ["starting", "initializing"].includes(state.value.localStatus)
));
const localLogin = computed(() => (
  state.value.mode === "local"
  && state.value.localInitialized
  && ["awaiting_login", "error"].includes(state.value.localStatus)
));
const showSetup = computed(() => !state.value.localInitialized && setupRequested.value);
const statusLabel = computed(() => {
  if (state.value.mode === "cloud" && state.value.status === "loading") return "正在连接云端";
  if (state.value.mode === "cloud" && connected.value) return "企业云端已连接";
  if (state.value.mode === "local" && state.value.localStatus === "initializing") return "正在初始化本地实例";
  if (state.value.mode === "local" && state.value.localStatus === "starting") return "正在启动本地 Runtime";
  if (state.value.mode === "local" && state.value.localStatus === "awaiting_login") return "等待本地登录";
  if (state.value.mode === "local" && connected.value) return "本地 Generic 已连接";
  if (state.value.status === "error") return "操作未完成";
  return "选择工作方式";
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
    desktop_profile_file_size_invalid: "连接文件大小或类型无效。",
    profile_expired: "企业连接文件已过期，请取得新文件。",
    profile_signature_mismatch: "企业连接文件签名校验失败。",
    profile_signing_key_unknown: "客户端尚未信任该连接签发者。",
    profile_signing_key_inactive: "连接签发密钥当前无效。",
    profile_shell_version_unsupported: "客户端版本过低，请先更新 BizHub Desktop。",
    desktop_connection_profile_expired: "企业连接文件已过期，请取得新文件。",
  };
  if (known[value]) return known[value];
  if (value.startsWith("desktop_local_login_failed:401")) return "本地管理员账号或密码不正确。";
  if (value.startsWith("workspace_load_failed:")) return "企业云端页面加载失败，请检查网络后重试。";
  if (value.startsWith("local_workspace_load_failed:")) return "本地页面加载失败，可停止后重新打开。";
  return "操作未通过安全校验，请查看本机诊断日志。";
});

async function chooseProfile() {
  state.value = await window.bizhubDesktop.chooseConnectionProfile();
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
            <span class="step">企业云端</span>
            <h1>连接企业云端 BizHub</h1>
            <p>
              选择企业提供的签名连接文件。账号和密码由企业云端系统直接验证，
              Desktop 不会启动 Python，也不会创建本地数据库作为故障回退。
            </p>
          </div>
          <button class="primary-button" type="button" :disabled="working" @click="chooseProfile">
            选择企业连接文件
          </button>
          <div class="boundary">
            <div><span>正式 Owner</span><strong>企业云端 Runtime</strong></div>
            <div><span>数据位置</span><strong>由企业云端管理</strong></div>
          </div>
        </section>

        <aside class="local-preview enabled">
          <span class="preview-label">本地 Generic</span>
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
          <small class="local-boundary">macOS arm64 · 127.0.0.1 随机端口 · 单一本地 SQLite</small>
        </aside>
        <p v-if="errorLabel" class="error-message page-error" role="alert">{{ errorLabel }}</p>
      </template>
    </main>
  </div>
</template>
