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
  const executableArguments = packagedExecutable
    ? ["--ignore-certificate-errors", `--remote-debugging-port=${debugPort}`]
    : ["--ignore-certificate-errors", `--remote-debugging-port=${debugPort}`, ROOT];
  child = spawn(executable, executableArguments, {
    cwd: ROOT,
    env: {
      ...process.env,
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
        <script>
          if (localStorage.getItem("token")) {
            document.getElementById("workspace-status").textContent = "Workspace Ready";
          }
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
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    })`);
    return value.text.includes("登录 BizHub") ? value : null;
  }, "desktop_account_flow_initial_ui_missing");
  if (initial.passwords !== 1 || initial.remember !== 1 || initial.overflow > 2) {
    fail("desktop_account_flow_initial_boundary_invalid");
  }
  if (!initial.text.includes("GENERIC LOCAL")) fail("desktop_account_flow_generic_local_missing");
  if (!await enterCredentials(cdp, "Charles.Example", "correct-cloud-password", false)) {
    fail("desktop_account_flow_credentials_input_missing");
  }
  await waitFor(async () => {
    const value = await evaluate(cdp, "window.bizhubDesktop.getState()");
    return value.mode === "cloud" && value.status === "connected" ? value : null;
  }, "desktop_account_flow_cloud_not_connected", 45_000);
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
    const state = await evaluate(workspaceCdp, `({
      text: document.body.innerText,
      token: localStorage.getItem("token"),
      profile: localStorage.getItem("bizhub_access_profile")
    })`);
    workspaceCdp.close();
    if (
      !state.text.includes("Workspace Ready")
      || state.token !== syntheticSessionToken
      || !state.profile?.includes("dashboard.read")
    ) {
      fail("desktop_account_flow_direct_login_not_ready");
    }
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
  if (!await clickButton(cdp, "换一个账号")) fail("desktop_account_flow_change_account_missing");
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
  if (!await clickButton(cdp, "换一个账号")) {
    fail("desktop_account_flow_fresh_descriptor_change_account_missing");
  }

  const cloudLoginsBeforeNoWorkspace = cloudLoginRequests.length;
  if (!await enterCredentials(cdp, "known.empty", "not-sent", false)) {
    fail("desktop_account_flow_empty_input_missing");
  }
  const empty = await waitFor(async () => {
    const text = await evaluate(cdp, "document.body.innerText");
    return text.includes("该账号当前没有企业云端工作区") ? text : null;
  }, "desktop_account_flow_empty_state_missing");
  if (
    !empty.includes("不会自动创建数据库")
    || cloudLoginRequests.length !== cloudLoginsBeforeNoWorkspace
  ) {
    fail("desktop_account_flow_empty_fallback_invalid");
  }
  if (!await clickButton(cdp, "换一个账号")) fail("desktop_account_flow_empty_change_account_missing");
  if (!await enterCredentials(cdp, "unknown.account", "not-sent", false)) {
    fail("desktop_account_flow_unknown_input_missing");
  }
  const unknown = await waitFor(async () => {
    const text = await evaluate(cdp, "document.body.innerText");
    return text.includes("没有找到企业云端工作区") ? text : null;
  }, "desktop_account_flow_unknown_state_missing");
  if (
    !unknown.includes("不会自动创建数据库")
    || cloudLoginRequests.length !== cloudLoginsBeforeNoWorkspace
  ) {
    fail("desktop_account_flow_unknown_fallback_invalid");
  }
  try {
    await stat(path.join(userDataRoot, "local-instance"));
    fail("desktop_account_flow_unknown_created_local_instance");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!await clickButton(cdp, "开始本地设置")) fail("desktop_account_flow_local_setup_button_missing");
  const setup = await waitFor(async () => {
    const value = await evaluate(cdp, `({
      text: document.body.innerText,
      username: document.querySelector('input[autocomplete="username"]')?.value || ""
    })`);
    return value.text.includes("创建一个本地 Generic 实例") ? value : null;
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
    const rememberedSessionPath = path.join(userDataRoot, "remembered-session.v1.json");
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
    await evaluate(cdp, "window.bizhubDesktop.forgetRememberedLogin()");
    await waitFor(async () => (await evaluate(cdp, "document.body.innerText")).includes("登录 BizHub"),
      "desktop_account_flow_forget_not_returned");
    try {
      await stat(rememberedSessionPath);
      fail("desktop_account_flow_forget_did_not_remove_session");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (
      cloudLogoutRequests !== 1
      || cloudLogoutAuthorization !== `Bearer ${syntheticSessionToken}`
    ) {
      fail("desktop_account_flow_cloud_logout_missing");
    }
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    shell_route: "bizhub-shell://app/",
    account_screen_password_fields: 1,
    unified_account_password_submit: true,
    account_directory_requests: directoryRequests.length,
    account_directory_passwords: 0,
    signed_cloud_workspaces: 1,
    cloud_password_logins: cloudLoginRequests.length,
    cloud_workspace_connected: true,
    descriptor_ttl_ms: descriptorTtlMs,
    connected_workspace_survived_descriptor_expiry: true,
    expired_descriptor_reconnect_rejected: true,
    fresh_descriptor_requery_reconnected: true,
    known_account_without_workspace_local_instances_created: 0,
    unknown_account_local_instances_created: 0,
    local_setup_form_reached: true,
    remembered_password_fields: 0,
    remembered_session_token_saved: true,
    remembered_session_auto_connected: true,
    auto_login_reused_token_without_password: true,
    forget_removes_session: true,
    forget_revokes_cloud_session: true,
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
