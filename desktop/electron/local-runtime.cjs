const { spawn } = require("node:child_process");
const { createHash, randomBytes, randomUUID } = require("node:crypto");
const {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");

const RUNTIME_COOKIE = "bizhub_desktop_runtime";
const MAX_COMMAND_OUTPUT = 256 * 1024;
const SETUP_MARKER_SCHEMA = "bizhub.desktop-local-setup.v1";
const SETUP_STAGE_PATTERN = /^\.setup-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const activeSetupIds = new Set();

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  const value = await readFile(filePath);
  return sha256Buffer(value);
}

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || entry.isFile()) output.push(target);
    else if (entry.isDirectory()) output.push(...await filesUnder(target));
  }
  return output;
}

function safeRelative(value) {
  return (
    typeof value === "string"
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/).includes("..")
    && value === value.replaceAll("\\", "/")
  );
}

function requireExactKeys(payload, expected, code) {
  const actual = Object.keys(payload).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(code);
}

async function verifyRuntimePackInternal(packRoot, trustPath, requireHostTarget) {
  const root = path.resolve(packRoot);
  if (!(await lstat(root)).isDirectory()) {
    throw new Error("desktop_runtime_pack_root_invalid");
  }
  const trust = JSON.parse(await readFile(trustPath, "utf8"));
  requireExactKeys(trust, [
    "allowlist_tree_digest",
    "architecture",
    "artifact_id",
    "core_artifact_digest",
    "core_source_commit",
    "platform",
    "profile_id",
    "runtime_id",
    "runtime_manifest_sha256",
    "runtime_manifest_schema",
    "runtime_pack_file_count",
    "runtime_pack_tree_digest",
    "runtime_source_tree_digest",
    "runtime_version",
    "schema_version",
  ], "desktop_runtime_trust_shape_invalid");
  if (trust.schema_version !== "bizhub.desktop-runtime-trust.v1") {
    throw new Error("desktop_runtime_trust_schema_invalid");
  }
  const supportedTarget = (
    (trust.platform === "darwin" && trust.architecture === "arm64")
    || (trust.platform === "win32" && trust.architecture === "x64")
  );
  if (!supportedTarget) throw new Error("desktop_runtime_target_unsupported");
  if (
    requireHostTarget
    && (trust.platform !== process.platform || trust.architecture !== process.arch)
  ) {
    throw new Error("desktop_runtime_host_target_mismatch");
  }
  if (
    !/^[0-9a-f]{64}$/.test(trust.runtime_manifest_sha256)
    || !/^[0-9a-f]{64}$/.test(trust.runtime_pack_tree_digest)
    || !Number.isSafeInteger(trust.runtime_pack_file_count)
    || trust.runtime_pack_file_count < 1
  ) {
    throw new Error("desktop_runtime_trust_digest_invalid");
  }
  const manifestPath = path.join(root, "runtime-release-manifest.json");
  const manifestRaw = await readFile(manifestPath);
  if (sha256Buffer(manifestRaw) !== trust.runtime_manifest_sha256) {
    throw new Error("desktop_runtime_manifest_digest_mismatch");
  }
  const manifest = JSON.parse(manifestRaw.toString("utf8"));
  requireExactKeys(manifest, [
    "allowlist_tree_digest",
    "architecture",
    "artifact_id",
    "core_artifact_digest",
    "core_source_commit",
    "executable",
    "files",
    "pack_tree_digest",
    "platform",
    "profile_id",
    "runtime_id",
    "runtime_source_files",
    "runtime_source_tree_digest",
    "runtime_version",
    "schema_version",
  ], "desktop_runtime_manifest_shape_invalid");
  const bindings = {
    schema_version: trust.runtime_manifest_schema,
    runtime_id: trust.runtime_id,
    runtime_version: trust.runtime_version,
    profile_id: trust.profile_id,
    platform: trust.platform,
    architecture: trust.architecture,
    artifact_id: trust.artifact_id,
    core_artifact_digest: trust.core_artifact_digest,
    core_source_commit: trust.core_source_commit,
    allowlist_tree_digest: trust.allowlist_tree_digest,
    runtime_source_tree_digest: trust.runtime_source_tree_digest,
  };
  for (const [key, expected] of Object.entries(bindings)) {
    if (manifest[key] !== expected) throw new Error(`desktop_runtime_identity_mismatch:${key}`);
  }
  const expectedExecutable = trust.platform === "win32"
    ? "bizhub-runtime.exe"
    : "bizhub-runtime";
  if (manifest.executable !== expectedExecutable) {
    throw new Error("desktop_runtime_executable_identity_invalid");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 1) {
    throw new Error("desktop_runtime_manifest_files_invalid");
  }
  if (
    manifest.pack_tree_digest !== trust.runtime_pack_tree_digest
    || manifest.files.length !== trust.runtime_pack_file_count
  ) {
    throw new Error("desktop_runtime_pack_pin_mismatch");
  }
  if (!Array.isArray(manifest.runtime_source_files) || manifest.runtime_source_files.length < 1) {
    throw new Error("desktop_runtime_source_files_invalid");
  }
  const sourcePaths = new Set();
  const canonicalSourceRecords = [];
  let previousSourcePath = "";
  for (const record of manifest.runtime_source_files) {
    requireExactKeys(record, ["path", "sha256"], "desktop_runtime_source_record_invalid");
    if (
      !safeRelative(record.path)
      || sourcePaths.has(record.path)
      || record.path <= previousSourcePath
      || !/^[0-9a-f]{64}$/.test(record.sha256)
    ) {
      throw new Error(`desktop_runtime_source_record_invalid:${record.path}`);
    }
    sourcePaths.add(record.path);
    previousSourcePath = record.path;
    canonicalSourceRecords.push({ path: record.path, sha256: record.sha256 });
  }
  const sourceTreeDigest = sha256Buffer(
    Buffer.from(`${JSON.stringify(canonicalSourceRecords)}\n`),
  );
  if (
    sourceTreeDigest !== manifest.runtime_source_tree_digest
    || sourceTreeDigest !== trust.runtime_source_tree_digest
  ) {
    throw new Error("desktop_runtime_source_tree_digest_mismatch");
  }
  const expectedPaths = new Set();
  const canonicalRecords = [];
  for (const record of manifest.files) {
    requireExactKeys(
      record,
      ["link_target", "path", "sha256", "size", "type"],
      "desktop_runtime_file_record_invalid",
    );
    if (!safeRelative(record.path) || expectedPaths.has(record.path)) {
      throw new Error(`desktop_runtime_file_path_invalid:${record.path}`);
    }
    const candidate = path.resolve(root, record.path);
    if (!candidate.startsWith(`${root}${path.sep}`)) {
      throw new Error(`desktop_runtime_file_path_escape:${record.path}`);
    }
    const metadata = await lstat(candidate);
    if (record.type === "symlink") {
      if (!metadata.isSymbolicLink() || typeof record.link_target !== "string") {
        throw new Error(`desktop_runtime_symlink_type_mismatch:${record.path}`);
      }
      const actualTarget = await readlink(candidate);
      const resolvedTarget = path.resolve(path.dirname(candidate), actualTarget);
      if (
        actualTarget !== record.link_target
        || !resolvedTarget.startsWith(`${root}${path.sep}`)
        || Buffer.byteLength(actualTarget) !== record.size
        || sha256Buffer(Buffer.from(actualTarget)) !== record.sha256
      ) {
        throw new Error(`desktop_runtime_symlink_mismatch:${record.path}`);
      }
    } else if (record.type === "file") {
      if (!metadata.isFile() || record.link_target !== null || metadata.size !== record.size) {
        throw new Error(`desktop_runtime_file_size_mismatch:${record.path}`);
      }
      if (await sha256File(candidate) !== record.sha256) {
        throw new Error(`desktop_runtime_file_digest_mismatch:${record.path}`);
      }
    } else {
      throw new Error(`desktop_runtime_file_type_invalid:${record.path}`);
    }
    expectedPaths.add(record.path);
    canonicalRecords.push({
      link_target: record.link_target,
      path: record.path,
      sha256: record.sha256,
      size: record.size,
      type: record.type,
    });
  }
  const actualPaths = new Set(
    (await filesUnder(root))
      .map((value) => path.relative(root, value).replaceAll("\\", "/"))
      .filter((value) => value !== "runtime-release-manifest.json"),
  );
  if (
    actualPaths.size !== expectedPaths.size
    || [...actualPaths].some((value) => !expectedPaths.has(value))
  ) {
    throw new Error("desktop_runtime_pack_file_set_mismatch");
  }
  const treeDigest = sha256Buffer(Buffer.from(`${JSON.stringify(canonicalRecords)}\n`));
  if (
    treeDigest !== manifest.pack_tree_digest
    || treeDigest !== trust.runtime_pack_tree_digest
  ) {
    throw new Error("desktop_runtime_pack_tree_digest_mismatch");
  }
  const executable = path.join(root, manifest.executable);
  await access(executable, 1);
  return { root, executable, manifest };
}

