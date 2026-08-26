import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production directory transport is configured without customer identity", async () => {
  const value = JSON.parse(await readFile(path.join(ROOT, "config", "account-directory.json"), "utf8"));
  assert.equal(value.schema_version, "bizhub.desktop-account-directory.v1");
  assert.equal(
    value.resolve_url,
    "https://bizhub-account-directory.150-158-11-134.sslip.io/v1/desktop/workspaces/resolve",
  );
  assert.equal(Object.keys(value).sort().join(","), "resolve_url,schema_version");
});

test("production trust store contains one bounded Ed25519 root", async () => {
  const value = JSON.parse(await readFile(path.join(ROOT, "config", "trusted-connection-keys.json"), "utf8"));
  assert.equal(value.schema_version, "bizhub.desktop-trust-store.v1");
  assert.equal(value.keys.length, 1);
  assert.deepEqual(
    Object.keys(value.keys[0]).sort(),
    ["algorithm", "key_id", "public_key_pem", "valid_from", "valid_until"].sort(),
  );
  assert.equal(value.keys[0].algorithm, "Ed25519");
  assert.equal(value.keys[0].key_id, "bizhub-workspace-2026-08");
  assert.match(value.keys[0].public_key_pem, /^-----BEGIN PUBLIC KEY-----/);
  assert.ok(Date.parse(value.keys[0].valid_from) < Date.now());
  assert.ok(Date.parse(value.keys[0].valid_until) > Date.now());
});
