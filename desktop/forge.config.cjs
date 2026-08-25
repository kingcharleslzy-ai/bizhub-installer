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
      "config/generic-runtime-trust.json",
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
  ],
};
