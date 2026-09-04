const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeImage,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
  WebContentsView,
} = require("electron");
const { randomBytes } = require("node:crypto");
const { mkdir, readFile, rm, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { validateConnectionEnvelope } = require("./connection-profile.cjs");
const {
  createAccountLookupGeneration,
  normalizeAccountId,
  resolveAccountWorkspaces,
  workspaceSessionPartition,
} = require("./account-directory.cjs");
const {
  cloudLoginError,
  cloudLoginScript,
  cloudLogoutScript,
  isCloudLogoutRequest,
  sessionStorageScript,
  validateCloudLoginInput,
} = require("./cloud-login.cjs");
const {
  clearAccountSession,
  loadSavedAccounts,
  saveAccount,
  setActiveAccount,
} = require("./credential-store.cjs");
const {
  localRequestAllowed,
  normalizeLocalOrigin,
  remoteRequestAllowed,
} = require("./network-policy.cjs");
const {
  RUNTIME_COOKIE,
  backupLocalInstance,
  bootstrapLocalInstance,
  changeLocalPasswordRuntime,
  fetchRuntime,
  loadLocalAdminIdentity,
  loadLocalInstance,
  loginLocalRuntime,
  recoverInterruptedLocalSetup,
  resumeLocalRuntime,
  startLocalRuntime,
  stopLocalRuntime,
} = require("./local-runtime.cjs");
const { createLocalRuntimeLifecycle } = require("./local-lifecycle.cjs");
const {
  DEMO_COMPANY_NAME,
  DEMO_USERNAME,
  seedGuestDemo,
} = require("./guest-demo.cjs");
const { handleSquirrelStartup } = require("./squirrel-startup.cjs");
const {
  finalizePendingMacUpdate,
  launchMacUpdate,
  launchWindowsUpdate,
  prepareMacUpdate,
} = require("./update-installer.cjs");
const {
  checkForUpdate,
  downloadUpdateArtifactWithFallback,
  normalizeUpdateConfig,
} = require("./update-manager.cjs");
const {
  DEFAULT_PREFERENCES,
  loadPreferences,
  mergePreferences,
  resolveWindowCloseAction,
  savePreferences,
} = require("./preferences.cjs");

const SHELL_ORIGIN = "bizhub-shell://app";
const SHELL_URL = `${SHELL_ORIGIN}/`;
const HEADER_HEIGHT = 72;
const GUEST_BANNER_HEIGHT = 36;
const MAX_PROFILE_BYTES = 64 * 1024;
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".woff2", "font/woff2"],
]);

let mainWindow = null;
let workspaceView = null;
let backgroundTray = null;
const remoteSessionPolicies = new WeakMap();
const localSessionPolicies = new WeakMap();
let activeEnterpriseProfiles = new Map();
const accountLookupGeneration = createAccountLookupGeneration();
let shutdownInProgress = false;
let quitRequested = false;
let cloudLogoutCleanupPromise = null;
let updateCheckPromise = null;
let updateDownloadPromise = null;
let availableUpdate = null;
let downloadedUpdate = null;
let localRuntimeKind = "local";
let desktopPreferences = { ...DEFAULT_PREFERENCES };
const localRuntimeLifecycle = createLocalRuntimeLifecycle({
  startRuntime: launchLocalRuntime,
  stopRuntime: stopLocalRuntime,
});
let workspaceState = {
  appVersion: app.getVersion(),
  platform: process.platform,
  mode: "none",
  status: "idle",
  displayName: "",
  profileId: "",
  applicationOrigin: "",
  error: "",
  localInitialized: false,
  localAccountId: "",
  localStatus: "stopped",
  localError: "",
  localLastBackup: "",
  accountLookupStatus: "idle",
  accountNotFound: false,
  enterpriseWorkspaces: [],
  rememberedLoginAvailable: false,
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
  guestDemoStatus: "idle",
  guestDemoReadback: null,
  preferences: null,
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: "bizhub-shell",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);
app.enableSandbox();
if (process.env.BIZHUB_DESKTOP_USER_DATA_ROOT) {
  app.setPath(
    "userData",
    path.join(path.resolve(process.env.BIZHUB_DESKTOP_USER_DATA_ROOT), "electron-profile"),
  );
}
if (process.env.BIZHUB_DESKTOP_SMOKE_EXIT_ON_LOAD === "1") {
  app.disableHardwareAcceleration();
}
const squirrelStartupHandled = handleSquirrelStartup(app);
const hasSingleInstanceLock = !squirrelStartupHandled && app.requestSingleInstanceLock();

function rendererRoot() {
  return path.resolve(__dirname, "..", "dist", "renderer");
}

function trustStorePath() {
  if (!app.isPackaged && process.env.BIZHUB_DESKTOP_TRUSTED_KEYS) {
    return path.resolve(process.env.BIZHUB_DESKTOP_TRUSTED_KEYS);
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, "trusted-connection-keys.json")
    : path.resolve(__dirname, "..", "config", "trusted-connection-keys.json");
}

function desktopUserDataRoot() {
  const override = process.env.BIZHUB_DESKTOP_USER_DATA_ROOT;
  return override ? path.resolve(override) : app.getPath("userData");
}

function credentialStoreOptions() {
  return { safeStorage, userDataRoot: desktopUserDataRoot() };
}

function publicDesktopPreferences() {
  return {
    ...desktopPreferences,
    effectiveTheme: desktopPreferences.theme === "system"
      ? (nativeTheme.shouldUseDarkColors ? "dark" : "light")
      : desktopPreferences.theme,
  };
}

function sendDesktopPreferences(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  webContents.setZoomFactor(desktopPreferences.zoomPercent / 100);
  webContents.send("desktop:preferences", publicDesktopPreferences());
}

function applyDesktopPreferences() {
  const preferences = publicDesktopPreferences();
  workspaceState = { ...workspaceState, preferences };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(preferences.effectiveTheme === "dark" ? "#15191d" : "#f4f6f8");
    sendDesktopPreferences(mainWindow.webContents);
    mainWindow.webContents.send("desktop:state", workspaceState);
  }
  sendDesktopPreferences(workspaceView?.webContents);
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: desktopPreferences.launchAtLogin });
  }
  return preferences;
}

async function updateDesktopPreferences(patch) {
  desktopPreferences = await savePreferences(
    desktopUserDataRoot(),
    mergePreferences(desktopPreferences, patch),
  );
  return applyDesktopPreferences();
}

function localInstanceRoot() {
  return path.join(desktopUserDataRoot(), "local-instance");
}

function guestDemoRoot() {
  return path.join(desktopUserDataRoot(), "guest-demo");
}

function guestInstanceRoot() {
  return path.join(guestDemoRoot(), "local-instance");
}

function activeLocalInstanceRoot() {
  return localRuntimeKind === "guest" ? guestInstanceRoot() : localInstanceRoot();
}

function accountDirectoryConfigPath() {
  if (!app.isPackaged && process.env.BIZHUB_DESKTOP_ACCOUNT_DIRECTORY_CONFIG) {
    return path.resolve(process.env.BIZHUB_DESKTOP_ACCOUNT_DIRECTORY_CONFIG);
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, "account-directory.json")
    : path.resolve(__dirname, "..", "config", "account-directory.json");
}

function updateChannelConfigPath() {
  if (!app.isPackaged && process.env.BIZHUB_DESKTOP_UPDATE_CHANNEL_CONFIG) {
    return path.resolve(process.env.BIZHUB_DESKTOP_UPDATE_CHANNEL_CONFIG);
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, "update-channel.json")
    : path.resolve(__dirname, "..", "config", "update-channel.json");
}

function updateDownloadRoot() {
  return path.join(desktopUserDataRoot(), "updates");
}

function automaticUpdateCheckPath() {
  return path.join(updateDownloadRoot(), "automatic-check.json");
}

async function connectionValidationOptions() {
  return {
    trustStore: await readJsonFile(trustStorePath(), MAX_PROFILE_BYTES),
    shellVersion: app.getVersion(),
    now: new Date(),
  };
}

function localRuntimePackPath() {
  if (!app.isPackaged && process.env.BIZHUB_DESKTOP_LOCAL_RUNTIME_DIR) {
    return path.resolve(process.env.BIZHUB_DESKTOP_LOCAL_RUNTIME_DIR);
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, "bizhub-runtime")
    : path.resolve(__dirname, "..", "runtime-dist", "bizhub-runtime");
}

function localRuntimeTrustPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "generic-runtime-trust.json")
    : path.resolve(
      __dirname,
      "..",
      "config",
      process.platform === "win32"
        ? "generic-runtime-trust.win32-x64.json"
        : "generic-runtime-trust.json",
    );
}

function publishState(next) {
  workspaceState = {
    ...workspaceState,
    ...next,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:state", workspaceState);
  }
}

