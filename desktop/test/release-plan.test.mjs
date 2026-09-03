import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "release-plan.mjs");
const COMMIT = "a".repeat(40);
const PACKAGE_VERSION = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).version;
const RELEASE_TAG = `desktop-v${PACKAGE_VERSION}`;

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(result.status, expectedStatus, `${result.stdout}\n${result.stderr}`);
  return result;
}

test("release plan binds exact Actions identities, publisher readback, and inner bytes", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-release-plan-"));
  const macRoot = path.join(temporaryRoot, "mac");
  const windowsRoot = path.join(temporaryRoot, "windows");
  const planPath = path.join(temporaryRoot, "plan.json");
  await Promise.all([mkdir(macRoot), mkdir(windowsRoot)]);
  try {
    const commonArtifactDigest = JSON.parse(await readFile(path.join(ROOT, "config", "generic-runtime-trust.json"), "utf8")).core_artifact_digest;
    await writeFile(path.join(macRoot, "desktop.zip"), "mac-zip");
    await writeFile(path.join(macRoot, "desktop.dmg"), "mac-dmg");
    await writeJson(path.join(macRoot, "desktop-r1-macos-containers.json"), {
      signing_mode: "production", package_version: PACKAGE_VERSION,
      zip: { name: "desktop.zip" }, dmg: { name: "desktop.dmg", notary_staple_readback: true },
    });
    await writeJson(path.join(macRoot, "desktop-r1-macos-release-identity.json"), {
      signing_mode: "production", publisher_team_id: "ABCDEFGHIJ", notary_staple_readback: true,
    });
    await writeJson(path.join(macRoot, "desktop-r1-macos-runtime-identity.json"), {
      signing_mode: "production", signed_manifest_sha256: "1".repeat(64),
      signed_pack_tree_digest: "2".repeat(64), signed_runtime_trust_sha256: "3".repeat(64), core_artifact_digest: commonArtifactDigest,
    });
    await writeJson(path.join(macRoot, "desktop-r1-macos-upgrade-rollback.json"), {
      status: "ok", schema_version: "bizhub.desktop-upgrade-rollback.v1",
    });

    await writeFile(path.join(windowsRoot, "Setup.exe"), "windows-setup");
    await writeFile(path.join(windowsRoot, "desktop-full.nupkg"), "windows-nupkg");
    await writeFile(path.join(windowsRoot, "RELEASES"), "windows-releases");
    await writeJson(path.join(windowsRoot, "desktop-r1-windows-x64-identity.json"), {
      signing_mode: "production", commit: COMMIT, signer_subject: "CN=Publisher",
      signer_thumbprint: "A".repeat(40), timestamp_subject: "CN=Timestamp",
      setup: { name: "Setup.exe" }, nupkg: { name: "desktop-full.nupkg" },
    });
    await writeJson(path.join(windowsRoot, "desktop-r1-windows-runtime-identity.json"), {
      signing_mode: "production", all_pe_signatures_valid: true,
      main_signer_subject: "CN=Publisher", main_signer_thumbprint: "A".repeat(40),
      signed_manifest_sha256: "4".repeat(64), signed_pack_tree_digest: "5".repeat(64),
      pe_file_count: 9, publisher_signed_file_count: 7, signed_runtime_trust_sha256: "6".repeat(64),
      core_artifact_digest: commonArtifactDigest,
    });
    await writeJson(path.join(windowsRoot, "desktop-r1-windows-upgrade-rollback.json"), {
      status: "ok", schema_version: "bizhub.desktop-upgrade-rollback.v1",
    });

    run([
      "build", "--source-run-id", "123", "--source-run-attempt", "1", "--commit", COMMIT,
      "--tag", RELEASE_TAG, "--mac-root", macRoot, "--mac-artifact-id", "456",
      "--mac-artifact-name", "mac-artifact", "--mac-artifact-digest", `sha256:${"7".repeat(64)}`,
      "--windows-root", windowsRoot, "--windows-artifact-id", "789",
      "--windows-artifact-name", "windows-artifact", "--windows-artifact-digest", `sha256:${"8".repeat(64)}`,
      "--output", planPath,
    ]);
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const commonManifest = JSON.parse(await readFile(path.join(ROOT, "..", "app", "vendor", "bizhub-common-manifest.json"), "utf8"));
    assert.equal(plan.schema_version, "bizhub.desktop-release-plan.v2");
    assert.deepEqual(plan.common_core, {
      artifact_digest: commonManifest.core_artifact_digest,
      source_commit: commonManifest.source_commit,
    });
    const planSha = createHash("sha256").update(await readFile(planPath)).digest("hex");
    const verifyArgs = [
      "verify", "--plan", planPath, "--plan-sha256", planSha, "--source-run-id", "123",
      "--commit", COMMIT, "--tag", RELEASE_TAG, "--mac-root", macRoot,
      "--windows-root", windowsRoot,
    ];
    run(verifyArgs);
    await writeFile(path.join(windowsRoot, "Setup.exe"), "tampered");
    run(verifyArgs, 1);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
