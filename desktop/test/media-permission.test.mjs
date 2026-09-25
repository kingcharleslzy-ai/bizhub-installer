import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { mediaPermissionAllowed, permissionOrigin } = require("../electron/media-permission.cjs");

const allowedOrigins = ["https://tenant.example.com", "http://127.0.0.1:43123"];
const audio = (overrides = {}) => mediaPermissionAllowed({
  permission: "media",
  mediaTypes: ["audio"],
  requestingOrigin: "https://tenant.example.com",
  allowedOrigins,
  ...overrides,
});

test("audio capture is allowed only for an allowed business origin", () => {
  assert.equal(audio(), true);
  assert.equal(audio({ requestingOrigin: "http://127.0.0.1:43123" }), true);
  assert.equal(audio({ requestingOrigin: "https://evil.example.com" }), false);
  assert.equal(audio({ requestingOrigin: "http://127.0.0.1:9999" }), false);
  assert.equal(audio({ requestingOrigin: "" }), false);
  assert.equal(audio({ allowedOrigins: [] }), false);
  assert.equal(audio({ allowedOrigins: undefined }), false);
});

test("video, mixed, or unspecified media types stay denied", () => {
  assert.equal(audio({ mediaTypes: ["video"] }), false);
  assert.equal(audio({ mediaTypes: ["audio", "video"] }), false);
  assert.equal(audio({ mediaTypes: ["video", "audio"] }), false);
  assert.equal(audio({ mediaTypes: [] }), false);
  assert.equal(audio({ mediaTypes: ["unknown"] }), false);
  assert.equal(audio({ mediaTypes: undefined }), false);
});

test("every non-media permission stays denied even for allowed origins", () => {
  for (const permission of [
    "geolocation",
    "notifications",
    "clipboard-read",
    "clipboard-sanitized-write",
    "display-capture",
    "fullscreen",
    "midi",
    "openExternal",
    "pointerLock",
    "usb",
  ]) {
    assert.equal(audio({ permission }), false, permission);
  }
  assert.equal(mediaPermissionAllowed(), false);
});

test("permission origins are normalized from Electron URLs", () => {
  assert.equal(permissionOrigin("https://tenant.example.com/"), "https://tenant.example.com");
  assert.equal(permissionOrigin("https://tenant.example.com/app?x=1"), "https://tenant.example.com");
  assert.equal(permissionOrigin("http://127.0.0.1:43123/app"), "http://127.0.0.1:43123");
  assert.equal(permissionOrigin(undefined), "");
  assert.equal(permissionOrigin("not a url"), "");
});

test("macOS packaging declares microphone usage and hardened-runtime audio entitlement", async () => {
  const forge = await readFile(path.join(ROOT, "forge.config.cjs"), "utf8");
  assert.match(forge, /NSMicrophoneUsageDescription: "BizHub 桌面端在总监助手按住说话时使用麦克风。"/);
  for (const name of ["entitlements.macos.plist", "entitlements.macos.synthetic-app.plist"]) {
    const plist = await readFile(path.join(ROOT, "config", name), "utf8");
    assert.match(plist, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/, name);
    assert.doesNotMatch(plist, /com\.apple\.security\.device\.camera/, name);
  }
});