function savedAccountSummaries(saved) {
  return saved.accounts.map((account) => ({
    accountId: account.accountId,
    displayName: account.displayName,
    mode: account.mode,
    savedAt: account.savedAt,
    canAutoLogin: account.session !== null,
  }));
}

async function refreshSavedAccountState() {
  const saved = await loadSavedAccounts(credentialStoreOptions());
  publishState({
    activeAccountId: saved.activeAccountId || "",
    savedAccounts: savedAccountSummaries(saved),
    rememberedLoginAvailable: saved.accounts.some((account) => account.session !== null),
  });
  return saved;
}

async function saveDesktopAccount({ accountId, displayName, mode, session: savedSession }) {
  const saved = await saveAccount({
    account: {
      accountId,
      displayName,
      mode,
      savedAt: new Date().toISOString(),
      session: savedSession,
    },
    ...credentialStoreOptions(),
  });
  publishState({
    activeAccountId: saved.activeAccountId || "",
    savedAccounts: savedAccountSummaries(saved),
    rememberedLoginAvailable: saved.accounts.some((account) => account.session !== null),
  });
  return saved;
}

function finishSmoke(result, exitCode) {
  const encoded = `${JSON.stringify(result)}\n`;
  (exitCode === 0 ? process.stdout : process.stderr).write(encoded);
  app.exit(exitCode);
}

function trustedShellSender(event) {
  try {
    const senderUrl = new URL(event.senderFrame.url);
    return (
      event.sender === mainWindow?.webContents
      && senderUrl.protocol === "bizhub-shell:"
      && senderUrl.host === "app"
    );
  } catch {
    return false;
  }
}

function requireTrustedShellSender(event) {
  if (!trustedShellSender(event)) throw new Error("desktop_ipc_sender_rejected");
}

function trustedCloudSender(event) {
  try {
    const senderUrl = new URL(event.senderFrame.url);
    return (
      workspaceState.mode === "cloud"
      && workspaceState.status === "connected"
      && event.sender === workspaceView?.webContents
      && event.senderFrame === event.sender.mainFrame
      && senderUrl.origin === workspaceState.applicationOrigin
    );
  } catch {
    return false;
  }
}

function requireTrustedCloudSender(event) {
  if (!trustedCloudSender(event)) throw new Error("desktop_cloud_ipc_sender_rejected");
}

function trustedLocalSender(event) {
  try {
    const runtime = localRuntimeLifecycle.current();
    return (
      ["local", "guest"].includes(workspaceState.mode)
      && workspaceState.status === "connected"
      && event.sender === workspaceView?.webContents
      && normalizeLocalOrigin(event.senderFrame.url) === normalizeLocalOrigin(runtime?.origin || "")
    );
  } catch {
    return false;
  }
}

function requireTrustedLocalSender(event) {
  if (!trustedLocalSender(event)) throw new Error("desktop_local_ipc_sender_rejected");
}

function setWorkspaceBounds() {
  if (!mainWindow || !workspaceView) return;
  const [width, height] = mainWindow.getContentSize();
  const topInset = workspaceState.status === "connected"
    ? (
      workspaceState.mode === "guest"
        ? GUEST_BANNER_HEIGHT
        : (process.platform === "darwin" && workspaceState.mode === "local" ? 30 : 0)
    )
    : HEADER_HEIGHT;
  workspaceView.setBounds({
    x: 0,
    y: topInset,
    width: Math.max(0, width),
    height: Math.max(0, height - topInset),
  });
}

function destroyWorkspaceView() {
  if (!workspaceView) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(workspaceView);
  }
  if (!workspaceView.webContents.isDestroyed()) workspaceView.webContents.close();
  workspaceView = null;
}

function allowedNavigation(url, allowedOrigins) {
  try {
    return allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function handleCloudLogoutRequest(phase) {
  if (phase === "started") {
    if (workspaceView && !workspaceView.webContents.isDestroyed()) {
      workspaceView.setVisible(false);
    }
    return;
  }
  void finalizeCloudLogout();
}

function configureRemoteSession(remoteSession, allowedOrigins) {
  const existingPolicy = remoteSessionPolicies.get(remoteSession);
  if (existingPolicy) {
    existingPolicy.allowedOrigins = allowedOrigins;
    existingPolicy.onCloudLogout = handleCloudLogoutRequest;
    return;
  }
  const policy = { allowedOrigins, onCloudLogout: handleCloudLogoutRequest };
  remoteSession.setPermissionCheckHandler(() => false);
  remoteSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  remoteSession.webRequest.onBeforeRequest((details, callback) => {
    const requestAllowed = remoteRequestAllowed(details.url, policy.allowedOrigins);
    if (requestAllowed && isCloudLogoutRequest(details, policy.allowedOrigins)) {
      policy.onCloudLogout("started");
    }
    callback({ cancel: !requestAllowed });
  });
  remoteSession.webRequest.onCompleted((details) => {
    if (isCloudLogoutRequest(details, policy.allowedOrigins)) {
      policy.onCloudLogout("finished");
    }
  });
  remoteSession.webRequest.onErrorOccurred((details) => {
    if (isCloudLogoutRequest(details, policy.allowedOrigins)) {
      policy.onCloudLogout("finished");
    }
  });
  remoteSession.on("will-download", (event) => {
    event.preventDefault();
    publishState({ error: "desktop_download_not_enabled" });
  });
  remoteSessionPolicies.set(remoteSession, policy);
}

function configureLocalSession(runtimeSession, localOrigin) {
  const existingPolicy = localSessionPolicies.get(runtimeSession);
  if (existingPolicy) {
    existingPolicy.localOrigin = localOrigin;
    return;
  }
  const policy = { localOrigin };
  runtimeSession.setPermissionCheckHandler(() => false);
  runtimeSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  runtimeSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !localRequestAllowed(details.url, policy.localOrigin) });
  });
  runtimeSession.on("will-download", (event) => {
    event.preventDefault();
    publishState({ localError: "desktop_local_download_not_enabled" });
  });
  localSessionPolicies.set(runtimeSession, policy);
}

async function refreshLocalState() {
  try {
    const instance = await loadLocalInstance(localInstanceRoot());
    const admin = await loadLocalAdminIdentity(localInstanceRoot());
    publishState({
      localInitialized: true,
      localAccountId: normalizeAccountId(admin.username),
      localError: "",
      ...(workspaceState.mode === "none" ? { displayName: instance.payload.display_name } : {}),
    });
    return instance;
  } catch (error) {
    if (error?.code === "ENOENT") {
      publishState({ localInitialized: false, localAccountId: "", localError: "" });
      return null;
    }
    publishState({
      localInitialized: false,
      localError: error instanceof Error ? error.message : "desktop_local_instance_invalid",
    });
    return null;
  }
}

async function setLocalSessionCookies(runtimeSession, runtime) {
  await runtimeSession.cookies.set({
    url: runtime.origin,
    name: RUNTIME_COOKIE,
    value: runtime.token,
    httpOnly: true,
    secure: false,
    sameSite: "strict",
    path: "/",
  });
  if (runtime.sessionCookie) {
    const separator = runtime.sessionCookie.indexOf("=");
    await runtimeSession.cookies.set({
      url: runtime.origin,
      name: runtime.sessionCookie.slice(0, separator),
      value: runtime.sessionCookie.slice(separator + 1),
      httpOnly: true,
      secure: false,
      sameSite: "strict",
      path: "/",
    });
  }
}

