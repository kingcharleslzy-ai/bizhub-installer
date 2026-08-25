import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  localRequestAllowed,
  normalizeLocalOrigin,
  remoteRequestAllowed,
} = require("../electron/network-policy.cjs");

const allowed = ["https://workspace.example", "https://api.example"];

test("allows only signed HTTPS origins and their secure websocket origin", () => {
  assert.equal(remoteRequestAllowed("https://workspace.example/app", allowed), true);
  assert.equal(remoteRequestAllowed("https://api.example/v1/health", allowed), true);
  assert.equal(remoteRequestAllowed("wss://api.example/events", allowed), true);
  assert.equal(remoteRequestAllowed("https://cdn.example/app.js", allowed), false);
  assert.equal(remoteRequestAllowed("ws://api.example/events", allowed), false);
  assert.equal(remoteRequestAllowed("http://workspace.example/app", allowed), false);
});

test("allows inert data URLs and bounded blob URLs but rejects privileged schemes", () => {
  assert.equal(remoteRequestAllowed("data:image/png;base64,AA==", allowed), true);
  assert.equal(remoteRequestAllowed("blob:https://workspace.example/id", allowed), true);
  assert.equal(remoteRequestAllowed("blob:https://other.example/id", allowed), false);
  assert.equal(remoteRequestAllowed("file:///tmp/private", allowed), false);
  assert.equal(remoteRequestAllowed("javascript:alert(1)", allowed), false);
  assert.equal(remoteRequestAllowed("not a url", allowed), false);
});

test("allows only the exact random 127.0.0.1 Runtime origin", () => {
  const origin = "http://127.0.0.1:43123";
  assert.equal(normalizeLocalOrigin(`${origin}/api/health`), origin);
  assert.equal(localRequestAllowed(`${origin}/api/health`, origin), true);
  assert.equal(localRequestAllowed(`${origin}/assets/app.js`, origin), true);
  assert.equal(localRequestAllowed(`blob:${origin}/asset`, origin), true);
  for (const rejected of [
    "http://127.0.0.1:43124/api/health",
    "http://localhost:43123/api/health",
    "http://0.0.0.0:43123/api/health",
    "https://127.0.0.1:43123/api/health",
    "file:///tmp/bizhub.sqlite",
    "javascript:alert(1)",
  ]) {
    assert.equal(localRequestAllowed(rejected, origin), false, rejected);
  }
});
