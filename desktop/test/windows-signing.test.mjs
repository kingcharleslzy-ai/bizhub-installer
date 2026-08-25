import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const configPath = require.resolve("../forge.config.cjs");
const signingKeys = [
  "BIZHUB_REQUIRE_WINDOWS_SIGNING",
  "BIZHUB_WINDOWS_CERTIFICATE_FILE",
  "BIZHUB_WINDOWS_CERTIFICATE_PASSWORD",
];

function loadForgeConfig(environment = {}) {
  const previous = Object.fromEntries(signingKeys.map((key) => [key, process.env[key]]));
  for (const key of signingKeys) delete process.env[key];
  Object.assign(process.env, environment);
  delete require.cache[configPath];
  try {
    return require(configPath);
  } finally {
    delete require.cache[configPath];
    for (const key of signingKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("Windows signing gate fails closed without both certificate inputs", () => {
  assert.throws(
    () => loadForgeConfig({ BIZHUB_REQUIRE_WINDOWS_SIGNING: "1" }),
    /desktop_windows_signing_credentials_missing/,
  );
});

test("Windows packaging signs the shell and preserves fixed Runtime Pack bytes", async () => {
  const config = loadForgeConfig({
    BIZHUB_REQUIRE_WINDOWS_SIGNING: "1",
    BIZHUB_WINDOWS_CERTIFICATE_FILE: "synthetic.pfx",
    BIZHUB_WINDOWS_CERTIFICATE_PASSWORD: "synthetic-password",
  });
  assert.deepEqual(config.packagerConfig.windowsSign.hashes, ["sha256"]);
  assert.equal(typeof config.packagerConfig.windowsSign.hookFunction, "function");
  const squirrel = config.makers.find((maker) => maker.name === "@electron-forge/maker-squirrel");
  assert.deepEqual(squirrel.config.windowsSign.hashes, ["sha256"]);
  assert.equal(squirrel.config.certificateFile, undefined);

  const fixedRuntimeExecutable = path.join(
    "C:",
    "review",
    "resources",
    "bizhub-runtime",
    "bizhub-runtime.exe",
  );
  await config.packagerConfig.windowsSign.hookFunction(fixedRuntimeExecutable);
});