async function openLocalWorkspaceView({ mode = localRuntimeKind } = {}) {
  const runtime = localRuntimeLifecycle.current();
  if (!runtime) throw new Error("desktop_local_runtime_not_started");
  const guest = mode === "guest";
  destroyWorkspaceView();
  const localOrigin = normalizeLocalOrigin(runtime.origin);
  if (!localOrigin) throw new Error("desktop_local_runtime_origin_invalid");
  const runtimeSession = session.fromPartition(guest ? "guest-demo" : "persist:local-generic");
  configureLocalSession(runtimeSession, localOrigin);
  await setLocalSessionCookies(runtimeSession, runtime);
  workspaceView = new WebContentsView({
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      experimentalFeatures: false,
      nodeIntegration: false,
      preload: path.join(__dirname, "local-preload.cjs"),
      sandbox: true,
      session: runtimeSession,
      webSecurity: true,
    },
  });
  workspaceView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  workspaceView.webContents.on("will-navigate", (event, url) => {
    if (normalizeLocalOrigin(url) !== localOrigin) event.preventDefault();
  });
  workspaceView.webContents.on("will-redirect", (event, url) => {
    if (normalizeLocalOrigin(url) !== localOrigin) event.preventDefault();
  });
  workspaceView.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      destroyWorkspaceView();
      publishState({
        mode,
        status: "error",
        localStatus: "error",
        localError: `local_workspace_load_failed:${errorCode}:${errorDescription}:${validatedUrl}`,
      });
    },
  );
  workspaceView.webContents.on("did-finish-load", () => {
    sendDesktopPreferences(workspaceView?.webContents);
    if (guest) return;
    publishState({
      mode,
      status: "connected",
      localStatus: "connected",
      error: "",
      localError: "",
    });
    if (!guest && process.env.BIZHUB_DESKTOP_SMOKE_LOCAL === "1") {
      const origin = runtime.origin;
      void (async () => {
        const deadline = Date.now() + 10_000;
        let product = null;
        while (Date.now() < deadline) {
          product = await workspaceView.webContents.executeJavaScript(`(() => ({
            title: document.querySelector("h1")?.textContent?.trim() || "",
            nav: [...document.querySelectorAll("nav button")].map((item) => item.textContent.trim()),
            text: document.body.innerText,
          }))()`, true).catch(() => null);
          if (product?.title === "开始使用" && product.nav.includes("开始使用")) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const productReady = (
          product?.title === "开始使用"
          && product.nav.length === 1
          && product.nav.includes("开始使用")
          && product.text.includes("进入我的企业空间")
          && !product.text.includes("BizHub is ready")
        );
        await stopLocalMode();
        finishSmoke({
          status: productReady ? "connected" : "error",
          mode: "local",
          origin,
          generic_workspace_ready: productReady,
          residual_runtime_processes: 0,
        }, productReady ? 0 : 1);
      })();
    }
  });
  mainWindow.contentView.addChildView(workspaceView);
  setWorkspaceBounds();
  await workspaceView.webContents.loadURL(`${localOrigin}/`);
  if (guest) {
    const deadline = Date.now() + 10_000;
    let navigationReady = false;
    while (Date.now() < deadline) {
      navigationReady = await workspaceView.webContents.executeJavaScript(`(() => {
        const buttons = [...document.querySelectorAll("nav button")];
        const overviewButton = buttons.find((item) => item.textContent.trim() === "概览");
        const settingsButton = buttons.find((item) => item.textContent.trim() === "设置");
        if (!overviewButton || !settingsButton) return false;
        settingsButton.dataset.page = "settings";
        overviewButton.click();
        return true;
      })()`, true).catch(() => false);
      if (navigationReady) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!navigationReady) {
      throw new Error("desktop_guest_demo_workspace_navigation_missing");
    }
    await workspaceView.webContents.insertCSS(
      "nav button[data-page=\"settings\"]{display:none!important}.account small{display:none!important}",
    );
    publishState({
      mode,
      status: "connected",
      localStatus: "connected",
      error: "",
      localError: "",
    });
  }
}

async function readJsonFile(filePath, maxBytes) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > maxBytes) {
    throw new Error("desktop_profile_file_size_invalid");
  }
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function publicUpdateState() {
  return {
    appVersion: app.getVersion(),
    status: workspaceState.updateStatus,
    version: workspaceState.updateVersion,
    progress: workspaceState.updateProgress,
    error: workspaceState.updateError,
    releaseNotes: workspaceState.updateReleaseNotes,
    downloaded: workspaceState.updateDownloaded,
    lastCheckedAt: workspaceState.updateLastCheckedAt,
  };
}

async function cloudDesktopInfo() {
  let updateConfig = { enabled: false, checkIntervalHours: 24 };
  try {
    updateConfig = normalizeUpdateConfig(
      await readJsonFile(updateChannelConfigPath(), MAX_PROFILE_BYTES),
    );
  } catch {
    // The current workspace remains usable when the optional update channel is unavailable.
  }
  return {
    schemaVersion: "bizhub.desktop-cloud-info.v1",
    appVersion: app.getVersion(),
    mode: "cloud",
    rememberedLogin: workspaceState.savedAccounts.some((account) => (
      account.accountId === workspaceState.activeAccountId && account.canAutoLogin
    )),
    automaticUpdates: updateConfig.enabled === true && desktopPreferences.automaticUpdates,
    checkIntervalHours: updateConfig.checkIntervalHours,
    update: publicUpdateState(),
    preferences: publicDesktopPreferences(),
  };
}

