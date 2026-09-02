import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runtimeTarget } from "./runtime-target.mjs";

const require = createRequire(import.meta.url);
const { bootstrapLocalInstance } = require("../electron/local-runtime.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = runtimeTarget();

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`desktop_smoke_option_missing:${name}`);
  return path.resolve(value);
}

function flag(name) {
  return process.argv.includes(name);
}

async function unusedPort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(predicate, code, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${code}:${lastError instanceof Error ? lastError.message : "timeout"}`);
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message));
    else callbacks.resolve(message.result);
  });
  return {
    async send(method, params = {}) {
      await opened;
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error("desktop_local_shell_evaluation_failed");
  return result.result.value;
}

const WORKSPACE_VIEWPORTS = [
  [1920, 1080],
  [1366, 768],
  [960, 720],
  [768, 900],
  [414, 896],
  [375, 812],
  [320, 720],
];

async function assertWorkspaceViewports(cdp, expectedText, code) {
  try {
    for (const [width, height] of WORKSPACE_VIEWPORTS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 414,
      });
      const layout = await evaluate(cdp, `({
        text: document.body.innerText,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rootHeight: document.querySelector("#app")?.getBoundingClientRect().height || 0,
      })`);
      if (!layout.text.includes(expectedText) || layout.overflow > 2 || layout.rootHeight <= 0) {
        throw new Error(`${code}:${width}x${height}:${layout.overflow}`);
      }
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
  }
}

const packagedExecutable = option("--packaged-executable");
const packagedResources = option("--packaged-resources");
const explicitUserDataRoot = option("--user-data-root");
const keepUserData = flag("--keep-user-data");
const rememberedSessionSmokeSupported = !(
  packagedExecutable && process.platform === "darwin"
);
if (Boolean(packagedExecutable) !== Boolean(packagedResources)) {
  throw new Error("desktop_local_smoke_packaged_options_incomplete");
}
const runtimePack = packagedResources
  ? path.join(packagedResources, "bizhub-runtime")
  : path.join(ROOT, "runtime-dist", "bizhub-runtime");
const trustPath = packagedResources
  ? path.join(packagedResources, "generic-runtime-trust.json")
  : path.join(ROOT, "config", target.trustName);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-desktop-local-shell-"));
const userDataRoot = explicitUserDataRoot || path.join(temporaryRoot, "user-data");
const username = "synthetic-admin";
const password = "synthetic correct horse battery staple";
let child = null;
let shellCdp = null;
let debugPort = null;

async function stopDesktop() {
  if (shellCdp) {
    shellCdp.close();
    shellCdp = null;
  }
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  child = null;
}

async function launchDesktop() {
  debugPort = await unusedPort();
  const executable = packagedExecutable || require("electron");
  const electronUserData = `--user-data-dir=${path.join(userDataRoot, "electron-profile")}`;
  const arguments_ = packagedExecutable
    ? [electronUserData, `--remote-debugging-port=${debugPort}`]
    : [electronUserData, `--remote-debugging-port=${debugPort}`, ROOT];
  child = spawn(executable, arguments_, {
    cwd: ROOT,
    env: {
      ...process.env,
      BIZHUB_DESKTOP_ACCOUNT_FLOW_SMOKE: "1",
      BIZHUB_DESKTOP_USER_DATA_ROOT: userDataRoot,
      ...(packagedExecutable ? {} : {
        BIZHUB_DESKTOP_ACCOUNT_DIRECTORY_CONFIG: path.join(temporaryRoot, "must-not-be-read.json"),
        BIZHUB_DESKTOP_LOCAL_RUNTIME_DIR: runtimePack,
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const shellTarget = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`electron_exited:${child.exitCode}:${stderr}`);
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.url === "bizhub-shell://app/") || null;
  }, "desktop_local_shell_debug_target_missing");
  shellCdp = createCdpClient(shellTarget.webSocketDebuggerUrl);
  await shellCdp.send("Runtime.enable");
}

async function localWorkspaceClient() {
  const localTarget = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await response.json();
    return targets.find((item) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url)) || null;
  }, "desktop_local_workspace_debug_target_missing");
  const client = createCdpClient(localTarget.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  return client;
}

function preEntryWorkspaceReady(product) {
  return (
    product.title === "开始使用"
    && product.nav.length === 1
    && product.nav.includes("开始使用")
    && product.text.includes("进入我的企业空间")
    && !product.text.includes("BizHub is ready")
  );
}

async function submitUnifiedLogin() {
  const submitted = await evaluate(shellCdp, `(() => {
    const account = document.querySelector('input[autocomplete="username"]');
    const password = document.querySelector('input[autocomplete="current-password"]');
    const remember = document.querySelector('input[type="checkbox"]');
    if (!account || !password || !remember) return false;
    account.value = ${JSON.stringify(username)};
    account.dispatchEvent(new Event("input", { bubbles: true }));
    password.value = ${JSON.stringify(password)};
    password.dispatchEvent(new Event("input", { bubbles: true }));
    remember.checked = ${JSON.stringify(rememberedSessionSmokeSupported)};
    remember.dispatchEvent(new Event("change", { bubbles: true }));
    account.form.requestSubmit();
    return true;
  })()`);
  if (!submitted) throw new Error("desktop_local_unified_login_form_missing");
}

async function quitDesktop() {
  if (!child || child.exitCode !== null) return;
  const exitingChild = child;
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("desktop_local_shell_quit_timeout")),
      15_000,
    );
    exitingChild.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  await evaluate(shellCdp, "window.bizhubDesktop.quitAppForSmoke()");
  shellCdp.close();
  shellCdp = null;
  await exited;
  child = null;
}

try {
  await bootstrapLocalInstance({
    userDataRoot,
    runtimePack,
    trustPath,
    input: {
      companyName: "Synthetic Desktop Shell",
      username,
      password,
    },
  });
  await launchDesktop();
  await waitFor(async () => (await evaluate(shellCdp, "document.body.innerText")).includes("进入你的 BizHub"),
    "desktop_local_unified_login_screen_missing");
  await submitUnifiedLogin();
  const firstState = await waitFor(async () => {
    const state = await evaluate(shellCdp, "window.bizhubDesktop.getState()");
    return state.mode === "local" && state.status === "connected" ? state : null;
  }, "desktop_local_unified_login_failed");
  if (firstState.accountLookupStatus !== "idle") {
    throw new Error("desktop_local_account_contacted_cloud_directory");
  }
  {
    const workspace = await localWorkspaceClient();
    await waitFor(async () => {
      const value = await evaluate(workspace, `({
        title: document.querySelector("h1")?.textContent?.trim() || "",
        nav: [...document.querySelectorAll("nav button")].map((item) => item.textContent.trim()),
        text: document.body.innerText
      })`);
      return preEntryWorkspaceReady(value) ? value : null;
    }, "desktop_local_workspace_product_missing");
    await assertWorkspaceViewports(
      workspace,
      "进入我的企业空间",
      "desktop_local_workspace_pre_entry_responsive_invalid",
    );
    await evaluate(workspace, `(() => {
      const button = [...document.querySelectorAll("button")]
        .find((item) => item.textContent.trim() === "进入我的企业空间");
      button?.click();
      return Boolean(button);
    })()`);
    await waitFor(async () => {
      const value = await evaluate(workspace, `({
        title: document.querySelector("h1")?.textContent?.trim() || "",
        nav: [...document.querySelectorAll("nav button")].map((item) => item.textContent.trim()),
        text: document.body.innerText,
      })`);
      return value.nav.includes("设置")
        && value.nav.includes("基础资料")
        && value.nav.includes("和助手聊聊")
        && value.nav.includes("我们已了解")
        && value.nav.includes("待确认")
        && value.nav.includes("改进机会")
        && value.title === "和助手聊聊"
        && value.text.includes("你现在最希望系统先帮你解决什么？") ? value : null;
    }, "desktop_local_workspace_entry_not_persisted");
    await assertWorkspaceViewports(
      workspace,
      "你现在最希望系统先帮你解决什么？",
      "desktop_local_workspace_post_entry_responsive_invalid",
    );
    const answered = await evaluate(workspace, `(() => {
      const field = document.querySelector(".current-question textarea");
      const button = [...document.querySelectorAll(".answer-actions button")]
        .find((item) => item.textContent.trim() === "发送");
      if (!field || !button) return false;
      field.value = "先把每天收到的订单和遗漏整理清楚";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      button.click();
      return true;
    })()`);
    if (!answered) throw new Error("desktop_local_cobuild_answer_controls_missing");
    await waitFor(async () => {
      const text = await evaluate(workspace, "document.body.innerText");
      return text.includes("已有可检查候选")
        && text.includes("为了先做出一个能检查的结果") ? text : null;
    }, "desktop_local_cobuild_first_candidate_missing");
    for (const [label, expected, code] of [
      ["我们已了解", "先把每天收到的订单和遗漏整理清楚", "knowledge"],
      ["待确认", "目前没有待确认事项", "confirmations"],
      ["改进机会", "第一项共建目标", "opportunities"],
    ]) {
      await evaluate(workspace, `(() => {
        const button = [...document.querySelectorAll("nav button")]
          .find((item) => item.textContent.trim() === ${JSON.stringify(label)});
        button?.click();
        return Boolean(button);
      })()`);
      await waitFor(async () => (await evaluate(workspace, "document.body.innerText")).includes(expected),
        `desktop_local_cobuild_${code}_missing`);
      await assertWorkspaceViewports(
        workspace,
        expected,
        `desktop_local_cobuild_${code}_responsive_invalid`,
      );
    }
    await evaluate(workspace, `(() => {
      const button = [...document.querySelectorAll("nav button")]
        .find((item) => item.textContent.trim() === "和助手聊聊");
      button?.click();
      return Boolean(button);
    })()`);
    for (const [text, expected] of [
      ["每天使用的订单表格", "这件事现在通常是谁先开始"],
      ["销售接单后交给仓库发货，负责人检查完成", "这件事最容易在哪一步出错"],
      ["客户名称不一致时容易匹配错", "这件事最终由哪个岗位"],
      ["销售负责人最终确认", "第一轮了解已经完成"],
    ]) {
      const submitted = await evaluate(workspace, `(() => {
        const field = document.querySelector(".current-question textarea");
        const button = [...document.querySelectorAll(".answer-actions button")]
          .find((item) => item.textContent.trim() === "发送");
        if (!field || !button) return false;
        field.value = ${JSON.stringify(text)};
        field.dispatchEvent(new Event("input", { bubbles: true }));
        button.click();
        return true;
      })()`);
      if (!submitted) throw new Error("desktop_local_cobuild_completion_controls_missing");
      await waitFor(async () => (await evaluate(workspace, "document.body.innerText")).includes(expected),
        "desktop_local_cobuild_completion_step_missing");
    }
    const materialSubmitted = await evaluate(workspace, `(() => {
      const form = document.querySelector(".material-panel form");
      const name = form?.querySelector("input");
      const summary = form?.querySelector("textarea");
      if (!form || !name || !summary) return false;
      name.value = "日常订单表.xlsx";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      summary.value = "表格包含客户、商品、数量、库存和发货日期。";
      summary.dispatchEvent(new Event("input", { bubbles: true }));
      form.requestSubmit();
      return true;
    })()`);
    if (!materialSubmitted) throw new Error("desktop_local_cobuild_material_controls_missing");
    await waitFor(async () => (await evaluate(workspace, "document.body.innerText")).includes("系统方案草案已经可以检查"),
      "desktop_local_system_candidate_not_ready");
    await evaluate(workspace, `(() => {
      const button = [...document.querySelectorAll("nav button")]
        .find((item) => item.textContent.trim() === "改进机会");
      button?.click();
      return Boolean(button);
    })()`);
    await waitFor(async () => {
      const text = await evaluate(workspace, "document.body.innerText");
      return text.includes("系统方案草案")
        && text.includes("等你检查")
        && text.includes("订单流转基础")
        && text.includes("库存与出入库")
        && text.includes("不会自动安装、写入业务数据或上线") ? text : null;
    }, "desktop_local_system_candidate_missing");
    await assertWorkspaceViewports(
      workspace,
      "已经拼出第一版，等你检查",
      "desktop_local_system_candidate_responsive_invalid",
    );
    await evaluate(workspace, `(() => {
      const button = [...document.querySelectorAll("nav button")]
        .find((item) => item.textContent.trim() === "设置");
      button?.click();
      return Boolean(button);
    })()`);
    await waitFor(async () => (await evaluate(workspace, "document.body.innerText")).includes("创建备份"),
      "desktop_local_settings_missing");
    workspace.close();
  }
  const savedPath = path.join(userDataRoot, "saved-accounts.v3.json");
  const savedBytes = await readFile(savedPath, "utf8");
  if (
    !savedBytes.includes(username)
    || savedBytes.includes(password)
  ) {
    throw new Error("desktop_local_remembered_account_invalid");
  }
  if (
    rememberedSessionSmokeSupported
    && !savedBytes.includes("bizhub.desktop-encrypted-session.v1")
  ) {
    throw new Error("desktop_local_remembered_account_not_encrypted");
  }
  let resumedTitle = "";
  await quitDesktop();
  if (rememberedSessionSmokeSupported) {
    await launchDesktop();
    const resumedState = await waitFor(async () => {
      const state = await evaluate(shellCdp, "window.bizhubDesktop.getState()");
      return state.mode === "local" && state.status === "connected"
        && state.autoLoginStatus === "connected" ? state : null;
    }, "desktop_local_remembered_auto_login_failed");
    if (resumedState.accountLookupStatus !== "idle") {
      throw new Error("desktop_local_remembered_login_contacted_cloud_directory");
    }
    const resumedWorkspace = await localWorkspaceClient();
    resumedTitle = await waitFor(async () => {
      const opened = await evaluate(resumedWorkspace, `(() => {
        const button = [...document.querySelectorAll("nav button")]
          .find((item) => item.textContent.trim() === "和助手聊聊");
        button?.click();
        return Boolean(button);
      })()`);
      if (!opened) return null;
      const value = await evaluate(resumedWorkspace, `({
        title: document.querySelector("h1")?.textContent?.trim() || "",
        text: document.body.innerText,
      })`);
      return value.title === "和助手聊聊"
        && value.text.includes("已有可检查候选")
        && value.text.includes("为了先做出一个能检查的结果")
        ? value.title : null;
    }, "desktop_local_remembered_workspace_missing");
    resumedWorkspace.close();
    await quitDesktop();
  }

  process.stdout.write(`${JSON.stringify({
    status: "connected",
    mode: "local",
    origin_kind: "random_loopback",
    unified_local_login: true,
    local_directory_requests: 0,
    local_remembered_token_saved: rememberedSessionSmokeSupported,
    local_remembered_session_ciphertext_saved: rememberedSessionSmokeSupported,
    local_remembered_auto_login: rememberedSessionSmokeSupported,
    remembered_login_test_skipped: !rememberedSessionSmokeSupported,
    generic_workspace_ready: rememberedSessionSmokeSupported
      ? resumedTitle === "和助手聊聊"
      : firstState.status === "connected",
    settings_ready: true,
    responsive_workspace_states: 6,
    responsive_workspace_viewports: WORKSPACE_VIEWPORTS.length,
    packaged: Boolean(packagedExecutable),
    user_data_root: userDataRoot,
    residual_runtime_processes: 0,
  })}\n`);
} finally {
  await stopDesktop();
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 10 : 0,
    retryDelay: 200,
  });
  if (explicitUserDataRoot && !keepUserData) {
    await rm(explicitUserDataRoot, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 10 : 0,
      retryDelay: 200,
    });
  }
}
