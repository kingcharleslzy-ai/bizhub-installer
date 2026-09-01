import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateProductionDirectory } from "../scripts/release-preflight.mjs";
import { previousFixtureVersion } from "../scripts/package-version-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowRoot = path.resolve(ROOT, "..", ".github", "workflows");

async function workflow(name) {
  return readFile(path.join(workflowRoot, name), "utf8");
}

test("synthetic CI cannot access production secrets, environments, or publication", async () => {
  const source = await workflow("desktop-r1-release.yml");
  assert.match(source, /^name: Desktop R1 Synthetic$/m);
  assert.match(source, /pull_request:\n\s+branches: \[main\]/);
  assert.match(source, /desktop-r1-synthetic-macos-arm64/);
  assert.match(source, /desktop-r1-synthetic-windows-x64/);
  assert.match(source, /macos-upgrade-rollback-smoke\.mjs/);
  assert.match(source, /windows-upgrade-rollback-smoke\.ps1/);
  assert.doesNotMatch(source, /\bsecrets\./);
  assert.doesNotMatch(source, /environment: desktop-production/);
  assert.doesNotMatch(source, /gh release|contents: write/);
});

test("production signing is isolated from exact-plan publication", async () => {
  const candidate = await workflow("desktop-r1-signed-candidate.yml");
  const publish = await workflow("desktop-r1-publish.yml");
  assert.match(candidate, /^name: Desktop R1 Signed Candidate$/m);
  assert.equal((candidate.match(/environment: desktop-production-signing/g) || []).length, 2);
  assert.match(candidate, /node scripts\/prepare-signed-windows-runtime\.mjs/);
  assert.match(candidate, /desktop-r1-release-plan\.sha256/);
  assert.doesNotMatch(candidate, /gh release create|contents: write/);

  assert.match(publish, /environment: desktop-production-publish/);
  for (const input of ["source_run_id", "release_plan_sha256", "release_commit", "release_tag"]) {
    assert.match(publish, new RegExp(`\\n      ${input}:`));
  }
  assert.match(publish, /\.immutable/);
  assert.match(publish, /immutable-releases/);
  assert.match(publish, /node desktop\/scripts\/release-plan\.mjs verify/);
  assert.doesNotMatch(publish, /npm (?:ci|run (?:build|make|package))|electron-forge|sign-production|secrets\./);
});

test("cross-version fixtures always produce a distinct older semantic version", () => {
  assert.equal(previousFixtureVersion("1.2.3"), "1.2.2");
  assert.equal(previousFixtureVersion("1.2.0"), "1.1.999");
  assert.equal(previousFixtureVersion("1.0.0"), "0.999.999");
  assert.equal(previousFixtureVersion("0.1.0"), "0.0.999");
  assert.throws(() => previousFixtureVersion("1.2"), /desktop_fixture_current_version_invalid/);
});

test("cross-version Owner readback enters once and preserves the onboarding gate", async () => {
  const source = await readFile(path.join(ROOT, "scripts", "versioned-owner-readback.mjs"), "utf8");
  const state = source.indexOf('fetchRuntime(runtime, "/api/workspace-onboarding/state")');
  const enter = source.indexOf('mutation(runtime, "/api/workspace-onboarding/enter"');
  const preview = source.indexOf('mutation(runtime, "/api/master-data/catalog/preview"');
  assert.ok(state >= 0 && enter > state && preview > enter);
  assert.match(source, /assert\.equal\(onboardingStage, "workspace_ready"\)/);
  assert.match(source, /assert\.equal\(onboardingStage, "enterprise_context_ready"\)/);
  assert.match(source, /idempotency_key: "desktop-upgrade-enter-v1"/);
  assert.match(source, /onboarding_stage: onboardingStage/);
});

test("the configured W2 temporary directory remains an intentional production blocker", async () => {
  const directory = JSON.parse(await readFile(path.join(ROOT, "config", "account-directory.json"), "utf8"));
  assert.throws(() => validateProductionDirectory(directory), /desktop_release_directory_/);
});

test("production entitlements never inherit the synthetic ad-hoc library exception", async () => {
  const production = await readFile(path.join(ROOT, "config", "entitlements.macos.plist"), "utf8");
  const syntheticApp = await readFile(path.join(ROOT, "config", "entitlements.macos.synthetic-app.plist"), "utf8");
  const syntheticRuntime = await readFile(path.join(ROOT, "config", "entitlements.macos.synthetic-runtime.plist"), "utf8");
  assert.doesNotMatch(production, /disable-library-validation/);
  assert.match(syntheticApp, /disable-library-validation/);
  assert.match(syntheticRuntime, /disable-library-validation/);
});
