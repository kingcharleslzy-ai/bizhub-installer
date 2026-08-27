import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(code) {
  throw new Error(code);
}

export function previousFixtureVersion(current) {
  const match = VERSION_PATTERN.exec(current || "");
  if (!match) fail("desktop_fixture_current_version_invalid");
  const values = match.slice(1).map(Number);
  if (values[2] > 0) return `${values[0]}.${values[1]}.${values[2] - 1}`;
  if (values[1] > 0) return `${values[0]}.${values[1] - 1}.999`;
  if (values[0] > 0) return `${values[0] - 1}.999.999`;
  fail("desktop_fixture_previous_version_unavailable");
}

export async function setPackageVersion(version, root = ROOT) {
  if (!VERSION_PATTERN.test(version || "")) fail("desktop_fixture_version_invalid");
  const packagePath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const packageLock = JSON.parse(await readFile(lockPath, "utf8"));
  if (
    packageJson.name !== "bizhub-desktop"
    || packageLock.name !== "bizhub-desktop"
    || packageLock.packages?.[""]?.name !== "bizhub-desktop"
  ) {
    fail("desktop_fixture_package_identity_invalid");
  }
  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[""].version = version;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
  return { status: "ok", version };
}

async function main() {
  const command = process.argv[2];
  if (command === "previous" && process.argv.length === 4) {
    process.stdout.write(`${previousFixtureVersion(process.argv[3])}\n`);
    return;
  }
  if (command === "set" && process.argv.length === 4) {
    process.stdout.write(`${JSON.stringify(await setPackageVersion(process.argv[3]))}\n`);
    return;
  }
  fail("desktop_fixture_command_invalid");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
