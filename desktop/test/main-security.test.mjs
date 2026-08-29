import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("remote content uses the hardened WebContentsView boundary", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const accountDirectory = await readFile(
    path.join(ROOT, "electron", "account-directory.cjs"),
    "utf8",
  );
  for (const required of [
    "WebContentsView",
    "allowRunningInsecureContent: false",
    "contextIsolation: true",
    "experimentalFeatures: false",
    "nodeIntegration: false",
    "requestSingleInstanceLock",
    "sandbox: true",
    "webSecurity: true",
    "setPermissionCheckHandler",
    "setPermissionRequestHandler",
    "setWindowOpenHandler",
    "event.sender === mainWindow?.webContents",
    "senderUrl.protocol === \"bizhub-shell:\"",
    "will-navigate",
    "will-redirect",
    "return `workspace-",
    "account-directory.json",
    "createAccountLookupGeneration",
    "resolveAccountWorkspaces",
    "workspaceSessionPartition",
    "activeEnterpriseProfiles = resolvedProfiles",
    "accountLookupGeneration.invalidate()",
    "clearStorageData",
    "clearCache",
    "cloudLoginScript",
    "sessionStorageScript",
    "saveDesktopAccount",
    "safeStorage",
    "clearAccountSession",
    "workspaceView.setVisible(false)",
    "workspaceView.setVisible(true)",
    "isCloudLogoutRequest",
    "finalizeCloudLogout",
    "trustedCloudSender",
    "event.senderFrame === event.sender.mainFrame",
    "senderUrl.origin === workspaceState.applicationOrigin",
    "cloud-preload.cjs",
    'titleBarStyle: "hiddenInset"',
    "trafficLightPosition",
    "new Tray(createWindowsTrayIcon())",
    'mainWindow.on("close", (event)',
    "event.preventDefault()",
    "mainWindow.hide()",
    "showMainWindow()",
    'label: "退出 BizHub"',
  ]) {
    assert.ok(`${main}\n${accountDirectory}`.includes(required), required);
  }
  for (const prohibited of [
    "BrowserView",
    "<webview",
    "shell.openExternal",
    "node:child_process",
    "better-sqlite3",
    "sqlite3",
    "sql.js",
    "0.0.0.0",
    "persist:workspace-",
  ]) {
    assert.ok(!main.includes(prohibited), prohibited);
  }
});

