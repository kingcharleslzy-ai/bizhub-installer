<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const state = ref({
  status: "idle",
  displayName: "",
  profileId: "",
  applicationOrigin: "",
  error: "",
});
let unsubscribe = () => {};

const connected = computed(() => ["loading", "connected"].includes(state.value.status));
const statusLabel = computed(() => {
  if (state.value.status === "loading") return "正在连接";
  if (state.value.status === "connected") return "云端已连接";
  if (state.value.status === "error") return "连接未完成";
  return "等待企业连接";
});
const errorLabel = computed(() => {
  const value = state.value.error;
  if (!value) return "";
  const known = {
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
  if (value.startsWith("workspace_load_failed:")) return "企业云端页面加载失败，请检查网络后重试。";
  return "连接文件未通过安全校验，请联系企业管理员。";
});

async function chooseProfile() {
  state.value = await window.bizhubDesktop.chooseConnectionProfile();
}

async function disconnect() {
  state.value = await window.bizhubDesktop.disconnectWorkspace();
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
          <small v-if="state.displayName">
            {{ state.displayName }} · {{ state.profileId }}
          </small>
          <small v-else>通用企业客户端</small>
        </div>
      </div>
      <div class="connection-state">
        <span class="status-dot" :class="state.status"></span>
        <span>{{ statusLabel }}</span>
        <button v-if="connected" class="quiet-button" type="button" @click="disconnect">
          断开
        </button>
      </div>
    </header>

    <main v-if="!connected" class="start-page">
      <section class="start-card">
        <div class="card-heading">
          <span class="step">企业云端</span>
          <h1>连接企业云端 BizHub</h1>
          <p>
            选择企业提供的签名连接文件。账号和密码将由企业云端系统直接验证，
            Desktop 不保存密码，也不会创建本地数据库。
          </p>
        </div>

        <button class="primary-button" type="button" @click="chooseProfile">
          选择企业连接文件
        </button>

        <p v-if="errorLabel" class="error-message" role="alert">{{ errorLabel }}</p>

        <div class="boundary">
          <div>
            <span>当前方式</span>
            <strong>安全连接企业工作区</strong>
          </div>
          <div>
            <span>数据位置</span>
            <strong>由企业云端系统管理</strong>
          </div>
        </div>
      </section>

      <aside class="local-preview">
        <span class="preview-label">即将提供</span>
        <h2>本地 BizHub</h2>
        <p>
          Generic 本地初始化将在 Desktop-D2 使用合成数据单独验收，
          不会由一次失败的云端登录自动触发。
        </p>
        <button type="button" disabled>尚未启用</button>
      </aside>
    </main>
  </div>
</template>
