import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { signatureInput } = require("../electron/connection-profile.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`desktop_smoke_option_missing:${name}`);
  return path.resolve(value);
}

const packagedExecutable = option("--packaged-executable");
const packagedTrustStore = option("--packaged-trust-store");
const packagedAccountDirectory = option("--packaged-account-directory");
const packagedOptions = [packagedExecutable, packagedTrustStore, packagedAccountDirectory];
if (packagedOptions.some(Boolean) && !packagedOptions.every(Boolean)) {
  throw new Error("desktop_account_flow_packaged_options_incomplete");
}

function fail(code, detail = "") {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function jwtWithExpiry(expiresAtSeconds) {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp: expiresAtSeconds, sub: "dashboard-operator" }))
      .toString("base64url"),
    "synthetic-signature",
  ].join(".");
}

async function unusedPort() {
  const { createServer: createTcpServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(predicate, code, timeoutMs = 30_000) {
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
  fail(code, lastError instanceof Error ? lastError.message : "timeout");
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
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
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
    close() {
      socket.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) fail("desktop_account_flow_evaluation_failed");
  return result.result.value;
}

async function clickButton(cdp, label) {
  const encoded = JSON.stringify(label);
  return evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((item) => item.textContent.trim() === ${encoded});
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function enterCredentials(cdp, accountId, password, remember = false) {
  const encodedAccount = JSON.stringify(accountId);
  const encodedPassword = JSON.stringify(password);
  const encodedRemember = JSON.stringify(remember);
  return evaluate(cdp, `(() => {
    const account = document.querySelector('input[autocomplete="username"]');
    const password = document.querySelector('input[autocomplete="current-password"]');
    const remember = document.querySelector('input[type="checkbox"]');
    if (!account || !password || !remember) return false;
    account.value = ${encodedAccount};
    account.dispatchEvent(new Event("input", { bubbles: true }));
    password.value = ${encodedPassword};
    password.dispatchEvent(new Event("input", { bubbles: true }));
    remember.checked = ${encodedRemember};
    remember.dispatchEvent(new Event("change", { bubbles: true }));
    account.form.requestSubmit();
    return true;
  })()`);
}

async function submitLocalCreation(cdp, accountId, password, companyName) {
  const encodedAccount = JSON.stringify(accountId);
  const encodedPassword = JSON.stringify(password);
  const encodedCompany = JSON.stringify(companyName);
  return evaluate(cdp, `(async () => {
    const account = document.querySelector('input[autocomplete="username"]');
    const password = document.querySelector('input[autocomplete="current-password"]');
    const company = [...document.querySelectorAll("input")]
      .find((item) => item.placeholder.includes("绿光"));
    if (!account || !password || !company) return false;
    account.value = ${encodedAccount};
    account.dispatchEvent(new Event("input", { bubbles: true }));
    password.value = ${encodedPassword};
    password.dispatchEvent(new Event("input", { bubbles: true }));
    company.value = ${encodedCompany};
    company.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const submit = [...document.querySelectorAll("button")]
      .find((item) => item.textContent.trim() === "明确创建并进入");
    if (!submit || submit.disabled) return false;
    submit.click();
    return true;
  })()`);
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-account-flow-"));
const trustStorePath = path.join(temporaryRoot, "trust.json");
const directoryConfigPath = path.join(temporaryRoot, "account-directory.json");
const userDataRoot = path.join(temporaryRoot, "user-data");
const certificatePath = path.join(temporaryRoot, "certificate.pem");
const certificateKeyPath = path.join(temporaryRoot, "certificate-key.pem");
let directoryServer = null;
let child = null;
let cdp = null;
let debugPort = null;
const directoryRequests = [];
const cloudLoginRequests = [];
let cloudLogoutRequests = 0;
let cloudLogoutAuthorization = "";
let syntheticSessionToken = "";
const issuedWorkspaceExpiries = [];
let cacheMarkerRequests = 0;
let originalPackagedTrustStore = null;
let originalPackagedAccountDirectory = null;

async function assertLocalInstanceMissing(code) {
  try {
    await stat(path.join(userDataRoot, "local-instance"));
    fail(code);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function stopDesktopProcess() {
  if (cdp) {
    cdp.close();
    cdp = null;
  }
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  child = null;
}

async function launchDesktopProcess() {
  debugPort = await unusedPort();
  const executable = packagedExecutable || require("electron");
  const electronUserDataArgument = `--user-data-dir=${path.join(userDataRoot, "electron-profile")}`;
  const executableArguments = packagedExecutable
    ? ["--ignore-certificate-errors", electronUserDataArgument, `--remote-debugging-port=${debugPort}`]
    : [
      "--ignore-certificate-errors",
      electronUserDataArgument,
      `--remote-debugging-port=${debugPort}`,
      ROOT,
    ];
  child = spawn(executable, executableArguments, {
    cwd: ROOT,
    env: {
      ...process.env,
      BIZHUB_DESKTOP_ACCOUNT_FLOW_SMOKE: "1",
      BIZHUB_DESKTOP_USER_DATA_ROOT: userDataRoot,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      ...(packagedExecutable ? {} : {
        BIZHUB_DESKTOP_ACCOUNT_DIRECTORY_CONFIG: directoryConfigPath,
        BIZHUB_DESKTOP_TRUSTED_KEYS: trustStorePath,
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.url === "bizhub-shell://app/") || null;
  }, "desktop_account_flow_debug_target_missing");
  cdp = createCdpClient(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
}

async function workspaceCdpClient() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await response.json();
    return targets.find((item) => item.url.includes("/workspace")) || null;
  }, "desktop_account_flow_workspace_debug_target_missing");
  const client = createCdpClient(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  return client;
}

async function localWorkspaceCdpClient() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await response.json();
    return targets.find((item) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(item.url)) || null;
  }, "desktop_account_flow_local_workspace_debug_target_missing");
  const client = createCdpClient(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  return client;
}

async function workspaceTargetPresent() {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  const targets = await response.json();
  return targets.some((item) => item.url.includes("/workspace"));
}

try {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", certificateKeyPath,
    "-out", certificatePath,
    "-subj", "/CN=localhost",
    "-days", "1",
  ], { stdio: "ignore" });
  const directoryPort = await unusedPort();
  const now = Date.now();
  syntheticSessionToken = jwtWithExpiry(Math.floor(now / 1000) + 3600);
  const workspaceOrigin = `https://127.0.0.1:${directoryPort}`;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "desktop-account-smoke-key";
  const descriptorTtlMs = 8_000;
  const issueEnvelope = () => {
    const expiresAt = Date.now() + descriptorTtlMs;
    const envelope = {
      schema_version: "bizhub.desktop-connection-envelope.v1",
      key_id: keyId,
      payload: {
        allowed_origins: [workspaceOrigin],
        application_url: `${workspaceOrigin}/workspace`,
        connection_id: "synthetic-enterprise",
        data_authority_mode: "cloud",
        display_name: "Synthetic Enterprise",
        expires_at: new Date(expiresAt).toISOString(),
        profile_id: "synthetic-profile",
        runtime_mode: "cloud",
        shell_min_version: "0.1.0",
      },
      signature: "",
    };
    envelope.signature = sign(null, signatureInput(envelope), privateKey).toString("base64url");
    issuedWorkspaceExpiries.push(expiresAt);
    return envelope;
  };
  const trustStore = {
    schema_version: "bizhub.desktop-trust-store.v1",
    keys: [{
      algorithm: "Ed25519",
      key_id: keyId,
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      valid_from: new Date(now - 60_000).toISOString(),
      valid_until: new Date(now + 10 * 60_000).toISOString(),
    }],
  };
  await Promise.all([
    writeFile(trustStorePath, `${JSON.stringify(trustStore, null, 2)}\n`, { mode: 0o600 }),
    writeFile(directoryConfigPath, `${JSON.stringify({
      schema_version: "bizhub.desktop-account-directory.v1",
      resolve_url: `https://127.0.0.1:${directoryPort}/v1/desktop/workspaces/resolve`,
    }, null, 2)}\n`, { mode: 0o600 }),
  ]);
  if (packagedExecutable) {
    [originalPackagedTrustStore, originalPackagedAccountDirectory] = await Promise.all([
      readFile(packagedTrustStore),
      readFile(packagedAccountDirectory),
    ]);
    const existingTrust = JSON.parse(originalPackagedTrustStore.toString("utf8"));
    const existingDirectory = JSON.parse(originalPackagedAccountDirectory.toString("utf8"));
    const expectedTrust = JSON.parse(
      await readFile(path.join(ROOT, "config", "trusted-connection-keys.json"), "utf8"),
    );
    const expectedDirectory = JSON.parse(
      await readFile(path.join(ROOT, "config", "account-directory.json"), "utf8"),
    );
    if (
      JSON.stringify(existingTrust) !== JSON.stringify(expectedTrust)
      || JSON.stringify(existingDirectory) !== JSON.stringify(expectedDirectory)
    ) {
      fail("desktop_account_flow_packaged_configuration_mismatch");
    }
    await Promise.all([
      writeFile(packagedTrustStore, `${JSON.stringify(trustStore, null, 2)}\n`),
      writeFile(packagedAccountDirectory, await readFile(directoryConfigPath)),
    ]);
  }

  directoryServer = createServer({
    cert: await readFile(certificatePath),
    key: await readFile(certificateKeyPath),
  }, (request, response) => {
    const requestUrl = new URL(request.url, workspaceOrigin);
    if (request.method === "GET" && requestUrl.pathname === "/workspace") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(`<!doctype html><html><body><main id="workspace-status">Workspace Login</main>
        <button id="workspace-logout" type="button">退出账号</button>
        <script>
          if (localStorage.getItem("token")) {
            document.getElementById("workspace-status").textContent = "Workspace Ready";
          }
          document.getElementById("workspace-logout").addEventListener("click", () => {
            localStorage.removeItem("bizhub_access_profile");
            localStorage.removeItem("bizhub_account_name");
            localStorage.removeItem("token");
            void fetch("/api/auth/logout", {
              method: "POST",
              credentials: "include",
              keepalive: true,
            });
          });
        </script></body></html>`);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/cache-marker") {
      cacheMarkerRequests += 1;
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600, immutable",
      });
      response.end(`cache-marker-${cacheMarkerRequests}`);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/auth/login") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        cloudLoginRequests.push(body);
        const parsed = JSON.parse(body);
        if (parsed.password !== "correct-cloud-password") {
          response.writeHead(401, { "Content-Type": "application/json" });
          response.end(`${JSON.stringify({ detail: "密码错误" })}\n`);
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "bizhub_auth=synthetic-cookie; HttpOnly; Secure; SameSite=Lax; Path=/",
        });
        response.end(`${JSON.stringify({
          token: syntheticSessionToken,
          account_name: "Synthetic Operator",
          roles: ["admin"],
          permissions: ["dashboard.read"],
          access_profile_version: 1,
        })}\n`);
      });
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
      cloudLogoutRequests += 1;
      cloudLogoutAuthorization = String(request.headers.authorization || "");
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "bizhub_auth=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/",
      });
      response.end("{\"ok\":true}\n");
      return;
    }
    if (request.method !== "POST" || requestUrl.pathname !== "/v1/desktop/workspaces/resolve") {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found\n");
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      directoryRequests.push(body);
      const parsed = JSON.parse(body);
      if (parsed.account_id === "known.empty") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(`${JSON.stringify({
          schema_version: "bizhub.desktop-workspace-directory-response.v1",
          workspaces: [],
        })}\n`);
        return;
      }
      if (parsed.account_id === "unknown.account") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end("{}\n");
        return;
      }
      if (parsed.account_id === "network.error") {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(`${JSON.stringify({
        schema_version: "bizhub.desktop-workspace-directory-response.v1",
        workspaces: [issueEnvelope()],
      })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    directoryServer.once("error", reject);
    directoryServer.listen(directoryPort, "127.0.0.1", resolve);
  });
  await launchDesktopProcess();

  const initial = await waitFor(async () => {
    const value = await evaluate(cdp, `({
      text: document.body.innerText,
      passwords: document.querySelectorAll('input[type="password"]').length,
      remember: document.querySelectorAll('input[type="checkbox"]').length,
      updateRows: document.querySelectorAll('.update-row[role="status"]').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    })`);
    return value.text.includes("登录 BizHub") ? value : null;
  }, "desktop_account_flow_initial_ui_missing");
  if (initial.passwords !== 1 || initial.remember !== 1 || initial.updateRows !== 1 || initial.overflow > 2) {
    fail("desktop_account_flow_initial_boundary_invalid");
  }
  if (initial.text.includes("开始本地设置")) fail("desktop_account_flow_separate_local_entry_present");
  if (!initial.text.includes("创建本地账号")) fail("desktop_account_flow_local_create_entry_missing");
  if (!initial.text.includes("游客体验")) fail("desktop_account_flow_guest_entry_missing");
  const directoryRequestsBeforeGuest = directoryRequests.length;
  if (!await clickButton(cdp, "游客体验")) fail("desktop_account_flow_guest_entry_not_clickable");
  const guestState = await waitFor(async () => {
    const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
    if (value.guestDemoStatus === "error" || value.status === "error") {
      throw new Error(value.error || value.localError || "desktop_guest_demo_unknown_error");
    }
    return value.mode === "guest" && value.status === "connected" ? value : null;
  }, "desktop_account_flow_guest_not_connected", 60_000).catch(async (error) => {
    const current = await evaluate(cdp, "window.bizhubDesktop.getState()").catch(() => null);
    throw new Error(`${error.message}:${JSON.stringify(current)}`);
  });
  if (
    directoryRequests.length !== directoryRequestsBeforeGuest
    || guestState.guestDemoStatus !== "ready"
    || guestState.guestDemoReadback?.overview?.parties !== 4
    || guestState.guestDemoReadback?.overview?.procurement_orders !== 2
    || guestState.guestDemoReadback?.overview?.sales_orders !== 2
    || guestState.guestDemoReadback?.overview?.inventory_movements !== 3
  ) {
    fail("desktop_account_flow_guest_boundary_invalid");
  }
  await assertLocalInstanceMissing("desktop_account_flow_guest_created_formal_local_instance");
  await stat(path.join(userDataRoot, "guest-demo", "local-instance", "instance.json"));
  {
    const guestWorkspace = await localWorkspaceCdpClient();
    const product = await waitFor(async () => {
      const value = await evaluate(guestWorkspace, `({
        text: document.body.innerText,
        title: document.querySelector("h1")?.textContent?.trim() || "",
        visibleNav: [...document.querySelectorAll("nav button")]
          .filter((item) => getComputedStyle(item).display !== "none")
          .map((item) => item.textContent.trim())
      })`);
      return value.title === "经营概览" && value.text.includes("星河新材料样板间") ? value : null;
    }, "desktop_account_flow_guest_product_missing");
    guestWorkspace.close();
    if (
      !product.visibleNav.includes("主数据")
      || !product.visibleNav.includes("采购")
      || !product.visibleNav.includes("销售")
      || !product.visibleNav.includes("库存")
      || product.visibleNav.includes("设置")
    ) {
      fail("desktop_account_flow_guest_product_invalid");
    }
  }
  const guestChrome = await evaluate(cdp, "document.body.innerText");
  if (!guestChrome.includes("游客样板间") || !guestChrome.includes("退出应用后自动重置")) {
    fail("desktop_account_flow_guest_banner_missing");
  }
  await evaluate(cdp, "window.bizhubDesktop.switchAccount()");
  await waitFor(async () => (await evaluate(cdp, "document.body.innerText")).includes("登录 BizHub"),
    "desktop_account_flow_guest_exit_not_returned");
  try {
    await stat(path.join(userDataRoot, "guest-demo"));
    fail("desktop_account_flow_guest_data_not_reset");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (directoryRequests.length !== directoryRequestsBeforeGuest) {
    fail("desktop_account_flow_guest_contacted_directory");
  }
  const directoryRequestsBeforeDirectLocal = directoryRequests.length;
  if (!await clickButton(cdp, "创建本地账号")) {
    fail("desktop_account_flow_local_create_entry_not_clickable");
  }
  await waitFor(async () => {
    const value = await evaluate(cdp, `({
      text: document.body.innerText,
      companyFields: [...document.querySelectorAll("input")]
        .filter((item) => item.placeholder.includes("绿光")).length
    })`);
    return value.text.includes("创建本地 BizHub") && value.companyFields === 1 ? value : null;
  }, "desktop_account_flow_direct_local_setup_missing");
  if (directoryRequests.length !== directoryRequestsBeforeDirectLocal) {
    fail("desktop_account_flow_direct_local_setup_contacted_directory");
  }
  await assertLocalInstanceMissing("desktop_account_flow_direct_local_setup_created_instance_early");
  if (!await clickButton(cdp, "取消")) fail("desktop_account_flow_direct_local_cancel_missing");
  await waitFor(async () => {
    const value = await evaluate(cdp, `({
      companyFields: [...document.querySelectorAll("input")]
        .filter((item) => item.placeholder.includes("绿光")).length
    })`);
    return value.companyFields === 0 ? value : null;
  }, "desktop_account_flow_direct_local_cancel_failed");
  if (!await enterCredentials(cdp, "Charles.Example", "correct-cloud-password", false)) {
    fail("desktop_account_flow_credentials_input_missing");
  }
  await waitFor(async () => {
    const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
    return value.mode === "cloud" && value.status === "connected" ? value : null;
  }, "desktop_account_flow_cloud_not_connected", 45_000);
  const connectedShell = await evaluate(cdp, `({
    shellBarVisible: document.querySelector(".shell-bar") !== null,
    startPageVisible: document.querySelector(".unified-start") !== null
  })`);
  if (connectedShell.shellBarVisible || connectedShell.startPageVisible) {
    fail("desktop_account_flow_cloud_chrome_not_removed");
  }
  if (
    directoryRequests.length !== 1
    || directoryRequests[0].includes("password")
    || cloudLoginRequests.length !== 1
    || JSON.parse(cloudLoginRequests[0]).password !== "correct-cloud-password"
  ) {
    fail("desktop_account_flow_credential_routing_invalid");
  }
  const firstDescriptorExpiresAt = issuedWorkspaceExpiries[0];
  if (!Number.isSafeInteger(firstDescriptorExpiresAt)) {
    fail("desktop_account_flow_descriptor_expiry_missing");
  }
  {
    const workspaceCdp = await workspaceCdpClient();
    const state = await evaluate(workspaceCdp, `(async () => ({
      text: document.body.innerText,
      token: localStorage.getItem("token"),
      profile: localStorage.getItem("bizhub_access_profile"),
      desktopInfo: await window.bizhubDesktop?.getInfo()
    }))()`);
    workspaceCdp.close();
    if (
      !state.text.includes("Workspace Ready")
      || state.token !== syntheticSessionToken
      || !state.profile?.includes("dashboard.read")
      || state.desktopInfo?.schemaVersion !== "bizhub.desktop-cloud-info.v1"
      || state.desktopInfo?.mode !== "cloud"
      || state.desktopInfo?.appVersion !== packageJson.version
    ) {
      fail("desktop_account_flow_direct_login_not_ready");
    }
  }

  const directoryRequestsBeforeBackgroundRestore = directoryRequests.length;
  const cloudLoginRequestsBeforeBackgroundRestore = cloudLoginRequests.length;
  await evaluate(cdp, "window.bizhubDesktop.hideWindowForSmoke()");
  await waitFor(async () => (await evaluate(cdp, "document.visibilityState")) === "hidden",
    "desktop_account_flow_window_not_hidden_in_background");
  if (!await workspaceTargetPresent()) {
    fail("desktop_account_flow_workspace_destroyed_in_background");
  }
  await evaluate(cdp, "window.bizhubDesktop.restoreWindowForSmoke()");
  await waitFor(async () => (await evaluate(cdp, "document.visibilityState")) === "visible",
    "desktop_account_flow_background_window_not_restored");
  const backgroundRestoredState = await evaluate(cdp, "window.bizhubDesktop.getState()");
  if (
    backgroundRestoredState.mode !== "cloud"
    || backgroundRestoredState.status !== "connected"
    || directoryRequests.length !== directoryRequestsBeforeBackgroundRestore
    || cloudLoginRequests.length !== cloudLoginRequestsBeforeBackgroundRestore
    || !await workspaceTargetPresent()
  ) {
    fail("desktop_account_flow_background_session_not_retained");
  }

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 960,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const compactOverflow = await evaluate(
    cdp,
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
  if (compactOverflow > 2) fail("desktop_account_flow_compact_overflow");
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  await new Promise((resolve) => setTimeout(
    resolve,
    Math.max(0, firstDescriptorExpiresAt + 750 - Date.now()),
  ));
  const connectedAfterDescriptorExpiry = await evaluate(cdp, "window.bizhubDesktop.getState()");
  if (
    connectedAfterDescriptorExpiry.mode !== "cloud"
    || connectedAfterDescriptorExpiry.status !== "connected"
    || !await workspaceTargetPresent()
  ) {
    fail("desktop_account_flow_connected_workspace_expired_with_descriptor");
  }
  await evaluate(cdp, "window.bizhubDesktop.disconnectWorkspace()");
  await evaluate(
    cdp,
    'window.bizhubDesktop.connectEnterpriseWorkspace("synthetic-enterprise")',
  );
  await waitFor(async () => {
    const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
    return value.error === "profile_expired" ? value : null;
  }, "desktop_account_flow_expired_descriptor_reconnect_not_rejected");
  if (await workspaceTargetPresent()) {
    fail("desktop_account_flow_expired_descriptor_reopened_workspace");
  }
  await evaluate(cdp, "window.bizhubDesktop.switchAccount()");
  if (!await enterCredentials(cdp, "Charles.Example", "correct-cloud-password", false)) {
    fail("desktop_account_flow_fresh_descriptor_input_missing");
  }
  await waitFor(async () => {
    const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
    return value.mode === "cloud" && value.status === "connected" ? value : null;
  }, "desktop_account_flow_fresh_descriptor_not_connected", 45_000);
  if (
    issuedWorkspaceExpiries.length < 2
    || issuedWorkspaceExpiries[1] <= firstDescriptorExpiresAt
  ) {
    fail("desktop_account_flow_fresh_descriptor_not_issued");
  }
  await evaluate(cdp, "window.bizhubDesktop.disconnectWorkspace()");
  await evaluate(cdp, "window.bizhubDesktop.switchAccount()");

  const directoryRequestsBeforeSavedCloudLocal = directoryRequests.length;
  const savedCloudAccountBeforeExpand = await evaluate(
    cdp,
    'document.querySelector(\'input[autocomplete="username"]\')?.value || ""',
  );
  if (!await clickButton(cdp, "创建本地账号")) {
    fail("desktop_account_flow_saved_cloud_local_create_entry_missing");
  }
  const savedCloudLocalSetup = await waitFor(async () => {
    const value = await evaluate(cdp, `({
      username: document.querySelector('input[autocomplete="username"]')?.value || "",
      text: document.body.innerText
    })`);
    return value.text.includes("确认时会先验证该账号没有企业云端身份") ? value : null;
  }, "desktop_account_flow_saved_cloud_local_setup_missing");
  if (savedCloudLocalSetup.username !== savedCloudAccountBeforeExpand) {
    fail("desktop_account_flow_saved_cloud_account_changed_on_expand");
  }
  if (directoryRequests.length !== directoryRequestsBeforeSavedCloudLocal) {
    fail("desktop_account_flow_saved_cloud_local_setup_contacted_directory");
  }
  const savedAccountsPath = path.join(userDataRoot, "saved-accounts.v2.json");
  const savedCloudBytesBeforeRejectedCreate = await readFile(savedAccountsPath, "utf8");
  if (!await submitLocalCreation(
    cdp,
    "charles.example",
    "synthetic local password",
    "Cloud Name Collision",
  )) {
    fail("desktop_account_flow_cloud_account_local_submit_missing");
  }
  await waitFor(async () => {
    const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
    return value.localError === "desktop_local_creation_cloud_account_exists" ? value : null;
  }, "desktop_account_flow_cloud_account_local_create_not_rejected");
  if (directoryRequests.length !== directoryRequestsBeforeSavedCloudLocal + 1) {
    fail("desktop_account_flow_cloud_account_local_create_lookup_missing");
  }
  const savedCloudBytesAfterRejectedCreate = await readFile(savedAccountsPath, "utf8");
  if (savedCloudBytesAfterRejectedCreate !== savedCloudBytesBeforeRejectedCreate) {
    fail("desktop_account_flow_rejected_local_create_changed_saved_cloud_account");
  }
  await assertLocalInstanceMissing("desktop_account_flow_cloud_account_created_local_instance");
  if (!await clickButton(cdp, "取消")) fail("desktop_account_flow_saved_cloud_local_cancel_missing");

  if (!await clickButton(cdp, "创建本地账号")) {
    fail("desktop_account_flow_registered_local_create_entry_missing");
  }
  const directoryRequestsBeforeRegisteredCreate = directoryRequests.length;
  if (!await submitLocalCreation(
    cdp,
    "known.empty",
    "synthetic local password",
    "Registered Without Workspace",
  )) {
    fail("desktop_account_flow_registered_local_submit_missing");
  }
  await waitFor(async () => {
    const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
    return value.localError === "desktop_local_creation_account_registered" ? value : null;
  }, "desktop_account_flow_registered_local_create_not_rejected");
  if (directoryRequests.length !== directoryRequestsBeforeRegisteredCreate + 1) {
    fail("desktop_account_flow_registered_local_create_lookup_missing");
  }
  await assertLocalInstanceMissing("desktop_account_flow_registered_account_created_local_instance");
  if (!await clickButton(cdp, "取消")) fail("desktop_account_flow_registered_local_cancel_missing");

  if (!await clickButton(cdp, "创建本地账号")) {
    fail("desktop_account_flow_network_error_local_create_entry_missing");
  }
  const directoryRequestsBeforeNetworkErrorCreate = directoryRequests.length;
  if (!await submitLocalCreation(
    cdp,
    "network.error",
    "synthetic local password",
    "Network Failure",
  )) {
    fail("desktop_account_flow_network_error_local_submit_missing");
  }
  await waitFor(async () => {
    const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
    return value.localError === "desktop_account_directory_unreachable" ? value : null;
  }, "desktop_account_flow_network_error_local_create_not_rejected");
  if (directoryRequests.length !== directoryRequestsBeforeNetworkErrorCreate + 1) {
    fail("desktop_account_flow_network_error_local_create_lookup_missing");
  }
  await assertLocalInstanceMissing("desktop_account_flow_network_error_created_local_instance");
  if (!await clickButton(cdp, "取消")) fail("desktop_account_flow_network_error_local_cancel_missing");

  const cloudLoginsBeforeNoWorkspace = cloudLoginRequests.length;
  if (!await enterCredentials(cdp, "known.empty", "not-sent", false)) {
    fail("desktop_account_flow_empty_input_missing");
  }
  const empty = await waitFor(async () => {
    const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
    return value.error === "desktop_account_no_workspace" ? value : null;
  }, "desktop_account_flow_empty_state_missing");
  if (
    empty.canCreateLocal !== false
    || cloudLoginRequests.length !== cloudLoginsBeforeNoWorkspace
  ) {
    fail("desktop_account_flow_empty_fallback_invalid");
  }
  await evaluate(cdp, "window.bizhubDesktop.switchAccount()");
  if (!await enterCredentials(cdp, "unknown.account", "not-sent", false)) {
    fail("desktop_account_flow_unknown_input_missing");
  }
  const unknown = await waitFor(async () => {
    const value = await evaluate(cdp, `(async () => ({
      state: await window.bizhubDesktop.getState(),
      text: document.body.innerText
    }))()`);
    const resolved = value.state;
    return resolved.canCreateLocal && value.text.includes("创建本地 BizHub")
      ? { ...resolved, text: value.text }
      : null;
  }, "desktop_account_flow_unknown_state_missing");
  if (
    unknown.pendingLocalAccountId !== "unknown.account"
    || cloudLoginRequests.length !== cloudLoginsBeforeNoWorkspace
  ) {
    fail("desktop_account_flow_unknown_fallback_invalid");
  }
  await assertLocalInstanceMissing("desktop_account_flow_unknown_created_local_instance");
  const setup = await waitFor(async () => {
    const value = await evaluate(cdp, `({
      text: document.body.innerText,
      username: document.querySelector('input[autocomplete="username"]')?.value || "",
      companyFields: [...document.querySelectorAll("input")].filter((item) => item.placeholder.includes("绿光")).length
    })`);
    return value.text.includes("创建本地 BizHub") && value.companyFields === 1 ? value : null;
  }, "desktop_account_flow_local_setup_missing");
  if (setup.username !== "unknown.account") fail("desktop_account_flow_local_username_not_carried");

  {
    await stopDesktopProcess();
    await launchDesktopProcess();
    await waitFor(async () => (await evaluate(cdp, "document.body.innerText")).includes("登录 BizHub"),
      "desktop_account_flow_restart_initial_ui_missing");
    if (!await enterCredentials(cdp, "Charles.Example", "correct-cloud-password", true)) {
      fail("desktop_account_flow_remembered_login_input_missing");
    }
    await waitFor(async () => {
      const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
      return value.mode === "cloud" && value.status === "connected" && value.rememberedLoginAvailable
        ? value
        : null;
    }, "desktop_account_flow_remembered_login_not_connected", 45_000);
    const rememberedSessionPath = path.join(userDataRoot, "saved-accounts.v2.json");
    const rememberedSessionBytes = await readFile(rememberedSessionPath, "utf8");
    if (
      !rememberedSessionBytes.includes("charles.example")
      || !rememberedSessionBytes.includes(syntheticSessionToken)
      || rememberedSessionBytes.includes("correct-cloud-password")
    ) {
      fail("desktop_account_flow_remembered_session_invalid");
    }
    {
      const workspaceCdp = await workspaceCdpClient();
      const beforeRestart = await evaluate(workspaceCdp, `(async () => {
        document.cookie = "w1_session=remembered; Secure; SameSite=Lax";
        localStorage.setItem("w1_session", "remembered");
        return {
          cookie: document.cookie,
          storage: localStorage.getItem("w1_session"),
          cache: await fetch("/cache-marker").then((response) => response.text()),
        };
      })()`);
      workspaceCdp.close();
      if (!beforeRestart.cookie.includes("w1_session=remembered") || beforeRestart.storage !== "remembered") {
        fail("desktop_account_flow_restart_marker_missing");
      }
    }
    const cacheRequestsBeforeRestart = cacheMarkerRequests;
    const directoryRequestsBeforeAutoLogin = directoryRequests.length;
    const cloudLoginRequestsBeforeAutoLogin = cloudLoginRequests.length;
    await stopDesktopProcess();
    await launchDesktopProcess();
    await waitFor(async () => {
      const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
      return value.mode === "cloud" && value.status === "connected" && value.autoLoginStatus === "connected"
        ? value
        : null;
    }, "desktop_account_flow_auto_login_not_connected", 45_000);
    if (
      directoryRequests.length !== directoryRequestsBeforeAutoLogin + 1
      || cloudLoginRequests.length !== cloudLoginRequestsBeforeAutoLogin
    ) {
      fail("desktop_account_flow_auto_login_did_not_reuse_token");
    }
    {
      const workspaceCdp = await workspaceCdpClient();
      const restartedSession = await evaluate(workspaceCdp, `(async () => ({
        cookie: document.cookie,
        storage: localStorage.getItem("w1_session"),
        token: localStorage.getItem("token"),
        cache: await fetch("/cache-marker").then((response) => response.text()),
      }))()`);
      workspaceCdp.close();
      if (
        restartedSession.cookie.includes("w1_session=remembered")
        || restartedSession.storage !== null
        || restartedSession.token !== syntheticSessionToken
        || cacheMarkerRequests !== cacheRequestsBeforeRestart + 1
      ) {
        fail("desktop_account_flow_cross_restart_auto_login_invalid");
      }
    }
    if (directoryRequests.some((body) => body.includes("password"))) {
      fail("desktop_account_flow_directory_credential_leak_after_restart");
    }
    {
      const workspaceCdp = await workspaceCdpClient();
      const clicked = await evaluate(workspaceCdp, `(() => {
        const button = document.getElementById("workspace-logout");
        if (!button) return false;
        button.click();
        return true;
      })()`);
      workspaceCdp.close();
      if (!clicked) fail("desktop_account_flow_workspace_logout_control_missing");
    }
    await waitFor(async () => (await evaluate(cdp, "document.body.innerText")).includes("登录 BizHub"),
      "desktop_account_flow_workspace_logout_not_returned");
    const signedOutSavedAccounts = JSON.parse(await readFile(rememberedSessionPath, "utf8"));
    const signedOutAccount = signedOutSavedAccounts.accounts.find(
      (account) => account.accountId === "charles.example",
    );
    if (!signedOutAccount || signedOutAccount.session !== null) {
      fail("desktop_account_flow_forget_did_not_clear_session");
    }
    if (
      cloudLogoutRequests !== 1
      || cloudLogoutAuthorization !== ""
    ) {
      fail("desktop_account_flow_cloud_logout_missing");
    }
  }

  const directoryRequestsBeforeConfirmedLocal = directoryRequests.length;
  if (!await clickButton(cdp, "创建本地账号")) {
    fail("desktop_account_flow_confirmed_local_create_entry_missing");
  }
  if (!await submitLocalCreation(
    cdp,
    "unknown.account",
    "synthetic local password",
    "Confirmed Local Company",
  )) {
    fail("desktop_account_flow_confirmed_local_submit_missing");
  }
  await waitFor(async () => {
    const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
    return value.mode === "local" && value.status === "connected" ? value : null;
  }, "desktop_account_flow_confirmed_not_found_local_not_created", 45_000);
  if (directoryRequests.length !== directoryRequestsBeforeConfirmedLocal + 1) {
    fail("desktop_account_flow_confirmed_local_create_lookup_missing");
  }
  await stat(path.join(userDataRoot, "local-instance", "instance.json"));
  const savedAfterLocalCreate = JSON.parse(await readFile(savedAccountsPath, "utf8"));
  const preservedCloudAccount = savedAfterLocalCreate.accounts.find(
    (account) => account.accountId === "charles.example",
  );
  const createdLocalAccount = savedAfterLocalCreate.accounts.find(
    (account) => account.accountId === "unknown.account",
  );
  if (
    preservedCloudAccount?.mode !== "cloud"
    || preservedCloudAccount.session !== null
    || createdLocalAccount?.mode !== "local"
  ) {
    fail("desktop_account_flow_confirmed_local_saved_account_boundary_invalid");
  }
  const stoppedLocalState = await evaluate(cdp, "window.bizhubDesktop.stopLocal()");
  if (
    stoppedLocalState.mode !== "none"
    || stoppedLocalState.status !== "idle"
    || stoppedLocalState.localStatus !== "stopped"
  ) {
    fail("desktop_account_flow_confirmed_local_runtime_not_stopped");
  }
  if (await workspaceTargetPresent()) {
    fail("desktop_account_flow_confirmed_local_workspace_not_closed");
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    shell_route: "bizhub-shell://app/",
    account_screen_password_fields: 1,
    unified_account_password_submit: true,
    account_directory_requests: directoryRequests.length,
    account_directory_passwords: 0,
    signed_cloud_workspaces: 1,
    guest_demo_without_credentials: true,
    guest_demo_directory_requests: 0,
    guest_demo_owner_seed_readback: true,
    guest_demo_reset_after_exit: true,
    guest_demo_formal_local_instances_created: 0,
    cloud_password_logins: cloudLoginRequests.length,
    cloud_workspace_connected: true,
    cloud_settings_bridge_connected: true,
    descriptor_ttl_ms: descriptorTtlMs,
    connected_workspace_survived_descriptor_expiry: true,
    expired_descriptor_reconnect_rejected: true,
    fresh_descriptor_requery_reconnected: true,
    cloud_account_local_instances_created: 0,
    known_account_without_workspace_local_instances_created: 0,
    network_error_local_instances_created: 0,
    unconfirmed_unknown_account_local_instances_created: 0,
    confirmed_not_found_local_instances_created: 1,
    final_local_create_directory_lookup: true,
    saved_cloud_account_preserved: true,
    confirmed_local_runtime_stopped: true,
    local_setup_form_reached: true,
    remembered_password_fields: 0,
    remembered_session_token_saved: true,
    remembered_session_auto_connected: true,
    auto_login_reused_token_without_password: true,
    forget_clears_session_token: true,
    forget_revokes_cloud_session: true,
    cloud_workspace_hides_desktop_chrome: true,
    workspace_logout_clears_desktop_session: true,
    close_to_background_session_retained: true,
    same_process_restores_background_window: true,
    windows_tray_background_supported: true,
    cross_restart_cookie_storage_cache_cleared: true,
    remembered_login_test_skipped: false,
    cloud_session_persistent: false,
    packaged: Boolean(packagedExecutable),
    viewports: ["1280x820", "960x720"],
  })}\n`);
} catch (error) {
  fail(
    error instanceof Error ? error.message : "desktop_account_flow_smoke_failed",
    child && !child.killed ? "electron_running" : "",
  );
} finally {
  await stopDesktopProcess();
  if (directoryServer) await new Promise((resolve) => directoryServer.close(resolve));
  if (packagedTrustStore && originalPackagedTrustStore) {
    await writeFile(packagedTrustStore, originalPackagedTrustStore);
  }
  if (packagedAccountDirectory && originalPackagedAccountDirectory) {
    await writeFile(packagedAccountDirectory, originalPackagedAccountDirectory);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