async function verifyRuntimePackIdentity(packRoot, trustPath) {
  return verifyRuntimePackInternal(packRoot, trustPath, false);
}

async function verifyRuntimePack(packRoot, trustPath) {
  return verifyRuntimePackInternal(packRoot, trustPath, true);
}

function instancePaths(instanceRoot) {
  const root = path.resolve(instanceRoot);
  return {
    root,
    database: path.join(root, "data", "bizhub.sqlite"),
    admin: path.join(root, "data", "admin.json"),
    company: path.join(root, "config", "company.json"),
    secret: path.join(root, "config", "secret-key"),
    instance: path.join(root, "instance.json"),
    backups: path.join(root, "backups"),
    logs: path.join(root, "logs"),
  };
}

function runtimeEnvironment(instanceRoot) {
  const paths = instancePaths(instanceRoot);
  return {
    BIZHUB_DESKTOP_INSTANCE_ROOT: paths.root,
    BIZHUB_GENERIC_DATABASE_PATH: paths.database,
    BIZHUB_ADMIN_CONFIG: paths.admin,
    BIZHUB_COMPANY_CONFIG: paths.company,
    BIZHUB_SECRET_KEY_FILE: paths.secret,
    BIZHUB_COOKIE_SECURE: "0",
  };
}

async function writeJsonSecure(filePath, payload, options = {}) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    ...options,
    mode: 0o600,
  });
  await chmod(filePath, 0o600);
}

