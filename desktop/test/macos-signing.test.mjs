import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  productionSigningOptions,
  validateProductionEnvironment,
} from "../scripts/sign-production-macos-app.mjs";
import {
  electronNotarizeOptions,
  notarytoolCredentialArguments,
  resolveNotaryCredentials,
} from "../scripts/macos-notary-credentials.mjs";

const require = createRequire(import.meta.url);
const configPath = require.resolve("../forge.config.cjs");

test("Forge remains an unsigned deterministic packager for both release modes", () => {
  delete require.cache[configPath];
  const config = require(configPath);
  assert.equal(config.packagerConfig.osxSign, undefined);
  assert.equal(config.packagerConfig.osxNotarize, undefined);
});

test("macOS production signing fails closed without publisher and notary identity", () => {
  assert.throws(
    () => validateProductionEnvironment({}),
    /desktop_macos_production_credentials_missing/,
  );
});

test("production signer preserves prepared Runtime and uses least-privilege entitlements", () => {
  const root = path.resolve("/tmp/bizhub-desktop-signing-review");
  const app = path.join(root, "BizHub Desktop.app");
  const environment = validateProductionEnvironment({
    BIZHUB_APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
    BIZHUB_APPLE_API_KEY_FILE: "/tmp/AuthKey_ABC123.p8",
    BIZHUB_APPLE_API_KEY_ID: "ABCDEF1234",
    BIZHUB_MACOS_KEYCHAIN: "/tmp/release.keychain-db",
    BIZHUB_MACOS_SIGNING_IDENTITY: "Developer ID Application: Example (ABCDE12345)",
    BIZHUB_MACOS_SIGNING_MODE: "production",
    BIZHUB_MACOS_TEAM_ID: "ABCDE12345",
  });
  const signing = productionSigningOptions({ appPath: app, environment, root });
  assert.equal(signing.identity, "Developer ID Application: Example (ABCDE12345)");
  assert.equal(signing.keychain, "/tmp/release.keychain-db");
  assert.equal(signing.platform, "darwin");
  assert.equal(signing.strictVerify, true);
  assert.equal(signing.ignore(path.join(
    app,
    "Contents",
    "Resources",
    "bizhub-runtime",
    "bizhub-runtime",
  )), true);
  assert.equal(signing.ignore(path.join(app, "Contents", "MacOS", "BizHub Desktop")), false);
  assert.equal(
    signing.optionsForFile(path.join(app, "Contents", "Frameworks", "BizHub Desktop Helper (Plugin).app")).entitlements,
    path.join(root, "config", "entitlements.macos.plugin.plist"),
  );
  assert.equal(
    signing.optionsForFile(path.join(app, "Contents", "Frameworks", "BizHub Desktop Helper (Renderer).app")).entitlements,
    path.join(root, "config", "entitlements.macos.renderer.plist"),
  );
});

const PUBLISHER = {
  BIZHUB_MACOS_KEYCHAIN: "/tmp/release.keychain-db",
  BIZHUB_MACOS_SIGNING_IDENTITY: "Developer ID Application: Example (ABCDE12345)",
  BIZHUB_MACOS_SIGNING_MODE: "production",
  BIZHUB_MACOS_TEAM_ID: "ABCDE12345",
};
const API_KEY = {
  BIZHUB_APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
  BIZHUB_APPLE_API_KEY_FILE: "/tmp/AuthKey_ABC123.p8",
  BIZHUB_APPLE_API_KEY_ID: "ABCDEF1234",
};
const APPLE_ID = {
  BIZHUB_APPLE_ID: "publisher@example.com",
  BIZHUB_APPLE_APP_PASSWORD: "synthetic-app-password",
};

test("Apple ID notarization binds the app-specific password to the publisher team", () => {
  const environment = validateProductionEnvironment({ ...PUBLISHER, ...APPLE_ID });
  assert.equal(environment.notary.kind, "apple-id");
  assert.deepEqual(electronNotarizeOptions("/tmp/BizHub Desktop.app", environment.notary), {
    appPath: "/tmp/BizHub Desktop.app",
    appleId: "publisher@example.com",
    appleIdPassword: "synthetic-app-password",
    teamId: "ABCDE12345",
  });
  assert.deepEqual(notarytoolCredentialArguments(environment.notary), [
    "--apple-id", "publisher@example.com",
    "--password", "synthetic-app-password",
    "--team-id", "ABCDE12345",
  ]);
});

test("API key notarization keeps the existing notarytool key arguments", () => {
  const environment = validateProductionEnvironment({ ...PUBLISHER, ...API_KEY });
  assert.equal(environment.notary.kind, "api-key");
  assert.deepEqual(notarytoolCredentialArguments(environment.notary), [
    "--key", "/tmp/AuthKey_ABC123.p8",
    "--key-id", "ABCDEF1234",
    "--issuer", "00000000-0000-0000-0000-000000000000",
  ]);
});

test("notarization requires exactly one complete credential kind", () => {
  for (const [environment, code] of [
    [{}, /desktop_macos_notary_credentials_missing/],
    [{ BIZHUB_APPLE_ID: "publisher@example.com" }, /desktop_macos_notary_credentials_missing/],
    [{ BIZHUB_APPLE_API_KEY_FILE: "/tmp/AuthKey.p8" }, /desktop_macos_notary_credentials_missing/],
    [{ ...API_KEY, ...APPLE_ID }, /desktop_macos_notary_credentials_ambiguous/],
    [{ ...APPLE_ID, BIZHUB_APPLE_API_KEY_ID: "ABCDEF1234" }, /desktop_macos_notary_credentials_ambiguous/],
    [{ ...API_KEY, BIZHUB_APPLE_APP_PASSWORD: "x" }, /desktop_macos_notary_credentials_ambiguous/],
    [{ ...APPLE_ID, BIZHUB_APPLE_ID: "not-an-apple-id" }, /desktop_macos_notary_credentials_invalid/],
  ]) {
    assert.throws(() => resolveNotaryCredentials(environment, "ABCDE12345"), code);
    assert.throws(() => validateProductionEnvironment({ ...PUBLISHER, ...environment }), code);
  }
  assert.throws(
    () => resolveNotaryCredentials(APPLE_ID, ""),
    /desktop_macos_notary_credentials_invalid/,
  );
});
