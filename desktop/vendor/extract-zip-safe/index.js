const { createWriteStream, promises: fs } = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { promisify } = require("node:util");
const yauzl = require("yauzl");

const openZip = promisify(yauzl.open);
const MAX_ENTRIES = 16_384;
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;

function fail(code, value = "") {
  throw new Error(value ? `${code}:${value}` : code);
}

function safeEntryName(fileName) {
  if (
    typeof fileName !== "string"
    || fileName.length < 1
    || fileName.length > 4096
    || fileName.includes("\\")
    || fileName.includes("\0")
    || fileName.startsWith("/")
    || /^[A-Za-z]:/.test(fileName)
  ) {
    fail("extract_zip_entry_path_invalid", fileName);
  }
  const trimmed = fileName.endsWith("/") ? fileName.slice(0, -1) : fileName;
  const parts = trimmed.split("/");
  if (parts.some((value) => value === "" || value === "." || value === "..")) {
    fail("extract_zip_entry_path_invalid", fileName);
  }
  return fileName;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && !path.isAbsolute(relative)
    && !relative.split(path.sep).includes("..");
}

function safeSymlinkTarget(root, destination, target) {
  if (
    typeof target !== "string"
    || target.length < 1
    || target.length > 4096
    || target.includes("\0")
    || path.isAbsolute(target)
  ) {
    fail("extract_zip_symlink_target_invalid", target);
  }
  const resolved = path.resolve(path.dirname(destination), target);
  if (!inside(root, resolved)) fail("extract_zip_symlink_target_escape", target);
  return target;
}

async function ensureSafeDirectory(root, directory, mode) {
  if (directory === root) return;
  const relative = path.relative(root, directory);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    fail("extract_zip_directory_escape", directory);
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const metadata = await fs.lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail("extract_zip_parent_not_directory", current);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(current, { mode });
    }
  }
}

function entryKind(entry) {
  const mode = (entry.externalFileAttributes >> 16) & 0xFFFF;
  const type = mode & 0xF000;
  const madeBy = entry.versionMadeBy >> 8;
  const symlink = type === 0xA000;
  const directory = type === 0x4000
    || entry.fileName.endsWith("/")
    || (madeBy === 0 && entry.externalFileAttributes === 16);
  return { directory, mode, symlink };
}

function extractedMode(entryMode, directory, options) {
  let mode = entryMode & 0o777;
  if (!mode) {
    const configured = directory ? options.defaultDirMode : options.defaultFileMode;
    mode = configured ? Number.parseInt(configured, 10) : (directory ? 0o755 : 0o644);
  }
  return mode & 0o777;
}

async function readStream(zipFile, entry) {
  return promisify(zipFile.openReadStream.bind(zipFile))(entry);
}

async function readBounded(stream, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximumBytes) fail("extract_zip_stream_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function extractEntry(zipFile, root, entry, options) {
  safeEntryName(entry.fileName);
  if (entry.fileName.startsWith("__MACOSX/")) return;
  const { directory, mode, symlink } = entryKind(entry);
  if (
    !Number.isSafeInteger(entry.uncompressedSize)
    || entry.uncompressedSize < 0
    || entry.uncompressedSize > MAX_ENTRY_BYTES
  ) {
    fail("extract_zip_entry_size_invalid", entry.fileName);
  }
  const destination = path.resolve(root, ...entry.fileName.split("/").filter(Boolean));
  if (!inside(root, destination)) fail("extract_zip_entry_path_escape", entry.fileName);
  const permissions = extractedMode(mode, directory, options);
  await ensureSafeDirectory(root, directory ? path.dirname(destination) : path.dirname(destination), 0o755);
  if (directory) {
    try {
      const metadata = await fs.lstat(destination);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail("extract_zip_directory_collision", entry.fileName);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(destination, { mode: permissions });
    }
    return;
  }
  const stream = await readStream(zipFile, entry);
  if (symlink) {
    const target = safeSymlinkTarget(
      root,
      destination,
      await readBounded(stream, 4096),
    );
    await fs.symlink(target, destination);
  } else {
    await pipeline(stream, createWriteStream(destination, {
      flags: "wx",
      mode: permissions,
    }));
  }
}

async function extract(zipPath, options) {
  if (!options || !path.isAbsolute(options.dir)) {
    fail("extract_zip_target_must_be_absolute");
  }
  await fs.mkdir(options.dir, { recursive: true });
  const root = await fs.realpath(options.dir);
  const zipFile = await openZip(zipPath, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  let entries = 0;
  let totalBytes = 0;
  let canceled = false;
  return new Promise((resolve, reject) => {
    const abort = (error) => {
      if (canceled) return;
      canceled = true;
      zipFile.close();
      reject(error);
    };
    zipFile.once("error", abort);
    zipFile.once("close", () => {
      if (!canceled) resolve();
    });
    zipFile.on("entry", async (entry) => {
      if (canceled) return;
      try {
        entries += 1;
        totalBytes += entry.uncompressedSize;
        if (entries > MAX_ENTRIES) fail("extract_zip_entry_count_invalid");
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
          fail("extract_zip_total_size_invalid");
        }
        if (options.onEntry) options.onEntry(entry, zipFile);
        await extractEntry(zipFile, root, entry, options);
        zipFile.readEntry();
      } catch (error) {
        abort(error);
      }
    });
    zipFile.readEntry();
  });
}

extract.safeEntryName = safeEntryName;
extract.safeSymlinkTarget = safeSymlinkTarget;
module.exports = extract;
