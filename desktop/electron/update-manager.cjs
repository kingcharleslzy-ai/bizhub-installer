const { createHash } = require("node:crypto");
const { mkdir, open, rename, rm } = require("node:fs/promises");
const path = require("node:path");

const RELEASE_LIST_MAX_BYTES = 512 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
const ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;

function fail(code) {
  throw new Error(code);
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || ""));
  if (!match) fail("desktop_update_version_invalid");
  return {
    numbers: match.slice(1, 4).map((part) => Number(part)),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference !== 0) return Math.sign(difference);
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const difference = left[index].localeCompare(right[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  for (let index = 0; index < left.numbers.length; index += 1) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function platformKey(platform, arch) {
  const key = `${platform}-${arch}`;
  if (!["darwin-arm64", "win32-x64"].includes(key)) {
    fail("desktop_update_platform_unsupported");
  }
  return key;
}

function validateHttpsUrl(value, allowedHosts, errorCode = "desktop_update_url_invalid") {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    fail(errorCode);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) fail(errorCode);
  if (!allowedHosts.includes(parsed.hostname.toLowerCase())) fail("desktop_update_host_rejected");
  return parsed.toString();
}

function normalizeUpdateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("desktop_update_config_invalid");
  }
  if (value.schema_version !== "bizhub.desktop-update-channel.v1") {
    fail("desktop_update_config_schema_invalid");
  }
  if (typeof value.enabled !== "boolean" || typeof value.auto_download !== "boolean") {
    fail("desktop_update_config_flags_invalid");
  }
  if (!Array.isArray(value.allowed_hosts) || value.allowed_hosts.length === 0) {
    fail("desktop_update_allowed_hosts_invalid");
  }
  const allowedHosts = [...new Set(value.allowed_hosts.map((host) => String(host).toLowerCase()))];
  if (allowedHosts.some((host) => !/^[a-z0-9.-]+$/.test(host))) {
    fail("desktop_update_allowed_hosts_invalid");
  }
  const intervalHours = Number(value.check_interval_hours);
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) {
    fail("desktop_update_check_interval_invalid");
  }
  const releaseApiUrl = validateHttpsUrl(
    value.release_api_url,
    allowedHosts,
    "desktop_update_release_api_url_invalid",
  );
  const tagPrefix = String(value.tag_prefix || "");
  const manifestAssetName = String(value.manifest_asset_name || "");
  if (!/^desktop-v[0-9A-Za-z._-]*$/.test(tagPrefix)) fail("desktop_update_tag_prefix_invalid");
  if (!/^desktop-update(?:-[0-9A-Za-z._-]+)?\.json$/.test(manifestAssetName)) {
    fail("desktop_update_manifest_asset_name_invalid");
  }
  return {
    enabled: value.enabled,
    autoDownload: value.auto_download,
    allowedHosts,
    checkIntervalHours: intervalHours,
    includePrerelease: value.include_prerelease === true,
    releaseApiUrl,
    tagPrefix,
    manifestAssetName,
  };
}

async function readBoundedBody(response, maximumBytes, sizeError) {
  const contentLength = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) fail(sizeError);
  if (!response.body || typeof response.body.getReader !== "function") {
    fail("desktop_update_response_body_invalid");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        await reader.cancel(sizeError);
        fail(sizeError);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, bytes);
}

async function fetchBoundedJson({ fetchImpl, url, allowedHosts, maximumBytes, timeoutMs, sizeError }) {
  const requestedUrl = validateHttpsUrl(url, allowedHosts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(requestedUrl, {
      headers: { Accept: "application/json", "User-Agent": "BizHub-Desktop-Updater" },
      redirect: "follow",
      signal: controller.signal,
    });
    validateHttpsUrl(response.url || requestedUrl, allowedHosts);
    if (!response.ok) fail(`desktop_update_http_${response.status}`);
    const payload = await readBoundedBody(response, maximumBytes, sizeError);
    try {
      return JSON.parse(payload.toString("utf8"));
    } catch {
      fail("desktop_update_json_invalid");
    }
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") fail("desktop_update_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function selectManifestUrl(releases, config) {
  if (!Array.isArray(releases)) fail("desktop_update_release_list_invalid");
  for (const release of releases.slice(0, 50)) {
    if (!release || typeof release !== "object" || release.draft === true) continue;
    if (!config.includePrerelease && release.prerelease === true) continue;
    if (!String(release.tag_name || "").startsWith(config.tagPrefix)) continue;
    const asset = Array.isArray(release.assets)
      ? release.assets.find((candidate) => candidate?.name === config.manifestAssetName)
      : null;
    if (!asset) continue;
    return validateHttpsUrl(asset.browser_download_url, config.allowedHosts);
  }
  return "";
}

function validateUpdateManifest(value, { allowedHosts, platform, arch }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("desktop_update_manifest_invalid");
  }
  if (value.schema_version !== "bizhub.desktop-update.v1") {
    fail("desktop_update_manifest_schema_invalid");
  }
  const version = String(value.version || "");
  parseVersion(version);
  const publishedAt = String(value.published_at || "");
  if (!Number.isFinite(Date.parse(publishedAt))) fail("desktop_update_published_at_invalid");
  const releaseNotes = String(value.release_notes || "");
  if (releaseNotes.length > 4000) fail("desktop_update_release_notes_invalid");
  const key = platformKey(platform, arch);
  const asset = value.platforms?.[key];
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    fail("desktop_update_platform_asset_missing");
  }
  const expectedKind = key === "darwin-arm64" ? "macos-zip" : "windows-squirrel-setup";
  if (asset.kind !== expectedKind) fail("desktop_update_artifact_kind_invalid");
  const bytes = Number(asset.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > ARTIFACT_MAX_BYTES) {
    fail("desktop_update_artifact_size_invalid");
  }
  const sha256 = String(asset.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) fail("desktop_update_artifact_sha256_invalid");
  const url = validateHttpsUrl(asset.url, allowedHosts);
  const filename = path.basename(decodeURIComponent(new URL(url).pathname));
  const extensionValid = key === "darwin-arm64"
    ? filename.endsWith(".zip")
    : filename.toLowerCase().endsWith(".exe");
  if (!extensionValid || !/^[0-9A-Za-z._ -]+$/.test(filename)) {
    fail("desktop_update_artifact_filename_invalid");
  }
  return {
    version,
    publishedAt,
    releaseNotes,
    platformKey: key,
    asset: { kind: asset.kind, bytes, filename, sha256, url },
  };
}

