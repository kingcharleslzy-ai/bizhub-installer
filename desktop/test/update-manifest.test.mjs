import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createUpdateManifest } from "../scripts/make-update-manifest.mjs";

test("builds one release-bound manifest for both native installers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bizhub-update-manifest-"));
  try {
    const macosPath = path.join(root, "BizHub-Desktop-macOS-arm64-0.1.1.zip");
    const windowsPath = path.join(root, "BizHub-Desktop-Setup-Windows-x64-0.1.1.exe");
    await writeFile(macosPath, "macos");
    await writeFile(windowsPath, "windows");
    const manifest = await createUpdateManifest({
      version: "0.1.1",
      repository: "kingcharleslzy-ai/bizhub-installer",
      tag: "desktop-v0.1.1-internal.7",
      macosPath,
      windowsPath,
      publishedAt: "2026-08-28T00:00:00Z",
      releaseNotes: "Updater test",
    });
    assert.equal(manifest.version, "0.1.1");
    assert.equal(manifest.platforms["darwin-arm64"].bytes, 5);
    assert.equal(
      manifest.platforms["win32-x64"].sha256,
      createHash("sha256").update("windows").digest("hex"),
    );
    assert.match(manifest.platforms["darwin-arm64"].url, /desktop-v0.1.1-internal.7/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
