import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  DEFAULT_PREFERENCES,
  loadPreferences,
  mergePreferences,
  preferencesPath,
  resolveWindowCloseAction,
  savePreferences,
} = require("../electron/preferences.cjs");

test("desktop preferences default to the existing product behavior", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bizhub-preferences-"));
  try {
    assert.deepEqual(await loadPreferences(root), {
      ...DEFAULT_PREFERENCES,
      theme: "system",
      density: "standard",
      zoomPercent: 100,
      closeBehavior: "background",
      launchAtLogin: false,
      automaticUpdates: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop preferences persist only the bounded public schema", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bizhub-preferences-"));
  try {
    const next = mergePreferences(DEFAULT_PREFERENCES, {
      theme: "dark",
      density: "compact",
      zoomPercent: 110,
      closeBehavior: "quit",
      launchAtLogin: true,
      automaticUpdates: false,
    });
    await savePreferences(root, next);
    assert.deepEqual(await loadPreferences(root), next);
    assert.deepEqual(JSON.parse(await readFile(preferencesPath(root), "utf8")), next);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop preferences reject unknown keys and out-of-range values", () => {
  assert.throws(
    () => mergePreferences(DEFAULT_PREFERENCES, { token: "no" }),
    /desktop_preferences_invalid/,
  );
  assert.throws(
    () => mergePreferences(DEFAULT_PREFERENCES, { zoomPercent: 125 }),
    /desktop_preferences_invalid/,
  );
  assert.throws(
    () => mergePreferences(DEFAULT_PREFERENCES, { theme: "blue" }),
    /desktop_preferences_invalid/,
  );
});

test("window close preserves the background default and supports explicit quit", () => {
  assert.equal(resolveWindowCloseAction(DEFAULT_PREFERENCES, {
    quitRequested: false,
    shutdownInProgress: false,
  }), "background");
  assert.equal(resolveWindowCloseAction({ ...DEFAULT_PREFERENCES, closeBehavior: "quit" }, {
    quitRequested: false,
    shutdownInProgress: false,
  }), "quit");
  assert.equal(resolveWindowCloseAction(DEFAULT_PREFERENCES, {
    quitRequested: true,
    shutdownInProgress: false,
  }), "allow");
});
