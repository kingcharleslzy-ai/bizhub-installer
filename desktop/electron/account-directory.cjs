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
  return `persist:workspace-${digest}`;
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

async function boundedJsonResponse(response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > MAX_DIRECTORY_RESPONSE_BYTES) {
    fail("desktop_account_directory_response_size_invalid");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("desktop_account_directory_response_json_invalid");
  }
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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(resolveUrl, {
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
  } catch (error) {
    if (error?.name === "AbortError") fail("desktop_account_directory_timeout");
    fail("desktop_account_directory_unreachable");
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) {
    return { accountId: account, status: "not_found", workspaces: [] };
  }
  if (!response.ok) fail(`desktop_account_directory_http_${response.status}`);
  const workspaces = validateDirectoryResponse(await boundedJsonResponse(response), {
    trustStore,
    shellVersion,
    now,
  });
  return { accountId: account, status: "resolved", workspaces };
}

module.exports = {
  DIRECTORY_CONFIG_SCHEMA,
  DIRECTORY_REQUEST_SCHEMA,
  DIRECTORY_RESPONSE_SCHEMA,
  MAX_ACCOUNT_WORKSPACES,
  MAX_DIRECTORY_RESPONSE_BYTES,
  normalizeAccountId,
  resolveAccountWorkspaces,
  signerFingerprint,
  validateDirectoryConfig,
  validateDirectoryResponse,
  workspaceSessionPartition,
};
