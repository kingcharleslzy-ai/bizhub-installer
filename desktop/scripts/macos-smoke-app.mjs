import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 冒烟只验加密记住登录等流程，不碰登录钥匙串：换了 Electron 版本后真钥匙串会弹密码框，
// 本机打断使用者，CI 上没人点就一直卡住。
export function smokeKeychainArguments() {
  return process.platform === "darwin" ? ["--use-mock-keychain"] : [];
}

export async function treeDigest(root) {
  const hash = createHash("sha256");
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      hash.update(JSON.stringify([path.relative(root, target), entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file"]));
      if (entry.isDirectory()) await walk(target);
      else if (entry.isSymbolicLink()) hash.update(await readlink(target));
      else if (entry.isFile()) hash.update(createHash("sha256").update(await readFile(target)).digest());
      else throw new Error("desktop_macos_smoke_candidate_entry_invalid");
    }
  }
  await walk(root);
  return hash.digest("hex");
}

// Every invocation gets its own staging path. No host Gatekeeper state is
// changed and the original candidate remains the release authority.
export async function stageMacosSmokeApp({ executable, resources, temporaryRoot }) {
  const mode = process.env.BIZHUB_MACOS_SIGNING_MODE;
  if (!["production", "synthetic-ci"].includes(mode)) throw new Error("desktop_macos_smoke_signing_mode_missing");
  const candidateApp = path.resolve(executable, "..", "..", "..");
  if (!candidateApp.endsWith(".app")
    || executable !== path.join(candidateApp, "Contents", "MacOS", "BizHub Desktop")
    || resources !== path.join(candidateApp, "Contents", "Resources")) {
    throw new Error("desktop_macos_smoke_candidate_paths_invalid");
  }
  const candidateRoot = path.dirname(candidateApp);
  const candidateDigest = await treeDigest(candidateRoot);
  const sourceDigest = await treeDigest(candidateApp);
  const app = path.join(temporaryRoot, "BizHub Desktop.app");
  execFileSync("/usr/bin/ditto", [candidateApp, app]);
  if (await treeDigest(app) !== sourceDigest) throw new Error("desktop_macos_smoke_copy_mismatch");
  return {
    app, mode, temporaryRoot, candidateApp, candidateRoot, candidateDigest, sealedDigest: null,
    executable: path.join(app, "Contents", "MacOS", "BizHub Desktop"),
    resources: path.join(app, "Contents", "Resources"),
  };
}

export function verifyMacosSmokeApp(staged) {
  const args = ["scripts/verify-macos-release.mjs", "--app", staged.app,
    "--expected-runtime-trust", path.join(ROOT, "runtime-dist", "generic-runtime-trust.json"),
    "--mode", staged.mode, "--output", path.join(staged.temporaryRoot, "staged-app-identity.json")];
  if (staged.mode === "production") args.push("--team-id", process.env.BIZHUB_MACOS_TEAM_ID);
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
}

export async function assertMacosSmokeUnchanged(staged) {
  if (await treeDigest(staged.candidateRoot) !== staged.candidateDigest) {
    throw new Error("desktop_macos_smoke_original_candidate_changed");
  }
  if (staged.sealedDigest) {
    if (await treeDigest(staged.app) !== staged.sealedDigest) throw new Error("desktop_macos_smoke_signed_staging_app_changed");
    verifyMacosSmokeApp(staged);
    process.stdout.write(`${JSON.stringify({ status: "ok", original_candidate_unchanged: true, signed_fixture_unchanged: true, signing_mode: staged.mode })}\n`);
  }
}