test("closing the window keeps the workspace alive in the background", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  assert.match(
    main,
    /mainWindow\.on\("close", \(event\) => \{[\s\S]+resolveWindowCloseAction\(desktopPreferences[\s\S]+event\.preventDefault\(\);\s+mainWindow\.hide\(\);/,
  );
  assert.match(main, /app\.on\("second-instance", \(\) => \{\s+showMainWindow\(\);/);
  assert.match(main, /app\.on\("activate", \(\) => \{[\s\S]*showMainWindow\(\);/);
  assert.match(main, /app\.on\("before-quit", \(event\) => \{\s+quitRequested = true;/);
  assert.ok(!main.includes('mainWindow.on("close", destroyWorkspaceView'));
});

test("login uses an integrated title area and connected workspaces replace the shell", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const shell = await readFile(path.join(ROOT, "shell-frontend", "src", "App.vue"), "utf8");
  const style = await readFile(path.join(ROOT, "shell-frontend", "src", "style.css"), "utf8");
  assert.match(main, /workspaceState\.mode === "guest"\s+\? GUEST_BANNER_HEIGHT/);
  assert.match(main, /process\.platform === "darwin" && workspaceState\.mode === "local" \? 30 : 0/);
  assert.match(main, /if \(authenticationPending\) return;[\s\S]*workspaceView\.setVisible\(true\)/);
  assert.ok(shell.includes('class="window-drag-region"'));
  assert.ok(shell.includes('class="workspace-backdrop"'));
  assert.ok(shell.includes('class="login-panel"'));
  assert.ok(!shell.includes('class="brand-lockup"'));
  assert.ok(!shell.includes('class="mark"'));
  assert.ok(!shell.includes('class="shell-bar"'));
  assert.ok(!shell.includes("通用企业客户端"));
  assert.ok(!shell.includes("123" + "crystal"));
  assert.ok(!shell.includes("daz" + "heng"));
  assert.ok(shell.includes('v-if="guestConnected" class="guest-banner"'));
  assert.ok(shell.includes("state.platform === 'darwin'"));
  assert.ok(!shell.includes("退出并清除保持登录"));
  assert.ok(style.includes("--shell-action: #26221c"));
  for (const oldGreen of ["#17695f", "#11574f", "#3d9a8c", "#4ba99a", "#25443c", "#9fc5b9"]) {
    assert.ok(!style.includes(oldGreen), oldGreen);
  }
});

test("cloud workspace bridge is narrow, origin-bound, and customer-neutral", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const cloudPreload = await readFile(path.join(ROOT, "electron", "cloud-preload.cjs"), "utf8");
  for (const api of [
    "getInfo",
    "getPreferences",
    "updatePreferences",
    "onPreferencesChange",
    "checkUpdate",
    "switchAccount",
  ]) {
    assert.ok(cloudPreload.includes(api), api);
  }
  for (const prohibited of ["node:fs", "node:child_process", "shell", "password", "token"]) {
    assert.ok(!cloudPreload.includes(prohibited), prohibited);
  }
  assert.match(main, /workspaceState\.mode === "cloud"/);
  assert.match(main, /event\.sender === workspaceView\?\.webContents/);
  assert.match(main, /event\.senderFrame === event\.sender\.mainFrame/);
  assert.match(main, /senderUrl\.origin === workspaceState\.applicationOrigin/);
  assert.match(main, /preload: path\.join\(__dirname, "cloud-preload\.cjs"\)/);
  assert.match(main, /schemaVersion: "bizhub\.desktop-cloud-info\.v1"/);
  assert.ok(!cloudPreload.includes("daz" + "heng"));
  assert.ok(!cloudPreload.includes("123" + "crystal"));
});

test("desktop preferences remain bounded and gate only shell lifecycle behavior", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const preferences = await readFile(path.join(ROOT, "electron", "preferences.cjs"), "utf8");
  const localPreload = await readFile(path.join(ROOT, "electron", "local-preload.cjs"), "utf8");
  const shellPreload = await readFile(path.join(ROOT, "electron", "preload.cjs"), "utf8");
  for (const value of [
    'theme: "system"',
    'density: "standard"',
    "zoomPercent: 100",
    'closeBehavior: "background"',
    "launchAtLogin: false",
    "automaticUpdates: true",
  ]) assert.ok(preferences.includes(value), value);
  assert.match(main, /desktopPreferences\.zoomPercent \/ 100/);
  assert.match(main, /app\.setLoginItemSettings\(\{ openAtLogin: desktopPreferences\.launchAtLogin \}\)/);
  assert.match(main, /!autoUpdateSuppressed\(\) && desktopPreferences\.automaticUpdates/);
  for (const preload of [localPreload, shellPreload]) {
    assert.ok(preload.includes("getPreferences"));
    assert.ok(preload.includes("updatePreferences"));
    assert.ok(preload.includes("onPreferencesChange"));
    assert.ok(!preload.includes("node:fs"));
  }
  for (const prohibited of ["Owner", "migration", "sqlite", "password", "token"]) {
    assert.ok(!preferences.toLocaleLowerCase().includes(prohibited.toLocaleLowerCase()), prohibited);
  }
});

test("desktop package keeps Node runtime empty and cloud trust public-only", async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies, undefined);
  const trustStore = JSON.parse(
    await readFile(path.join(ROOT, "config", "trusted-connection-keys.json"), "utf8"),
  );
  assert.equal(trustStore.keys.length, 1);
  assert.equal(trustStore.keys[0].algorithm, "Ed25519");
  assert.match(trustStore.keys[0].public_key_pem, /^-----BEGIN PUBLIC KEY-----/);
  assert.ok(!trustStore.keys[0].public_key_pem.includes("PRIVATE KEY"));
  const runtimeTrust = JSON.parse(
    await readFile(path.join(ROOT, "config", "generic-runtime-trust.json"), "utf8"),
  );
  assert.equal(runtimeTrust.profile_id, "generic-kernel-smoke");
  assert.equal(runtimeTrust.platform, "darwin");
  assert.equal(runtimeTrust.architecture, "arm64");
  assert.match(runtimeTrust.runtime_manifest_sha256, /^[0-9a-f]{64}$/);
  assert.match(runtimeTrust.runtime_pack_tree_digest, /^[0-9a-f]{64}$/);
  assert.ok(runtimeTrust.runtime_pack_file_count > 0);
  assert.ok(mainTrustSelection(await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8")));
  const updateChannel = JSON.parse(
    await readFile(path.join(ROOT, "config", "update-channel.json"), "utf8"),
  );
  assert.equal(updateChannel.schema_version, "bizhub.desktop-update-channel.v1");
  assert.equal(
    updateChannel.artifact_fallback_base_url,
    "https://qilinshuzhi.com/bizhub-updates/releases/",
  );
  assert.equal("primary_manifest_url" in updateChannel, false);
  assert.equal(updateChannel.release_api_url.startsWith("https://api.github.com/"), true);
  assert.ok(!JSON.stringify(updateChannel).includes("123" + "crystal"));
});

test("Descriptor expiry gates each cloud open without expiring the connected Session", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  assert.match(
    main,
    /validateConnectionEnvelope\(workspace\.envelope, options\);\s+await stopLocalMode\(\);\s+await openWorkspace/,
  );
  assert.ok(!main.includes("scheduleWorkspaceExpiry"));
  assert.ok(!main.includes("workspaceExpiryTimer"));
  assert.ok(!main.includes("desktop_connection_profile_expired"));
});

test("local bootstrap requires a fresh explicit directory not-found result", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const start = main.indexOf("async function setupLocalInstance");
  const end = main.indexOf("async function authenticateLocal", start);
  assert.ok(start >= 0 && end > start);
  const setup = main.slice(start, end);
  const resolve = setup.indexOf("await resolveAccountWorkspaces");
  const notFound = setup.indexOf('directoryResult.status !== "not_found"');
  const bootstrap = setup.indexOf("await bootstrapLocalInstance");
  assert.ok(resolve >= 0 && notFound > resolve && bootstrap > notFound);
  assert.equal((setup.match(/assertLocalInstanceAbsent\(\)/g) || []).length, 2);
  assert.ok(setup.includes("desktop_local_creation_cloud_account_exists"));
  assert.ok(setup.includes("desktop_local_creation_account_registered"));
  assert.ok(!setup.includes("activeEnterpriseProfiles"));
});

test("guest demo is an isolated disposable instance and never weakens local account lookup", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const start = main.indexOf("async function openGuestDemo");
  const end = main.indexOf("async function prepareLocalLogin", start);
  assert.ok(start >= 0 && end > start);
  const guest = main.slice(start, end);
  assert.ok(guest.includes("userDataRoot: guestDemoRoot()"));
  assert.ok(guest.includes("await seedGuestDemo(runtime, fetchRuntime)"));
  assert.ok(guest.includes('localRuntimeKind = "guest"'));
  assert.ok(!guest.includes("resolveAccountWorkspaces"));
  assert.ok(!guest.includes("saveDesktopAccount"));
  assert.match(main, /await rm\(guestDemoRoot\(\), \{ recursive: true, force: true \}\)/);
  assert.match(main, /settingsButton\.dataset\.page = "settings"/);
  assert.match(main, /nav button\[data-page=\\"settings\\"\]/);
  assert.doesNotMatch(main, /nav button:last-child/);
});

test("guest local bridge cannot change device preferences", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  assert.match(
    main,
    /ipcMain\.handle\("desktop:local-update-preferences"[\s\S]+workspaceState\.mode === "guest"[\s\S]+desktop_guest_demo_preferences_not_available[\s\S]+updateDesktopPreferences\(patch\)/,
  );
});

test("Windows local-shell cleanup retries locked profiles without skipping process evidence", async () => {
  const smoke = await readFile(path.join(ROOT, "scripts", "local-shell-smoke.mjs"), "utf8");
  assert.match(smoke, /maxRetries: process\.platform === "win32" \? 10 : 0/);
  assert.match(smoke, /retryDelay: 200/);
  assert.match(smoke, /residual_runtime_processes: 0/);
  assert.match(smoke, /await stopDesktop\(\);\s+await rm\(temporaryRoot/);

  const accountFlow = await readFile(path.join(ROOT, "scripts", "account-flow-smoke.mjs"), "utf8");
  assert.match(accountFlow, /maxRetries: process\.platform === "win32" \? 10 : 0/);
  assert.match(accountFlow, /retryDelay: 200/);
  assert.match(accountFlow, /await stopDesktopProcess\(\);[\s\S]+await rm\(temporaryRoot/);
});

test("account-flow local submission does not depend on foreground animation frames", async () => {
  const smoke = await readFile(path.join(ROOT, "scripts", "account-flow-smoke.mjs"), "utf8");
  assert.ok(!smoke.includes("requestAnimationFrame"));
  assert.match(smoke, /await new Promise\(\(resolve\) => setTimeout\(resolve, 0\)\)/);
});

function mainTrustSelection(main) {
  return main.includes("generic-runtime-trust.win32-x64.json")
    && main.includes("generic-runtime-trust.json");
}

test("local Runtime lifecycle is isolated behind bounded main-process IPC", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const preload = await readFile(path.join(ROOT, "electron", "preload.cjs"), "utf8");
  const cloudPreload = await readFile(path.join(ROOT, "electron", "cloud-preload.cjs"), "utf8");
  const localPreload = await readFile(path.join(ROOT, "electron", "local-preload.cjs"), "utf8");
  const localRuntime = await readFile(path.join(ROOT, "electron", "local-runtime.cjs"), "utf8");
  const localLifecycle = await readFile(path.join(ROOT, "electron", "local-lifecycle.cjs"), "utf8");
  for (const required of [
    "bootstrapLocalInstance",
    "startLocalRuntime",
    "stopLocalRuntime",
    "resumeLocalRuntime",
    "changeLocalPasswordRuntime",
    "loadLocalAdminIdentity",
    "backupLocalInstance",
    "BIZHUB_DESKTOP_PARENT_PID",
    "127.0.0.1",
    "recoverInterruptedLocalSetup",
    "createLocalRuntimeLifecycle",
    "handleSquirrelStartup",
    "checkForUpdate",
    "downloadUpdateArtifact",
  ]) {
    assert.ok(`${main}\n${localRuntime}\n${localLifecycle}`.includes(required), required);
  }
  for (const api of [
    "lookupAccount",
    "loginAccount",
    "resumeAccount",
    "switchAccount",
    "loginEnterprise",
    "forgetRememberedLogin",
    "resetAccountLookup",
    "connectEnterpriseWorkspace",
    "openGuestDemo",
    "setupLocal",
    "loginLocal",
    "backupLocal",
    "stopLocal",
    "checkUpdate",
    "downloadUpdate",
    "installUpdate",
  ]) {
    assert.ok(preload.includes(api), api);
  }
  assert.ok(!preload.includes("node:child_process"));
  assert.ok(!preload.includes("node:fs"));
  for (const api of ["getInfo", "checkUpdate", "switchAccount"]) {
    assert.ok(cloudPreload.includes(api), api);
  }
  assert.ok(!cloudPreload.includes("node:child_process"));
  assert.ok(!cloudPreload.includes("node:fs"));
  for (const api of ["getSettings", "createBackup", "openBackupFolder", "changePassword", "switchAccount", "forgetAccount"]) {
    assert.ok(localPreload.includes(api), api);
  }
  assert.ok(!localPreload.includes("node:child_process"));
  assert.ok(!localPreload.includes("node:fs"));
  const squirrelStartup = await readFile(path.join(ROOT, "electron", "squirrel-startup.cjs"), "utf8");
  assert.ok(squirrelStartup.includes("--squirrel-install"));
  assert.ok(squirrelStartup.includes("--squirrel-uninstall"));
});

test("the shared Runtime frontend builder resolves npm correctly on Windows", async () => {
  const builder = await readFile(
    path.resolve(ROOT, "runtime", "build_local_runtime.py"),
    "utf8",
  );
  assert.match(builder, /npm_name = "npm\.cmd" if os\.name == "nt" else "npm"/);
  assert.match(builder, /npm = shutil\.which\(npm_name\)/);
  assert.ok(!builder.includes('["npm", "run", "build"]'));
});
