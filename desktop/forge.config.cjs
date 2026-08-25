const certificateFile = process.env.BIZHUB_WINDOWS_CERTIFICATE_FILE;
const certificatePassword = process.env.BIZHUB_WINDOWS_CERTIFICATE_PASSWORD;
const requireWindowsSigning = process.env.BIZHUB_REQUIRE_WINDOWS_SIGNING === "1";

if (requireWindowsSigning && (!certificateFile || !certificatePassword)) {
  throw new Error("desktop_windows_signing_credentials_missing");
}

const squirrelSigning = certificateFile && certificatePassword
  ? { certificateFile, certificatePassword }
  : {};

module.exports = {
  packagerConfig: {
    appBundleId: "com.bizhub.desktop",
    appCategoryType: "public.app-category.business",
    asar: true,
    executableName: "BizHub Desktop",
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
        ...squirrelSigning,
      },
    },
  ],
};