function setupRecord(setupId, stageName) {
  return {
    schema_version: SETUP_MARKER_SCHEMA,
    setup_id: setupId,
    stage_name: stageName,
    owner_pid: process.pid,
    created_at: new Date().toISOString(),
  };
}

function validateSetupRecord(payload, expectedStageName = null) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("desktop_local_setup_marker_invalid");
  }
  requireExactKeys(payload, [
    "created_at",
    "owner_pid",
    "schema_version",
    "setup_id",
    "stage_name",
  ], "desktop_local_setup_marker_invalid");
  const match = SETUP_STAGE_PATTERN.exec(payload.stage_name);
  if (
    payload.schema_version !== SETUP_MARKER_SCHEMA
    || !match
    || payload.setup_id !== match[1]
    || (expectedStageName && payload.stage_name !== expectedStageName)
    || !Number.isSafeInteger(payload.owner_pid)
    || payload.owner_pid <= 1
    || !Number.isFinite(Date.parse(payload.created_at))
  ) {
    throw new Error("desktop_local_setup_marker_invalid");
  }
  return payload;
}

async function readSetupRecord(filePath, expectedStageName = null) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`desktop_local_setup_marker_type_invalid:${filePath}`);
  }
  return validateSetupRecord(
    JSON.parse(await readFile(filePath, "utf8")),
    expectedStageName,
  );
}

function sameSetupRecord(left, right) {
  return ["schema_version", "setup_id", "stage_name", "owner_pid", "created_at"]
    .every((key) => left[key] === right[key]);
}

