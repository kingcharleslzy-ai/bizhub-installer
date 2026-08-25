import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { recoverInterruptedLocalSetup } = require("../electron/local-runtime.cjs");

function marker(setupId) {
  return {
    schema_version: "bizhub.desktop-local-setup.v1",
    setup_id: setupId,
    stage_name: `.setup-${setupId}`,
    owner_pid: 987654,
    created_at: "2026-08-25T00:00:00.000Z",
  };
}

async function writeJson(filePath, payload) {
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

test("startup recovery removes only marked setup remnants and preserves formal instance", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-setup-recovery-"));
  try {
    const runtimeRoot = path.join(temporaryRoot, "runtime");
    const formalRoot = path.join(temporaryRoot, "local-instance");
    const setupId = randomUUID();
    const record = marker(setupId);
    const stage = path.join(runtimeRoot, record.stage_name);
    const markerPath = path.join(runtimeRoot, `${record.stage_name}.marker.json`);
    const lockPath = path.join(runtimeRoot, "setup.lock");
    const formalSentinel = path.join(formalRoot, "formal-sentinel.txt");
    await mkdir(stage, { recursive: true });
    await mkdir(formalRoot);
    await writeFile(path.join(stage, "partial.sqlite"), "synthetic partial state");
    await writeFile(formalSentinel, "preserve me");
    await writeJson(markerPath, record);
    await writeJson(lockPath, record);

    const result = await recoverInterruptedLocalSetup(temporaryRoot);
    assert.deepEqual(result, {
      status: "recovered",
      recovered_setups: 1,
      formal_instance_present: true,
    });
    await access(formalSentinel);
    await assert.rejects(access(stage));
    await assert.rejects(access(markerPath));
    await assert.rejects(access(lockPath));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("startup recovery fails closed when a setup stage has no matching marker", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-setup-fail-closed-"));
  try {
    const stage = path.join(temporaryRoot, "runtime", `.setup-${randomUUID()}`);
    await mkdir(stage, { recursive: true });
    await writeFile(path.join(stage, "unknown-state"), "do not remove");

    await assert.rejects(
      recoverInterruptedLocalSetup(temporaryRoot),
      /desktop_local_setup_recovery_marker_missing/,
    );
    await access(path.join(stage, "unknown-state"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("startup recovery handles interruption after formal promotion but before lock cleanup", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "bizhub-setup-post-promotion-"));
  try {
    const runtimeRoot = path.join(temporaryRoot, "runtime");
    const formalRoot = path.join(temporaryRoot, "local-instance");
    const setupId = randomUUID();
    const record = marker(setupId);
    const markerPath = path.join(runtimeRoot, `${record.stage_name}.marker.json`);
    const lockPath = path.join(runtimeRoot, "setup.lock");
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(formalRoot);
    await writeFile(path.join(formalRoot, "formal-sentinel.txt"), "preserve me");
    await writeJson(markerPath, record);
    await writeJson(lockPath, record);

    const result = await recoverInterruptedLocalSetup(temporaryRoot);
    assert.equal(result.status, "recovered");
    assert.equal(result.formal_instance_present, true);
    await access(path.join(formalRoot, "formal-sentinel.txt"));
    await assert.rejects(access(markerPath));
    await assert.rejects(access(lockPath));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
