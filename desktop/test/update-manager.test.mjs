import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  checkForUpdate,
  compareVersions,
  downloadUpdateArtifact,
  normalizeUpdateConfig,
  selectManifestUrl,
  validateUpdateManifest,
} = require("../electron/update-manager.cjs");

const CONFIG = {
  schema_version: "bizhub.desktop-update-channel.v1",
  enabled: true,
  auto_download: true,
  check_interval_hours: 24,
  include_prerelease: true,
  release_api_url: "https://api.github.com/repos/example/bizhub/releases?per_page=20",
  tag_prefix: "desktop-v",
  manifest_asset_name: "desktop-update.json",
  allowed_hosts: ["api.github.com", "github.com", "release-assets.githubusercontent.com"],
};

function manifest(overrides = {}) {
  return {
    schema_version: "bizhub.desktop-update.v1",
    version: "0.1.1",
    published_at: "2026-08-28T00:00:00.000Z",
    release_notes: "简化应用内更新。",
    platforms: {
      "darwin-arm64": {
        kind: "macos-zip",
        url: "https://github.com/example/bizhub/releases/download/desktop-v0.1.1/BizHub-Desktop-macOS-arm64-0.1.1.zip",
        bytes: 123,
        sha256: "a".repeat(64),
      },
      "win32-x64": {
        kind: "windows-squirrel-setup",
        url: "https://github.com/example/bizhub/releases/download/desktop-v0.1.1/BizHub-Desktop-Setup-Windows-x64-0.1.1.exe",
        bytes: 456,
        sha256: "b".repeat(64),
      },
    },
    ...overrides,
  };
}

test("compares stable and prerelease Desktop versions", () => {
  assert.equal(compareVersions("0.1.1", "0.1.0"), 1);
  assert.equal(compareVersions("0.1.1", "0.1.1"), 0);
  assert.equal(compareVersions("0.1.1-beta.2", "0.1.1-beta.1"), 1);
  assert.equal(compareVersions("0.1.1", "0.1.1-beta.9"), 1);
  assert.throws(() => compareVersions("latest", "0.1.0"), /desktop_update_version_invalid/);
});

test("selects only a non-draft Desktop release manifest", () => {
  const config = normalizeUpdateConfig(CONFIG);
  const releases = [
    { draft: true, tag_name: "desktop-v9.0.0", assets: [{ name: "desktop-update.json", browser_download_url: "https://github.com/draft" }] },
    { draft: false, prerelease: true, tag_name: "desktop-v0.1.1", assets: [{ name: "desktop-update.json", browser_download_url: "https://github.com/update.json" }] },
    { draft: false, tag_name: "v0.7.0", assets: [{ name: "desktop-update.json", browser_download_url: "https://github.com/wrong.json" }] },
  ];
  assert.equal(selectManifestUrl(releases, config), "https://github.com/update.json");
});

test("validates platform-specific artifact identity and host", () => {
  const config = normalizeUpdateConfig(CONFIG);
  const validated = validateUpdateManifest(manifest(), {
    allowedHosts: config.allowedHosts,
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(validated.version, "0.1.1");
  assert.equal(validated.asset.kind, "macos-zip");
  assert.throws(
    () => validateUpdateManifest(manifest({ platforms: { "darwin-arm64": { ...manifest().platforms["darwin-arm64"], url: "https://evil.example/update.zip" } } }), {
      allowedHosts: config.allowedHosts,
      platform: "darwin",
      arch: "arm64",
    }),
    /desktop_update_host_rejected/,
  );
});

test("checks the immutable release manifest and reports an available update", async () => {
  const releases = [{
    draft: false,
    prerelease: true,
    tag_name: "desktop-v0.1.1-internal.1",
    assets: [{
      name: "desktop-update.json",
      browser_download_url: "https://github.com/example/bizhub/releases/download/desktop-v0.1.1-internal.1/desktop-update.json",
    }],
  }];
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    return new Response(JSON.stringify(requests.length === 1 ? releases : manifest()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await checkForUpdate({
    fetchImpl,
    config: CONFIG,
    currentVersion: "0.1.0",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(result.status, "available");
  assert.equal(result.manifest.version, "0.1.1");
  assert.equal(requests.length, 2);
});

test("downloads atomically and rejects a tampered artifact", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-update-test-"));
  try {
    const payload = Buffer.from("synthetic-bizhub-update");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const destination = path.join(temporaryRoot, "update.zip");
    const asset = {
      url: "https://github.com/example/update.zip",
      bytes: payload.length,
      sha256,
    };
    const fetchImpl = async () => new Response(payload, { status: 200 });
    const downloaded = await downloadUpdateArtifact({
      fetchImpl,
      asset,
      allowedHosts: CONFIG.allowed_hosts,
      destination,
    });
    assert.equal(downloaded.sha256, sha256);
    assert.deepEqual(await readFile(destination), payload);

    await assert.rejects(
      downloadUpdateArtifact({
        fetchImpl,
        asset: { ...asset, sha256: "0".repeat(64) },
        allowedHosts: CONFIG.allowed_hosts,
        destination: path.join(temporaryRoot, "tampered.zip"),
      }),
      /desktop_update_download_sha256_mismatch/,
    );
    await assert.rejects(access(path.join(temporaryRoot, "tampered.zip.partial")));
    await assert.rejects(access(path.join(temporaryRoot, "tampered.zip")));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
