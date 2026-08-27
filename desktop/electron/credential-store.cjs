const { chmod, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { normalizeAccountId } = require("./account-directory.cjs");

const CREDENTIAL_FILE_SCHEMA = "bizhub.desktop-remembered-login.v1";
const CREDENTIAL_FILE_NAME = "remembered-login.v1.json";
const MAX_CREDENTIAL_FILE_BYTES = 16 * 1024;

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code);
}

function validateCredential(value) {
  exactKeys(value, ["accountId", "password"], "desktop_remembered_login_shape_invalid");
  const accountId = normalizeAccountId(value.accountId);
  const password = String(value.password || "");
  if (!password || password.length > 1024) fail("desktop_cloud_password_invalid");
  return { accountId, password };
}

function credentialFilePath(userDataRoot) {
  return path.join(path.resolve(userDataRoot), CREDENTIAL_FILE_NAME);
}

function requireSecureStorage(safeStorage) {
  if (
    !safeStorage
    || typeof safeStorage.isEncryptionAvailable !== "function"
    || !safeStorage.isEncryptionAvailable()
    || typeof safeStorage.encryptString !== "function"
    || typeof safeStorage.decryptString !== "function"
  ) {
    fail("desktop_secure_storage_unavailable");
  }
}

async function saveRememberedLogin({ credential, safeStorage, userDataRoot }) {
  requireSecureStorage(safeStorage);
  const normalized = validateCredential(credential);
  const encrypted = safeStorage.encryptString(JSON.stringify(normalized));
  if (!Buffer.isBuffer(encrypted) || encrypted.length < 1) {
    fail("desktop_secure_storage_encrypt_failed");
  }
  await mkdir(path.resolve(userDataRoot), { recursive: true, mode: 0o700 });
  await writeFile(credentialFilePath(userDataRoot), `${JSON.stringify({
    schema_version: CREDENTIAL_FILE_SCHEMA,
    encrypted: encrypted.toString("base64"),
  })}\n`, { mode: 0o600 });
  await chmod(credentialFilePath(userDataRoot), 0o600);
}

async function loadRememberedLogin({ safeStorage, userDataRoot }) {
  let raw;
  try {
    raw = await readFile(credentialFilePath(userDataRoot));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (raw.length < 2 || raw.length > MAX_CREDENTIAL_FILE_BYTES) {
    fail("desktop_remembered_login_file_invalid");
  }
  requireSecureStorage(safeStorage);
  let envelope;
  try {
    envelope = JSON.parse(raw.toString("utf8"));
  } catch {
    fail("desktop_remembered_login_file_invalid");
  }
  exactKeys(
    envelope,
    ["encrypted", "schema_version"],
    "desktop_remembered_login_file_invalid",
  );
  if (
    envelope.schema_version !== CREDENTIAL_FILE_SCHEMA
    || typeof envelope.encrypted !== "string"
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.encrypted)
  ) {
    fail("desktop_remembered_login_file_invalid");
  }
  let decrypted;
  try {
    decrypted = safeStorage.decryptString(Buffer.from(envelope.encrypted, "base64"));
  } catch {
    fail("desktop_remembered_login_decrypt_failed");
  }
  let credential;
  try {
    credential = JSON.parse(decrypted);
  } catch {
    fail("desktop_remembered_login_decrypt_failed");
  }
  return validateCredential(credential);
}

async function clearRememberedLogin({ userDataRoot }) {
  await rm(credentialFilePath(userDataRoot), { force: true });
}

module.exports = {
  CREDENTIAL_FILE_NAME,
  CREDENTIAL_FILE_SCHEMA,
  clearRememberedLogin,
  credentialFilePath,
  loadRememberedLogin,
  saveRememberedLogin,
  validateCredential,
};
