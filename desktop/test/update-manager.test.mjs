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
  downloadUpdateArtifactWithFallback,
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
  primary_manifest_url: "https://qilinshuzhi.com/bizhub-updates/latest.json",
  release_api_url: "https://api.github.com/repos/example/bizhub/releases?per_page=20",
  tag_prefix: "desktop-v",
  manifest_asset_name: "desktop-update.json",
  allowed_hosts: ["qilinshuzhi.com", "api.github.com", "github.com", "release-assets.githubusercontent.com"],
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

function primaryManifest(overrides = {}) {
  const value = manifest(overrides);
  return {
    ...value,
    platforms: Object.fromEntries(Object.entries(value.platforms).map(([key, asset]) => [
      key,
      {
        ...asset,
        url: `https://qilinshuzhi.com/bizhub-updates/releases/desktop-v${value.version}/${path.basename(new URL(asset.url).pathname)}`,
      },
    ])),
  };
}

function githubReleases(version = "0.1.1") {
  return [{
    draft: false,
    prerelease: true,
    tag_name: `desktop-v${version}-internal.1`,
    assets: [{
      name: "desktop-update.json",
      browser_download_url: `https://github.com/example/bizhub/releases/download/desktop-v${version}-internal.1/desktop-update.json`,
    }],
  }];
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

test("prefers the Aliyun manifest and keeps an identical GitHub artifact fallback", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const payload = url === CONFIG.primary_manifest_url
      ? primaryManifest()
      : url === CONFIG.release_api_url
        ? githubReleases()
        : manifest();
    return new Response(JSON.stringify(payload), {
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
  assert.equal(result.source, "primary");
  assert.equal(result.manifest.version, "0.1.1");
  assert.equal(result.manifest.asset.url.startsWith("https://qilinshuzhi.com/"), true);
  assert.equal(result.fallbackManifest.asset.url.startsWith("https://github.com/"), true);
  assert.equal(requests.length, 3);
});

test("uses GitHub when the primary manifest is unavailable", async () => {
  const fetchImpl = async (url) => {
    if (url === CONFIG.primary_manifest_url) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify(url === CONFIG.release_api_url ? githubReleases() : manifest()), {
      status: 200,
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
  assert.equal(result.source, "github");
  assert.equal(result.fallbackManifest, null);
});

test("uses a newer GitHub release when the primary mirror is stale", async () => {
  const fetchImpl = async (url) => {
    const payload = url === CONFIG.primary_manifest_url
      ? primaryManifest({ version: "0.1.1" })
      : url === CONFIG.release_api_url
        ? githubReleases("0.1.2")
        : manifest({ version: "0.1.2" });
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const result = await checkForUpdate({
    fetchImpl,
    config: CONFIG,
    currentVersion: "0.1.1",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(result.status, "available");
  assert.equal(result.source, "github");
  assert.equal(result.manifest.version, "0.1.2");
});

test("fails only when both update metadata sources are unavailable", async () => {
  await assert.rejects(
    checkForUpdate({
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
      config: CONFIG,
      currentVersion: "0.1.0",
      platform: "darwin",
      arch: "arm64",
    }),
    /desktop_update_sources_unavailable/,
  );
});

test("does not attach a mismatched GitHub artifact as download fallback", async () => {
  const fetchImpl = async (url) => {
    let payload;
    if (url === CONFIG.primary_manifest_url) payload = primaryManifest();
    else if (url === CONFIG.release_api_url) payload = githubReleases();
    else {
      const value = manifest();
      value.platforms["darwin-arm64"].sha256 = "c".repeat(64);
      payload = value;
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const result = await checkForUpdate({
    fetchImpl,
    config: CONFIG,
    currentVersion: "0.1.0",
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(result.source, "primary");
  assert.equal(result.fallbackManifest, null);
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

test("retries an identical artifact from GitHub when the Aliyun download fails", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-update-fallback-test-"));
  try {
    const payload = Buffer.from("synthetic-bizhub-update-fallback");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const common = {
      kind: "macos-zip",
      bytes: payload.length,
      filename: "BizHub-Desktop-macOS-arm64-0.1.8.zip",
      sha256,
    };
    const primaryAsset = {
      ...common,
      url: "https://qilinshuzhi.com/bizhub-updates/releases/desktop-v0.1.8/BizHub-Desktop-macOS-arm64-0.1.8.zip",
    };
    const fallbackAsset = {
      ...common,
      url: "https://github.com/example/bizhub/releases/download/desktop-v0.1.8/BizHub-Desktop-macOS-arm64-0.1.8.zip",
    };
    const requested = [];
    const downloaded = await downloadUpdateArtifactWithFallback({
      fetchImpl: async (url) => {
        requested.push(url);
        return url === primaryAsset.url
          ? new Response("unavailable", { status: 503 })
          : new Response(payload, { status: 200 });
      },
      asset: primaryAsset,
      fallbackAsset,
      allowedHosts: CONFIG.allowed_hosts,
      destination: path.join(temporaryRoot, common.filename),
    });
    assert.equal(downloaded.source, "github");
    assert.deepEqual(await readFile(downloaded.path), payload);
    assert.deepEqual(requested, [primaryAsset.url, fallbackAsset.url]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
