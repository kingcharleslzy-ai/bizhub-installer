import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  cloudLoginError,
  cloudLoginScript,
  cloudLogoutScript,
  sessionStorageScript,
  validateCloudLoginInput,
} = require("../electron/cloud-login.cjs");
const {
  clearRememberedSession,
  legacyCredentialFilePath,
  loadRememberedSession,
  rememberedSessionFilePath,
  saveRememberedSession,
  tokenExpiresAt,
  validateRememberedSession,
} = require("../electron/credential-store.cjs");

function jwtWithExpiry(expiresAtSeconds) {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp: expiresAtSeconds, sub: "dashboard-operator" }))
      .toString("base64url"),
    "synthetic-signature",
  ].join(".");
}

function rememberedFixture(expiresAtSeconds) {
  return {
    accountId: "demo.user",
    session: {
      accessProfileVersion: 1,
      accountName: "Demo",
      permissions: ["dashboard.read"],
      roles: ["admin"],
      token: jwtWithExpiry(expiresAtSeconds),
    },
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

test("cloud scripts route the password once and resume only from a token", () => {
  const loginScript = cloudLoginScript("correct cloud password");
  assert.ok(loginScript.includes("/api/auth/login"));
  assert.ok(loginScript.includes("window.location.origin"));
  assert.ok(loginScript.includes("bizhub_access_profile"));
  assert.ok(loginScript.includes("localStorage.setItem(\"token\""));
  assert.equal(loginScript.includes("correct cloud password"), false);
  assert.equal(loginScript.includes("account-directory"), false);
  assert.equal(cloudLoginError({ ok: true, status: 200 }), null);
  assert.equal(cloudLoginError({ ok: false, status: 401 }), "desktop_cloud_login_invalid");
  assert.equal(cloudLoginError({ ok: false, status: 429 }), "desktop_cloud_login_rate_limited");

  const fixture = rememberedFixture(Math.floor(Date.now() / 1000) + 3600);
  const resumeScript = sessionStorageScript(fixture.session);
  assert.ok(resumeScript.includes("localStorage.setItem(\"token\""));
  assert.equal(resumeScript.includes("password"), false);
  const logoutScript = cloudLogoutScript();
  assert.ok(logoutScript.includes("/api/auth/logout"));
  assert.ok(logoutScript.includes("Authorization"));
  assert.ok(logoutScript.includes("localStorage.removeItem(\"token\")"));
});

test("remembered session stores no password and can be forgotten", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-remembered-session-"));
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const remembered = rememberedFixture(expiresAt);
  try {
    await writeFile(legacyCredentialFilePath(root), "legacy-password-ciphertext\n");
    await saveRememberedSession({ remembered, userDataRoot: root });
    const raw = await readFile(rememberedSessionFilePath(root), "utf8");
    assert.ok(raw.includes("demo.user"));
    assert.ok(raw.includes(remembered.session.token));
    assert.equal(raw.includes("correct cloud password"), false);
    assert.deepEqual(await loadRememberedSession({ userDataRoot: root }), remembered);
    if (process.platform !== "win32") {
      assert.equal((await stat(rememberedSessionFilePath(root))).mode & 0o777, 0o600);
    }
    await assert.rejects(stat(legacyCredentialFilePath(root)), { code: "ENOENT" });
    await clearRememberedSession({ userDataRoot: root });
    await assert.rejects(stat(rememberedSessionFilePath(root)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired or malformed remembered tokens fail closed", () => {
  const now = Date.now();
  const active = rememberedFixture(Math.floor(now / 1000) + 3600);
  assert.equal(tokenExpiresAt(active.session.token), (Math.floor(now / 1000) + 3600) * 1000);
  assert.deepEqual(validateRememberedSession(active, { now }), active);

  const expired = rememberedFixture(Math.floor(now / 1000) - 1);
  assert.throws(
    () => validateRememberedSession(expired, { now }),
    /desktop_remembered_session_expired/,
  );
  assert.throws(
    () => validateRememberedSession({
      ...active,
      session: { ...active.session, token: "not-a-jwt" },
    }, { now }),
    /desktop_remembered_session_invalid/,
  );
});
