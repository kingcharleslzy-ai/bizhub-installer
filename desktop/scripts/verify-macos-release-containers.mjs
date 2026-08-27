import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(code) {
  throw new Error(code);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    fail(`desktop_macos_container_verify_command_failed:${path.basename(command)}:${result.status}:${output.trim().slice(0, 4096)}`);
  }
  return output;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function signatureMetadata(target, mode, expectedTeamId) {
  const output = run("/usr/bin/codesign", ["-dv", "--verbose=4", target]);
  const rawTeamId = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim() || "";
  const teamId = rawTeamId === "not set" ? "" : rawTeamId;
  const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim());
  const timestamp = /^Timestamp=(.+)$/m.exec(output)?.[1]?.trim() || "";
  if (mode === "production") {
    if (teamId !== expectedTeamId) fail("desktop_macos_dmg_team_id_mismatch");
    if (!authorities.some((value) => value.startsWith("Developer ID Application:"))) {
      fail("desktop_macos_dmg_developer_id_missing");
    }
    if (!timestamp) fail("desktop_macos_dmg_timestamp_missing");
  }
  return { authorities, teamId, timestamp };
}

async function singleApp(directory, code) {
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => path.join(directory, entry.name));
  if (candidates.length !== 1) fail(code);
  return candidates[0];
}

const outputRoot = path.resolve(
  process.env.BIZHUB_MACOS_RELEASE_OUTPUT || path.join(ROOT, "out", "release"),
);
const expectedRuntimeTrustPath = path.resolve(
  process.env.BIZHUB_MACOS_SIGNED_RUNTIME_TRUST
    || path.join(ROOT, "runtime-dist", "generic-runtime-trust.json"),
);
const mode = process.env.BIZHUB_MACOS_SIGNING_MODE || "";
const expectedTeamId = process.env.BIZHUB_MACOS_TEAM_ID || "";
if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail("desktop_macos_container_verify_host_invalid");
}
if (!new Set(["synthetic-ci", "production"]).has(mode)) {
  fail("desktop_macos_container_verify_mode_invalid");
}
if (mode === "production" && !/^[A-Z0-9]{10}$/.test(expectedTeamId)) {
  fail("desktop_macos_container_verify_team_id_invalid");
}
if (!(await lstat(expectedRuntimeTrustPath)).isFile()) {
  fail("desktop_macos_container_verify_trust_invalid");
}

const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const artifactStem = `BizHub-Desktop-${packageJson.version}-macOS-arm64`;
const zipPath = path.join(outputRoot, `${artifactStem}.zip`);
const dmgPath = path.join(outputRoot, `${artifactStem}.dmg`);
const identityPath = path.join(outputRoot, "desktop-r1-macos-containers.json");
const identity = JSON.parse(await readFile(identityPath, "utf8"));
for (const [name, filePath] of [["zip", zipPath], ["dmg", dmgPath]]) {
  const metadata = await stat(filePath);
  if (
    identity[name]?.name !== path.basename(filePath)
    || identity[name]?.bytes !== metadata.size
    || identity[name]?.sha256 !== await sha256File(filePath)
  ) {
    fail(`desktop_macos_container_identity_mismatch:${name}`);
  }
}

run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", dmgPath]);
const dmgSignature = signatureMetadata(dmgPath, mode, expectedTeamId);
if (mode === "production") run("/usr/bin/xcrun", ["stapler", "validate", dmgPath]);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "bizhub-desktop-container-review-"));
const zipRoot = path.join(temporaryRoot, "zip");
const mountRoot = path.join(temporaryRoot, "dmg");
await import("node:fs/promises").then(({ mkdir }) => Promise.all([
  mkdir(zipRoot),
  mkdir(mountRoot),
]));
let attached = false;
try {
  run("/usr/bin/ditto", ["-x", "-k", zipPath, zipRoot]);
  const zipApp = await singleApp(zipRoot, "desktop_macos_zip_app_count_invalid");
  const verifierArguments = [
    path.join(ROOT, "scripts", "verify-macos-release.mjs"),
    "--app", zipApp,
    "--expected-runtime-trust", expectedRuntimeTrustPath,
    "--mode", mode,
  ];
  if (mode === "production") verifierArguments.push("--team-id", expectedTeamId);
  run(process.execPath, verifierArguments);

  run("/usr/bin/hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mountRoot,
    dmgPath,
  ]);
  attached = true;
  const dmgApp = await singleApp(mountRoot, "desktop_macos_dmg_app_count_invalid");
  const dmgVerifierArguments = [
    path.join(ROOT, "scripts", "verify-macos-release.mjs"),
    "--app", dmgApp,
    "--expected-runtime-trust", expectedRuntimeTrustPath,
    "--mode", mode,
  ];
  if (mode === "production") dmgVerifierArguments.push("--team-id", expectedTeamId);
  run(process.execPath, dmgVerifierArguments);
} finally {
  if (attached) {
    run("/usr/bin/hdiutil", ["detach", "-force", mountRoot]);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  status: "ok",
  schema_version: "bizhub.desktop-macos-container-verification.v1",
  signing_mode: mode,
  publisher_team_id: dmgSignature.teamId || null,
  zip_sha256: identity.zip.sha256,
  dmg_sha256: identity.dmg.sha256,
  zip_product_verified: true,
  dmg_product_verified: true,
})}\n`);