async function recoverInterruptedLocalSetup(userDataRoot) {
  const base = path.resolve(userDataRoot);
  const runtimeRoot = path.join(base, "runtime");
  const finalRoot = path.join(base, "local-instance");
  let formalInstancePresent = false;
  try {
    const finalMetadata = await lstat(finalRoot);
    if (!finalMetadata.isDirectory() || finalMetadata.isSymbolicLink()) {
      throw new Error("desktop_local_instance_root_invalid");
    }
    formalInstancePresent = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let entries;
  try {
    const runtimeMetadata = await lstat(runtimeRoot);
    if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()) {
      throw new Error("desktop_local_setup_runtime_root_invalid");
    }
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "clean", recovered_setups: 0, formal_instance_present: formalInstancePresent };
    }
    throw error;
  }

  const stages = new Map();
  const markerPaths = new Map();
  let lockPath = null;
  for (const entry of entries) {
    const candidate = path.join(runtimeRoot, entry.name);
    if (entry.name === "setup.lock") {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("desktop_local_setup_lock_type_invalid");
      }
      lockPath = candidate;
      continue;
    }
    const markerMatch = /^(\.setup-[0-9a-f-]+)\.marker\.json$/.exec(entry.name);
    const stageMatch = SETUP_STAGE_PATTERN.exec(entry.name);
    if (markerMatch) {
      if (!entry.isFile() || entry.isSymbolicLink() || !SETUP_STAGE_PATTERN.test(markerMatch[1])) {
        throw new Error(`desktop_local_setup_recovery_path_invalid:${entry.name}`);
      }
      markerPaths.set(markerMatch[1], candidate);
      continue;
    }
    if (stageMatch) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`desktop_local_setup_recovery_path_invalid:${entry.name}`);
      }
      stages.set(entry.name, candidate);
      continue;
    }
    if (entry.name.startsWith(".setup-")) {
      throw new Error(`desktop_local_setup_recovery_path_invalid:${entry.name}`);
    }
  }

  const records = new Map();
  for (const [stageName, markerPath] of markerPaths) {
    const record = await readSetupRecord(markerPath, stageName);
    if (activeSetupIds.has(record.setup_id)) {
      throw new Error("desktop_local_setup_recovery_active");
    }
    records.set(stageName, record);
  }
  for (const stageName of stages.keys()) {
    if (!records.has(stageName)) {
      throw new Error(`desktop_local_setup_recovery_marker_missing:${stageName}`);
    }
  }
  let lockRecord = null;
  if (lockPath) {
    lockRecord = await readSetupRecord(lockPath);
    const markerRecord = records.get(lockRecord.stage_name);
    if (!markerRecord || !sameSetupRecord(lockRecord, markerRecord)) {
      throw new Error("desktop_local_setup_lock_marker_mismatch");
    }
  }

  for (const stagePath of stages.values()) {
    await rm(stagePath, { recursive: true, force: true });
  }
  for (const markerPath of markerPaths.values()) {
    await unlink(markerPath);
  }
  if (lockPath) await unlink(lockPath);
  return {
    status: records.size || lockRecord ? "recovered" : "clean",
    recovered_setups: records.size,
    formal_instance_present: formalInstancePresent,
  };
}

function validateSetupInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("desktop_local_setup_invalid");
  }
  requireExactKeys(input, ["companyName", "username", "password"], "desktop_local_setup_shape_invalid");
  const companyName = String(input.companyName || "").trim();
  const username = String(input.username || "").trim();
  const password = String(input.password || "");
  if (companyName.length < 2 || companyName.length > 80) throw new Error("desktop_company_name_invalid");
  if (username.length < 3 || username.length > 80) throw new Error("desktop_admin_username_invalid");
  if (password.length < 12 || password.length > 1024) throw new Error("desktop_admin_password_invalid");
  return { companyName, username, password };
}

function runRuntimeCommand(executable, args, environment, input = "", timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const fail = (error) => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      finish(reject, error);
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_COMMAND_OUTPUT) throw new Error("desktop_runtime_output_too_large");
      return next;
    };
    child.stdout.on("data", (chunk) => {
      try { stdout = append(stdout, chunk); } catch (error) { fail(error); }
    });
    child.stderr.on("data", (chunk) => {
      try { stderr = append(stderr, chunk); } catch (error) { fail(error); }
    });
    child.once("error", fail);
    timeout = setTimeout(() => {
      fail(new Error("desktop_runtime_command_timeout"));
    }, timeoutMs);
    child.once("exit", (code) => {
      if (settled) return;
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      let payload = null;
      try {
        payload = lines.length ? JSON.parse(lines.at(-1)) : null;
      } catch {
        payload = null;
      }
      if (code !== 0 || !payload || payload.status === "error") {
        finish(reject, new Error(payload?.error || stderr.trim() || `desktop_runtime_command_failed:${code}`));
        return;
      }
      finish(resolve, payload);
    });
    child.stdin.end(input);
  });
}

