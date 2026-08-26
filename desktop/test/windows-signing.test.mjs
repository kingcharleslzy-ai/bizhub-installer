import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("Windows packaging signs the shell and preserves the already rebound Runtime Pack bytes", async () => {
  const config = loadForgeConfig({
    BIZHUB_REQUIRE_WINDOWS_SIGNING: "1",
    BIZHUB_WINDOWS_CERTIFICATE_FILE: "synthetic.pfx",
    BIZHUB_WINDOWS_CERTIFICATE_PASSWORD: "synthetic-password",
  });
  assert.deepEqual(config.packagerConfig.windowsSign.hashes, ["sha256"]);
  assert.match(config.packagerConfig.windowsSign.hookModulePath, /windows-sign-hook\.cjs$/);
  const squirrel = config.makers.find((maker) => maker.name === "@electron-forge/maker-squirrel");
  assert.deepEqual(squirrel.config.windowsSign.hashes, ["sha256"]);
  assert.equal(
    squirrel.config.windowsSign.hookModulePath,
    config.packagerConfig.windowsSign.hookModulePath,
  );
  assert.equal(squirrel.config.certificateFile, undefined);

  const signWindowsFile = require(config.packagerConfig.windowsSign.hookModulePath);
  const fixedRuntimeExecutable = path.join(
    "C:",
    "review",
    "resources",
    "bizhub-runtime",
    "bizhub-runtime.exe",
  );
  assert.equal(signWindowsFile.preservesFixedRuntime(fixedRuntimeExecutable), true);
  await signWindowsFile(fixedRuntimeExecutable);
  assert.equal(
    signWindowsFile.preservesFixedRuntime(path.join("C:", "review", "BizHub Desktop.exe")),
    false,
  );
});

test("R1 requires explicit Runtime PE signing, verification, and release-specific trust", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/desktop-r1-signed-candidate.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /prepare-signed-windows-runtime\.mjs/);
  assert.match(workflow, /verify-windows-runtime-signatures\.ps1/);
  assert.match(workflow, /--expected-runtime-trust runtime-dist\/generic-runtime-trust\.json/);
  assert.match(workflow, /make:windows-release/);
  assert.doesNotMatch(workflow, /npm run make:windows(?:\s|$)/m);
  const runtimePreparation = readFileSync(
    new URL("../scripts/prepare-signed-windows-runtime.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runtimePreparation, /runtimeTarget\(\)/);
  assert.match(runtimePreparation, /path\.join\(ROOT, "config", target\.trustName\)/);
});

test("Windows install smoke checks only the formal BizHub instance boundary", () => {
  const source = readFileSync(
    new URL("../scripts/windows-installer-smoke.ps1", import.meta.url),
    "utf8",
  );
  assert.match(source, /Join-Path \$defaultUserData "local-instance"/);
  assert.match(source, /desktop_windows_install_created_local_instance/);
  assert.doesNotMatch(source, /Where-Object \{ \$_\.Extension -in/);
});

test("Windows evidence requires exactly one full Squirrel package", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/desktop-d3-windows.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /\$nupkgs\.Count -ne 1/);
  assert.doesNotMatch(workflow, /Select-Object -Single/);
});
