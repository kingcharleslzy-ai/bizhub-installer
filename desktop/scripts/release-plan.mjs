import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(code) {
  throw new Error(code);
}

function parseArguments(values) {
  const result = { command: values.shift() };
  while (values.length > 0) {
    const key = values.shift();
    const value = values.shift();
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      fail(`desktop_release_plan_argument_invalid:${key || "missing"}`);
    }
    result[key.slice(2).replaceAll("-", "_")] = value;
  }
  return result;
}

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]));
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(sortedObject(value), null, 2)}\n`);
}

async function fileIdentity(filePath) {
  const raw = await readFile(filePath);
  return {
    bytes: (await stat(filePath)).size,
    name: path.basename(filePath),
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function digest(value, code) {
  const normalized = value?.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized || "")) fail(code);
  return normalized;
}

function artifactId(value, code) {
  if (!/^[1-9]\d*$/.test(value || "")) fail(code);
  return Number(value);
}

async function verifyInnerArtifacts(plan, macRoot, windowsRoot) {
  const files = [
    [macRoot, plan.platforms.macos_arm64.files.zip],
    [macRoot, plan.platforms.macos_arm64.files.dmg],
    [windowsRoot, plan.platforms.windows_x64.files.setup],
    [windowsRoot, plan.platforms.windows_x64.files.nupkg],
    [windowsRoot, plan.platforms.windows_x64.files.releases],
  ];
  for (const [root, expected] of files) {
    const actual = await fileIdentity(path.join(root, expected.name));
    assert.deepEqual(actual, expected, `desktop_release_plan_file_identity_mismatch:${expected.name}`);
  }
  const evidence = [
    [macRoot, plan.platforms.macos_arm64.evidence.containers],
    [macRoot, plan.platforms.macos_arm64.evidence.release],
    [macRoot, plan.platforms.macos_arm64.evidence.runtime],
    [macRoot, plan.platforms.macos_arm64.evidence.upgrade_rollback],
    [windowsRoot, plan.platforms.windows_x64.evidence.release],
    [windowsRoot, plan.platforms.windows_x64.evidence.runtime],
    [windowsRoot, plan.platforms.windows_x64.evidence.upgrade_rollback],
  ];
  for (const [root, expected] of evidence) {
    const actual = await fileIdentity(path.join(root, expected.name));
    assert.deepEqual(actual, expected, `desktop_release_plan_evidence_identity_mismatch:${expected.name}`);
  }
}

async function build(options) {
  for (const key of [
    "source_run_id", "source_run_attempt", "commit", "tag", "mac_root",
    "mac_artifact_id", "mac_artifact_name", "mac_artifact_digest", "windows_root",
    "windows_artifact_id", "windows_artifact_name", "windows_artifact_digest", "output",
  ]) if (!options[key]) fail(`desktop_release_plan_argument_missing:${key}`);
  if (!/^[0-9a-f]{40}$/.test(options.commit)) fail("desktop_release_plan_commit_invalid");

  const packageJson = await readJson(path.join(ROOT, "package.json"));
  const directory = await readJson(path.join(ROOT, "config", "account-directory.json"));
  const macRoot = path.resolve(options.mac_root);
  const windowsRoot = path.resolve(options.windows_root);
  const containers = await readJson(path.join(macRoot, "desktop-r1-macos-containers.json"));
  const macRelease = await readJson(path.join(macRoot, "desktop-r1-macos-release-identity.json"));
  const macRuntime = await readJson(path.join(macRoot, "desktop-r1-macos-runtime-identity.json"));
  const macUpgrade = await readJson(path.join(macRoot, "desktop-r1-macos-upgrade-rollback.json"));
  const windowsRelease = await readJson(path.join(windowsRoot, "desktop-r1-windows-x64-identity.json"));
  const windowsRuntime = await readJson(path.join(windowsRoot, "desktop-r1-windows-runtime-identity.json"));
  const windowsUpgrade = await readJson(path.join(windowsRoot, "desktop-r1-windows-upgrade-rollback.json"));

  for (const identity of [containers, macRelease, macRuntime, windowsRelease, windowsRuntime]) {
    if (identity.signing_mode !== "production") fail("desktop_release_plan_requires_production_identity");
  }
  for (const identity of [macUpgrade, windowsUpgrade]) {
    if (identity.schema_version !== "bizhub.desktop-upgrade-rollback.v1" || identity.status !== "ok") {
      fail("desktop_release_plan_upgrade_identity_invalid");
    }
  }
  if (windowsRelease.commit !== options.commit) fail("desktop_release_plan_windows_commit_mismatch");
  if (containers.package_version !== packageJson.version) fail("desktop_release_plan_version_mismatch");
  const releaseTagPattern = new RegExp(`^desktop-v${packageJson.version.replaceAll(".", "\\.")}(?:-preview\\.[1-9]\\d*)?$`);
  if (!releaseTagPattern.test(options.tag)) fail("desktop_release_plan_tag_version_mismatch");
  const commonArtifactDigest = (await readJson(path.join(ROOT, "config", "generic-runtime-trust.json"))).core_artifact_digest;
  if (macRuntime.core_artifact_digest !== commonArtifactDigest || windowsRuntime.core_artifact_digest !== commonArtifactDigest) {
    fail("desktop_release_plan_common_artifact_mismatch");
  }

  const plan = {
    schema_version: "bizhub.desktop-release-plan.v1",
    repository: process.env.GITHUB_REPOSITORY || "kingcharleslzy-ai/bizhub-installer",
    source_run: {
      attempt: Number(options.source_run_attempt),
      commit: options.commit,
      id: Number(options.source_run_id),
      workflow: "Desktop R1 Signed Candidate",
    },
    release: { package_version: packageJson.version, tag: options.tag },
    public_configuration: {
      account_directory_resolve_url: directory.resolve_url,
      account_directory_sha256: (await fileIdentity(path.join(ROOT, "config", "account-directory.json"))).sha256,
      workspace_trust_sha256: (await fileIdentity(path.join(ROOT, "config", "trusted-connection-keys.json"))).sha256,
    },
    common_core_artifact_digest: commonArtifactDigest,
    platforms: {
      macos_arm64: {
        actions_artifact: {
          digest: digest(options.mac_artifact_digest, "desktop_release_plan_mac_artifact_digest_invalid"),
          id: artifactId(options.mac_artifact_id, "desktop_release_plan_mac_artifact_id_invalid"),
          name: options.mac_artifact_name,
        },
        files: {
          dmg: await fileIdentity(path.join(macRoot, containers.dmg.name)),
          zip: await fileIdentity(path.join(macRoot, containers.zip.name)),
        },
        publisher: {
          team_id: macRelease.publisher_team_id,
          app_notarized_and_stapled: macRelease.notary_staple_readback === true,
          dmg_notarized_and_stapled: containers.dmg.notary_staple_readback === true,
        },
        runtime: {
          manifest_sha256: macRuntime.signed_manifest_sha256,
          pack_tree_digest: macRuntime.signed_pack_tree_digest,
          trust_sha256: macRuntime.signed_runtime_trust_sha256,
        },
        upgrade_rollback: macUpgrade,
        evidence: {
          containers: await fileIdentity(path.join(macRoot, "desktop-r1-macos-containers.json")),
          release: await fileIdentity(path.join(macRoot, "desktop-r1-macos-release-identity.json")),
          runtime: await fileIdentity(path.join(macRoot, "desktop-r1-macos-runtime-identity.json")),
          upgrade_rollback: await fileIdentity(path.join(macRoot, "desktop-r1-macos-upgrade-rollback.json")),
        },
      },
      windows_x64: {
        actions_artifact: {
          digest: digest(options.windows_artifact_digest, "desktop_release_plan_windows_artifact_digest_invalid"),
          id: artifactId(options.windows_artifact_id, "desktop_release_plan_windows_artifact_id_invalid"),
          name: options.windows_artifact_name,
        },
        files: {
          nupkg: await fileIdentity(path.join(windowsRoot, windowsRelease.nupkg.name)),
          releases: await fileIdentity(path.join(windowsRoot, "RELEASES")),
          setup: await fileIdentity(path.join(windowsRoot, windowsRelease.setup.name)),
        },
        publisher: {
          subject: windowsRelease.signer_subject,
          thumbprint: windowsRelease.signer_thumbprint,
          timestamp_subject: windowsRelease.timestamp_subject,
        },
        runtime: {
          all_pe_signatures_valid: windowsRuntime.all_pe_signatures_valid,
          main_signer_subject: windowsRuntime.main_signer_subject,
          main_signer_thumbprint: windowsRuntime.main_signer_thumbprint,
          manifest_sha256: windowsRuntime.signed_manifest_sha256,
          pack_tree_digest: windowsRuntime.signed_pack_tree_digest,
          pe_file_count: windowsRuntime.pe_file_count,
          publisher_signed_file_count: windowsRuntime.publisher_signed_file_count,
          trust_sha256: windowsRuntime.signed_runtime_trust_sha256,
        },
        upgrade_rollback: windowsUpgrade,
        evidence: {
          release: await fileIdentity(path.join(windowsRoot, "desktop-r1-windows-x64-identity.json")),
          runtime: await fileIdentity(path.join(windowsRoot, "desktop-r1-windows-runtime-identity.json")),
          upgrade_rollback: await fileIdentity(path.join(windowsRoot, "desktop-r1-windows-upgrade-rollback.json")),
        },
      },
    },
  };
  if (!plan.platforms.macos_arm64.publisher.app_notarized_and_stapled
    || !plan.platforms.macos_arm64.publisher.dmg_notarized_and_stapled
    || !plan.platforms.windows_x64.publisher.timestamp_subject
    || !plan.platforms.windows_x64.runtime.all_pe_signatures_valid) {
    fail("desktop_release_plan_publisher_readback_invalid");
  }
  await verifyInnerArtifacts(plan, macRoot, windowsRoot);
  const outputPath = path.resolve(options.output);
  await writeFile(outputPath, jsonBytes(plan));
  const planIdentity = await fileIdentity(outputPath);
  process.stdout.write(`${JSON.stringify({ status: "ok", ...planIdentity })}\n`);
}

async function verify(options) {
  for (const key of ["plan", "plan_sha256", "source_run_id", "commit", "tag", "mac_root", "windows_root"]) {
    if (!options[key]) fail(`desktop_release_plan_argument_missing:${key}`);
  }
  const planPath = path.resolve(options.plan);
  const planIdentity = await fileIdentity(planPath);
  if (planIdentity.sha256 !== digest(options.plan_sha256, "desktop_release_plan_sha_invalid")) {
    fail("desktop_release_plan_sha_mismatch");
  }
  const plan = await readJson(planPath);
  if (plan.schema_version !== "bizhub.desktop-release-plan.v1") fail("desktop_release_plan_schema_invalid");
  if (
    plan.source_run.id !== Number(options.source_run_id)
    || plan.source_run.commit !== options.commit
    || plan.release.tag !== options.tag
  ) {
    fail("desktop_release_plan_requested_identity_mismatch");
  }
  await verifyInnerArtifacts(plan, path.resolve(options.mac_root), path.resolve(options.windows_root));
  process.stdout.write(`${JSON.stringify({ status: "ok", plan_sha256: planIdentity.sha256 })}\n`);
}

const options = parseArguments(process.argv.slice(2));
if (options.command === "build") await build(options);
else if (options.command === "verify") await verify(options);
else fail("desktop_release_plan_command_invalid");