async function loadLocalInstance(instanceRoot) {
  const paths = instancePaths(instanceRoot);
  for (const directory of [
    paths.root,
    path.dirname(paths.database),
    path.dirname(paths.company),
    paths.backups,
    paths.logs,
  ]) {
    if (!(await lstat(directory)).isDirectory()) {
      throw new Error(`desktop_local_instance_directory_invalid:${directory}`);
    }
  }
  const payload = JSON.parse(await readFile(paths.instance, "utf8"));
  requireExactKeys(payload, [
    "authority_epoch",
    "created_at",
    "data_identity",
    "display_name",
    "profile_id",
    "schema_version",
    "writer_instance_id",
  ], "desktop_local_instance_shape_invalid");
  if (
    payload.schema_version !== "bizhub.desktop-local-instance.v1"
    || payload.profile_id !== "generic-kernel-smoke"
    || payload.authority_epoch !== 1
  ) {
    throw new Error("desktop_local_instance_identity_invalid");
  }
  for (const required of [paths.database, paths.admin, paths.company, paths.secret]) {
    if (!(await lstat(required)).isFile()) throw new Error(`desktop_local_instance_file_invalid:${required}`);
  }
  return { paths, payload };
}

async function loadLocalAdminIdentity(instanceRoot) {
  const instance = await loadLocalInstance(instanceRoot);
  const payload = JSON.parse(await readFile(instance.paths.admin, "utf8"));
  const keys = Object.keys(payload).sort().join(",");
  if (
    !["password_hash,schema_version,username", "auth_version,password_hash,schema_version,username"]
      .includes(keys)
    || payload.schema_version !== "bizhub.public-admin.v1"
    || typeof payload.username !== "string"
    || payload.username.length < 3
    || payload.username.length > 80
    || typeof payload.password_hash !== "string"
    || payload.password_hash.length < 20
  ) {
    throw new Error("desktop_local_admin_identity_invalid");
  }
  const authVersion = payload.auth_version ?? 1;
  if (!Number.isSafeInteger(authVersion) || authVersion < 1) {
    throw new Error("desktop_local_admin_identity_invalid");
  }
  return { username: payload.username, authVersion };
}

