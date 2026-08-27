import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { notarize } from "@electron/notarize";
import { sign } from "@electron/osx-sign";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(code) {
  throw new Error(code);
}

export function validateProductionEnvironment(environment) {
  const result = {
    appleApiIssuer: environment.BIZHUB_APPLE_API_ISSUER || "",
    appleApiKey: environment.BIZHUB_APPLE_API_KEY_FILE || "",
    appleApiKeyId: environment.BIZHUB_APPLE_API_KEY_ID || "",
    identity: environment.BIZHUB_MACOS_SIGNING_IDENTITY || "",
    keychain: environment.BIZHUB_MACOS_KEYCHAIN || "",
    mode: environment.BIZHUB_MACOS_SIGNING_MODE || "",
    teamId: environment.BIZHUB_MACOS_TEAM_ID || "",
  };
  if (
    result.mode !== "production"
    || !result.identity
    || !result.keychain
    || !/^[A-Z0-9]{10}$/.test(result.teamId)
    || !result.appleApiKey
    || !result.appleApiKeyId
    || !result.appleApiIssuer
  ) {
    fail("desktop_macos_production_credentials_missing");
  }
  for (const value of Object.values(result)) {
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
      fail("desktop_macos_production_credentials_invalid");
    }
  }
  if (
    !path.isAbsolute(result.appleApiKey)
    || !path.isAbsolute(result.keychain)
    || !/^[A-Z0-9]{10}$/.test(result.appleApiKeyId)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result.appleApiIssuer)
    || !result.identity.startsWith("Developer ID Application: ")
    || !result.identity.endsWith(`(${result.teamId})`)
  ) {
    fail("desktop_macos_production_credentials_invalid");
  }
  return result;
}

export function productionSigningOptions({ appPath, environment, root = ROOT }) {
  const runtimeResourceSegment = `${path.sep}Resources${path.sep}bizhub-runtime`.toLowerCase();
  const entitlements = {
    default: path.join(root, "config", "entitlements.macos.plist"),
    gpu: path.join(root, "config", "entitlements.macos.gpu.plist"),
    plugin: path.join(root, "config", "entitlements.macos.plugin.plist"),
    renderer: path.join(root, "config", "entitlements.macos.renderer.plist"),
  };
  return {
    app: appPath,
    identity: environment.identity,
    keychain: environment.keychain,
    platform: "darwin",
    strictVerify: true,
    ignore: (filePath) => {
      const normalized = path.resolve(filePath).toLowerCase();
      return normalized.endsWith(runtimeResourceSegment)
        || normalized.includes(`${runtimeResourceSegment}${path.sep}`);
    },
    optionsForFile: (filePath) => {
      let entitlement = entitlements.default;
      if (filePath.includes("(Plugin).app")) entitlement = entitlements.plugin;
      else if (filePath.includes("(GPU).app")) entitlement = entitlements.gpu;
      else if (filePath.includes("(Renderer).app")) entitlement = entitlements.renderer;
      return {
        entitlements: entitlement,
        hardenedRuntime: true,
      };
    },
  };
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("desktop_macos_production_signing_host_invalid");
  }
  const environment = validateProductionEnvironment(process.env);
  const appPath = path.resolve(
    process.env.BIZHUB_MACOS_PACKAGED_APP
      || path.join(ROOT, "out", "BizHub Desktop-darwin-arm64", "BizHub Desktop.app"),
  );
  if (!(await lstat(appPath)).isDirectory() || !appPath.endsWith(".app")) {
    fail("desktop_macos_production_signing_app_invalid");
  }
  await sign(productionSigningOptions({ appPath, environment }));
  await notarize({
    appPath,
    appleApiIssuer: environment.appleApiIssuer,
    appleApiKey: environment.appleApiKey,
    appleApiKeyId: environment.appleApiKeyId,
  });
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    schema_version: "bizhub.desktop-macos-production-signing.v1",
    signing_mode: "production",
    publisher_team_id: environment.teamId,
    notarized_and_stapled: true,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
