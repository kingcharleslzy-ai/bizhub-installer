const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  WebContentsView,
} = require("electron");
const { createHash } = require("node:crypto");
const { readFile, stat } = require("node:fs/promises");
const path = require("node:path");
const { validateConnectionEnvelope } = require("./connection-profile.cjs");
const { remoteRequestAllowed } = require("./network-policy.cjs");

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
let workspaceExpiryTimer = null;
const remoteSessionPolicies = new WeakMap();
let workspaceState = {
  status: "idle",
  displayName: "",
  profileId: "",
  applicationOrigin: "",
  error: "",
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
const hasSingleInstanceLock = app.requestSingleInstanceLock();

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
  workspaceView.setBounds({
    x: 0,
    y: HEADER_HEIGHT,
    width: Math.max(0, width),
    height: Math.max(0, height - HEADER_HEIGHT),
  });
}

function destroyWorkspaceView() {
  if (workspaceExpiryTimer) {
    clearTimeout(workspaceExpiryTimer);
    workspaceExpiryTimer = null;
  }
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

function configureRemoteSession(remoteSession, allowedOrigins) {
  const existingPolicy = remoteSessionPolicies.get(remoteSession);
  if (existingPolicy) {
    existingPolicy.allowedOrigins = allowedOrigins;
    return;
  }
  const policy = { allowedOrigins };
  remoteSession.setPermissionCheckHandler(() => false);
  remoteSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  remoteSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !remoteRequestAllowed(details.url, policy.allowedOrigins) });
  });
  remoteSession.on("will-download", (event) => {
    event.preventDefault();
    publishState({ error: "desktop_download_not_enabled" });
  });
  remoteSessionPolicies.set(remoteSession, policy);
}

function scheduleWorkspaceExpiry(expiresAt) {
  const check = () => {
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) {
      destroyWorkspaceView();
      publishState({ status: "error", error: "desktop_connection_profile_expired" });
      return;
    }
    workspaceExpiryTimer = setTimeout(check, Math.min(remaining, 60_000));
  };
  check();
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

async function openWorkspace(profile) {
  destroyWorkspaceView();
  const partitionHash = createHash("sha256")
    .update(profile.connectionId)
    .digest("hex")
    .slice(0, 24);
  const remoteSession = session.fromPartition(`persist:workspace-${partitionHash}`);
  configureRemoteSession(remoteSession, profile.allowedOrigins);
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
    publishState({ status: "connected", error: "" });
    if (process.env.BIZHUB_DESKTOP_SMOKE_EXIT_ON_LOAD === "1") {
      void finishSmoke({ status: "connected", origin: profile.allowedOrigins[0] }, 0);
    }
  });
  mainWindow.contentView.addChildView(workspaceView);
  setWorkspaceBounds();
  publishState({
    status: "loading",
    displayName: profile.displayName,
    profileId: profile.profileId,
    applicationOrigin: new URL(profile.applicationUrl).origin,
    error: "",
  });
  scheduleWorkspaceExpiry(profile.expiresAt);
  await workspaceView.webContents.loadURL(profile.applicationUrl);
}

async function chooseConnectionProfile() {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "选择 BizHub 企业连接文件",
    buttonLabel: "验证并连接",
    properties: ["openFile"],
    filters: [{ name: "BizHub connection", extensions: ["json"] }],
  });
  if (selection.canceled || selection.filePaths.length !== 1) return workspaceState;
  try {
    const profile = await loadConnectionProfile(selection.filePaths[0]);
    await openWorkspace(profile);
  } catch (error) {
    destroyWorkspaceView();
    publishState({
      status: "error",
      error: error instanceof Error ? error.message : "desktop_connection_failed",
    });
  }
  return workspaceState;
}

async function disconnectWorkspace() {
  destroyWorkspaceView();
  publishState({
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
  ipcMain.handle("desktop:choose-connection-profile", async (event) => {
    requireTrustedShellSender(event);
    return chooseConnectionProfile();
  });
  ipcMain.handle("desktop:disconnect-workspace", async (event) => {
    requireTrustedShellSender(event);
    return disconnectWorkspace();
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
  });
  await mainWindow.loadURL(SHELL_URL);

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
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    protocol.handle("bizhub-shell", serveShellAsset);
    installIpcHandlers();
    await createMainWindow();
  });

  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });

  app.on("before-quit", destroyWorkspaceView);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