async function bootstrapLocalInstance({ userDataRoot, runtimePack, trustPath, input }) {
  const values = validateSetupInput(input);
  const verified = await verifyRuntimePack(runtimePack, trustPath);
  const base = path.resolve(userDataRoot);
  const finalRoot = path.join(base, "local-instance");
  const runtimeRoot = path.join(base, "runtime");
  const lock = path.join(runtimeRoot, "setup.lock");
  const setupId = randomUUID();
  const stageName = `.setup-${setupId}`;
  const stage = path.join(runtimeRoot, stageName);
  const markerPath = path.join(runtimeRoot, `${stageName}.marker.json`);
  const marker = setupRecord(setupId, stageName);
  let markerOwned = false;
  let stageOwned = false;
  let lockOwned = false;
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  if (!(await lstat(runtimeRoot)).isDirectory()) {
    throw new Error("desktop_local_setup_runtime_root_invalid");
  }
  try {
    await writeJsonSecure(markerPath, marker, { flag: "wx" });
    markerOwned = true;
    await mkdir(stage, { mode: 0o700 });
    stageOwned = true;
    try {
      await writeJsonSecure(lock, marker, { flag: "wx" });
      lockOwned = true;
      activeSetupIds.add(setupId);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error("desktop_local_setup_in_progress");
      throw error;
    }
    try {
      await access(finalRoot);
      throw new Error("desktop_local_instance_already_exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const paths = instancePaths(stage);
    for (const directory of [
      path.join(stage, "attachments"),
      paths.backups,
      path.dirname(paths.company),
      path.dirname(paths.database),
      paths.logs,
      path.join(stage, "reports"),
      path.join(stage, "runtime"),
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const dataIdentity = `local:${randomUUID()}`;
    const writerInstanceId = `desktop:${randomUUID()}`;
    const createdAt = new Date().toISOString();
    await Promise.all([
      writeJsonSecure(paths.company, {
        schema_version: 1,
        profile_id: "local-generic",
        legal_name: values.companyName,
        display_name: values.companyName,
        brand_mark: "BH",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        currency: "CNY",
        data_identity: dataIdentity,
        data_authority_mode: "local",
        authority_epoch: 1,
        writer_instance_id: writerInstanceId,
      }),
      writeFile(paths.secret, randomBytes(48), { mode: 0o600 }),
      writeJsonSecure(paths.instance, {
        schema_version: "bizhub.desktop-local-instance.v1",
        profile_id: "generic-kernel-smoke",
        display_name: values.companyName,
        data_identity: dataIdentity,
        authority_epoch: 1,
        writer_instance_id: writerInstanceId,
        created_at: createdAt,
      }),
    ]);
    const bootstrapToken = randomBytes(32).toString("base64url");
    const result = await runRuntimeCommand(
      verified.executable,
      ["bootstrap"],
      {
        ...runtimeEnvironment(stage),
        BIZHUB_DESKTOP_BOOTSTRAP_SHA256: sha256Buffer(Buffer.from(bootstrapToken)),
      },
      `${JSON.stringify({
        schema_version: "bizhub.desktop-local-bootstrap.v1",
        bootstrap_token: bootstrapToken,
        username: values.username,
        password: values.password,
      })}\n`,
    );
    await rename(stage, finalRoot);
    stageOwned = false;
    return {
      status: "created",
      instance: (await loadLocalInstance(finalRoot)).payload,
      readback: result.readback,
    };
  } finally {
    activeSetupIds.delete(setupId);
    if (lockOwned) {
      try {
        const currentLock = await readSetupRecord(lock, stageName);
        if (!sameSetupRecord(currentLock, marker)) {
          throw new Error("desktop_local_setup_lock_ownership_lost");
        }
        await unlink(lock);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (stageOwned) await rm(stage, { recursive: true, force: true });
    if (markerOwned) await rm(markerPath, { force: true });
  }
}

async function fetchRuntime(runtime, pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  const cookies = [`${RUNTIME_COOKIE}=${runtime.token}`];
  if (runtime.sessionCookie) cookies.push(runtime.sessionCookie);
  headers.set("Cookie", cookies.join("; "));
  const response = await fetch(`${runtime.origin}${pathname}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(options.timeoutMs || 5_000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

async function waitForHealth(runtime) {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await fetchRuntime(runtime, "/api/health", { timeoutMs: 2_000 });
      if (result.response.ok && result.body?.status === "ok") return result.body;
      lastError = new Error(`desktop_runtime_health_status:${result.response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error("desktop_runtime_health_timeout");
}

async function startLocalRuntime({ instanceRoot, runtimePack, trustPath }) {
  const verified = await verifyRuntimePack(runtimePack, trustPath);
  const instance = await loadLocalInstance(instanceRoot);
  const token = randomBytes(32).toString("base64url");
  const child = spawn(verified.executable, ["serve"], {
    env: {
      ...process.env,
      ...runtimeEnvironment(instance.paths.root),
      BIZHUB_DESKTOP_PARENT_PID: String(process.pid),
      BIZHUB_DESKTOP_RUNTIME_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-MAX_COMMAND_OUTPUT);
  });
  const ready = await new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("desktop_runtime_start_timeout"));
    }, 20_000);
    const fail = (error) => {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(stderr || `desktop_runtime_exited:${code}`)));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT) {
        fail(new Error("desktop_runtime_output_too_large"));
        return;
      }
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        try {
          const payload = JSON.parse(line);
          if (payload.status === "ready") {
            clearTimeout(timeout);
            resolve(payload);
            return;
          }
        } catch {
          // Only the bounded JSON readiness line is authoritative.
        }
      }
    });
  });
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.origin)) {
    child.kill("SIGKILL");
    throw new Error("desktop_runtime_origin_invalid");
  }
  const runtime = {
    child,
    instance,
    origin: ready.origin,
    token,
    sessionCookie: "",
    release: verified.manifest,
  };
  try {
    runtime.health = await waitForHealth(runtime);
  } catch (error) {
    await stopLocalRuntime(runtime);
    throw error;
  }
  return runtime;
}

async function stopLocalRuntime(runtime, timeoutMs = 10_000) {
  if (
    !runtime?.child
    || runtime.child.exitCode !== null
    || runtime.child.signalCode !== null
  ) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(gracefulTimeout);
      clearTimeout(hardTimeout);
      resolve();
    };
    const gracefulTimeout = setTimeout(() => {
      runtime.child.kill("SIGKILL");
    }, timeoutMs);
    const hardTimeout = setTimeout(finish, timeoutMs + 2_000);
    runtime.child.once("exit", finish);
    if (!runtime.child.kill("SIGTERM")) setTimeout(finish, 0);
  });
}

