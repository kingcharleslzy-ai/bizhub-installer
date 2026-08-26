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
  assert.equal(runtimeTrust.runtime_pack_file_count, 126);
  assert.ok(mainTrustSelection(await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8")));
});

function mainTrustSelection(main) {
  return main.includes("generic-runtime-trust.win32-x64.json")
    && main.includes("generic-runtime-trust.json");
}

test("local Runtime lifecycle is isolated behind bounded main-process IPC", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const preload = await readFile(path.join(ROOT, "electron", "preload.cjs"), "utf8");
  const localRuntime = await readFile(path.join(ROOT, "electron", "local-runtime.cjs"), "utf8");
  const localLifecycle = await readFile(path.join(ROOT, "electron", "local-lifecycle.cjs"), "utf8");
  for (const required of [
    "bootstrapLocalInstance",
    "startLocalRuntime",
    "stopLocalRuntime",
    "backupLocalInstance",
    "BIZHUB_DESKTOP_PARENT_PID",
    "127.0.0.1",
    "recoverInterruptedLocalSetup",
    "createLocalRuntimeLifecycle",
    "handleSquirrelStartup",
  ]) {
    assert.ok(`${main}\n${localRuntime}\n${localLifecycle}`.includes(required), required);
  }
  for (const api of [
    "lookupAccount",
    "resetAccountLookup",
    "connectEnterpriseWorkspace",
    "setupLocal",
    "loginLocal",
    "backupLocal",
    "stopLocal",
  ]) {
    assert.ok(preload.includes(api), api);
  }
  assert.ok(!preload.includes("node:child_process"));
  assert.ok(!preload.includes("node:fs"));
  const squirrelStartup = await readFile(path.join(ROOT, "electron", "squirrel-startup.cjs"), "utf8");
  assert.ok(squirrelStartup.includes("--squirrel-install"));
  assert.ok(squirrelStartup.includes("--squirrel-uninstall"));
});
