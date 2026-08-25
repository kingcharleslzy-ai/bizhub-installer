const {
  createPublicKey,
  verify,
} = require("node:crypto");

const ENVELOPE_SCHEMA = "bizhub.desktop-connection-envelope.v1";
const TRUST_STORE_SCHEMA = "bizhub.desktop-trust-store.v1";
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(code);
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) fail("profile_non_finite_number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  fail("profile_value_not_json");
}

function parseVersion(value, code) {
  const match = VERSION_PATTERN.exec(String(value || ""));
  if (!match) fail(code);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left, "shell_version_invalid");
  const rightParts = parseVersion(right, "profile_shell_min_version_invalid");
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function parseTimestamp(value, code) {
  if (typeof value !== "string" || !value.endsWith("Z")) fail(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(code);
  return parsed;
}

function parseExactOrigin(value) {
  if (typeof value !== "string" || value.length > 300) fail("profile_origin_invalid");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("profile_origin_invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.origin !== value
  ) {
    fail("profile_origin_invalid");
  }
  return parsed.origin;
}

function parseApplicationUrl(value) {
  if (typeof value !== "string" || value.length > 500) fail("profile_application_url_invalid");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("profile_application_url_invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    fail("profile_application_url_invalid");
  }
  return parsed;
}

function signatureInput(envelope) {
  return Buffer.from(canonicalJson({
    schema_version: envelope.schema_version,
    key_id: envelope.key_id,
    payload: envelope.payload,
  }), "utf8");
}

function validateTrustStore(trustStore, nowMs) {
  exactKeys(trustStore, ["schema_version", "keys"], "trust_store_shape_invalid");
  if (trustStore.schema_version !== TRUST_STORE_SCHEMA || !Array.isArray(trustStore.keys)) {
    fail("trust_store_shape_invalid");
  }
  const keys = new Map();
  for (const item of trustStore.keys) {
    exactKeys(
      item,
      ["algorithm", "key_id", "public_key_pem", "valid_from", "valid_until"],
      "trust_key_shape_invalid",
    );
    if (!ID_PATTERN.test(item.key_id) || item.algorithm !== "Ed25519") {
      fail("trust_key_identity_invalid");
    }
    if (keys.has(item.key_id)) fail("trust_key_duplicate");
    const validFrom = parseTimestamp(item.valid_from, "trust_key_valid_from_invalid");
    const validUntil = parseTimestamp(item.valid_until, "trust_key_valid_until_invalid");
    if (validFrom >= validUntil) fail("trust_key_window_invalid");
    keys.set(item.key_id, {
      ...item,
      active: validFrom <= nowMs && nowMs < validUntil,
    });
  }
  return keys;
}

function validateConnectionEnvelope(
  envelope,
  {
    trustStore,
    shellVersion,
    now = new Date(),
  },
) {
  exactKeys(
    envelope,
    ["key_id", "payload", "schema_version", "signature"],
    "profile_envelope_shape_invalid",
  );
  if (envelope.schema_version !== ENVELOPE_SCHEMA || !ID_PATTERN.test(envelope.key_id)) {
    fail("profile_envelope_identity_invalid");
  }

  exactKeys(
    envelope.payload,
    [
      "allowed_origins",
      "application_url",
      "connection_id",
      "display_name",
      "expires_at",
      "profile_id",
      "shell_min_version",
    ],
    "profile_payload_shape_invalid",
  );
  const payload = envelope.payload;
  if (!ID_PATTERN.test(payload.connection_id) || !ID_PATTERN.test(payload.profile_id)) {
    fail("profile_payload_identity_invalid");
  }
  if (
    typeof payload.display_name !== "string"
    || !payload.display_name.trim()
    || payload.display_name.length > 100
  ) {
    fail("profile_display_name_invalid");
  }
  if (
    !Array.isArray(payload.allowed_origins)
    || payload.allowed_origins.length < 1
    || payload.allowed_origins.length > 8
  ) {
    fail("profile_allowed_origins_invalid");
  }
  const allowedOrigins = payload.allowed_origins.map(parseExactOrigin);
  if (new Set(allowedOrigins).size !== allowedOrigins.length) {
    fail("profile_allowed_origins_duplicate");
  }
  const applicationUrl = parseApplicationUrl(payload.application_url);
  if (!allowedOrigins.includes(applicationUrl.origin)) fail("profile_application_origin_not_allowed");
  if (compareVersions(shellVersion, payload.shell_min_version) < 0) {
    fail("profile_shell_version_unsupported");
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) fail("profile_now_invalid");
  const expiresAt = parseTimestamp(payload.expires_at, "profile_expiry_invalid");
  if (expiresAt <= nowMs) fail("profile_expired");

  const keys = validateTrustStore(trustStore, nowMs);
  const trustedKey = keys.get(envelope.key_id);
  if (!trustedKey) fail("profile_signing_key_unknown");
  if (!trustedKey.active) fail("profile_signing_key_inactive");

  if (
    typeof envelope.signature !== "string"
    || !/^[A-Za-z0-9_-]+$/.test(envelope.signature)
  ) {
    fail("profile_signature_invalid");
  }
  let signature;
  try {
    signature = Buffer.from(envelope.signature, "base64url");
  } catch {
    fail("profile_signature_invalid");
  }
  let publicKey;
  try {
    publicKey = createPublicKey(trustedKey.public_key_pem);
  } catch {
    fail("trust_key_material_invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") fail("trust_key_material_invalid");
  if (!verify(null, signatureInput(envelope), publicKey, signature)) {
    fail("profile_signature_mismatch");
  }

  return {
    allowedOrigins,
    applicationUrl: applicationUrl.toString(),
    connectionId: payload.connection_id,
    displayName: payload.display_name.trim(),
    expiresAt: payload.expires_at,
    profileId: payload.profile_id,
  };
}

module.exports = {
  ENVELOPE_SCHEMA,
  TRUST_STORE_SCHEMA,
  canonicalJson,
  signatureInput,
  validateConnectionEnvelope,
};
