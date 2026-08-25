import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("remote content uses the hardened WebContentsView boundary", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
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
    "persist:workspace-",
  ]) {
    assert.ok(main.includes(required), required);
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
  ]) {
    assert.ok(!main.includes(prohibited), prohibited);
  }
});

test("desktop package keeps Node runtime empty and cloud trust empty", async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies, undefined);
  const trustStore = JSON.parse(
    await readFile(path.join(ROOT, "config", "trusted-connection-keys.json"), "utf8"),
  );
  assert.deepEqual(trustStore.keys, []);
  const runtimeTrust = JSON.parse(
    await readFile(path.join(ROOT, "config", "generic-runtime-trust.json"), "utf8"),
  );
  assert.equal(runtimeTrust.profile_id, "generic-kernel-smoke");
  assert.equal(runtimeTrust.platform, "darwin");
  assert.equal(runtimeTrust.architecture, "arm64");
});

test("local Runtime lifecycle is isolated behind bounded main-process IPC", async () => {
  const main = await readFile(path.join(ROOT, "electron", "main.cjs"), "utf8");
  const preload = await readFile(path.join(ROOT, "electron", "preload.cjs"), "utf8");
  const localRuntime = await readFile(path.join(ROOT, "electron", "local-runtime.cjs"), "utf8");
  for (const required of [
    "bootstrapLocalInstance",
    "startLocalRuntime",
    "stopLocalRuntime",
    "backupLocalInstance",
    "BIZHUB_DESKTOP_PARENT_PID",
    "127.0.0.1",
  ]) {
    assert.ok(`${main}\n${localRuntime}`.includes(required), required);
  }
  for (const api of ["setupLocal", "loginLocal", "backupLocal", "stopLocal"]) {
    assert.ok(preload.includes(api), api);
  }
  assert.ok(!preload.includes("node:child_process"));
  assert.ok(!preload.includes("node:fs"));
});
