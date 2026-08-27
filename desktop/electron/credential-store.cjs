const { chmod, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { normalizeAccountId } = require("./account-directory.cjs");

const REMEMBERED_SESSION_SCHEMA = "bizhub.desktop-remembered-session.v1";
const REMEMBERED_SESSION_FILE_NAME = "remembered-session.v1.json";
const LEGACY_CREDENTIAL_FILE_NAME = "remembered-login.v1.json";
const MAX_SESSION_FILE_BYTES = 32 * 1024;

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

function tokenExpiresAt(token) {
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

function validateRememberedSession(value, { now = Date.now() } = {}) {
  exactKeys(value, ["accountId", "session"], "desktop_remembered_session_invalid");
  exactKeys(
    value.session,
    ["accessProfileVersion", "accountName", "permissions", "roles", "token"],
    "desktop_remembered_session_invalid",
  );
  const accountId = normalizeAccountId(value.accountId);
  const accountName = String(value.session.accountName || "").trim();
  if (
    !accountName
    || accountName.length > 128
    || Number(value.session.accessProfileVersion) !== 1
  ) {
    fail("desktop_remembered_session_invalid");
  }
  const token = String(value.session.token || "");
  if (tokenExpiresAt(token) <= now + 30_000) {
    fail("desktop_remembered_session_expired");
  }
  return {
    accountId,
    session: {
      accessProfileVersion: 1,
      accountName,
      permissions: validateStringList(
        value.session.permissions,
        "desktop_remembered_session_invalid",
      ),
      roles: validateStringList(value.session.roles, "desktop_remembered_session_invalid"),
      token,
    },
  };
}

function rememberedSessionFilePath(userDataRoot) {
  return path.join(path.resolve(userDataRoot), REMEMBERED_SESSION_FILE_NAME);
}

function legacyCredentialFilePath(userDataRoot) {
  return path.join(path.resolve(userDataRoot), LEGACY_CREDENTIAL_FILE_NAME);
}

async function clearLegacyCredential(userDataRoot) {
  await rm(legacyCredentialFilePath(userDataRoot), { force: true });
}

async function saveRememberedSession({ remembered, userDataRoot }) {
  const normalized = validateRememberedSession(remembered);
  await mkdir(path.resolve(userDataRoot), { recursive: true, mode: 0o700 });
  await writeFile(rememberedSessionFilePath(userDataRoot), `${JSON.stringify({
    schema_version: REMEMBERED_SESSION_SCHEMA,
    ...normalized,
  })}\n`, { mode: 0o600 });
  await chmod(rememberedSessionFilePath(userDataRoot), 0o600);
  await clearLegacyCredential(userDataRoot);
}

async function loadRememberedSession({ userDataRoot, now = Date.now() }) {
  await clearLegacyCredential(userDataRoot);
  let raw;
  try {
    raw = await readFile(rememberedSessionFilePath(userDataRoot));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (raw.length < 2 || raw.length > MAX_SESSION_FILE_BYTES) {
    fail("desktop_remembered_session_file_invalid");
  }
  let envelope;
  try {
    envelope = JSON.parse(raw.toString("utf8"));
  } catch {
    fail("desktop_remembered_session_file_invalid");
  }
  exactKeys(
    envelope,
    ["accountId", "schema_version", "session"],
    "desktop_remembered_session_file_invalid",
  );
  if (envelope.schema_version !== REMEMBERED_SESSION_SCHEMA) {
    fail("desktop_remembered_session_file_invalid");
  }
  return validateRememberedSession({
    accountId: envelope.accountId,
    session: envelope.session,
  }, { now });
}

async function clearRememberedSession({ userDataRoot }) {
  await Promise.all([
    rm(rememberedSessionFilePath(userDataRoot), { force: true }),
    clearLegacyCredential(userDataRoot),
  ]);
}

module.exports = {
  LEGACY_CREDENTIAL_FILE_NAME,
  REMEMBERED_SESSION_FILE_NAME,
  REMEMBERED_SESSION_SCHEMA,
  clearRememberedSession,
  legacyCredentialFilePath,
  loadRememberedSession,
  rememberedSessionFilePath,
  saveRememberedSession,
  tokenExpiresAt,
  validateRememberedSession,
};
