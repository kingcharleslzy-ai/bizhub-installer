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
  selectManifestRelease,
  validateUpdateManifest,
} = require("../electron/update-manager.cjs");

const CONFIG = {
  schema_version: "bizhub.desktop-update-channel.v1",
  enabled: true,
  auto_download: true,
  check_interval_hours: 24,
  include_prerelease: true,
  artifact_fallback_base_url: "https://qilinshuzhi.com/bizhub-updates/releases/",
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
        url: "https://github.com/example/bizhub/releases/download/desktop-v0.1.1-internal.1/BizHub-Desktop-macOS-arm64-0.1.1.zip",
        bytes: 123,
        sha256: "a".repeat(64),
      },
      "win32-x64": {
        kind: "windows-squirrel-setup",
        url: "https://github.com/example/bizhub/releases/download/desktop-v0.1.1-internal.1/BizHub-Desktop-Setup-Windows-x64-0.1.1.exe",
        bytes: 456,
        sha256: "b".repeat(64),
      },
    },
    ...overrides,
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

test("selects only a non-draft Desktop release manifest and retains its tag identity", () => {
  const config = normalizeUpdateConfig(CONFIG);
  const releases = [
    { draft: true, tag_name: "desktop-v9.0.0", assets: [{ name: "desktop-update.json", browser_download_url: "https://github.com/draft" }] },
    { draft: false, prerelease: true, tag_name: "desktop-v0.1.1", assets: [{ name: "desktop-update.json", browser_download_url: "https://github.com/update.json" }] },
    { draft: false, tag_name: "v0.7.0", assets: [{ name: "desktop-update.json", browser_download_url: "https://github.com/wrong.json" }] },
  ];
  assert.deepEqual(selectManifestRelease(releases, config), {
    manifestUrl: "https://github.com/update.json",
    tagName: "desktop-v0.1.1",
    tagVersion: "0.1.1",
  });
  assert.throws(
    () => selectManifestRelease([{
      draft: false,
      prerelease: true,
      tag_name: "desktop-v0.1.1",
      assets: [{
        name: "desktop-update.json",
        browser_download_url: "https://qilinshuzhi.com/bizhub-updates/latest.json",
      }],
    }], config),
    /desktop_update_host_rejected/,
  );
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

test("uses only the GitHub Release manifest and derives an identical Aliyun fallback", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.includes("qilinshuzhi.com")) {
      throw new Error("desktop_update_test_aliyun_metadata_must_not_be_requested");
    }
    const payload = url === CONFIG.release_api_url ? githubReleases() : manifest();
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
  assert.equal(result.source, "github");
  assert.equal(result.manifest.version, "0.1.1");
  assert.equal(result.manifest.asset.url.startsWith("https://github.com/"), true);
  assert.equal(result.fallbackManifest.asset.url.startsWith("https://qilinshuzhi.com/"), true);
  assert.equal(result.fallbackSource, "aliyun");
  assert.deepEqual(requests, [
    CONFIG.release_api_url,
    "https://github.com/example/bizhub/releases/download/desktop-v0.1.1-internal.1/desktop-update.json",
  ]);
});

test("fails closed when the sole GitHub manifest source is unavailable", async () => {
  await assert.rejects(
    checkForUpdate({
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
      config: CONFIG,
      currentVersion: "0.1.0",
      platform: "darwin",
      arch: "arm64",
    }),
    /desktop_update_http_503/,
  );
});

test("rejects a release whose GitHub manifest version does not match its tag", async () => {
  const fetchImpl = async (url) => {
    const payload = url === CONFIG.release_api_url
      ? githubReleases("0.1.2")
      : manifest({ version: "0.1.1" });
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  await assert.rejects(checkForUpdate({
    fetchImpl,
    config: CONFIG,
    currentVersion: "0.1.0",
    platform: "darwin",
    arch: "arm64",
  }), /desktop_update_release_manifest_version_mismatch/);
});

test("rejects a GitHub manifest that points its primary artifact at the mirror", async () => {
  const fetchImpl = async (url) => {
    const value = manifest();
    value.platforms["darwin-arm64"].url =
      "https://qilinshuzhi.com/bizhub-updates/releases/desktop-v0.1.1-internal.1/BizHub-Desktop-macOS-arm64-0.1.1.zip";
    return new Response(JSON.stringify(url === CONFIG.release_api_url ? githubReleases() : value), {
      status: 200,
    });
  };
  await assert.rejects(checkForUpdate({
    fetchImpl,
    config: CONFIG,
    currentVersion: "0.1.0",
    platform: "darwin",
    arch: "arm64",
  }), /desktop_update_github_artifact_url_invalid/);
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

test("retries the identical Aliyun mirror when the GitHub download fails", async () => {
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
      url: "https://github.com/example/bizhub/releases/download/desktop-v0.1.8/BizHub-Desktop-macOS-arm64-0.1.8.zip",
    };
    const fallbackAsset = {
      ...common,
      url: "https://qilinshuzhi.com/bizhub-updates/releases/desktop-v0.1.8/BizHub-Desktop-macOS-arm64-0.1.8.zip",
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
      fallbackSource: "aliyun",
    });
    assert.equal(downloaded.source, "aliyun");
    assert.deepEqual(await readFile(downloaded.path), payload);
    assert.deepEqual(requested, [primaryAsset.url, fallbackAsset.url]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("falls back to the identical Aliyun mirror when the GitHub download stalls", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-update-stall-test-"));
  try {
    const payload = Buffer.from("synthetic-bizhub-update-after-stall");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const common = {
      kind: "macos-zip",
      bytes: payload.length,
      filename: "BizHub-Desktop-macOS-arm64-0.1.14.zip",
      sha256,
    };
    const primaryAsset = {
      ...common,
      url: "https://github.com/example/bizhub/releases/download/desktop-v0.1.14/BizHub-Desktop-macOS-arm64-0.1.14.zip",
    };
    const fallbackAsset = {
      ...common,
      url: "https://qilinshuzhi.com/bizhub-updates/releases/desktop-v0.1.14/BizHub-Desktop-macOS-arm64-0.1.14.zip",
    };
    const requested = [];
    const downloaded = await downloadUpdateArtifactWithFallback({
      fetchImpl: async (url, options) => {
        requested.push(url);
        if (url !== primaryAsset.url) return new Response(payload, { status: 200 });
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
      asset: primaryAsset,
      fallbackAsset,
      allowedHosts: CONFIG.allowed_hosts,
      destination: path.join(temporaryRoot, common.filename),
      timeoutMs: 1_000,
      stallTimeoutMs: 20,
      fallbackSource: "aliyun",
    });
    assert.equal(downloaded.source, "aliyun");
    assert.deepEqual(await readFile(downloaded.path), payload);
    assert.deepEqual(requested, [primaryAsset.url, fallbackAsset.url]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
