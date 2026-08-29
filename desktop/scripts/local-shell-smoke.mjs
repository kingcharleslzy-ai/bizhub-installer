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

const packagedExecutable = option("--packaged-executable");
const packagedResources = option("--packaged-resources");
const explicitUserDataRoot = option("--user-data-root");
const keepUserData = flag("--keep-user-data");
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
    remember.checked = true;
    remember.dispatchEvent(new Event("change", { bubbles: true }));
    account.form.requestSubmit();
    return true;
  })()`);
  if (!submitted) throw new Error("desktop_local_unified_login_form_missing");
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
  await waitFor(async () => (await evaluate(shellCdp, "document.body.innerText")).includes("登录 BizHub"),
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
    const product = await waitFor(async () => {
      const value = await evaluate(workspace, `({
        title: document.querySelector("h1")?.textContent?.trim() || "",
        nav: [...document.querySelectorAll("nav button")].map((item) => item.textContent.trim()),
        text: document.body.innerText
      })`);
      return value.title === "经营概览" && value.nav.includes("设置") ? value : null;
    }, "desktop_local_workspace_product_missing");
    if (
      !product.nav.includes("主数据")
      || !product.nav.includes("采购")
      || !product.nav.includes("销售")
      || !product.nav.includes("库存")
      || product.text.includes("BizHub is ready")
    ) throw new Error("desktop_local_workspace_product_invalid");
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
    || !savedBytes.includes("bizhub.desktop-encrypted-session.v1")
    || savedBytes.includes(password)
  ) {
    throw new Error("desktop_local_remembered_account_invalid");
  }
  await stopDesktop();
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
  const resumedTitle = await waitFor(async () => {
    const value = await evaluate(resumedWorkspace, "document.querySelector('h1')?.textContent?.trim() || ''");
    return value === "经营概览" ? value : null;
  }, "desktop_local_remembered_workspace_missing");
  resumedWorkspace.close();
  await stopDesktop();

  process.stdout.write(`${JSON.stringify({
    status: "connected",
    mode: "local",
    origin_kind: "random_loopback",
    unified_local_login: true,
    local_directory_requests: 0,
    local_remembered_token_saved: true,
    local_remembered_session_ciphertext_saved: true,
    local_remembered_auto_login: true,
    generic_workspace_ready: resumedTitle === "经营概览",
    settings_ready: true,
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
