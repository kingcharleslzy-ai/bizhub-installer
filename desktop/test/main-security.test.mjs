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
    "safeStorage",
  ]) {
    assert.ok(!main.includes(prohibited), prohibited);
  }
});

test("connected cloud and local workspaces replace the Desktop chrome", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const shell = await readFile(path.join(ROOT, "shell-frontend", "src", "App.vue"), "utf8");
  assert.match(
    main,
    /workspaceState\.status === "connected"\s+\? \(process\.platform === "darwin" && workspaceState\.mode === "local" \? 30 : 0\)\s+: HEADER_HEIGHT/,
  );
  assert.match(main, /if \(authenticationPending\) return;[\s\S]*workspaceView\.setVisible\(true\)/);
  assert.ok(shell.includes('v-if="!connected" class="shell-bar"'));
  assert.ok(shell.includes("state.platform === 'darwin'"));
  assert.ok(!shell.includes("退出并清除保持登录"));
});

test("cloud workspace bridge is narrow, origin-bound, and customer-neutral", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const cloudPreload = await readFile(path.join(ROOT, "electron", "cloud-preload.cjs"), "utf8");
  for (const api of ["getInfo", "checkUpdate", "switchAccount"]) {
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
