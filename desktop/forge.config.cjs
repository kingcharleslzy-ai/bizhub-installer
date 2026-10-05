const path = require("node:path");
const { readdir, readlink, stat, symlink, unlink } = require("node:fs/promises");

const certificateFile = process.env.BIZHUB_WINDOWS_CERTIFICATE_FILE;
const certificatePassword = process.env.BIZHUB_WINDOWS_CERTIFICATE_PASSWORD;
const requireWindowsSigning = process.env.BIZHUB_REQUIRE_WINDOWS_SIGNING === "1";
const windowsSignHook = path.join(__dirname, "scripts", "windows-sign-hook.cjs");

if (requireWindowsSigning && (!certificateFile || !certificatePassword)) {
  throw new Error("desktop_windows_signing_credentials_missing");
}

// @electron/packager 20 copies extraResource entries with Node fs.cp, which
// resolves the darwin Runtime Pack's relative symlinks into absolute links
// pointing back at the build tree. Codesign rejects those, so relink every
// absolute symlink back to its in-bundle relative target, restoring the
// Forge 7 shape. The win32 Runtime Pack archive contains no symlinks.
async function relinkRuntimeSymlinks({ buildPath, platform }) {
  if (platform !== "darwin") return;
  const sourceRoot = path.join(__dirname, "runtime-dist", "bizhub-runtime");
  const appBundles = (await readdir(buildPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (appBundles.length !== 1) {
    throw new Error("desktop_packaged_runtime_symlink_app_bundle_missing");
  }
  const runtimeRoot = path.join(buildPath, appBundles[0].name, "Contents", "Resources", "bizhub-runtime");
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isSymbolicLink()) {
        const link = await readlink(target);
        if (!path.isAbsolute(link)) continue;
        const relative = path.relative(sourceRoot, link);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error(`desktop_packaged_runtime_symlink_escape:${target}`);
        }
        const mirrored = path.join(runtimeRoot, relative);
        if (!((await stat(mirrored)).isFile() || (await stat(mirrored)).isDirectory())) {
          throw new Error(`desktop_packaged_runtime_symlink_target_missing:${target}`);
        }
        await unlink(target);
        await symlink(path.relative(path.dirname(target), mirrored), target);
      }
    }
  };
  await walk(runtimeRoot);
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
      NSMicrophoneUsageDescription: "BizHub 桌面端在总监助手按住说话时使用麦克风。",
    },
    extraResource: [
      "config/account-directory.json",
      "config/trusted-connection-keys.json",
      "config/update-channel.json",
      "runtime-dist/generic-runtime-trust.json",
      "runtime-dist/bizhub-runtime",
    ],
    afterCopyExtraResources: [relinkRuntimeSymlinks],
    ignore: [
      /^\/\.runtime-venv($|\/)/,
      /^\/config($|\/)/,
      /^\/electron-windows-sign\.log$/,
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
