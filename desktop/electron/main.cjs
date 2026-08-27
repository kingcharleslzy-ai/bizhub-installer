const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  session,
  WebContentsView,
} = require("electron");
const { readFile, stat } = require("node:fs/promises");
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
  clearRememberedSession,
  loadRememberedSession,
  saveRememberedSession,
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
  loadLocalInstance,
  loginLocalRuntime,
  recoverInterruptedLocalSetup,
  startLocalRuntime,
  stopLocalRuntime,
} = require("./local-runtime.cjs");
const { createLocalRuntimeLifecycle } = require("./local-lifecycle.cjs");
const { handleSquirrelStartup } = require("./squirrel-startup.cjs");

const SHELL_ORIGIN = "bizhub-shell://app";
const SHELL_URL = `${SHELL_ORIGIN}/`;
const HEADER_HEIGHT = 72;
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
const remoteSessionPolicies = new WeakMap();
const localSessionPolicies = new WeakMap();
let activeEnterpriseProfiles = new Map();
const accountLookupGeneration = createAccountLookupGeneration();
let shutdownInProgress = false;
let cloudLogoutCleanupPromise = null;
const localRuntimeLifecycle = createLocalRuntimeLifecycle({
  startRuntime: launchLocalRuntime,
  stopRuntime: stopLocalRuntime,
});
let workspaceState = {
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

function localInstanceRoot() {
  return path.join(desktopUserDataRoot(), "local-instance");
}

function accountDirectoryConfigPath() {
  if (!app.isPackaged && process.env.BIZHUB_DESKTOP_ACCOUNT_DIRECTORY_CONFIG) {
    return path.resolve(process.env.BIZHUB_DESKTOP_ACCOUNT_DIRECTORY_CONFIG);
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, "account-directory.json")
    : path.resolve(__dirname, "..", "config", "account-directory.json");
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

function setWorkspaceBounds() {
  if (!mainWindow || !workspaceView) return;
  const [width, height] = mainWindow.getContentSize();
  const topInset = workspaceState.mode === "cloud" && workspaceState.status === "connected"
    ? 0
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
    publishState({
      localInitialized: true,
      localError: "",
      ...(workspaceState.mode === "none" ? { displayName: instance.payload.display_name } : {}),
    });
    return instance;
  } catch (error) {
    if (error?.code === "ENOENT") {
      publishState({ localInitialized: false, localError: "" });
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

async function openLocalWorkspaceView() {
  const runtime = localRuntimeLifecycle.current();
  if (!runtime) throw new Error("desktop_local_runtime_not_started");
  destroyWorkspaceView();
  const localOrigin = normalizeLocalOrigin(runtime.origin);
  if (!localOrigin) throw new Error("desktop_local_runtime_origin_invalid");
  const runtimeSession = session.fromPartition("persist:local-generic");
  configureLocalSession(runtimeSession, localOrigin);
  await setLocalSessionCookies(runtimeSession, runtime);
  workspaceView = new WebContentsView({
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      experimentalFeatures: false,
      nodeIntegration: false,
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
        mode: "local",
        status: "error",
        localStatus: "error",
        localError: `local_workspace_load_failed:${errorCode}:${errorDescription}:${validatedUrl}`,
      });
    },
  );
  workspaceView.webContents.on("did-finish-load", () => {
    publishState({
      mode: "local",
      status: "connected",
      localStatus: "connected",
      error: "",
      localError: "",
    });
    if (process.env.BIZHUB_DESKTOP_SMOKE_LOCAL === "1") {
      const origin = runtime.origin;
      void stopLocalMode().then(() => {
        finishSmoke({
          status: "connected",
          mode: "local",
          origin,
          residual_runtime_processes: 0,
        }, 0);
      });
    }
  });
  mainWindow.contentView.addChildView(workspaceView);
  setWorkspaceBounds();
  await workspaceView.webContents.loadURL(`${localOrigin}/`);
}

async function readJsonFile(filePath, maxBytes) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > maxBytes) {
    throw new Error("desktop_profile_file_size_invalid");
  }
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
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
  const instance = await refreshLocalState();
  if (!instance) throw new Error("desktop_local_instance_not_initialized");
  publishState({
    mode: "local",
    status: "loading",
    displayName: instance.payload.display_name,
    profileId: "generic-kernel-smoke",
    applicationOrigin: "127.0.0.1",
    error: "",
    localStatus: "starting",
    localError: "",
  });
  const started = await startLocalRuntime({
    instanceRoot: localInstanceRoot(),
    runtimePack: localRuntimePackPath(),
    trustPath: localRuntimeTrustPath(),
  });
  started.child.once("exit", (code, signalName) => {
    const expectedExit = localRuntimeLifecycle.state() === "stopping" || shutdownInProgress;
    if (!localRuntimeLifecycle.markExited(started)) return;
    destroyWorkspaceView();
    if (!expectedExit) {
      publishState({
        mode: "local",
        status: "error",
        localStatus: "error",
        localError: `desktop_local_runtime_exited:${code ?? signalName ?? "unknown"}`,
      });
    }
  });
  return started;
}

