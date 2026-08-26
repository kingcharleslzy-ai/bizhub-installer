import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  productionSigningOptions,
  validateProductionEnvironment,
} from "../scripts/sign-production-macos-app.mjs";

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
