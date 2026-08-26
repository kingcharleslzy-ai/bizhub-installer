import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  TRUST_STORE_SCHEMA,
  signatureInput,
} = require("../electron/connection-profile.cjs");
const {
  DIRECTORY_CONFIG_SCHEMA,
  DIRECTORY_REQUEST_SCHEMA,
  DIRECTORY_RESPONSE_SCHEMA,
  normalizeAccountId,
  resolveAccountWorkspaces,
  validateDirectoryConfig,
  validateDirectoryResponse,
  workspaceSessionPartition,
} = require("../electron/account-directory.cjs");

const NOW = new Date("2026-08-26T00:00:00Z");

function fixture() {
  const keyPair = generateKeyPairSync("ed25519");
  const keyId = "synthetic-platform-2026";
  const envelope = {
    schema_version: "bizhub.desktop-connection-envelope.v1",
    key_id: keyId,
    payload: {
      allowed_origins: ["https://workspace.example"],
      application_url: "https://workspace.example/app/",
      connection_id: "synthetic-cloud",
      data_authority_mode: "cloud",
      display_name: "Synthetic Cloud",
      expires_at: "2026-09-26T00:00:00Z",
      profile_id: "synthetic-profile",
      runtime_mode: "cloud",
      shell_min_version: "0.1.0",
    },
    signature: "",
  };
  envelope.signature = sign(null, signatureInput(envelope), keyPair.privateKey)
    .toString("base64url");
  const trustStore = {
    schema_version: TRUST_STORE_SCHEMA,
    keys: [{
      algorithm: "Ed25519",
      key_id: keyId,
      public_key_pem: keyPair.publicKey.export({ format: "pem", type: "spki" }),
      valid_from: "2026-01-01T00:00:00Z",
      valid_until: "2027-01-01T00:00:00Z",
    }],
  };
  return {
    envelope,
    options: { now: NOW, shellVersion: "0.1.0", trustStore },
    response: {
      schema_version: DIRECTORY_RESPONSE_SCHEMA,
      workspaces: [envelope],
    },
  };
}

test("normalizes a bounded account identifier and rejects ambiguous input", () => {
  assert.equal(normalizeAccountId("  Charles.Example  "), "charles.example");
  for (const value of ["ab", "含中文", "has space", "https://example.com", "a".repeat(129)]) {
    assert.throws(() => normalizeAccountId(value), /desktop_account_id_invalid/);
  }
});

test("isolates persistent cloud sessions by account and Workspace without exposing either", () => {
  const first = workspaceSessionPartition("synthetic-cloud", "first.account");
  const repeated = workspaceSessionPartition("synthetic-cloud", "FIRST.ACCOUNT");
  const second = workspaceSessionPartition("synthetic-cloud", "second.account");
  assert.equal(first, repeated);
  assert.notEqual(first, second);
  assert.match(first, /^persist:workspace-[0-9a-f]{24}$/);
  assert.equal(first.includes("synthetic"), false);
  assert.equal(first.includes("account"), false);
});

test("accepts only an exact HTTPS account-directory endpoint", () => {
  assert.deepEqual(validateDirectoryConfig({
    schema_version: DIRECTORY_CONFIG_SCHEMA,
    resolve_url: "https://accounts.example/v1/desktop/workspaces/resolve",
  }), { resolveUrl: "https://accounts.example/v1/desktop/workspaces/resolve" });
  assert.deepEqual(validateDirectoryConfig({
    schema_version: DIRECTORY_CONFIG_SCHEMA,
    resolve_url: null,
  }), { resolveUrl: null });
  for (const resolveUrl of [
    "http://accounts.example/resolve",
    "https://user:pass@accounts.example/resolve",
    "https://accounts.example/resolve?next=elsewhere",
  ]) {
    assert.throws(
      () => validateDirectoryConfig({
        schema_version: DIRECTORY_CONFIG_SCHEMA,
        resolve_url: resolveUrl,
      }),
      /desktop_account_directory_url_invalid/,
    );
  }
});

test("validates platform-signed workspace results without credentials", () => {
  const { response, options } = fixture();
  const workspaces = validateDirectoryResponse(response, options);
  assert.equal(workspaces.length, 1);
  assert.deepEqual(workspaces[0].summary, {
    applicationOrigin: "https://workspace.example",
    connectionId: "synthetic-cloud",
    dataAuthorityMode: "cloud",
    displayName: "Synthetic Cloud",
    expiresAt: "2026-09-26T00:00:00Z",
    profileId: "synthetic-profile",
    runtimeMode: "cloud",
    signerFingerprint: workspaces[0].summary.signerFingerprint,
  });
  assert.match(workspaces[0].summary.signerFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(response).includes("password"), false);
});

test("rejects unknown signing keys, tamper, duplicate workspaces, and extra fields", () => {
  {
    const { response, options } = fixture();
    options.trustStore.keys = [];
    assert.throws(() => validateDirectoryResponse(response, options), /profile_signing_key_unknown/);
  }
  {
    const { response, options } = fixture();
    response.workspaces[0].payload.application_url = "https://workspace.example/changed/";
    assert.throws(() => validateDirectoryResponse(response, options), /profile_signature_mismatch/);
  }
  {
    const { response, options } = fixture();
    response.workspaces.push(structuredClone(response.workspaces[0]));
    assert.throws(() => validateDirectoryResponse(response, options), /desktop_account_workspace_duplicate/);
  }
  {
    const { response, options } = fixture();
    response.password = "not-accepted";
    assert.throws(
      () => validateDirectoryResponse(response, options),
      /desktop_account_directory_response_shape_invalid/,
    );
  }
});

test("sends only the account identifier and returns verified workspaces", async () => {
  const { response, options } = fixture();
  let request;
  const result = await resolveAccountWorkspaces("Charles.Example", {
    ...options,
    config: {
      schema_version: DIRECTORY_CONFIG_SCHEMA,
      resolve_url: "https://accounts.example/v1/desktop/workspaces/resolve",
    },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.accountId, "charles.example");
  assert.equal(result.workspaces.length, 1);
  assert.equal(request.url, "https://accounts.example/v1/desktop/workspaces/resolve");
  assert.deepEqual(JSON.parse(request.init.body), {
    schema_version: DIRECTORY_REQUEST_SCHEMA,
    account_id: "charles.example",
  });
  assert.equal(request.init.body.includes("password"), false);
  assert.equal(request.init.redirect, "error");
});

test("distinguishes a confirmed unknown account from directory failures", async () => {
  const { options } = fixture();
  const config = {
    schema_version: DIRECTORY_CONFIG_SCHEMA,
    resolve_url: "https://accounts.example/v1/desktop/workspaces/resolve",
  };
  const missing = await resolveAccountWorkspaces("unknown.account", {
    ...options,
    config,
    fetchImpl: async () => new Response("", { status: 404 }),
  });
  assert.deepEqual(missing, {
    accountId: "unknown.account",
    status: "not_found",
    workspaces: [],
  });
  await assert.rejects(resolveAccountWorkspaces("unknown.account", {
    ...options,
    config,
    fetchImpl: async () => new Response("failure", { status: 503 }),
  }), /desktop_account_directory_http_503/);
  await assert.rejects(resolveAccountWorkspaces("unknown.account", {
    ...options,
    config: { schema_version: DIRECTORY_CONFIG_SCHEMA, resolve_url: null },
  }), /desktop_account_directory_not_configured/);
});
