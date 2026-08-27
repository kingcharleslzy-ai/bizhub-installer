import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const extract = require("../vendor/extract-zip-safe/index.js");

test("bounded ZIP extractor rejects lexical path traversal and Windows ambiguity", () => {
  for (const value of [
    "../escape",
    "root/../../escape",
    "/absolute",
    "C:/absolute",
    "root\\windows",
    "root//empty",
    "root/./dot",
  ]) {
    assert.throws(() => extract.safeEntryName(value), /extract_zip_entry_path_invalid/);
  }
  assert.equal(extract.safeEntryName("Electron.app/Contents/MacOS/Electron"), "Electron.app/Contents/MacOS/Electron");
});

test("bounded ZIP extractor allows only in-root relative symlink targets", () => {
  const root = path.resolve("/tmp", "electron-extract-root");
  const destination = path.join(root, "Electron.app", "Versions", "Current");
  assert.equal(extract.safeSymlinkTarget(root, destination, "A"), "A");
  assert.throws(
    () => extract.safeSymlinkTarget(root, destination, "../../../../outside"),
    /extract_zip_symlink_target_escape/,
  );
  assert.throws(
    () => extract.safeSymlinkTarget(root, destination, "/outside"),
    /extract_zip_symlink_target_invalid/,
  );
});
