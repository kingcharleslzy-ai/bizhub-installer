const { chmod, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { normalizeAccountId } = require("./account-directory.cjs");

const REMEMBERED_SESSION_SCHEMA = "bizhub.desktop-remembered-session.v1";
const REMEMBERED_SESSION_FILE_NAME = "remembered-session.v1.json";
const LEGACY_CREDENTIAL_FILE_NAME = "remembered-login.v1.json";
const SAVED_ACCOUNTS_SCHEMA = "bizhub.desktop-saved-accounts.v2";
const SAVED_ACCOUNTS_FILE_NAME = "saved-accounts.v2.json";
const MAX_SESSION_FILE_BYTES = 64 * 1024;
const MAX_SAVED_ACCOUNTS = 8;

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code);
}

function validateStringList(value, code) {
  if (
    !Array.isArray(value)
    || value.length > 128
    || value.some((item) => typeof item !== "string" || !item || item.length > 128)
  ) {
    fail(code);
  }
  return [...value];
}

function cloudTokenExpiresAt(token) {
  if (
    typeof token !== "string"
    || token.length < 20
    || token.length > 8192
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  ) {
    fail("desktop_remembered_session_invalid");
  }
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (!Number.isSafeInteger(payload.exp) || payload.exp < 1) {
      fail("desktop_remembered_session_invalid");
    }
    return payload.exp * 1000;
  } catch (error) {
    if (error instanceof Error && error.message === "desktop_remembered_session_invalid") {
      throw error;
    }
    fail("desktop_remembered_session_invalid");
  }
}

function localTokenPayload(token) {
  if (
    typeof token !== "string"
    || token.length < 40
    || token.length > 8192
    || !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(token)
  ) {
    fail("desktop_local_remembered_session_invalid");
  }
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    exactKeys(
      payload,
      ["auth_version", "expires_at", "purpose", "username"],
      "desktop_local_remembered_session_invalid",
    );
    if (
      payload.purpose !== "remember"
      || typeof payload.username !== "string"
      || !payload.username
      || payload.username.length > 80
      || !Number.isSafeInteger(payload.auth_version)
      || payload.auth_version < 1
      || !Number.isSafeInteger(payload.expires_at)
      || payload.expires_at < 1
    ) {
      fail("desktop_local_remembered_session_invalid");
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.message === "desktop_local_remembered_session_invalid") {
      throw error;
    }
    fail("desktop_local_remembered_session_invalid");
  }
}

function validateCloudSession(value, { now = Date.now(), allowExpired = false } = {}) {
  exactKeys(
    value,
    ["accessProfileVersion", "accountName", "permissions", "roles", "token"],
    "desktop_remembered_session_invalid",
  );
  const accountName = String(value.accountName || "").trim();
  if (!accountName || accountName.length > 128 || Number(value.accessProfileVersion) !== 1) {
    fail("desktop_remembered_session_invalid");
  }
  const token = String(value.token || "");
  if (!allowExpired && cloudTokenExpiresAt(token) <= now + 30_000) {
    fail("desktop_remembered_session_expired");
  }
  return {
    accessProfileVersion: 1,
    accountName,
    permissions: validateStringList(value.permissions, "desktop_remembered_session_invalid"),
    roles: validateStringList(value.roles, "desktop_remembered_session_invalid"),
    token,
  };
}

function validateLocalSession(value, { now = Date.now(), allowExpired = false } = {}) {
  exactKeys(
    value,
    ["authVersion", "expiresAt", "token", "username"],
    "desktop_local_remembered_session_invalid",
  );
  const payload = localTokenPayload(String(value.token || ""));
  const username = String(value.username || "").trim();
  const expiresAt = Number(value.expiresAt);
  const authVersion = Number(value.authVersion);
  if (
    username !== payload.username
    || expiresAt !== payload.expires_at * 1000
    || authVersion !== payload.auth_version
    || (!allowExpired && expiresAt <= now + 30_000)
  ) {
    fail(
      !allowExpired && expiresAt <= now + 30_000
        ? "desktop_local_remembered_session_expired"
        : "desktop_local_remembered_session_invalid",
    );
  }
  return { authVersion, expiresAt, token: String(value.token), username };
}

function validateRememberedSession(value, { now = Date.now() } = {}) {
  exactKeys(value, ["accountId", "session"], "desktop_remembered_session_invalid");
  return {
    accountId: normalizeAccountId(value.accountId),
    session: validateCloudSession(value.session, { now }),
  };
}