function localRememberedSession(token, username, authVersion) {
  if (
    typeof token !== "string"
    || token.length > 8192
    || !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(token)
  ) throw new Error("desktop_local_remembered_session_invalid");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(token).split(".")[0], "base64url").toString("utf8"));
  } catch {
    throw new Error("desktop_local_remembered_session_invalid");
  }
  if (
    payload?.purpose !== "remember"
    || payload.username !== username
    || payload.auth_version !== authVersion
    || !Number.isSafeInteger(payload.expires_at)
  ) {
    throw new Error("desktop_local_remembered_session_invalid");
  }
  return {
    authVersion,
    expiresAt: payload.expires_at * 1000,
    token,
    username,
  };
}

function captureRuntimeSession(runtime, result) {
  const setCookie = result.response.headers.get("set-cookie") || "";
  const sessionCookie = setCookie.split(";", 1)[0];
  if (!sessionCookie.startsWith("bizhub_session=")) throw new Error("desktop_local_session_missing");
  runtime.sessionCookie = sessionCookie;
  return sessionCookie;
}

async function loginLocalRuntime(runtime, username, password, { remember = false } = {}) {
  const result = await fetchRuntime(runtime, "/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BizHub-Request": "1",
    },
    body: JSON.stringify({ username, password, remember }),
  });
  if (!result.response.ok) throw new Error(`desktop_local_login_failed:${result.response.status}`);
  const sessionCookie = captureRuntimeSession(runtime, result);
  const rememberSession = remember
    ? localRememberedSession(
      result.body?.remember_token,
      result.body?.username,
      result.body?.auth_version,
    )
    : null;
  return { status: "authenticated", username: result.body.username, sessionCookie, rememberSession };
}

async function resumeLocalRuntime(runtime, token) {
  const result = await fetchRuntime(runtime, "/api/auth/remember", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BizHub-Request": "1",
    },
    body: JSON.stringify({ token }),
  });
  if (!result.response.ok) throw new Error(`desktop_local_remembered_login_failed:${result.response.status}`);
  const sessionCookie = captureRuntimeSession(runtime, result);
  return { status: "authenticated", username: result.body.username, sessionCookie };
}

async function changeLocalPasswordRuntime(
  runtime,
  currentPassword,
  newPassword,
  { remember = false } = {},
) {
  const result = await fetchRuntime(runtime, "/api/auth/password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BizHub-Request": "1",
    },
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
      remember,
    }),
  });
  if (!result.response.ok) throw new Error(`desktop_local_password_change_failed:${result.response.status}`);
  const sessionCookie = captureRuntimeSession(runtime, result);
  const rememberSession = remember
    ? localRememberedSession(
      result.body?.remember_token,
      result.body?.username,
      result.body?.auth_version,
    )
    : null;
  return { status: "changed", username: result.body.username, sessionCookie, rememberSession };
}

async function backupLocalInstance({ instanceRoot, runtimePack, trustPath }) {
  const verified = await verifyRuntimePack(runtimePack, trustPath);
  const instance = await loadLocalInstance(instanceRoot);
  const label = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const output = path.join(instance.paths.backups, `bizhub-${label}-${randomUUID().slice(0, 8)}.sqlite`);
  const result = await runRuntimeCommand(
    verified.executable,
    ["backup", "--output", output],
    runtimeEnvironment(instance.paths.root),
  );
  const validation = await runRuntimeCommand(
    verified.executable,
    ["validate-backup", "--backup", output, "--manifest", `${output}.manifest.json`],
    runtimeEnvironment(instance.paths.root),
  );
  return { ...result, validation };
}

module.exports = {
  RUNTIME_COOKIE,
  backupLocalInstance,
  bootstrapLocalInstance,
  changeLocalPasswordRuntime,
  fetchRuntime,
  instancePaths,
  loadLocalAdminIdentity,
  loadLocalInstance,
  loginLocalRuntime,
  recoverInterruptedLocalSetup,
  resumeLocalRuntime,
  runtimeEnvironment,
  startLocalRuntime,
  stopLocalRuntime,
  verifyRuntimePack,
  verifyRuntimePackIdentity,
};
