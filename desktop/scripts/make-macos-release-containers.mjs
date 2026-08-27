import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(code) {
  throw new Error(code);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status !== 0) {
    fail(`desktop_macos_container_command_failed:${path.basename(command)}:${result.status}:${output.trim().slice(0, 4096)}`);
  }
  return output;
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const appPath = path.resolve(
  process.env.BIZHUB_MACOS_PACKAGED_APP
    || path.join(ROOT, "out", "BizHub Desktop-darwin-arm64", "BizHub Desktop.app"),
);
const outputRoot = path.resolve(
  process.env.BIZHUB_MACOS_RELEASE_OUTPUT || path.join(ROOT, "out", "release"),
);
const signingMode = process.env.BIZHUB_MACOS_SIGNING_MODE || "";
const signingIdentity = process.env.BIZHUB_MACOS_SIGNING_IDENTITY || "";
const signingKeychain = process.env.BIZHUB_MACOS_KEYCHAIN || "";
const expectedTeamId = process.env.BIZHUB_MACOS_TEAM_ID || "";
const appleApiKey = process.env.BIZHUB_APPLE_API_KEY_FILE || "";
const appleApiKeyId = process.env.BIZHUB_APPLE_API_KEY_ID || "";
const appleApiIssuer = process.env.BIZHUB_APPLE_API_ISSUER || "";
if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail("desktop_macos_container_host_invalid");
}
if (!new Set(["synthetic-ci", "production"]).has(signingMode)) {
  fail("desktop_macos_container_signing_mode_invalid");
}
if (!signingIdentity || /[\r\n\0]/.test(signingIdentity)) {
  fail("desktop_macos_container_signing_identity_invalid");
}
if (
  signingMode === "production"
  && (!appleApiKey || !appleApiKeyId || !appleApiIssuer)
) {
  fail("desktop_macos_container_notary_credentials_missing");
}
if (!(await lstat(appPath)).isDirectory() || !appPath.endsWith(".app")) {
  fail("desktop_macos_container_app_invalid");
}

const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const artifactStem = `BizHub-Desktop-${packageJson.version}-macOS-arm64`;
const zipPath = path.join(outputRoot, `${artifactStem}.zip`);
const dmgPath = path.join(outputRoot, `${artifactStem}.dmg`);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

if (signingMode === "production") {
  run("/usr/bin/xcrun", ["stapler", "validate", appPath]);
}
run("/usr/bin/ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  appPath,
  zipPath,
]);

const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "bizhub-desktop-dmg-"));
try {
  run("/usr/bin/ditto", [appPath, path.join(stagingRoot, "BizHub Desktop.app")]);
  await symlink("/Applications", path.join(stagingRoot, "Applications"));
  run("/usr/bin/hdiutil", [
    "create",
    "-volname",
    "BizHub Desktop",
    "-srcfolder",
    stagingRoot,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ]);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

const dmgSignArgs = ["--force", "--sign", signingIdentity];
if (signingKeychain) dmgSignArgs.push("--keychain", signingKeychain);
if (signingMode === "production") dmgSignArgs.push("--timestamp");
else dmgSignArgs.push("--timestamp=none");
dmgSignArgs.push(dmgPath);
run("/usr/bin/codesign", dmgSignArgs);
run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", dmgPath]);
if (signingMode === "production") {
  run("/usr/bin/xcrun", [
    "notarytool",
    "submit",
    dmgPath,
    "--key",
    appleApiKey,
    "--key-id",
    appleApiKeyId,
    "--issuer",
    appleApiIssuer,
    "--wait",
  ]);
  run("/usr/bin/xcrun", ["stapler", "staple", dmgPath]);
  run("/usr/bin/xcrun", ["stapler", "validate", dmgPath]);
}

const zipMetadata = await stat(zipPath);
const dmgMetadata = await stat(dmgPath);
const identity = {
  status: "ok",
  schema_version: "bizhub.desktop-macos-containers.v1",
  signing_mode: signingMode,
  package_version: packageJson.version,
  zip: {
    name: path.basename(zipPath),
    bytes: zipMetadata.size,
    sha256: await sha256File(zipPath),
  },
  dmg: {
    name: path.basename(dmgPath),
    bytes: dmgMetadata.size,
    sha256: await sha256File(dmgPath),
    notary_staple_readback: signingMode === "production",
  },
  publisher_team_id: expectedTeamId || null,
};
const identityPath = path.join(outputRoot, "desktop-r1-macos-containers.json");
await writeFile(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(identity)}\n`);