function validateSavedAccount(value, { now = Date.now() } = {}) {
  exactKeys(
    value,
    ["accountId", "displayName", "mode", "savedAt", "session"],
    "desktop_saved_account_invalid",
  );
  const accountId = normalizeAccountId(value.accountId);
  const displayName = String(value.displayName || "").trim();
  const savedAt = String(value.savedAt || "");
  if (
    !["cloud", "local"].includes(value.mode)
    || !displayName
    || displayName.length > 128
    || !Number.isFinite(Date.parse(savedAt))
  ) {
    fail("desktop_saved_account_invalid");
  }
  let session = null;
  if (value.session !== null) {
    try {
      session = value.mode === "cloud"
        ? validateCloudSession(value.session, { now })
        : validateLocalSession(value.session, { now });
    } catch (error) {
      if (
        error instanceof Error
        && [
          "desktop_remembered_session_expired",
          "desktop_local_remembered_session_expired",
        ].includes(error.message)
      ) {
        session = null;
      } else {
        throw error;
      }
    }
  }
  return { accountId, displayName, mode: value.mode, savedAt, session };
}

function emptySavedAccounts() {
  return { activeAccountId: null, accounts: [] };
}

function validateSavedAccounts(value, { now = Date.now() } = {}) {
  exactKeys(value, ["accounts", "activeAccountId"], "desktop_saved_accounts_invalid");
  if (!Array.isArray(value.accounts) || value.accounts.length > MAX_SAVED_ACCOUNTS) {
    fail("desktop_saved_accounts_invalid");
  }
  const accounts = value.accounts.map((item) => validateSavedAccount(item, { now }));
  const ids = accounts.map((item) => item.accountId);
  if (new Set(ids).size !== ids.length) fail("desktop_saved_accounts_invalid");
  const activeAccountId = value.activeAccountId === null
    ? null
    : normalizeAccountId(value.activeAccountId);
  if (activeAccountId !== null && !ids.includes(activeAccountId)) {
    fail("desktop_saved_accounts_invalid");
  }
  return { activeAccountId, accounts };
}

function rememberedSessionFilePath(userDataRoot) {
  return path.join(path.resolve(userDataRoot), REMEMBERED_SESSION_FILE_NAME);
}

function savedAccountsFilePath(userDataRoot) {
  return path.join(path.resolve(userDataRoot), SAVED_ACCOUNTS_FILE_NAME);
}

function legacyCredentialFilePath(userDataRoot) {
  return path.join(path.resolve(userDataRoot), LEGACY_CREDENTIAL_FILE_NAME);
}

async function clearLegacyCredential(userDataRoot) {
  await rm(legacyCredentialFilePath(userDataRoot), { force: true });
}

async function readJsonFile(filePath, missingValue) {
  let raw;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return missingValue;
    throw error;
  }
  if (raw.length < 2 || raw.length > MAX_SESSION_FILE_BYTES) {
    fail("desktop_saved_accounts_file_invalid");
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    fail("desktop_saved_accounts_file_invalid");
  }
}

