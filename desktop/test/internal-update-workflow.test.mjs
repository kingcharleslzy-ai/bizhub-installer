import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("internal updates remain one manual main-only native build and prerelease", async () => {
  const workflow = await readFile(
    path.join(ROOT, ".github", "workflows", "desktop-internal-update.yml"),
    "utf8",
  );
  for (const required of [
    "workflow_dispatch:",
    "github.ref == 'refs/heads/main'",
    "runs-on: macos-14",
    "runs-on: windows-2022",
    "make-update-manifest.mjs",
    "gh release create",
    "--prerelease",
    "desktop-update.json",
    "npm run verify:boundary",
    "npm run audit:runtime",
  ]) assert.ok(workflow.includes(required), required);
  for (const prohibited of [
    "pull_request:",
    "push:",
    "environment:",
    "BIZHUB_APPLE_",
    "BIZHUB_WINDOWS_CERTIFICATE_",
    "desktop-r1-signed-candidate",
    "desktop-r1-publish",
  ]) assert.ok(!workflow.includes(prohibited), prohibited);
});