async function automaticUpdateCheckDue(config) {
  try {
    const record = await readJsonFile(automaticUpdateCheckPath(), MAX_PROFILE_BYTES);
    const checkedAt = Date.parse(record?.checked_at || "");
    return !Number.isFinite(checkedAt)
      || Date.now() - checkedAt >= config.checkIntervalHours * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

async function recordAutomaticUpdateCheck() {
  await mkdir(updateDownloadRoot(), { recursive: true, mode: 0o700 });
  await writeFile(automaticUpdateCheckPath(), `${JSON.stringify({
    schema_version: "bizhub.desktop-update-check.v1",
    checked_at: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function publishUpdateState(next) {
  publishState(Object.fromEntries(
    Object.entries(next).map(([key, value]) => [`update${key[0].toUpperCase()}${key.slice(1)}`, value]),
  ));
}

async function showDesktopMessage(options) {
  if (mainWindow && !mainWindow.isDestroyed()) return dialog.showMessageBox(mainWindow, options);
  return dialog.showMessageBox(options);
}

function autoUpdateSuppressed() {
  return (
    !app.isPackaged
    || process.env.BIZHUB_DESKTOP_DISABLE_AUTO_UPDATE === "1"
    || Object.keys(process.env).some((key) => key.startsWith("BIZHUB_DESKTOP_SMOKE_"))
  );
}

async function promptToDownloadUpdate() {
  if (!availableUpdate) return;
  const result = await showDesktopMessage({
    type: "info",
    title: "BizHub Desktop 更新",
    message: `发现新版本 ${availableUpdate.manifest.version}`,
    detail: availableUpdate.manifest.releaseNotes || "可以在后台下载，现有云端和本地数据不会被覆盖。",
    buttons: ["后台下载", "稍后"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) await downloadDesktopUpdate({ promptAfterDownload: true });
}

async function checkDesktopUpdate({
  interactive = false,
  automatic = false,
  autoDownload = true,
} = {}) {
  if (updateCheckPromise) return updateCheckPromise;
  updateCheckPromise = (async () => {
    let automaticCheckAttempted = !automatic;
    publishUpdateState({ status: "checking", error: "", progress: 0 });
    try {
      const config = await readJsonFile(updateChannelConfigPath(), MAX_PROFILE_BYTES);
      if (automatic && !await automaticUpdateCheckDue(normalizeUpdateConfig(config))) {
        publishUpdateState({ status: "idle", error: "" });
        return publicUpdateState();
      }
      automaticCheckAttempted = true;
      const result = await checkForUpdate({
        fetchImpl: net.fetch,
        config,
        currentVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
      });
      const checkedAt = new Date().toISOString();
      if (result.status !== "available") {
        availableUpdate = null;
        downloadedUpdate = null;
        publishUpdateState({
          status: result.status,
          version: "",
          releaseNotes: "",
          downloaded: false,
          lastCheckedAt: checkedAt,
        });
        if (interactive) {
          await showDesktopMessage({
            type: "info",
            title: "BizHub Desktop 更新",
            message: result.status === "disabled" ? "当前更新通道未启用" : "当前已是最新版本",
            detail: `当前版本 ${app.getVersion()}`,
            buttons: ["好"],
            noLink: true,
          });
        }
        return publicUpdateState();
      }
      availableUpdate = result;
      downloadedUpdate = null;
      publishUpdateState({
        status: "available",
        version: result.manifest.version,
        releaseNotes: result.manifest.releaseNotes,
        downloaded: false,
        lastCheckedAt: checkedAt,
      });
      if (interactive) await promptToDownloadUpdate();
      else if (autoDownload && result.config.autoDownload) {
        await downloadDesktopUpdate({ promptAfterDownload: true });
      }
      return publicUpdateState();
    } catch (error) {
      const code = error instanceof Error ? error.message : "desktop_update_check_failed";
      publishUpdateState({ status: "error", error: code, lastCheckedAt: new Date().toISOString() });
      if (interactive) {
        await showDesktopMessage({
          type: "warning",
          title: "暂时无法检查更新",
          message: "更新服务器暂时不可用",
          detail: "现有 BizHub 可以继续正常使用，请稍后再试。",
          buttons: ["好"],
          noLink: true,
        });
      }
      return publicUpdateState();
    } finally {
      if (automatic && automaticCheckAttempted) await recordAutomaticUpdateCheck().catch(() => {});
      updateCheckPromise = null;
    }
  })();
  return updateCheckPromise;
}

async function promptToInstallUpdate() {
  if (!downloadedUpdate) return;
  const localDetail = workspaceState.localInitialized
    ? "重启前会先创建并验证 Generic Local 数据备份，然后正常停止本地后端。"
    : "客户端将退出并安装新版本，云端业务数据不会被修改。";
  const result = await showDesktopMessage({
    type: "info",
    title: "更新已下载",
    message: `BizHub Desktop ${downloadedUpdate.version} 已准备好`,
    detail: localDetail,
    buttons: ["重启并更新", "稍后"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) await installDesktopUpdate({ confirmed: true });
}

async function downloadDesktopUpdate({ promptAfterDownload = false } = {}) {
  if (updateDownloadPromise) return updateDownloadPromise;
  updateDownloadPromise = (async () => {
    if (!availableUpdate) {
      await checkDesktopUpdate({ interactive: false, autoDownload: false });
      if (!availableUpdate) return publicUpdateState();
    }
    publishUpdateState({ status: "downloading", error: "", progress: 0, downloaded: false });
    const destination = path.join(
      updateDownloadRoot(),
      availableUpdate.manifest.version,
      availableUpdate.manifest.asset.filename,
    );
    let lastPercent = -1;
    try {
      const downloaded = await downloadUpdateArtifactWithFallback({
        fetchImpl: net.fetch,
        asset: availableUpdate.manifest.asset,
        fallbackAsset: availableUpdate.fallbackManifest?.asset,
        allowedHosts: availableUpdate.config.allowedHosts,
        destination,
        source: availableUpdate.source,
        fallbackSource: availableUpdate.fallbackSource || "github",
        onProgress: ({ bytes, totalBytes }) => {
          const percent = Math.min(100, Math.floor((bytes / totalBytes) * 100));
          if (percent === lastPercent) return;
          lastPercent = percent;
          publishUpdateState({ progress: percent });
          mainWindow?.setProgressBar?.(percent / 100);
        },
      });
      mainWindow?.setProgressBar?.(-1);
      downloadedUpdate = {
        ...downloaded,
        version: availableUpdate.manifest.version,
        kind: availableUpdate.manifest.asset.kind,
      };
      publishUpdateState({ status: "downloaded", progress: 100, downloaded: true, error: "" });
      if (promptAfterDownload) await promptToInstallUpdate();
      return publicUpdateState();
    } catch (error) {
      mainWindow?.setProgressBar?.(-1);
      publishUpdateState({
        status: "error",
        error: error instanceof Error ? error.message : "desktop_update_download_failed",
        downloaded: false,
      });
      return publicUpdateState();
    } finally {
      updateDownloadPromise = null;
    }
  })();
  return updateDownloadPromise;
}

async function prepareLocalDataForUpdate() {
  if (workspaceState.localInitialized) {
    await createLocalBackup();
    if (workspaceState.localError) throw new Error(workspaceState.localError);
  }
  destroyWorkspaceView();
  if (localRuntimeLifecycle.state() !== "stopped" || localRuntimeKind === "guest") {
    await stopLocalMode();
  }
  publishState({ localStatus: "stopped" });
}

async function installDesktopUpdate({ confirmed = false } = {}) {
  if (!confirmed) {
    await promptToInstallUpdate();
    return publicUpdateState();
  }
  if (!app.isPackaged) throw new Error("desktop_update_install_requires_packaged_app");
  if (!downloadedUpdate) throw new Error("desktop_update_artifact_not_downloaded");
  publishUpdateState({ status: "installing", error: "" });
  try {
    const stagedBundle = process.platform === "darwin"
      ? await prepareMacUpdate({
        artifactPath: downloadedUpdate.path,
        version: downloadedUpdate.version,
        updateRoot: updateDownloadRoot(),
      })
      : null;
    await prepareLocalDataForUpdate();
    shutdownInProgress = true;
    if (process.platform === "darwin") {
      await launchMacUpdate({
        executablePath: app.getPath("exe"),
        processId: process.pid,
        stagedBundle,
        updateRoot: updateDownloadRoot(),
        version: downloadedUpdate.version,
      });
    } else if (process.platform === "win32" && downloadedUpdate.kind === "windows-squirrel-setup") {
      launchWindowsUpdate(downloadedUpdate.path);
    } else {
      throw new Error("desktop_update_install_platform_invalid");
    }
    app.quit();
    return publicUpdateState();
  } catch (error) {
    shutdownInProgress = false;
    publishUpdateState({
      status: "error",
      error: error instanceof Error ? error.message : "desktop_update_install_failed",
    });
    await showDesktopMessage({
      type: "error",
      title: "更新未安装",
      message: "BizHub Desktop 保持当前版本",
      detail: "更新准备失败，没有修改现有客户端和本地数据。请稍后重试。",
      buttons: ["好"],
      noLink: true,
    });
    return publicUpdateState();
  }
}

async function loadConnectionProfile(filePath) {
  const [envelope, trustStore] = await Promise.all([
    readJsonFile(filePath, MAX_PROFILE_BYTES),
    readJsonFile(trustStorePath(), MAX_PROFILE_BYTES),
  ]);
  return validateConnectionEnvelope(envelope, {
    trustStore,
    shellVersion: app.getVersion(),
    now: new Date(),
  });
}

async function openWorkspace(
  profile,
  partitionName = workspaceSessionPartition(profile.connectionId, "standalone.profile"),
  { password = null, rememberedSession = null } = {},
) {
  destroyWorkspaceView();
  const remoteSession = session.fromPartition(partitionName);
  configureRemoteSession(remoteSession, profile.allowedOrigins);
  let authenticationPending = typeof password === "string" || rememberedSession !== null;
  let authenticatedSession = null;
  workspaceView = new WebContentsView({
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      experimentalFeatures: false,
      nodeIntegration: false,
      preload: path.join(__dirname, "cloud-preload.cjs"),
      sandbox: true,
      session: remoteSession,
      webSecurity: true,
    },
  });
  workspaceView.setVisible(false);
  workspaceView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  workspaceView.webContents.on("will-navigate", (event, url) => {
    if (!allowedNavigation(url, profile.allowedOrigins)) event.preventDefault();
  });
  workspaceView.webContents.on("will-redirect", (event, url) => {
    if (!allowedNavigation(url, profile.allowedOrigins)) event.preventDefault();
  });
  workspaceView.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      publishState({
        status: "error",
        error: `workspace_load_failed:${errorCode}:${errorDescription}:${validatedUrl}`,
      });
      if (process.env.BIZHUB_DESKTOP_SMOKE_EXIT_ON_LOAD === "1") {
        void finishSmoke({
          status: "error",
          error: `workspace_load_failed:${errorCode}`,
        }, 1);
      }
    },
  );
  workspaceView.webContents.on("did-finish-load", () => {
    sendDesktopPreferences(workspaceView?.webContents);
    if (authenticationPending) return;
    publishState({ status: "connected", error: "" });
    setWorkspaceBounds();
    workspaceView.setVisible(true);
    if (process.env.BIZHUB_DESKTOP_SMOKE_EXIT_ON_LOAD === "1") {
      void finishSmoke({ status: "connected", origin: profile.allowedOrigins[0] }, 0);
    }
  });
  mainWindow.contentView.addChildView(workspaceView);
  setWorkspaceBounds();
  publishState({
    mode: "cloud",
    status: "loading",
    displayName: profile.displayName,
    profileId: profile.profileId,
    applicationOrigin: new URL(profile.applicationUrl).origin,
    error: "",
  });
  await workspaceView.webContents.loadURL(profile.applicationUrl);
  if (typeof password === "string") {
    const result = await workspaceView.webContents.executeJavaScript(
      cloudLoginScript(password),
      true,
    );
    const error = cloudLoginError(result);
    if (error) throw new Error(error);
    authenticatedSession = result.session;
    authenticationPending = false;
    await workspaceView.webContents.loadURL(profile.applicationUrl);
  } else if (rememberedSession !== null) {
    const resumed = await workspaceView.webContents.executeJavaScript(
      sessionStorageScript(rememberedSession),
      true,
    );
    if (resumed !== true) throw new Error("desktop_remembered_session_invalid");
    authenticationPending = false;
    await workspaceView.webContents.loadURL(profile.applicationUrl);
  }
  return authenticatedSession;
}

async function launchLocalRuntime() {
  const runtimeKind = localRuntimeKind;
  const instance = runtimeKind === "guest"
    ? await loadLocalInstance(guestInstanceRoot())
    : await refreshLocalState();
  if (!instance) throw new Error("desktop_local_instance_not_initialized");
  publishState({
    mode: runtimeKind,
    status: "loading",
    displayName: instance.payload.display_name,
    profileId: "generic-kernel-smoke",
    applicationOrigin: "127.0.0.1",
    error: "",
    localStatus: "starting",
    localError: "",
  });
  const started = await startLocalRuntime({
    instanceRoot: activeLocalInstanceRoot(),
    runtimePack: localRuntimePackPath(),
    trustPath: localRuntimeTrustPath(),
  });
  started.child.once("exit", (code, signalName) => {
    const expectedExit = localRuntimeLifecycle.state() === "stopping" || shutdownInProgress;
    if (!localRuntimeLifecycle.markExited(started)) return;
    destroyWorkspaceView();
    if (!expectedExit) {
      publishState({
        mode: runtimeKind,
        status: "error",
        localStatus: "error",
        localError: `desktop_local_runtime_exited:${code ?? signalName ?? "unknown"}`,
      });
    }
  });
  return started;
}

async function startLocalMode() {
  if (localRuntimeLifecycle.state() !== "stopped" && localRuntimeKind !== "local") {
    throw new Error("desktop_guest_demo_runtime_active");
  }
  if (localRuntimeLifecycle.state() === "stopped") localRuntimeKind = "local";
  const runtime = await localRuntimeLifecycle.start();
  publishState({
    mode: "local",
    status: "idle",
    localStatus: "awaiting_login",
    applicationOrigin: runtime.origin,
  });
  return runtime;
}

async function resetGuestDemoData() {
  await rm(guestDemoRoot(), { recursive: true, force: true });
  if (app.isReady()) {
    const demoSession = session.fromPartition("guest-demo");
    await demoSession.clearStorageData();
    await demoSession.clearCache();
  }
}

async function openGuestDemo() {
  publishState({
    mode: "guest",
    status: "loading",
    displayName: DEMO_COMPANY_NAME,
    profileId: "generic-kernel-smoke",
    applicationOrigin: "127.0.0.1",
    error: "",
    localError: "",
    localStatus: "initializing",
    guestDemoStatus: "initializing",
    guestDemoReadback: null,
  });
  try {
    destroyWorkspaceView();
    if (localRuntimeLifecycle.state() !== "stopped") await localRuntimeLifecycle.stop();
    await resetGuestDemoData();
    localRuntimeKind = "guest";
    const password = `guest-${randomBytes(32).toString("base64url")}`;
    await bootstrapLocalInstance({
      userDataRoot: guestDemoRoot(),
      runtimePack: localRuntimePackPath(),
      trustPath: localRuntimeTrustPath(),
      input: {
        companyName: DEMO_COMPANY_NAME,
        username: DEMO_USERNAME,
        password,
      },
    });
    const runtime = await localRuntimeLifecycle.start();
    await loginLocalRuntime(runtime, DEMO_USERNAME, password, { remember: false });
    const readback = await seedGuestDemo(runtime, fetchRuntime);
    publishState({
      mode: "guest",
      status: "loading",
      displayName: DEMO_COMPANY_NAME,
      profileId: "generic-kernel-smoke",
      applicationOrigin: runtime.origin,
      localStatus: "connected",
      guestDemoStatus: "ready",
      guestDemoReadback: readback,
    });
    await openLocalWorkspaceView({ mode: "guest" });
  } catch (error) {
    if (localRuntimeLifecycle.state() !== "stopped") {
      await localRuntimeLifecycle.stop().catch(() => {});
    }
    await resetGuestDemoData().catch(() => {});
    localRuntimeKind = "local";
    publishState({
      mode: "none",
      status: "error",
      displayName: "",
      profileId: "",
      applicationOrigin: "",
      localStatus: "stopped",
      guestDemoStatus: "error",
      guestDemoReadback: null,
      error: error instanceof Error ? error.message : "desktop_guest_demo_failed",
    });
  }
  return workspaceState;
}

async function prepareLocalLogin() {
  try {
    await startLocalMode();
  } catch (error) {
    publishState({
      mode: "local",
      status: "error",
      localStatus: "error",
      localError: error instanceof Error ? error.message : "desktop_local_runtime_start_failed",
    });
  }
  return workspaceState;
}

async function assertLocalInstanceAbsent() {
  try {
    await stat(localInstanceRoot());
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("desktop_local_instance_already_exists");
}

async function setupLocalInstance(input) {
  if (
    !input
    || typeof input !== "object"
    || Object.keys(input).sort().join(",") !== "accountId,companyName,password,remember"
    || typeof input.remember !== "boolean"
  ) {
    throw new Error("desktop_local_setup_shape_invalid");
  }
  const accountId = normalizeAccountId(input.accountId);
  if (localRuntimeLifecycle.state() !== "stopped") {
    throw new Error("desktop_local_runtime_already_started");
  }
  publishState({
    mode: "none",
    status: "loading",
    accountLookupStatus: "resolving",
    accountNotFound: false,
    localStatus: "stopped",
    localError: "",
  });
  try {
    await assertLocalInstanceAbsent();
    const [config, validationOptions] = await Promise.all([
      readJsonFile(accountDirectoryConfigPath(), MAX_PROFILE_BYTES),
      connectionValidationOptions(),
    ]);
    const directoryResult = await resolveAccountWorkspaces(accountId, {
      config,
      ...validationOptions,
    });
    if (directoryResult.status !== "not_found") {
      throw new Error(
        directoryResult.workspaces.length > 0
          ? "desktop_local_creation_cloud_account_exists"
          : "desktop_local_creation_account_registered",
      );
    }
    await assertLocalInstanceAbsent();
    if (localRuntimeLifecycle.state() !== "stopped") {
      throw new Error("desktop_local_runtime_already_started");
    }
    publishState({
      mode: "local",
      status: "loading",
      accountLookupStatus: "not_found",
      accountNotFound: true,
      localStatus: "initializing",
      localError: "",
    });
    const created = await bootstrapLocalInstance({
      userDataRoot: desktopUserDataRoot(),
      runtimePack: localRuntimePackPath(),
      trustPath: localRuntimeTrustPath(),
      input: {
        companyName: input.companyName,
        username: accountId,
        password: input.password,
      },
    });
    publishState({
      localInitialized: true,
      displayName: created.instance.display_name,
      profileId: created.instance.profile_id,
    });
    const runtime = await startLocalMode();
    const authenticated = await loginLocalRuntime(runtime, accountId, input.password, {
      remember: input.remember,
    });
    await saveDesktopAccount({
      accountId,
      displayName: accountId,
      mode: "local",
      session: authenticated.rememberSession,
    });
    await openLocalWorkspaceView();
  } catch (error) {
    await refreshLocalState();
    publishState({
      mode: "local",
      status: "error",
      accountLookupStatus: "error",
      accountNotFound: false,
      localStatus: "error",
      localError: error instanceof Error ? error.message : "desktop_local_setup_failed",
    });
  }
  return workspaceState;
}

async function authenticateLocal(input) {
  if (
    !input
    || typeof input !== "object"
    || Object.keys(input).sort().join(",") !== "password,remember,username"
    || typeof input.remember !== "boolean"
  ) {
    throw new Error("desktop_local_login_shape_invalid");
  }
  try {
    const runtime = await startLocalMode();
    const username = normalizeAccountId(String(input.username || ""));
    const authenticated = await loginLocalRuntime(
      runtime,
      username,
      String(input.password || ""),
      { remember: input.remember },
    );
    await saveDesktopAccount({
      accountId: username,
      displayName: username,
      mode: "local",
      session: authenticated.rememberSession,
    });
    await openLocalWorkspaceView();
  } catch (error) {
    publishState({
      mode: "local",
      status: "error",
      localStatus: "awaiting_login",
      localError: error instanceof Error ? error.message : "desktop_local_login_failed",
    });
  }
  return workspaceState;
}

async function createLocalBackup() {
  try {
    const result = await backupLocalInstance({
      instanceRoot: localInstanceRoot(),
      runtimePack: localRuntimePackPath(),
      trustPath: localRuntimeTrustPath(),
    });
    publishState({ localLastBackup: result.path, localError: "" });
  } catch (error) {
    publishState({
      localError: error instanceof Error ? error.message : "desktop_local_backup_failed",
    });
  }
  return workspaceState;
}

async function stopLocalMode() {
  const wasGuest = localRuntimeKind === "guest";
  destroyWorkspaceView();
  await localRuntimeLifecycle.stop();
  if (wasGuest) await resetGuestDemoData();
  localRuntimeKind = "local";
  publishState({
    mode: "none",
    status: "idle",
    profileId: "",
    applicationOrigin: "",
    error: "",
    localStatus: "stopped",
    localError: "",
    guestDemoStatus: "idle",
    guestDemoReadback: null,
  });
  await refreshLocalState();
  return workspaceState;
}

async function lookupAccount(input) {
  if (
    !input
    || typeof input !== "object"
    || Object.keys(input).sort().join(",") !== "accountId"
    || typeof input.accountId !== "string"
  ) {
    throw new Error("desktop_account_lookup_shape_invalid");
  }
  const generation = accountLookupGeneration.begin();
  activeEnterpriseProfiles = new Map();
  publishState({
    mode: "none",
    status: "loading",
    error: "",
    accountLookupStatus: "resolving",
    accountNotFound: false,
    enterpriseWorkspaces: [],
  });
  try {
    const [config, validationOptions] = await Promise.all([
      readJsonFile(accountDirectoryConfigPath(), MAX_PROFILE_BYTES),
      connectionValidationOptions(),
    ]);
    const result = await resolveAccountWorkspaces(input.accountId, {
      config,
      ...validationOptions,
    });
    const resolvedProfiles = new Map();
    for (const workspace of result.workspaces) {
      resolvedProfiles.set(workspace.profile.connectionId, {
        envelope: workspace.envelope,
        partitionName: workspaceSessionPartition(
          workspace.profile.connectionId,
          result.accountId,
        ),
      });
    }
    accountLookupGeneration.commit(generation, () => {
      activeEnterpriseProfiles = resolvedProfiles;
      publishState({
        status: "idle",
        error: "",
        accountLookupStatus: result.status,
        accountNotFound: result.status === "not_found",
        enterpriseWorkspaces: result.workspaces.map((workspace) => workspace.summary),
      });
    });
  } catch (error) {
    accountLookupGeneration.commit(generation, () => {
      activeEnterpriseProfiles = new Map();
      publishState({
        status: "error",
        error: error instanceof Error ? error.message : "desktop_account_lookup_failed",
        accountLookupStatus: "error",
        accountNotFound: false,
        enterpriseWorkspaces: [],
      });
    });
  }
  return workspaceState;
}

async function loginEnterprise(input) {
  let normalized;
  try {
    const validated = validateCloudLoginInput(input);
    normalized = {
      accountId: normalizeAccountId(validated.accountId),
      password: validated.password,
      remember: validated.remember,
    };
  } catch (error) {
    publishState({
      status: "error",
      error: error instanceof Error ? error.message : "desktop_cloud_login_shape_invalid",
      autoLoginStatus: "idle",
    });
    return workspaceState;
  }

  await lookupAccount({ accountId: normalized.accountId });
  if (workspaceState.accountLookupStatus !== "resolved") return workspaceState;
  if (activeEnterpriseProfiles.size === 0) return workspaceState;
  if (activeEnterpriseProfiles.size !== 1) {
    publishState({
      status: "error",
      error: "desktop_account_multiple_workspaces",
      autoLoginStatus: "idle",
    });
    return workspaceState;
  }

  try {
    const workspace = [...activeEnterpriseProfiles.values()][0];
    const options = await connectionValidationOptions();
    const profile = validateConnectionEnvelope(workspace.envelope, options);
    await stopLocalMode();
    publishState({ autoLoginStatus: "idle" });
    const authenticatedSession = await openWorkspace(
      profile,
      workspace.partitionName,
      { password: normalized.password },
    );
    let rememberError = "";
    try {
      await saveDesktopAccount({
        accountId: normalized.accountId,
        displayName: authenticatedSession.accountName,
        mode: "cloud",
        session: normalized.remember ? authenticatedSession : null,
      });
    } catch {
      rememberError = "desktop_remembered_session_save_failed";
    }
    publishState({
      rememberedLoginAvailable: normalized.remember && !rememberError,
      autoLoginStatus: "idle",
      error: rememberError,
    });
  } catch (error) {
    destroyWorkspaceView();
    publishState({
      mode: "none",
      status: "error",
      error: error instanceof Error ? error.message : "desktop_cloud_login_failed",
      autoLoginStatus: "idle",
    });
  }
  return workspaceState;
}

function validateUnifiedLoginInput(input) {
  if (
    !input
    || typeof input !== "object"
    || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "accountId,password,remember"
    || typeof input.accountId !== "string"
    || typeof input.password !== "string"
    || typeof input.remember !== "boolean"
  ) throw new Error("desktop_login_shape_invalid");
  return {
    accountId: normalizeAccountId(input.accountId),
    password: input.password,
    remember: input.remember,
  };
}

async function loginAccount(input) {
  let normalized;
  try {
    normalized = validateUnifiedLoginInput(input);
  } catch (error) {
    publishState({
      status: "error",
      error: error instanceof Error ? error.message : "desktop_login_shape_invalid",
    });
    return workspaceState;
  }
  const local = await refreshLocalState();
  if (local) {
    const admin = await loadLocalAdminIdentity(localInstanceRoot());
    if (normalizeAccountId(admin.username) === normalized.accountId) {
      publishState({ canCreateLocal: false, pendingLocalAccountId: "" });
      return authenticateLocal({
        username: normalized.accountId,
        password: normalized.password,
        remember: normalized.remember,
      });
    }
  }
  const result = await loginEnterprise(normalized);
  if (workspaceState.accountLookupStatus === "not_found") {
    publishState({
      canCreateLocal: !local,
      pendingLocalAccountId: local ? "" : normalized.accountId,
      status: "error",
      error: local ? "desktop_account_not_found" : "desktop_account_not_found_can_create_local",
    });
  } else if (
    workspaceState.accountLookupStatus === "resolved"
    && activeEnterpriseProfiles.size === 0
  ) {
    publishState({
      canCreateLocal: false,
      pendingLocalAccountId: "",
      status: "error",
      error: "desktop_account_no_workspace",
    });
  } else {
    publishState({ canCreateLocal: false, pendingLocalAccountId: "" });
  }
  return workspaceState;
}

async function resumeSavedAccount(accountId) {
  const normalized = normalizeAccountId(accountId);
  const saved = await loadSavedAccounts(credentialStoreOptions());
  const account = saved.accounts.find((item) => item.accountId === normalized);
  if (!account || !account.session) throw new Error("desktop_saved_account_session_missing");
  await setActiveAccount({ accountId: normalized, ...credentialStoreOptions() });
  publishState({ activeAccountId: normalized, autoLoginStatus: "authenticating", error: "" });
  try {
    if (account.mode === "local") {
      const local = await refreshLocalState();
      if (!local) throw new Error("desktop_local_instance_not_initialized");
      const admin = await loadLocalAdminIdentity(localInstanceRoot());
      if (normalizeAccountId(admin.username) !== normalized) {
        throw new Error("desktop_local_account_mismatch");
      }
      const runtime = await startLocalMode();
      await resumeLocalRuntime(runtime, account.session.token);
      await openLocalWorkspaceView();
    } else {
      await lookupAccount({ accountId: normalized });
      if (workspaceState.accountLookupStatus !== "resolved") {
        throw new Error(
          workspaceState.accountLookupStatus === "not_found"
            ? "desktop_saved_cloud_workspace_not_found"
            : "desktop_saved_cloud_workspace_unavailable",
        );
      }
      if (activeEnterpriseProfiles.size !== 1) {
        throw new Error("desktop_saved_cloud_workspace_invalid");
      }
      const workspace = [...activeEnterpriseProfiles.values()][0];
      const profile = validateConnectionEnvelope(
        workspace.envelope,
        await connectionValidationOptions(),
      );
      await stopLocalMode();
      await openWorkspace(profile, workspace.partitionName, { rememberedSession: account.session });
    }
    publishState({ autoLoginStatus: "connected", error: "" });
  } catch (error) {
    const code = error instanceof Error ? error.message : "desktop_saved_account_login_failed";
    const invalidSession = (
      code.startsWith("desktop_local_remembered_login_failed:401")
      || code === "desktop_local_account_mismatch"
      || code === "desktop_remembered_session_invalid"
      || code === "desktop_saved_cloud_workspace_not_found"
      || code === "desktop_saved_cloud_workspace_invalid"
    );
    if (invalidSession) {
      await clearAccountSession({
        accountId: normalized,
        removeAccount: false,
        ...credentialStoreOptions(),
      }).catch(() => {});
    }
    await refreshSavedAccountState().catch(() => {});
    destroyWorkspaceView();
    if (localRuntimeLifecycle.state() !== "stopped") await localRuntimeLifecycle.stop().catch(() => {});
    publishState({
      mode: "none",
      status: "error",
      autoLoginStatus: "error",
      error: code,
    });
  }
  return workspaceState;
}

async function trySavedAccountLogin() {
  let saved;
  try {
    saved = await refreshSavedAccountState();
  } catch (error) {
    publishState({
      rememberedLoginAvailable: false,
      autoLoginStatus: "error",
      error: error instanceof Error ? error.message : "desktop_saved_accounts_invalid",
    });
    return workspaceState;
  }
  const active = saved.accounts.find((account) => account.accountId === saved.activeAccountId);
  if (!active?.session) return workspaceState;
  return resumeSavedAccount(active.accountId);
}

async function switchAccount(input = {}) {
  const accountId = typeof input.accountId === "string" && input.accountId
    ? normalizeAccountId(input.accountId)
    : "";
  destroyWorkspaceView();
  if (localRuntimeLifecycle.state() !== "stopped" || localRuntimeKind === "guest") {
    await stopLocalMode();
  }
  accountLookupGeneration.invalidate();
  activeEnterpriseProfiles = new Map();
  publishState({
    mode: "none",
    status: "idle",
    displayName: "",
    profileId: "",
    applicationOrigin: "",
    error: "",
    localStatus: "stopped",
    accountLookupStatus: "idle",
    accountNotFound: false,
    canCreateLocal: false,
    pendingLocalAccountId: "",
    autoLoginStatus: "idle",
  });
  if (accountId) {
    await setActiveAccount({ accountId, ...credentialStoreOptions() });
    await refreshSavedAccountState();
    const selected = workspaceState.savedAccounts.find((item) => item.accountId === accountId);
    if (selected?.canAutoLogin) return resumeSavedAccount(accountId);
  }
  return workspaceState;
}

async function changeLocalPassword(input) {
  if (
    !input
    || typeof input !== "object"
    || Object.keys(input).sort().join(",") !== "currentPassword,newPassword,remember"
    || typeof input.remember !== "boolean"
  ) throw new Error("desktop_local_password_change_shape_invalid");
  const runtime = localRuntimeLifecycle.current();
  if (!runtime) throw new Error("desktop_local_runtime_not_started");
  const changed = await changeLocalPasswordRuntime(
    runtime,
    String(input.currentPassword || ""),
    String(input.newPassword || ""),
    { remember: input.remember },
  );
  const accountId = normalizeAccountId(changed.username);
  await saveDesktopAccount({
    accountId,
    displayName: changed.username,
    mode: "local",
    session: changed.rememberSession,
  });
  await setLocalSessionCookies(workspaceView.webContents.session, runtime);
  return { status: "changed", remembered: changed.rememberSession !== null };
}

async function forgetRememberedLogin() {
  return finalizeCloudLogout({ revokeServerSession: true });
}

async function finalizeCloudLogout({ revokeServerSession = false } = {}) {
  if (cloudLogoutCleanupPromise) return cloudLogoutCleanupPromise;
  cloudLogoutCleanupPromise = (async () => {
    if (
      revokeServerSession
      && workspaceState.mode === "cloud"
      && workspaceView
      && !workspaceView.webContents.isDestroyed()
    ) {
      await workspaceView.webContents.executeJavaScript(cloudLogoutScript(), true).catch(() => false);
    }
    if (workspaceState.activeAccountId) {
      await clearAccountSession({
        accountId: workspaceState.activeAccountId,
        removeAccount: false,
        ...credentialStoreOptions(),
      });
    }
    await resetAccountLookup();
    await refreshSavedAccountState();
    publishState({ autoLoginStatus: "idle" });
    return workspaceState;
  })();
  try {
    return await cloudLogoutCleanupPromise;
  } finally {
    cloudLogoutCleanupPromise = null;
  }
}

async function resetAccountLookup() {
  const generation = accountLookupGeneration.invalidate();
  const profilesToClear = activeEnterpriseProfiles;
  activeEnterpriseProfiles = new Map();
  destroyWorkspaceView();
  await Promise.all([...profilesToClear.values()].map(async (workspace) => {
    const remoteSession = session.fromPartition(workspace.partitionName);
    await remoteSession.clearStorageData();
    await remoteSession.clearCache();
  }));
  accountLookupGeneration.commit(generation, () => {
    publishState({
      mode: "none",
      status: "idle",
      displayName: "",
      profileId: "",
      applicationOrigin: "",
      error: "",
      accountLookupStatus: "idle",
      accountNotFound: false,
      enterpriseWorkspaces: [],
    });
  });
  return workspaceState;
}

async function connectEnterpriseWorkspace(input) {
  if (
    !input
    || typeof input !== "object"
    || Object.keys(input).sort().join(",") !== "connectionId"
    || typeof input.connectionId !== "string"
  ) {
    throw new Error("desktop_workspace_selection_shape_invalid");
  }
  try {
    const workspace = activeEnterpriseProfiles.get(input.connectionId);
    if (!workspace) throw new Error("desktop_workspace_not_resolved_for_account");
    const options = await connectionValidationOptions();
    const profile = validateConnectionEnvelope(workspace.envelope, options);
    await stopLocalMode();
    await openWorkspace(profile, workspace.partitionName);
  } catch (error) {
    destroyWorkspaceView();
    publishState({
      status: "error",
      error: error instanceof Error ? error.message : "desktop_workspace_connection_failed",
    });
  }
  return workspaceState;
}

async function disconnectWorkspace() {
  destroyWorkspaceView();
  publishState({
    mode: "none",
    status: "idle",
    displayName: "",
    profileId: "",
    applicationOrigin: "",
    error: "",
  });
  return workspaceState;
}

async function serveShellAsset(request) {
  const requestUrl = new URL(request.url);
  const relative = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
  const root = rendererRoot();
  const target = path.resolve(root, `.${relative}`);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return new Response("Not Found", { status: 404 });
  }
  try {
    const content = await readFile(target);
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": MIME_TYPES.get(path.extname(target)) || "application/octet-stream",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

function installIpcHandlers() {
  ipcMain.handle("desktop:get-state", (event) => {
    requireTrustedShellSender(event);
    return workspaceState;
  });
  ipcMain.handle("desktop:get-preferences", (event) => {
    requireTrustedShellSender(event);
    return publicDesktopPreferences();
  });
  ipcMain.handle("desktop:update-preferences", async (event, patch) => {
    requireTrustedShellSender(event);
    return updateDesktopPreferences(patch);
  });
  if (process.env.BIZHUB_DESKTOP_ACCOUNT_FLOW_SMOKE === "1") {
    ipcMain.handle("desktop:smoke-hide-window", (event) => {
      requireTrustedShellSender(event);
      setTimeout(() => mainWindow?.close(), 100);
      return { status: "hiding" };
    });
    ipcMain.handle("desktop:smoke-restore-window", (event) => {
      requireTrustedShellSender(event);
      showMainWindow();
      return { status: "visible" };
    });
    ipcMain.handle("desktop:smoke-quit-app", (event) => {
      requireTrustedShellSender(event);
      setTimeout(() => {
        quitRequested = true;
        app.quit();
      }, 100);
      return { status: "quitting" };
    });
  }
  ipcMain.handle("desktop:get-update-state", (event) => {
    requireTrustedShellSender(event);
    return publicUpdateState();
  });
  ipcMain.handle("desktop:check-update", async (event) => {
    requireTrustedShellSender(event);
    return checkDesktopUpdate({ interactive: false });
  });
  ipcMain.handle("desktop:download-update", async (event) => {
    requireTrustedShellSender(event);
    return downloadDesktopUpdate({ promptAfterDownload: false });
  });
  ipcMain.handle("desktop:install-update", async (event) => {
    requireTrustedShellSender(event);
    return installDesktopUpdate();
  });
  ipcMain.handle("desktop:lookup-account", async (event, input) => {
    requireTrustedShellSender(event);
    return lookupAccount(input);
  });
  ipcMain.handle("desktop:login-enterprise", async (event, input) => {
    requireTrustedShellSender(event);
    return loginEnterprise(input);
  });
  ipcMain.handle("desktop:login-account", async (event, input) => {
    requireTrustedShellSender(event);
    return loginAccount(input);
  });
  ipcMain.handle("desktop:resume-account", async (event, input) => {
    requireTrustedShellSender(event);
    if (
      !input
      || typeof input !== "object"
      || Object.keys(input).sort().join(",") !== "accountId"
    ) throw new Error("desktop_saved_account_selection_invalid");
    return resumeSavedAccount(input.accountId);
  });
  ipcMain.handle("desktop:switch-account", async (event, input) => {
    requireTrustedShellSender(event);
    return switchAccount(input);
  });
  ipcMain.handle("desktop:forget-remembered-login", async (event) => {
    requireTrustedShellSender(event);
    return forgetRememberedLogin();
  });
  ipcMain.handle("desktop:reset-account-lookup", async (event) => {
    requireTrustedShellSender(event);
    return resetAccountLookup();
  });
  ipcMain.handle("desktop:connect-enterprise-workspace", async (event, input) => {
    requireTrustedShellSender(event);
    return connectEnterpriseWorkspace(input);
  });
  ipcMain.handle("desktop:disconnect-workspace", async (event) => {
    requireTrustedShellSender(event);
    return disconnectWorkspace();
  });
  ipcMain.handle("desktop:cloud-get-info", async (event) => {
    requireTrustedCloudSender(event);
    return cloudDesktopInfo();
  });
  ipcMain.handle("desktop:cloud-get-preferences", (event) => {
    requireTrustedCloudSender(event);
    return publicDesktopPreferences();
  });
  ipcMain.handle("desktop:cloud-update-preferences", async (event, patch) => {
    requireTrustedCloudSender(event);
    return updateDesktopPreferences(patch);
  });
  ipcMain.handle("desktop:cloud-check-update", async (event) => {
    requireTrustedCloudSender(event);
    return checkDesktopUpdate({ interactive: false });
  });
  ipcMain.handle("desktop:cloud-switch-account", async (event) => {
    requireTrustedCloudSender(event);
    setTimeout(() => {
      void switchAccount().catch((error) => {
        publishState({
          status: "error",
          error: error instanceof Error ? error.message : "desktop_switch_account_failed",
        });
      });
    }, 0);
    return { status: "switching" };
  });
  ipcMain.handle("desktop:open-guest-demo", async (event) => {
    requireTrustedShellSender(event);
    return openGuestDemo();
  });
  ipcMain.handle("desktop:prepare-local", async (event) => {
    requireTrustedShellSender(event);
    return prepareLocalLogin();
  });
  ipcMain.handle("desktop:setup-local", async (event, input) => {
    requireTrustedShellSender(event);
    return setupLocalInstance(input);
  });
  ipcMain.handle("desktop:login-local", async (event, input) => {
    requireTrustedShellSender(event);
    return authenticateLocal(input);
  });
  ipcMain.handle("desktop:backup-local", async (event) => {
    requireTrustedShellSender(event);
    return createLocalBackup();
  });
  ipcMain.handle("desktop:stop-local", async (event) => {
    requireTrustedShellSender(event);
    return stopLocalMode();
  });
  ipcMain.handle("desktop:local-settings", async (event) => {
    requireTrustedLocalSender(event);
    const runtime = localRuntimeLifecycle.current();
    if (workspaceState.mode === "guest") {
      return {
        appVersion: app.getVersion(),
        accountId: "游客",
        displayName: DEMO_COMPANY_NAME,
        runtimeVersion: runtime?.release?.runtime_version || "",
        lastBackup: "",
        remembered: false,
        guestMode: true,
        preferences: publicDesktopPreferences(),
      };
    }
    return {
      appVersion: app.getVersion(),
      accountId: workspaceState.activeAccountId,
      displayName: workspaceState.displayName,
      runtimeVersion: runtime?.release?.runtime_version || "",
      lastBackup: workspaceState.localLastBackup,
      remembered: workspaceState.savedAccounts.some((account) => (
        account.accountId === workspaceState.activeAccountId && account.canAutoLogin
      )),
      guestMode: false,
      preferences: publicDesktopPreferences(),
    };
  });
  ipcMain.handle("desktop:local-get-preferences", (event) => {
    requireTrustedLocalSender(event);
    return publicDesktopPreferences();
  });
  ipcMain.handle("desktop:local-update-preferences", async (event, patch) => {
    requireTrustedLocalSender(event);
    if (workspaceState.mode === "guest") {
      throw new Error("desktop_guest_demo_preferences_not_available");
    }
    return updateDesktopPreferences(patch);
  });
  ipcMain.handle("desktop:local-backup", async (event) => {
    requireTrustedLocalSender(event);
    if (workspaceState.mode === "guest") throw new Error("desktop_guest_demo_backup_not_available");
    await createLocalBackup();
    if (workspaceState.localError) throw new Error(workspaceState.localError);
    return { status: "created", path: workspaceState.localLastBackup };
  });
  ipcMain.handle("desktop:local-open-backups", async (event) => {
    requireTrustedLocalSender(event);
    if (workspaceState.mode === "guest") throw new Error("desktop_guest_demo_backup_not_available");
    const instance = await loadLocalInstance(localInstanceRoot());
    const error = await shell.openPath(instance.paths.backups);
    if (error) throw new Error("desktop_local_backup_folder_open_failed");
    return { status: "opened" };
  });
  ipcMain.handle("desktop:local-change-password", async (event, input) => {
    requireTrustedLocalSender(event);
    if (workspaceState.mode === "guest") throw new Error("desktop_guest_demo_password_not_available");
    return changeLocalPassword(input);
  });
  ipcMain.handle("desktop:local-switch-account", async (event) => {
    requireTrustedLocalSender(event);
    return switchAccount();
  });
  ipcMain.handle("desktop:local-forget-account", async (event) => {
    requireTrustedLocalSender(event);
    if (workspaceState.mode === "guest") return switchAccount();
    const accountId = workspaceState.activeAccountId;
    if (accountId) {
      await clearAccountSession({
        accountId,
        removeAccount: false,
        ...credentialStoreOptions(),
      });
    }
    return switchAccount();
  });
}

function installApplicationMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const updateItem = {
    label: "检查更新…",
    click: () => { void checkDesktopUpdate({ interactive: true }); },
  };
  const template = [{
    label: app.name,
    submenu: [
      { role: "about" },
      updateItem,
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  }];
  template.push(
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "显示", submenu: [{ role: "reload" }, { role: "togglefullscreen" }] },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }] },
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindowsTrayIcon() {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const border = x < 2 || x >= size - 2 || y < 2 || y >= size - 2;
      pixels[offset] = border ? 38 : 82;
      pixels[offset + 1] = border ? 48 : 129;
      pixels[offset + 2] = border ? 37 : 41;
      pixels[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}

function installBackgroundTray() {
  if (process.platform !== "win32" || backgroundTray) return;
  backgroundTray = new Tray(createWindowsTrayIcon());
  backgroundTray.setToolTip("BizHub Desktop");
  backgroundTray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 BizHub", click: showMainWindow },
    { label: "检查更新…", click: () => { void checkDesktopUpdate({ interactive: true }); } },
    { type: "separator" },
    {
      label: "退出 BizHub",
      click: () => {
        quitRequested = true;
        app.quit();
      },
    },
  ]));
  backgroundTray.on("click", showMainWindow);
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: process.platform === "win32",
    backgroundColor: publicDesktopPreferences().effectiveTheme === "dark" ? "#15191d" : "#f4f6f8",
    title: "BizHub Desktop",
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 13 },
    } : {}),
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      experimentalFeatures: false,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      webSecurity: true,
    },
  });
  if (process.platform === "win32") mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const destination = new URL(url);
    if (destination.protocol !== "bizhub-shell:" || destination.host !== "app") {
      event.preventDefault();
    }
  });
  mainWindow.on("resize", setWorkspaceBounds);
  mainWindow.on("close", (event) => {
    const closeAction = resolveWindowCloseAction(desktopPreferences, {
      quitRequested,
      shutdownInProgress,
    });
    if (closeAction === "allow") return;
    if (closeAction === "quit") {
      quitRequested = true;
      app.quit();
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on("closed", () => {
    destroyWorkspaceView();
    mainWindow = null;
    if (localRuntimeLifecycle.state() !== "stopped" || localRuntimeKind === "guest") {
      void stopLocalMode();
    }
  });
  await mainWindow.loadURL(SHELL_URL);
  applyDesktopPreferences();
  if (process.platform === "darwin" && app.isPackaged) {
    await finalizePendingMacUpdate({
      executablePath: app.getPath("exe"),
      currentVersion: app.getVersion(),
      updateRoot: updateDownloadRoot(),
    }).catch(() => {});
  }
  await refreshLocalState();
  await refreshSavedAccountState();

  if (process.env.BIZHUB_DESKTOP_SMOKE_LOCAL === "1") {
    try {
      const runtime = await startLocalMode();
      await loginLocalRuntime(
        runtime,
        process.env.BIZHUB_DESKTOP_SMOKE_LOCAL_USERNAME || "synthetic-admin",
        process.env.BIZHUB_DESKTOP_SMOKE_LOCAL_PASSWORD || "",
      );
      await openLocalWorkspaceView();
    } catch (error) {
      finishSmoke({
        status: "error",
        mode: "local",
        error: error instanceof Error ? error.message : "desktop_local_smoke_failed",
      }, 1);
    }
    return;
  }

  const smokeProfile = process.env.BIZHUB_DESKTOP_SMOKE_PROFILE;
  if (smokeProfile) {
    try {
      await openWorkspace(await loadConnectionProfile(path.resolve(smokeProfile)));
    } catch (error) {
      finishSmoke({
        status: "error",
        error: error instanceof Error ? error.message : "desktop_smoke_failed",
      }, 1);
    }
    return;
  }
  await trySavedAccountLogin();
}

if (squirrelStartupHandled) {
  // Squirrel startup handling owns this short-lived process.
} else if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    protocol.handle("bizhub-shell", serveShellAsset);
    desktopPreferences = await loadPreferences(desktopUserDataRoot())
      .catch(() => ({ ...DEFAULT_PREFERENCES }));
    installIpcHandlers();
    installApplicationMenu();
    installBackgroundTray();
    nativeTheme.on("updated", () => {
      if (desktopPreferences.theme === "system") applyDesktopPreferences();
    });
    let recoveryError = null;
    try {
      await recoverInterruptedLocalSetup(desktopUserDataRoot());
      await resetGuestDemoData();
    } catch (error) {
      recoveryError = error instanceof Error ? error.message : "desktop_local_setup_recovery_failed";
    }
    await createMainWindow();
    if (recoveryError) publishState({ localError: recoveryError });
    if (!autoUpdateSuppressed() && desktopPreferences.automaticUpdates) {
      setTimeout(() => { void checkDesktopUpdate({ interactive: false, automatic: true }); }, 3_000);
    }
  });

  app.on("second-instance", () => {
    showMainWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    } else {
      showMainWindow();
    }
  });

  app.on("before-quit", (event) => {
    quitRequested = true;
    destroyWorkspaceView();
    if (
      (localRuntimeLifecycle.state() === "stopped" && localRuntimeKind !== "guest")
      || shutdownInProgress
    ) return;
    event.preventDefault();
    shutdownInProgress = true;
    void stopLocalMode().finally(() => {
      app.quit();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
