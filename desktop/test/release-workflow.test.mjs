import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateProductionDirectory } from "../scripts/release-preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.resolve(ROOT, "..", ".github", "workflows", "desktop-r1-release.yml");

test("R1 branch runs cannot publish and production needs all explicit release gates", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /push:\n\s+branches:\n\s+- codex\/desktop-r1-release-20260826/);
  assert.doesNotMatch(workflow, /push:\n\s+tags:/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(
    workflow,
    /if: github\.event_name == 'workflow_dispatch' && inputs\.signing_mode == 'production' && inputs\.publish == true/,
  );
  assert.match(workflow, /needs:\n\s+- macos-arm64\n\s+- windows-x64/);
  assert.match(workflow, /desktop_release_tag_already_exists/);
  assert.match(workflow, /node scripts\/sign-production-macos-app\.mjs/);
  assert.match(workflow, /sha256sum --check SHA256SUMS\.expected/);
});

test("the configured W2 temporary directory remains an intentional production blocker", async () => {
  const directory = JSON.parse(await readFile(path.join(ROOT, "config", "account-directory.json"), "utf8"));
  assert.throws(
    () => validateProductionDirectory(directory),
    /desktop_release_directory_/,
  );
});

test("production entitlements never inherit the synthetic ad-hoc library exception", async () => {
  const production = await readFile(path.join(ROOT, "config", "entitlements.macos.plist"), "utf8");
  const syntheticApp = await readFile(
    path.join(ROOT, "config", "entitlements.macos.synthetic-app.plist"),
    "utf8",
  );
  const syntheticRuntime = await readFile(
    path.join(ROOT, "config", "entitlements.macos.synthetic-runtime.plist"),
    "utf8",
  );
  assert.doesNotMatch(production, /disable-library-validation/);
  assert.match(syntheticApp, /disable-library-validation/);
  assert.match(syntheticRuntime, /disable-library-validation/);
});
