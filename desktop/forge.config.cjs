const path = require("node:path");

const certificateFile = process.env.BIZHUB_WINDOWS_CERTIFICATE_FILE;
const certificatePassword = process.env.BIZHUB_WINDOWS_CERTIFICATE_PASSWORD;
const requireWindowsSigning = process.env.BIZHUB_REQUIRE_WINDOWS_SIGNING === "1";
const windowsSignHook = path.join(__dirname, "scripts", "windows-sign-hook.cjs");

if (requireWindowsSigning && (!certificateFile || !certificatePassword)) {
  throw new Error("desktop_windows_signing_credentials_missing");
}

const windowsSigning = certificateFile && certificatePassword
  ? {
      certificateFile,
      certificatePassword,
      hashes: ["sha256"],
      hookModulePath: windowsSignHook,
    }
  : null;

module.exports = {
  packagerConfig: {
    appBundleId: "com.bizhub.desktop",
    appCategoryType: "public.app-category.business",
    asar: true,
    executableName: "BizHub Desktop",
    ...(windowsSigning ? {
      windowsSign: windowsSigning,
    } : {}),
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
      },
    },
    extraResource: [
      "config/account-directory.json",
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
      /^\/vendor($|\/)/,
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