async function startLocalMode() {
  const runtime = await localRuntimeLifecycle.start();
  publishState({
    mode: "local",
    status: "idle",
    localStatus: "awaiting_login",
    applicationOrigin: runtime.origin,
  });
  return runtime;
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

async function setupLocalInstance(input) {
  if (localRuntimeLifecycle.state() !== "stopped") {
    throw new Error("desktop_local_runtime_already_started");
  }
  publishState({
    mode: "local",
    status: "loading",
    localStatus: "initializing",
    localError: "",
  });
  try {
    const created = await bootstrapLocalInstance({
      userDataRoot: desktopUserDataRoot(),
      runtimePack: localRuntimePackPath(),
      trustPath: localRuntimeTrustPath(),
      input,
    });
    publishState({
      localInitialized: true,
      displayName: created.instance.display_name,
      profileId: created.instance.profile_id,
    });
    const runtime = await startLocalMode();
    await loginLocalRuntime(runtime, input.username, input.password);
    await openLocalWorkspaceView();
  } catch (error) {
    await refreshLocalState();
    publishState({
      mode: "local",
      status: "error",
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
    || Object.keys(input).sort().join(",") !== "password,username"
  ) {
    throw new Error("desktop_local_login_shape_invalid");
  }
  try {
    const runtime = await startLocalMode();
    await loginLocalRuntime(runtime, String(input.username || ""), String(input.password || ""));
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
  destroyWorkspaceView();
  await localRuntimeLifecycle.stop();
  publishState({
    mode: "none",
    status: "idle",
    profileId: "",
    applicationOrigin: "",
    error: "",
    localStatus: "stopped",
    localError: "",
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
    if (normalized.remember) {
      try {
        await saveRememberedSession({
          remembered: {
            accountId: normalized.accountId,
            session: authenticatedSession,
          },
          userDataRoot: desktopUserDataRoot(),
        });
      } catch {
        rememberError = "desktop_remembered_session_save_failed";
      }
    } else {
      try {
        await clearRememberedSession({ userDataRoot: desktopUserDataRoot() });
      } catch {
        rememberError = "desktop_remembered_session_clear_failed";
      }
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

async function tryRememberedLogin() {
  let remembered;
  try {
    remembered = await loadRememberedSession({ userDataRoot: desktopUserDataRoot() });
  } catch (error) {
    await clearRememberedSession({ userDataRoot: desktopUserDataRoot() }).catch(() => {});
    publishState({
      rememberedLoginAvailable: false,
      autoLoginStatus: "error",
      error: error instanceof Error ? error.message : "desktop_remembered_session_invalid",
    });
    return workspaceState;
  }
  if (!remembered) return workspaceState;
  publishState({
    rememberedLoginAvailable: true,
    autoLoginStatus: "resolving",
    error: "",
  });
  await lookupAccount({ accountId: remembered.accountId });
  if (
    workspaceState.accountLookupStatus !== "resolved"
    || activeEnterpriseProfiles.size !== 1
  ) {
    publishState({ autoLoginStatus: "error" });
    return workspaceState;
  }
  try {
    const workspace = [...activeEnterpriseProfiles.values()][0];
    const options = await connectionValidationOptions();
    const profile = validateConnectionEnvelope(workspace.envelope, options);
    await stopLocalMode();
    publishState({ autoLoginStatus: "authenticating" });
    await openWorkspace(profile, workspace.partitionName, {
      rememberedSession: remembered.session,
    });
    publishState({
      rememberedLoginAvailable: true,
      autoLoginStatus: "connected",
      error: "",
    });
  } catch (error) {
    destroyWorkspaceView();
    const code = error instanceof Error ? error.message : "desktop_remembered_session_invalid";
    if (code.startsWith("desktop_remembered_session_")) {
      await clearRememberedSession({ userDataRoot: desktopUserDataRoot() }).catch(() => {});
    }
    publishState({
      mode: "none",
      status: "error",
      error: code,
      rememberedLoginAvailable: !code.startsWith("desktop_remembered_session_"),
      autoLoginStatus: "error",
    });
  }
  return workspaceState;
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
    await clearRememberedSession({ userDataRoot: desktopUserDataRoot() });
    await resetAccountLookup();
    publishState({ rememberedLoginAvailable: false, autoLoginStatus: "idle" });
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
  ipcMain.handle("desktop:lookup-account", async (event, input) => {
    requireTrustedShellSender(event);
    return lookupAccount(input);
  });
  ipcMain.handle("desktop:login-enterprise", async (event, input) => {
    requireTrustedShellSender(event);
    return loginEnterprise(input);
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
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f4f6f8",
    title: "BizHub Desktop",
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
  mainWindow.on("closed", () => {
    destroyWorkspaceView();
    mainWindow = null;
    if (localRuntimeLifecycle.state() !== "stopped") void stopLocalMode();
  });
  await mainWindow.loadURL(SHELL_URL);
  await refreshLocalState();

  if (process.env.BIZHUB_DESKTOP_SMOKE_LOCAL === "1") {
    try {
      await startLocalMode();
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
  await tryRememberedLogin();
}

if (squirrelStartupHandled) {
  // Squirrel startup handling owns this short-lived process.
} else if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    protocol.handle("bizhub-shell", serveShellAsset);
    installIpcHandlers();
    let recoveryError = null;
    try {
      await recoverInterruptedLocalSetup(desktopUserDataRoot());
    } catch (error) {
      recoveryError = error instanceof Error ? error.message : "desktop_local_setup_recovery_failed";
    }
    await createMainWindow();
    if (recoveryError) publishState({ localError: recoveryError });
  });

  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });

  app.on("before-quit", (event) => {
    destroyWorkspaceView();
    if (localRuntimeLifecycle.state() === "stopped" || shutdownInProgress) return;
    event.preventDefault();
    shutdownInProgress = true;
    void localRuntimeLifecycle.stop().finally(() => {
      app.quit();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
