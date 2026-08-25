export const RUNTIME_TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    platform: "darwin",
    architecture: "arm64",
    archiveName: "bizhub-runtime-darwin-arm64-0.1.0-d2.zip",
    trustName: "generic-runtime-trust.json",
  }),
  "win32-x64": Object.freeze({
    platform: "win32",
    architecture: "x64",
    archiveName: "bizhub-runtime-win32-x64-0.1.0-d3.zip",
    trustName: "generic-runtime-trust.win32-x64.json",
  }),
});

export function runtimeTarget(platform = process.platform, architecture = process.arch) {
  const target = RUNTIME_TARGETS[`${platform}-${architecture}`];
  if (!target) throw new Error(`desktop_runtime_target_unsupported:${platform}:${architecture}`);
  return target;
}
