import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(code) {
  throw new Error(code);
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateReleaseTag(version, tag) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail("desktop_release_package_version_invalid");
  }
  const pattern = new RegExp(`^desktop-v${escaped(version)}(?:-preview\\.[1-9]\\d*)?$`);
  if (typeof tag !== "string" || !pattern.test(tag)) {
    fail("desktop_release_tag_version_mismatch");
  }
  return tag;
}

export function validateProductionDirectory(payload) {
  if (
    !payload
    || payload.schema_version !== "bizhub.desktop-account-directory.v1"
    || typeof payload.resolve_url !== "string"
  ) {
    fail("desktop_release_directory_config_invalid");
  }
  const endpoint = new URL(payload.resolve_url);
  if (
    endpoint.protocol !== "https:"
    || endpoint.port !== ""
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || endpoint.pathname !== "/v1/desktop/workspaces/resolve"
  ) {
    fail("desktop_release_directory_endpoint_not_standard_https");
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (
    isIP(hostname)
    || hostname === "nip.io"
    || hostname.endsWith(".nip.io")
    || hostname === "sslip.io"
    || hostname.endsWith(".sslip.io")
  ) {
    fail("desktop_release_directory_hostname_not_owned");
  }
  return endpoint.href;
}

export function validateReleaseCommit(expected, actual) {
  if (!/^[0-9a-f]{40}$/.test(expected || "") || expected !== actual) {
    fail("desktop_release_commit_mismatch");
  }
  return actual;
}

export async function runPreflight({
  mode,
  releaseTag,
  releaseCommit,
  githubRef,
  actualCommit,
  packagePath = path.join(ROOT, "package.json"),
  directoryPath = path.join(ROOT, "config", "account-directory.json"),
}) {
  if (!new Set(["synthetic-ci", "production"]).has(mode)) {
    fail("desktop_release_signing_mode_invalid");
  }
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const result = {
    status: "ready",
    schema_version: "bizhub.desktop-release-preflight.v1",
    signing_mode: mode,
    package_version: packageJson.version,
    release_tag: null,
    release_commit: actualCommit,
    production_directory: false,
  };
  if (mode === "production") {
    if (githubRef !== "refs/heads/main") fail("desktop_release_requires_main");
    result.release_tag = validateReleaseTag(packageJson.version, releaseTag);
    validateReleaseCommit(releaseCommit, actualCommit);
    const directory = JSON.parse(await readFile(directoryPath, "utf8"));
    validateProductionDirectory(directory);
    result.production_directory = true;
  }
  return result;
}

async function main() {
  const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(ROOT, ".."),
    encoding: "utf8",
  }).trim();
  const result = await runPreflight({
    mode: process.env.BIZHUB_DESKTOP_RELEASE_MODE || "",
    releaseTag: process.env.BIZHUB_DESKTOP_RELEASE_TAG || "",
    releaseCommit: process.env.BIZHUB_DESKTOP_RELEASE_COMMIT || "",
    githubRef: process.env.GITHUB_REF || "",
    actualCommit,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
