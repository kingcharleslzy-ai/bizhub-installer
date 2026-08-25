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

test("desktop package has no runtime dependency or trusted key by default", async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.dependencies, undefined);
  const trustStore = JSON.parse(
    await readFile(path.join(ROOT, "config", "trusted-connection-keys.json"), "utf8"),
  );
  assert.deepEqual(trustStore.keys, []);
});
