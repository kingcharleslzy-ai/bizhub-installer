import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  ENVELOPE_SCHEMA,
  TRUST_STORE_SCHEMA,
  signatureInput,
  validateConnectionEnvelope,
} = require("../electron/connection-profile.cjs");

const NOW = new Date("2026-08-25T08:00:00Z");

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "desktop-test-2026";
  const envelope = {
    schema_version: ENVELOPE_SCHEMA,
    key_id: keyId,
    payload: {
      allowed_origins: ["https://example.com"],
      application_url: "https://example.com/app/",
      connection_id: "synthetic-cloud",
      display_name: "Synthetic Cloud",
      expires_at: "2026-09-01T00:00:00Z",
      profile_id: "synthetic-profile",
      shell_min_version: "0.1.0",
    },
    signature: "",
  };
  envelope.signature = sign(null, signatureInput(envelope), privateKey).toString("base64url");
  const trustStore = {
    schema_version: TRUST_STORE_SCHEMA,
    keys: [
      {
        algorithm: "Ed25519",
        key_id: keyId,
        public_key_pem: publicKey.export({ format: "pem", type: "spki" }),
        valid_from: "2026-01-01T00:00:00Z",
        valid_until: "2027-01-01T00:00:00Z",
      },
    ],
  };
  return { envelope, privateKey, trustStore };
}

function validate(envelope, trustStore, overrides = {}) {
  return validateConnectionEnvelope(envelope, {
    trustStore,
    shellVersion: "0.1.0",
    now: NOW,
    ...overrides,
  });
}

test("accepts a signed bounded HTTPS connection profile", () => {
  const { envelope, trustStore } = fixture();
  assert.deepEqual(validate(envelope, trustStore), {
    allowedOrigins: ["https://example.com"],
    applicationUrl: "https://example.com/app/",
    connectionId: "synthetic-cloud",
    displayName: "Synthetic Cloud",
    expiresAt: "2026-09-01T00:00:00Z",
    profileId: "synthetic-profile",
  });
});

test("rejects a profile modified after signing", () => {
  const { envelope, trustStore } = fixture();
  envelope.payload.application_url = "https://example.com/changed/";
  assert.throws(() => validate(envelope, trustStore), /profile_signature_mismatch/);
});

test("rejects an expired profile", () => {
  const { envelope, privateKey, trustStore } = fixture();
  envelope.payload.expires_at = "2026-08-25T07:59:59Z";
  envelope.signature = sign(null, signatureInput(envelope), privateKey).toString("base64url");
  assert.throws(() => validate(envelope, trustStore), /profile_expired/);
});

test("rejects non-HTTPS and credential-bearing application URLs", () => {
  for (const applicationUrl of [
    "http://example.com/app/",
    "https://user:password@example.com/app/",
    "https://example.com/app/?token=value",
  ]) {
    const { envelope, privateKey, trustStore } = fixture();
    envelope.payload.application_url = applicationUrl;
    envelope.signature = sign(null, signatureInput(envelope), privateKey).toString("base64url");
    assert.throws(
      () => validate(envelope, trustStore),
      /profile_application_url_invalid/,
      applicationUrl,
    );
  }
});

test("rejects an application origin outside the signed allowlist", () => {
  const { envelope, privateKey, trustStore } = fixture();
  envelope.payload.application_url = "https://other.example/app/";
  envelope.signature = sign(null, signatureInput(envelope), privateKey).toString("base64url");
  assert.throws(
    () => validate(envelope, trustStore),
    /profile_application_origin_not_allowed/,
  );
});

test("rejects a profile requiring a newer shell", () => {
  const { envelope, privateKey, trustStore } = fixture();
  envelope.payload.shell_min_version = "0.2.0";
  envelope.signature = sign(null, signatureInput(envelope), privateKey).toString("base64url");
  assert.throws(() => validate(envelope, trustStore), /profile_shell_version_unsupported/);
});

test("rejects unknown fields and unknown signing keys", () => {
  const { envelope, trustStore } = fixture();
  envelope.payload.runtime_manifest_url = "https://example.com/runtime.json";
  assert.throws(() => validate(envelope, trustStore), /profile_payload_shape_invalid/);
  delete envelope.payload.runtime_manifest_url;
  envelope.key_id = "unknown-key";
  assert.throws(() => validate(envelope, trustStore), /profile_signing_key_unknown/);
});
