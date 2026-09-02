import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const {
  currentMacBundlePath,
  finalizePendingMacUpdate,
  pendingMacUpdatePath,
  prepareMacUpdate,
} = require("../electron/update-installer.cjs");
const execFileAsync = promisify(execFile);
const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));

test("derives only a real macOS application bundle path", { skip: process.platform !== "darwin" }, () => {
  assert.equal(
    currentMacBundlePath("/Applications/BizHub Desktop.app/Contents/MacOS/BizHub Desktop"),
    "/Applications/BizHub Desktop.app",
  );
  assert.throws(() => currentMacBundlePath("/tmp/BizHub Desktop"), /desktop_update_macos_bundle_path_invalid/);
});

test("validates the macOS ZIP bundle id and exact version before installation", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-macos-update-"));
  try {
    const source = path.join(root, "source");
    const bundle = path.join(source, "BizHub Desktop.app");
    const contents = path.join(bundle, "Contents");
    await mkdir(path.join(contents, "MacOS"), { recursive: true });
    await writeFile(path.join(contents, "MacOS", "BizHub Desktop"), "synthetic");
    await writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.bizhub.desktop</string>
<key>CFBundleShortVersionString</key><string>0.1.1</string>
</dict></plist>\n`);
    const archive = path.join(root, "update.zip");
    await execFileAsync("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archive]);
    const staged = await prepareMacUpdate({
      artifactPath: archive,
      version: "0.1.1",
      updateRoot: path.join(root, "updates"),
    });
    assert.ok(staged.endsWith("BizHub Desktop.app"));
    await assert.rejects(
      prepareMacUpdate({ artifactPath: archive, version: "0.1.2", updateRoot: path.join(root, "wrong") }),
      /desktop_update_macos_bundle_identity_invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes the macOS rollback bundle only after exact-version startup", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-macos-finalize-"));
  try {
    const destination = path.join(root, "BizHub Desktop.app");
    const executablePath = path.join(destination, "Contents", "MacOS", "BizHub Desktop");
    const backup = `${destination}.bizhub-backup-0.1.1`;
    const updateRoot = path.join(root, "updates");
    await mkdir(path.dirname(executablePath), { recursive: true });
    await mkdir(backup, { recursive: true });
    await mkdir(updateRoot, { recursive: true });
    await writeFile(executablePath, "synthetic");
    await writeFile(pendingMacUpdatePath(updateRoot), `${JSON.stringify({
      schema_version: "bizhub.desktop-pending-update.v1",
      expected_version: "0.1.1",
      destination,
      backup,
    })}\n`);
    assert.deepEqual(await finalizePendingMacUpdate({
      executablePath,
      currentVersion: "0.1.1",
      updateRoot,
    }), { status: "finalized" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes a real asar rollback bundle under Electron's patched fs", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-electron-asar-finalize-"));
  try {
    const destination = path.join(root, "BizHub Desktop.app");
    const executablePath = path.join(destination, "Contents", "MacOS", "BizHub Desktop");
    const backup = `${destination}.bizhub-backup-0.1.16`;
    const updateRoot = path.join(root, "updates");
    const asarSource = path.join(root, "asar-source");
    const probe = path.join(root, "electron-finalize-probe.cjs");
    await mkdir(path.dirname(executablePath), { recursive: true });
    await mkdir(path.join(backup, "Contents", "Resources"), { recursive: true });
    await mkdir(asarSource, { recursive: true });
    await mkdir(updateRoot, { recursive: true });
    await writeFile(executablePath, "synthetic");
    await writeFile(path.join(asarSource, "index.js"), "module.exports = 'synthetic';\n");
    const { createPackage } = await import("@electron/asar");
    await createPackage(asarSource, path.join(backup, "Contents", "Resources", "app.asar"));
    await writeFile(pendingMacUpdatePath(updateRoot), `${JSON.stringify({
      schema_version: "bizhub.desktop-pending-update.v1",
      expected_version: "0.1.16",
      destination,
      backup,
    })}\n`);
    await writeFile(probe, `
const [modulePath, executablePath, currentVersion, updateRoot] = process.argv.slice(2);
const { finalizePendingMacUpdate } = require(modulePath);
finalizePendingMacUpdate({ executablePath, currentVersion, updateRoot })
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error) => { console.error(error); process.exitCode = 1; });
`);
    const electronPath = require("electron");
    const installerPath = path.join(TEST_ROOT, "..", "electron", "update-installer.cjs");
    const { stdout } = await execFileAsync(
      electronPath,
      [probe, installerPath, executablePath, "0.1.16", updateRoot],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    );
    assert.deepEqual(JSON.parse(stdout), { status: "finalized" });
    await assert.rejects(access(backup), { code: "ENOENT" });
    await assert.rejects(access(pendingMacUpdatePath(updateRoot)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains a macOS pending record that names any non-exact backup path", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-macos-finalize-path-"));
  try {
    const destination = path.join(root, "BizHub Desktop.app");
    const executablePath = path.join(destination, "Contents", "MacOS", "BizHub Desktop");
    const updateRoot = path.join(root, "updates");
    const unrelated = path.join(root, "unrelated");
    await mkdir(path.dirname(executablePath), { recursive: true });
    await mkdir(unrelated, { recursive: true });
    await mkdir(updateRoot, { recursive: true });
    await writeFile(executablePath, "synthetic");
    await writeFile(pendingMacUpdatePath(updateRoot), `${JSON.stringify({
      schema_version: "bizhub.desktop-pending-update.v1",
      expected_version: "0.1.1",
      destination,
      backup: unrelated,
    })}\n`);
    assert.deepEqual(await finalizePendingMacUpdate({
      executablePath,
      currentVersion: "0.1.1",
      updateRoot,
    }), { status: "retained" });
    await access(unrelated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
