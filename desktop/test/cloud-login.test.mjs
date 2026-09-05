import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  cloudLoginError,
  cloudLoginScript,
  cloudLogoutScript,
  isCloudLogoutRequest,
  sessionStorageScript,
  validateCloudLoginInput,
} = require("../electron/cloud-login.cjs");
const {
  clearRememberedSession,
  legacySavedAccountsFilePath,
  legacyCredentialFilePath,
  loadRememberedSession,
  loadSavedAccounts,
  rememberedSessionFilePath,
  saveAccount,
  savedAccountsFilePath,
  saveRememberedSession,
  tokenExpiresAt,
  validateRememberedSession,
} = require("../electron/credential-store.cjs");

const SAFE_STORAGE = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`safe-storage:${value}`, "utf8"),
  decryptString: (value) => {
    const plaintext = Buffer.from(value).toString("utf8");
    if (!plaintext.startsWith("safe-storage:")) throw new Error("synthetic_decryption_failed");
    return plaintext.slice("safe-storage:".length);
  },
};

const UNAVAILABLE_SAFE_STORAGE = {
  isEncryptionAvailable: () => false,
  encryptString: () => { throw new Error("synthetic_encryption_must_not_run"); },
  decryptString: () => { throw new Error("synthetic_decryption_must_not_run"); },
};

function storeOptions(userDataRoot, safeStorage = SAFE_STORAGE) {
  return { safeStorage, userDataRoot };
}

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

test("only the formal POST logout endpoint in an allowed Workspace ends Desktop login", () => {
  const allowedOrigins = ["https://workspace.example.com"];
  assert.equal(isCloudLogoutRequest({
    method: "POST",
    url: "https://workspace.example.com/api/auth/logout",
  }, allowedOrigins), true);
  assert.equal(isCloudLogoutRequest({
    method: "POST",
    url: "https://workspace.example.com/api/auth/logout?source=desktop",
  }, allowedOrigins), true);
  assert.equal(isCloudLogoutRequest({
    method: "GET",
    url: "https://workspace.example.com/api/auth/logout",
  }, allowedOrigins), false);
  assert.equal(isCloudLogoutRequest({
    method: "POST",
    url: "https://workspace.example.com/api/auth/logout/other",
  }, allowedOrigins), false);
  assert.equal(isCloudLogoutRequest({
    method: "POST",
    url: "https://untrusted.example.com/api/auth/logout",
  }, allowedOrigins), false);
});