async function writeSavedAccounts({ saved, userDataRoot }) {
  const normalized = validateSavedAccounts(saved);
  await mkdir(path.resolve(userDataRoot), { recursive: true, mode: 0o700 });
  const target = savedAccountsFilePath(userDataRoot);
  await writeFile(target, `${JSON.stringify({
    schema_version: SAVED_ACCOUNTS_SCHEMA,
    activeAccountId: normalized.activeAccountId,
    accounts: normalized.accounts,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
  return normalized;
}

async function migrateRememberedSession(userDataRoot, now) {
  const legacy = await readJsonFile(rememberedSessionFilePath(userDataRoot), null);
  if (!legacy) return emptySavedAccounts();
  try {
    exactKeys(
      legacy,
      ["accountId", "schema_version", "session"],
      "desktop_remembered_session_file_invalid",
    );
    if (legacy.schema_version !== REMEMBERED_SESSION_SCHEMA) {
      fail("desktop_remembered_session_file_invalid");
    }
    const remembered = validateRememberedSession({
      accountId: legacy.accountId,
      session: legacy.session,
    }, { now });
    return {
      activeAccountId: remembered.accountId,
      accounts: [{
        accountId: remembered.accountId,
        displayName: remembered.session.accountName,
        mode: "cloud",
        savedAt: new Date(now).toISOString(),
        session: remembered.session,
      }],
    };
  } catch {
    return emptySavedAccounts();
  } finally {
    await rm(rememberedSessionFilePath(userDataRoot), { force: true });
  }
}

async function loadSavedAccounts({ userDataRoot, now = Date.now() }) {
  await clearLegacyCredential(userDataRoot);
  const envelope = await readJsonFile(savedAccountsFilePath(userDataRoot), null);
  if (!envelope) {
    const migrated = await migrateRememberedSession(userDataRoot, now);
    if (migrated.accounts.length) await writeSavedAccounts({ saved: migrated, userDataRoot });
    return migrated;
  }
  exactKeys(
    envelope,
    ["accounts", "activeAccountId", "schema_version"],
    "desktop_saved_accounts_file_invalid",
  );
  if (envelope.schema_version !== SAVED_ACCOUNTS_SCHEMA) {
    fail("desktop_saved_accounts_file_invalid");
  }
  return validateSavedAccounts({
    activeAccountId: envelope.activeAccountId,
    accounts: envelope.accounts,
  }, { now });
}

async function saveAccount({ account, makeActive = true, userDataRoot }) {
  const normalized = validateSavedAccount(account);
  const current = await loadSavedAccounts({ userDataRoot });
  const accounts = current.accounts.filter((item) => item.accountId !== normalized.accountId);
  accounts.unshift(normalized);
  return writeSavedAccounts({
    saved: {
      activeAccountId: makeActive ? normalized.accountId : current.activeAccountId,
      accounts: accounts.slice(0, MAX_SAVED_ACCOUNTS),
    },
    userDataRoot,
  });
}

async function setActiveAccount({ accountId, userDataRoot }) {
  const normalized = normalizeAccountId(accountId);
  const current = await loadSavedAccounts({ userDataRoot });
  if (!current.accounts.some((item) => item.accountId === normalized)) {
    fail("desktop_saved_account_missing");
  }
  return writeSavedAccounts({
    saved: { ...current, activeAccountId: normalized },
    userDataRoot,
  });
}

async function clearAccountSession({ accountId, removeAccount = false, userDataRoot }) {
  const normalized = normalizeAccountId(accountId);
  const current = await loadSavedAccounts({ userDataRoot });
  const accounts = removeAccount
    ? current.accounts.filter((item) => item.accountId !== normalized)
    : current.accounts.map((item) => (
      item.accountId === normalized ? { ...item, session: null } : item
    ));
  const activeAccountId = current.activeAccountId === normalized
    ? (accounts[0]?.accountId || null)
    : current.activeAccountId;
  if (!accounts.length) {
    await rm(savedAccountsFilePath(userDataRoot), { force: true });
    return emptySavedAccounts();
  }
  return writeSavedAccounts({
    saved: { activeAccountId, accounts },
    userDataRoot,
  });
}

async function saveRememberedSession({ remembered, userDataRoot }) {
  const normalized = validateRememberedSession(remembered);
  return saveAccount({
    account: {
      accountId: normalized.accountId,
      displayName: normalized.session.accountName,
      mode: "cloud",
      savedAt: new Date().toISOString(),
      session: normalized.session,
    },
    userDataRoot,
  });
}

async function loadRememberedSession({ userDataRoot, now = Date.now() }) {
  const saved = await loadSavedAccounts({ userDataRoot, now });
  const active = saved.accounts.find((item) => item.accountId === saved.activeAccountId);
  if (!active || active.mode !== "cloud" || !active.session) return null;
  return { accountId: active.accountId, session: active.session };
}

async function clearRememberedSession({ userDataRoot }) {
  const saved = await loadSavedAccounts({ userDataRoot });
  if (saved.activeAccountId) {
    await clearAccountSession({ accountId: saved.activeAccountId, removeAccount: true, userDataRoot });
  }
  await Promise.all([
    rm(rememberedSessionFilePath(userDataRoot), { force: true }),
    clearLegacyCredential(userDataRoot),
  ]);
}

module.exports = {
  LEGACY_CREDENTIAL_FILE_NAME,
  MAX_SAVED_ACCOUNTS,
  REMEMBERED_SESSION_FILE_NAME,
  REMEMBERED_SESSION_SCHEMA,
  SAVED_ACCOUNTS_FILE_NAME,
  SAVED_ACCOUNTS_SCHEMA,
  clearAccountSession,
  clearRememberedSession,
  legacyCredentialFilePath,
  loadRememberedSession,
  loadSavedAccounts,
  localTokenPayload,
  rememberedSessionFilePath,
  saveAccount,
  saveRememberedSession,
  savedAccountsFilePath,
  setActiveAccount,
  tokenExpiresAt: cloudTokenExpiresAt,
  validateCloudSession,
  validateLocalSession,
  validateRememberedSession,
  validateSavedAccount,
  validateSavedAccounts,
};
