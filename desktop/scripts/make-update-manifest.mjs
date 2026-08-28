import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(code) {
  throw new Error(code);
}

function releaseAssetUrl(repository, tag, filename) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail("desktop_update_repository_invalid");
  if (!/^desktop-v[0-9A-Za-z._-]+$/.test(tag)) fail("desktop_update_tag_invalid");
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
}

async function identity(filePath) {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 1) fail("desktop_update_artifact_invalid");
  return {
    bytes: metadata.size,
    sha256: createHash("sha256").update(await readFile(filePath)).digest("hex"),
  };
}

export async function createUpdateManifest({
  version,
  repository,
  tag,
  macosPath,
  windowsPath,
  publishedAt,
  releaseNotes,
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail("desktop_update_version_invalid");
  if (!Number.isFinite(Date.parse(publishedAt))) fail("desktop_update_published_at_invalid");
  if (typeof releaseNotes !== "string" || releaseNotes.length > 4000) fail("desktop_update_release_notes_invalid");
  const [macos, windows] = await Promise.all([identity(macosPath), identity(windowsPath)]);
  const macosName = path.basename(macosPath);
  const windowsName = path.basename(windowsPath);
  if (!macosName.endsWith(".zip")) fail("desktop_update_macos_filename_invalid");
  if (!windowsName.toLowerCase().endsWith(".exe")) fail("desktop_update_windows_filename_invalid");
  return {
    schema_version: "bizhub.desktop-update.v1",
    version,
    published_at: new Date(publishedAt).toISOString(),
    release_notes: releaseNotes,
    platforms: {
      "darwin-arm64": {
        kind: "macos-zip",
        url: releaseAssetUrl(repository, tag, macosName),
        bytes: macos.bytes,
        sha256: macos.sha256,
      },
      "win32-x64": {
        kind: "windows-squirrel-setup",
        url: releaseAssetUrl(repository, tag, windowsName),
        bytes: windows.bytes,
        sha256: windows.sha256,
      },
    },
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail("desktop_update_manifest_argument_invalid");
    options[name.slice(2)] = value;
  }
  for (const required of ["version", "repository", "tag", "macos", "windows", "published-at", "output"]) {
    if (!options[required]) fail(`desktop_update_manifest_argument_missing:${required}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = await createUpdateManifest({
    version: options.version,
    repository: options.repository,
    tag: options.tag,
    macosPath: path.resolve(options.macos),
    windowsPath: path.resolve(options.windows),
    publishedAt: options["published-at"],
    releaseNotes: options.notes || "BizHub Desktop 内部更新。",
  });
  await writeFile(path.resolve(options.output), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