test("remembered session stores no password and can be forgotten", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-remembered-session-"));
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const remembered = rememberedFixture(expiresAt);
  try {
    await writeFile(legacyCredentialFilePath(root), "legacy-password-ciphertext\n");
    await saveRememberedSession({ remembered, ...storeOptions(root) });
    await saveRememberedSession({ remembered, ...storeOptions(root) });
    const raw = await readFile(savedAccountsFilePath(root), "utf8");
    assert.ok(raw.includes("demo.user"));
    assert.equal(raw.includes(remembered.session.token), false);
    assert.ok(raw.includes("bizhub.desktop-encrypted-session.v1"));
    assert.equal(raw.includes("correct cloud password"), false);
    assert.deepEqual(await loadRememberedSession(storeOptions(root)), remembered);
    if (process.platform !== "win32") {
      assert.equal((await stat(savedAccountsFilePath(root))).mode & 0o777, 0o600);
    }
    await assert.rejects(stat(legacyCredentialFilePath(root)), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), [path.basename(savedAccountsFilePath(root))]);
    await clearRememberedSession(storeOptions(root));
    await assert.rejects(stat(savedAccountsFilePath(root)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy cloud session migrates once and local/cloud accounts coexist without passwords", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-saved-accounts-"));
  const now = Date.now();
  const remembered = rememberedFixture(Math.floor(now / 1000) + 3600);
  const localPayload = {
    auth_version: 1,
    expires_at: Math.floor(now / 1000) + 7200,
    purpose: "remember",
    username: "local.admin",
  };
  const localToken = `${Buffer.from(JSON.stringify(localPayload)).toString("base64url")}.${"a".repeat(64)}`;
  try {
    await writeFile(rememberedSessionFilePath(root), `${JSON.stringify({
      schema_version: "bizhub.desktop-remembered-session.v1",
      ...remembered,
    })}\n`);
    const migrated = await loadSavedAccounts({ ...storeOptions(root), now });
    assert.equal(migrated.accounts.length, 1);
    assert.equal(migrated.accounts[0].mode, "cloud");
    await assert.rejects(stat(rememberedSessionFilePath(root)), { code: "ENOENT" });

    await saveAccount({
      account: {
        accountId: "local.admin",
        displayName: "Local Admin",
        mode: "local",
        savedAt: new Date(now).toISOString(),
        session: {
          authVersion: 1,
          expiresAt: localPayload.expires_at * 1000,
          token: localToken,
          username: "local.admin",
        },
      },
      ...storeOptions(root),
    });
    const saved = await loadSavedAccounts({ ...storeOptions(root), now });
    assert.deepEqual(saved.accounts.map((item) => item.mode).sort(), ["cloud", "local"]);
    const raw = await readFile(savedAccountsFilePath(root), "utf8");
    assert.equal(raw.includes("password"), false);
    assert.equal(raw.includes(localToken), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saved-accounts.v2 plaintext sessions migrate once into encrypted v3 storage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-saved-accounts-v2-"));
  const now = Date.now();
  const remembered = rememberedFixture(Math.floor(now / 1000) + 3600);
  try {
    await writeFile(legacySavedAccountsFilePath(root), `${JSON.stringify({
      schema_version: "bizhub.desktop-saved-accounts.v2",
      activeAccountId: remembered.accountId,
      accounts: [{
        accountId: remembered.accountId,
        displayName: remembered.session.accountName,
        mode: "cloud",
        savedAt: new Date(now).toISOString(),
        session: remembered.session,
      }],
    })}\n`);

    const migrated = await loadSavedAccounts({ ...storeOptions(root), now });
    assert.equal(migrated.activeAccountId, remembered.accountId);
    assert.deepEqual(migrated.accounts[0].session, remembered.session);
    const raw = await readFile(savedAccountsFilePath(root), "utf8");
    assert.ok(raw.includes("bizhub.desktop-saved-accounts.v3"));
    assert.equal(raw.includes(remembered.session.token), false);
    await assert.rejects(stat(legacySavedAccountsFilePath(root)), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), [path.basename(savedAccountsFilePath(root))]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unavailable safeStorage retains account metadata without persisting a session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-safe-storage-unavailable-"));
  const now = Date.now();
  const remembered = rememberedFixture(Math.floor(now / 1000) + 3600);
  try {
    const saved = await saveAccount({
      account: {
        accountId: remembered.accountId,
        displayName: remembered.session.accountName,
        mode: "cloud",
        savedAt: new Date(now).toISOString(),
        session: remembered.session,
      },
      ...storeOptions(root, UNAVAILABLE_SAFE_STORAGE),
    });
    assert.equal(saved.accounts[0].displayName, remembered.session.accountName);
    assert.equal(saved.accounts[0].session, null);
    const raw = await readFile(savedAccountsFilePath(root), "utf8");
    assert.ok(raw.includes(remembered.accountId));
    assert.equal(raw.includes(remembered.session.token), false);
    assert.equal(JSON.parse(raw).accounts[0].session, null);
    assert.deepEqual(
      await loadSavedAccounts({ ...storeOptions(root, UNAVAILABLE_SAFE_STORAGE), now }),
      saved,
    );
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

test('superseded credential persistence leaves the previous account file intact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bizhub-stale-login-'));
  try {
    const account = { accountId: 'current.user', displayName: 'Current', mode: 'cloud', savedAt: new Date().toISOString(), session: null };
    await saveAccount({ account, ...storeOptions(root) });
    const before = await readFile(savedAccountsFilePath(root));
    let checks = 0;
    await assert.rejects(saveAccount({
      account: { ...account, accountId: 'stale.user' },
      ...storeOptions(root),
      isCurrent: () => ++checks < 2,
    }), /desktop_login_superseded/);
    assert.deepEqual(await readFile(savedAccountsFilePath(root)), before);
    assert.deepEqual(await readdir(root), [path.basename(savedAccountsFilePath(root))]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
