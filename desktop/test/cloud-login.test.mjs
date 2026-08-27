import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  cloudLoginError,
  cloudLoginScript,
  cloudLogoutScript,
  validateCloudLoginInput,
} = require("../electron/cloud-login.cjs");
const {
  clearRememberedLogin,
  credentialFilePath,
  loadRememberedLogin,
  saveRememberedLogin,
} = require("../electron/credential-store.cjs");

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
  };
}

test("cloud login accepts one exact account-password form and rejects extra fields", () => {
  assert.deepEqual(validateCloudLoginInput({
    accountId: "demo.user",
    password: "correct cloud password",
    remember: true,
  }), {
    accountId: "demo.user",
    password: "correct cloud password",
    remember: true,
  });
  assert.throws(() => validateCloudLoginInput({
    accountId: "demo.user",
    password: "correct cloud password",
  }), /desktop_cloud_login_shape_invalid/);
  assert.throws(() => validateCloudLoginInput({
    accountId: "demo.user",
    password: "correct cloud password",
    remember: true,
    connectionId: "private-workspace",
  }), /desktop_cloud_login_shape_invalid/);
});

test("cloud login script sends the password only to the Workspace auth route", () => {
  const script = cloudLoginScript("correct cloud password");
  assert.ok(script.includes("/api/auth/login"));
  assert.ok(script.includes("window.location.origin"));
  assert.ok(script.includes("bizhub_access_profile"));
  assert.ok(script.includes("localStorage.setItem(\"token\""));
  assert.equal(script.includes("correct cloud password"), false);
  assert.equal(script.includes("account-directory"), false);
  assert.equal(cloudLoginError({ ok: true, status: 200 }), null);
  assert.equal(cloudLoginError({ ok: false, status: 401 }), "desktop_cloud_login_invalid");
  assert.equal(cloudLoginError({ ok: false, status: 429 }), "desktop_cloud_login_rate_limited");
  assert.ok(cloudLogoutScript().includes("/api/auth/logout"));
  assert.ok(cloudLogoutScript().includes('method: "POST"'));
});

test("remembered login is encrypted at rest and can be forgotten", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-remembered-login-"));
  const safeStorage = fakeSafeStorage();
  try {
    await saveRememberedLogin({
      credential: { accountId: " Demo.User ", password: "correct cloud password" },
      safeStorage,
      userDataRoot: root,
    });
    const raw = await readFile(credentialFilePath(root), "utf8");
    assert.equal(raw.includes("demo.user"), false);
    assert.equal(raw.includes("correct cloud password"), false);
    assert.deepEqual(await loadRememberedLogin({ safeStorage, userDataRoot: root }), {
      accountId: "demo.user",
      password: "correct cloud password",
    });
    await clearRememberedLogin({ userDataRoot: root });
    await assert.rejects(stat(credentialFilePath(root)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remembering fails closed when OS encryption is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-remembered-login-unavailable-"));
  try {
    await assert.rejects(saveRememberedLogin({
      credential: { accountId: "demo.user", password: "correct cloud password" },
      safeStorage: { isEncryptionAvailable: () => false },
      userDataRoot: root,
    }), /desktop_secure_storage_unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
