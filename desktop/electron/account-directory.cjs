const { createHash, createPublicKey } = require("node:crypto");
const { validateConnectionEnvelope } = require("./connection-profile.cjs");

const DIRECTORY_CONFIG_SCHEMA = "bizhub.desktop-account-directory.v1";
const DIRECTORY_REQUEST_SCHEMA = "bizhub.desktop-account-lookup.v1";
const DIRECTORY_RESPONSE_SCHEMA = "bizhub.desktop-workspace-directory-response.v1";
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9._@+-]{2,127}$/;
const MAX_DIRECTORY_RESPONSE_BYTES = 64 * 1024;
const MAX_ACCOUNT_WORKSPACES = 8;

function fail(code) {
  throw new Error(code);
}

function abortError() {
  const error = new Error("desktop_account_directory_aborted");
  error.name = "AbortError";
  return error;
}

function createAccountLookupGeneration() {
  let current = 0;
  return Object.freeze({
    begin() {
      current += 1;
      return current;
    },
    commit(generation, callback) {
      if (generation !== current) return false;
      callback();
      return true;
    },
    invalidate() {
      current += 1;
      return current;
    },
    isCurrent(generation) {
      return generation === current;
    },
  });
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code);
}

function normalizeAccountId(value) {
  const normalized = String(value || "").normalize("NFKC").trim().toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(normalized)) fail("desktop_account_id_invalid");
  return normalized;
}

function workspaceSessionPartition(connectionId, accountId) {
  const connection = String(connectionId || "");
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(connection)) {
    fail("workspace_connection_id_invalid");
  }
  const account = normalizeAccountId(accountId);
  const digest = createHash("sha256")
    .update(`${connection}\0${account}`)
    .digest("hex")
    .slice(0, 24);
  return `workspace-${digest}`;
}

function parseExactHttpsUrl(value, code) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(code);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    fail(code);
  }
  return parsed.toString();
}

function validateDirectoryConfig(config) {
  exactKeys(config, ["resolve_url", "schema_version"], "desktop_account_directory_shape_invalid");
  if (config.schema_version !== DIRECTORY_CONFIG_SCHEMA) {
    fail("desktop_account_directory_schema_invalid");
  }
  if (config.resolve_url === null) return { resolveUrl: null };
  return {
    resolveUrl: parseExactHttpsUrl(
      config.resolve_url,
      "desktop_account_directory_url_invalid",
    ),
  };
}

function signerFingerprint(trustStore, keyId) {
  const signer = trustStore.keys.find((item) => item.key_id === keyId);
  if (!signer) fail("profile_signing_key_unknown");
  let publicKey;
  try {
    publicKey = createPublicKey(signer.public_key_pem);
  } catch {
    fail("trust_key_material_invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("trust_key_material_invalid");
  return createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
}

function validateDirectoryResponse(
  response,
  {
    trustStore,
    shellVersion,
    now = new Date(),
  },
) {
  exactKeys(
    response,
    ["schema_version", "workspaces"],
    "desktop_account_directory_response_shape_invalid",
  );
  if (
    response.schema_version !== DIRECTORY_RESPONSE_SCHEMA
    || !Array.isArray(response.workspaces)
    || response.workspaces.length > MAX_ACCOUNT_WORKSPACES
  ) {
    fail("desktop_account_directory_response_invalid");
  }
  const seen = new Set();
  return response.workspaces.map((envelope) => {
    const profile = validateConnectionEnvelope(envelope, {
      trustStore,
      shellVersion,
      now,
    });
    if (seen.has(profile.connectionId)) fail("desktop_account_workspace_duplicate");
    seen.add(profile.connectionId);
    return {
      envelope,
      profile,
      summary: {
        applicationOrigin: new URL(profile.applicationUrl).origin,
        connectionId: profile.connectionId,
        dataAuthorityMode: profile.dataAuthorityMode,
        displayName: profile.displayName,
        expiresAt: profile.expiresAt,
        profileId: profile.profileId,
        runtimeMode: profile.runtimeMode,
        signerFingerprint: signerFingerprint(trustStore, envelope.key_id),
      },
    };
  });
}

async function readChunk(reader, signal) {
  if (signal.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => {});
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function boundedJsonResponse(response, { controller, deadline }) {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null
    && /^\d+$/.test(contentLength)
    && Number(contentLength) > MAX_DIRECTORY_RESPONSE_BYTES
  ) {
    controller.abort();
    if (response.body) void response.body.cancel().catch(() => {});
    fail("desktop_account_directory_response_size_invalid");
  }
  if (!response.body) fail("desktop_account_directory_response_size_invalid");
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await readChunk(reader, controller.signal);
    if (done) break;
    received += value.byteLength;
    if (received > MAX_DIRECTORY_RESPONSE_BYTES) {
      controller.abort();
      void reader.cancel().catch(() => {});
      fail("desktop_account_directory_response_size_invalid");
    }
    chunks.push(Buffer.from(value));
  }
  if (received < 2) fail("desktop_account_directory_response_size_invalid");
  if (Date.now() > deadline) fail("desktop_account_directory_timeout");
  const bytes = Buffer.concat(chunks, received);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("desktop_account_directory_response_json_invalid");
  }
  if (Date.now() > deadline) fail("desktop_account_directory_timeout");
  return parsed;
}

async function resolveAccountWorkspaces(
  accountId,
  {
    config,
    fetchImpl = fetch,
    now = new Date(),
    shellVersion,
    timeoutMs = 10_000,
    trustStore,
  },
) {
  const account = normalizeAccountId(accountId);
  const { resolveUrl } = validateDirectoryConfig(config);
  if (!resolveUrl) fail("desktop_account_directory_not_configured");
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(resolveUrl, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        schema_version: DIRECTORY_REQUEST_SCHEMA,
        account_id: account,
      }),
    });
    if (response.status === 404) {
      if (response.body) await response.body.cancel();
      return { accountId: account, status: "not_found", workspaces: [] };
    }
    if (!response.ok) {
      if (response.body) await response.body.cancel();
      fail(`desktop_account_directory_http_${response.status}`);
    }
    const body = await boundedJsonResponse(response, { controller, deadline });
    const workspaces = validateDirectoryResponse(body, {
      trustStore,
      shellVersion,
      now,
    });
    if (Date.now() > deadline) fail("desktop_account_directory_timeout");
    return { accountId: account, status: "resolved", workspaces };
  } catch (error) {
    if (
      error instanceof Error
      && /^(desktop_|profile_|trust_)/.test(error.message)
      && error.name !== "AbortError"
    ) {
      throw error;
    }
    if (error?.name === "AbortError" || controller.signal.aborted) {
      fail("desktop_account_directory_timeout");
    }
    fail("desktop_account_directory_unreachable");
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DIRECTORY_CONFIG_SCHEMA,
  DIRECTORY_REQUEST_SCHEMA,
  DIRECTORY_RESPONSE_SCHEMA,
  MAX_ACCOUNT_WORKSPACES,
  MAX_DIRECTORY_RESPONSE_BYTES,
  createAccountLookupGeneration,
  normalizeAccountId,
  resolveAccountWorkspaces,
  signerFingerprint,
  validateDirectoryConfig,
  validateDirectoryResponse,
  workspaceSessionPartition,
};
