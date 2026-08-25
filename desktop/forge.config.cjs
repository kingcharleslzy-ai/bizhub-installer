const path = require("node:path");
const { sign: signWindowsFiles } = require("@electron/windows-sign");

const certificateFile = process.env.BIZHUB_WINDOWS_CERTIFICATE_FILE;
const certificatePassword = process.env.BIZHUB_WINDOWS_CERTIFICATE_PASSWORD;
const requireWindowsSigning = process.env.BIZHUB_REQUIRE_WINDOWS_SIGNING === "1";

if (requireWindowsSigning && (!certificateFile || !certificatePassword)) {
  throw new Error("desktop_windows_signing_credentials_missing");
}

const windowsSigning = certificateFile && certificatePassword
  ? { certificateFile, certificatePassword, hashes: ["sha256"] }
  : null;
const runtimeResourceSegment = `${path.sep}resources${path.sep}bizhub-runtime${path.sep}`.toLowerCase();

async function signPackagedWindowsFile(fileToSign) {
  if (!windowsSigning) throw new Error("desktop_windows_signing_credentials_missing");
  const normalized = path.resolve(fileToSign).toLowerCase();
  // The fixed Runtime Pack is independently identity-bound before packaging.
  // Signing it here would mutate its PE files after trust verification.
  if (normalized.includes(runtimeResourceSegment)) return;
  await signWindowsFiles({
    files: [fileToSign],
    ...windowsSigning,
  });
}

module.exports = {
  packagerConfig: {
    appBundleId: "com.bizhub.desktop",
    appCategoryType: "public.app-category.business",
    asar: true,
    executableName: "BizHub Desktop",
    ...(windowsSigning ? {
      windowsSign: {
        ...windowsSigning,
        hookFunction: signPackagedWindowsFile,
      },
    } : {}),
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
      },
    },
    extraResource: [
      "config/trusted-connection-keys.json",
      "runtime-dist/generic-runtime-trust.json",
      "runtime-dist/bizhub-runtime",
    ],
    ignore: [
      /^\/\.runtime-venv($|\/)/,
      /^\/config($|\/)/,
      /^\/forge\.config\.cjs$/,
      /^\/node_modules($|\/)/,
      /^\/out($|\/)/,
      /^\/package-lock\.json$/,
      /^\/README\.md$/,
      /^\/runtime($|\/)/,
      /^\/runtime-build($|\/)/,
      /^\/runtime-dist($|\/)/,
      /^\/scripts($|\/)/,
      /^\/shell-frontend($|\/)/,
      /^\/test($|\/)/,
      /^\/vite\.config\.mjs$/,
    ],
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "bizhub_desktop",
        setupExe: "BizHub-Desktop-Setup-x64.exe",
        noMsi: true,
        ...(windowsSigning ? { windowsSign: windowsSigning } : {}),
      },
    },
  ],
};