async function checkForUpdate({ fetchImpl, config: rawConfig, currentVersion, platform, arch }) {
  const config = normalizeUpdateConfig(rawConfig);
  parseVersion(currentVersion);
  if (!config.enabled) return { status: "disabled", config };
  const releases = await fetchBoundedJson({
    fetchImpl,
    url: config.releaseApiUrl,
    allowedHosts: config.allowedHosts,
    maximumBytes: RELEASE_LIST_MAX_BYTES,
    timeoutMs: 10_000,
    sizeError: "desktop_update_release_list_size_invalid",
  });
  const manifestUrl = selectManifestUrl(releases, config);
  if (!manifestUrl) return { status: "up-to-date", config };
  const rawManifest = await fetchBoundedJson({
    fetchImpl,
    url: manifestUrl,
    allowedHosts: config.allowedHosts,
    maximumBytes: MANIFEST_MAX_BYTES,
    timeoutMs: 10_000,
    sizeError: "desktop_update_manifest_size_invalid",
  });
  const manifest = validateUpdateManifest(rawManifest, {
    allowedHosts: config.allowedHosts,
    platform,
    arch,
  });
  if (compareVersions(manifest.version, currentVersion) <= 0) {
    return { status: "up-to-date", config, manifest };
  }
  return { status: "available", config, manifest, manifestUrl };
}

async function downloadUpdateArtifact({
  fetchImpl,
  asset,
  allowedHosts,
  destination,
  timeoutMs = 30 * 60 * 1000,
  onProgress = () => {},
}) {
  validateHttpsUrl(asset.url, allowedHosts);
  const partial = `${destination}.partial`;
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await rm(partial, { force: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let fileHandle = null;
  let reader = null;
  try {
    const response = await fetchImpl(asset.url, {
      headers: { Accept: "application/octet-stream", "User-Agent": "BizHub-Desktop-Updater" },
      redirect: "follow",
      signal: controller.signal,
    });
    validateHttpsUrl(response.url || asset.url, allowedHosts);
    if (!response.ok) fail(`desktop_update_download_http_${response.status}`);
    const contentLength = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > ARTIFACT_MAX_BYTES) {
      fail("desktop_update_download_size_invalid");
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      fail("desktop_update_response_body_invalid");
    }
    reader = response.body.getReader();
    fileHandle = await open(partial, "wx", 0o600);
    const digest = createHash("sha256");
    let bytes = 0;
    while (true) {
      const chunkResult = await reader.read();
      if (chunkResult.done) break;
      const chunk = Buffer.from(chunkResult.value);
      bytes += chunk.length;
      if (bytes > ARTIFACT_MAX_BYTES || bytes > asset.bytes) {
        await reader.cancel("desktop_update_download_size_invalid");
        fail("desktop_update_download_size_invalid");
      }
      digest.update(chunk);
      await fileHandle.write(chunk);
      onProgress({ bytes, totalBytes: asset.bytes });
    }
    await fileHandle.sync();
    await fileHandle.close();
    fileHandle = null;
    if (bytes !== asset.bytes) fail("desktop_update_download_size_mismatch");
    if (digest.digest("hex") !== asset.sha256) fail("desktop_update_download_sha256_mismatch");
    await rm(destination, { force: true });
    await rename(partial, destination);
    return { path: destination, bytes, sha256: asset.sha256 };
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      await rm(partial, { force: true });
      fail("desktop_update_download_timeout");
    }
    await rm(partial, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
    if (fileHandle) await fileHandle.close().catch(() => {});
    reader?.releaseLock?.();
  }
}

module.exports = {
  ARTIFACT_MAX_BYTES,
  checkForUpdate,
  compareVersions,
  downloadUpdateArtifact,
  normalizeUpdateConfig,
  platformKey,
  selectManifestUrl,
  validateUpdateManifest,
};
