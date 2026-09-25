import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("internal updates stay one manual native build with a Developer ID macOS publisher", async () => {
  const workflow = await readFile(
    path.join(ROOT, ".github", "workflows", "desktop-internal-update.yml"),
    "utf8",
  );
  for (const required of [
    "workflow_dispatch:",
    "runs-on: macos-14",
    "runs-on: windows-2022",
    "make-update-manifest.mjs",
    "gh release create",
    "--prerelease",
    "desktop-update.json",
    "npm run verify:boundary",
    "npm run audit:runtime",
    "environment: desktop-internal-signing",
    "node scripts/prepare-signed-macos-runtime.mjs",
    "node scripts/sign-production-macos-app.mjs",
    "--mode production",
    "node scripts/make-macos-release-containers.mjs",
    "node scripts/verify-macos-release-containers.mjs",
    "security delete-keychain",
    "release-assets/*.dmg",
  ]) assert.ok(workflow.includes(required), required);
  for (const prohibited of [
    "pull_request:",
    "push:",
    "desktop-production-signing",
    "BIZHUB_APPLE_API_",
    "BIZHUB_DESKTOP_RELEASE_",
    "BIZHUB_WINDOWS_CERTIFICATE_",
    "desktop-r1-signed-candidate",
    "desktop-r1-publish",
  ]) assert.ok(!workflow.includes(prohibited), prohibited);
  const jobs = workflow.slice(workflow.indexOf("\njobs:"));
  const signingScope = "if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/desktop-signing/')";
  assert.equal(jobs.split(signingScope).length - 1, 2);
  assert.match(jobs, /\n  publish:\n    if: github\.ref == 'refs\/heads\/main' && inputs\.publish\n/);
  assert.equal((workflow.match(/secrets\.BIZHUB_APPLE_APP_PASSWORD/g) || []).length, 2);
});
