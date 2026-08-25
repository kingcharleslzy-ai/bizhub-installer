import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { bootstrapLocalInstance } = require("../electron/local-runtime.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`desktop_smoke_option_missing:${name}`);
  return path.resolve(value);
}

const packagedExecutable = option("--packaged-executable");
const packagedResources = option("--packaged-resources");
if (Boolean(packagedExecutable) !== Boolean(packagedResources)) {
  throw new Error("desktop_local_smoke_packaged_options_incomplete");
}
const runtimePack = packagedResources
  ? path.join(packagedResources, "bizhub-runtime")
  : path.join(ROOT, "runtime-dist", "bizhub-runtime");
const trustPath = packagedResources
  ? path.join(packagedResources, "generic-runtime-trust.json")
  : path.join(ROOT, "config", "generic-runtime-trust.json");
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-desktop-local-shell-"));
const userDataRoot = path.join(temporaryRoot, "user-data");

try {
  await bootstrapLocalInstance({
    userDataRoot,
    runtimePack,
    trustPath,
    input: {
      companyName: "Synthetic Desktop Shell",
      username: "synthetic-admin",
      password: "synthetic correct horse battery staple",
    },
  });
  const executable = packagedExecutable || require("electron");
  const child = spawn(executable, packagedExecutable ? [] : [ROOT], {
    cwd: ROOT,
    env: {
      ...process.env,
      BIZHUB_DESKTOP_SMOKE_LOCAL: "1",
      BIZHUB_DESKTOP_USER_DATA_ROOT: userDataRoot,
      ...(packagedExecutable ? {} : { BIZHUB_DESKTOP_LOCAL_RUNTIME_DIR: runtimePack }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("desktop_local_shell_smoke_timeout"));
    }, 60_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  const marker = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .find((value) => value?.mode === "local" && value?.status === "connected");
  if (exitCode !== 0 || !marker || marker.residual_runtime_processes !== 0) {
    throw new Error(`desktop_local_shell_smoke_failed:${exitCode}:${stderr.trim()}:${stdout.trim()}`);
  }
  process.stdout.write(`${JSON.stringify({
    status: "connected",
    mode: "local",
    origin_kind: "random_loopback",
    packaged: Boolean(packagedExecutable),
    residual_runtime_processes: marker.residual_runtime_processes,
  })}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
