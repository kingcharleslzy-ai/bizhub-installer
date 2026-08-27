import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runPreflight,
  validateProductionDirectory,
  validateReleaseCommit,
  validateReleaseTag,
} from "../scripts/release-preflight.mjs";

test("release tags follow the mutable package version without a global fixed version", () => {
  assert.equal(validateReleaseTag("0.1.0", "desktop-v0.1.0"), "desktop-v0.1.0");
  assert.equal(
    validateReleaseTag("0.1.0", "desktop-v0.1.0-preview.2"),
    "desktop-v0.1.0-preview.2",
  );
  assert.throws(
    () => validateReleaseTag("0.1.0", "desktop-v0.2.0"),
    /desktop_release_tag_version_mismatch/,
  );
});

test("formal release rejects temporary DNS, literal IP, custom port, and moving commit", () => {
  for (const resolveUrl of [
    "https://bizhub.38.49.54.254.nip.io/v1/desktop/workspaces/resolve",
    "https://38.49.54.254/v1/desktop/workspaces/resolve",
    "https://directory.example.com:8443/v1/desktop/workspaces/resolve",
  ]) {
    assert.throws(
      () => validateProductionDirectory({
        schema_version: "bizhub.desktop-account-directory.v1",
        resolve_url: resolveUrl,
      }),
      /desktop_release_directory_/,
    );
  }
  assert.throws(
    () => validateReleaseCommit("a".repeat(40), "b".repeat(40)),
    /desktop_release_commit_mismatch/,
  );
});

test("formal release accepts an owned neutral standard-HTTPS directory", () => {
  assert.equal(
    validateProductionDirectory({
      schema_version: "bizhub.desktop-account-directory.v1",
      resolve_url: "https://directory.bizhub.example/v1/desktop/workspaces/resolve",
    }),
    "https://directory.bizhub.example/v1/desktop/workspaces/resolve",
  );
});

test("production preflight is main-only and synthetic verification remains publish-disabled", async () => {
  const temporaryRoot = await import("node:fs/promises").then(({ mkdtemp }) => (
    mkdtemp(path.join(os.tmpdir(), "bizhub-release-preflight-"))
  ));
  const packagePath = path.join(temporaryRoot, "package.json");
  const directoryPath = path.join(temporaryRoot, "directory.json");
  await writeFile(packagePath, '{"version":"1.2.3"}\n');
  await writeFile(directoryPath, JSON.stringify({
    schema_version: "bizhub.desktop-account-directory.v1",
    resolve_url: "https://directory.bizhub.example/v1/desktop/workspaces/resolve",
  }));
  const synthetic = await runPreflight({
    mode: "synthetic-ci",
    releaseTag: "",
    releaseCommit: "",
    githubRef: "refs/heads/candidate",
    actualCommit: "a".repeat(40),
    packagePath,
    directoryPath,
  });
  assert.equal(synthetic.release_tag, null);
  assert.equal(synthetic.production_directory, false);
  await assert.rejects(
    runPreflight({
      mode: "production",
      releaseTag: "desktop-v1.2.3",
      releaseCommit: "a".repeat(40),
      githubRef: "refs/heads/candidate",
      actualCommit: "a".repeat(40),
      packagePath,
      directoryPath,
    }),
    /desktop_release_requires_main/,
  );
});
