const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");

const PREFERENCES_SCHEMA = "bizhub.desktop-preferences.v1";
const PREFERENCES_FILE = "preferences.json";
const THEMES = new Set(["system", "light", "dark"]);
const DENSITIES = new Set(["standard", "compact"]);
const ZOOM_PERCENTS = new Set([90, 100, 110]);
const CLOSE_BEHAVIORS = new Set(["background", "quit"]);
const PATCH_KEYS = new Set([
  "theme",
  "density",
  "zoomPercent",
  "closeBehavior",
  "launchAtLogin",
  "automaticUpdates",
]);

const DEFAULT_PREFERENCES = Object.freeze({
  schemaVersion: PREFERENCES_SCHEMA,
  theme: "system",
  density: "standard",
  zoomPercent: 100,
  closeBehavior: "background",
  launchAtLogin: false,
  automaticUpdates: true,
});

function invalid() {
  throw new Error("desktop_preferences_invalid");
}

function normalizePreferences(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const expectedKeys = ["schemaVersion", ...PATCH_KEYS].sort();
  if (Object.keys(input).sort().join(",") !== expectedKeys.join(",")) invalid();
  if (input.schemaVersion !== PREFERENCES_SCHEMA) invalid();
  const normalized = {
    schemaVersion: PREFERENCES_SCHEMA,
    theme: input.theme,
    density: input.density,
    zoomPercent: input.zoomPercent,
    closeBehavior: input.closeBehavior,
    launchAtLogin: input.launchAtLogin,
    automaticUpdates: input.automaticUpdates,
  };
  if (!THEMES.has(normalized.theme)) invalid();
  if (!DENSITIES.has(normalized.density)) invalid();
  if (!ZOOM_PERCENTS.has(normalized.zoomPercent)) invalid();
  if (!CLOSE_BEHAVIORS.has(normalized.closeBehavior)) invalid();
  if (typeof normalized.launchAtLogin !== "boolean") invalid();
  if (typeof normalized.automaticUpdates !== "boolean") invalid();
  return normalized;
}

function mergePreferences(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) invalid();
  const keys = Object.keys(patch);
  if (keys.length < 1 || keys.some((key) => !PATCH_KEYS.has(key))) invalid();
  return normalizePreferences({ ...current, ...patch });
}

function preferencesPath(userDataRoot) {
  return path.join(path.resolve(userDataRoot), PREFERENCES_FILE);
}

function resolveWindowCloseAction(preferences, { quitRequested, shutdownInProgress }) {
  if (quitRequested || shutdownInProgress) return "allow";
  return preferences.closeBehavior === "quit" ? "quit" : "background";
}

async function loadPreferences(userDataRoot) {
  try {
    const parsed = JSON.parse(await readFile(preferencesPath(userDataRoot), "utf8"));
    return normalizePreferences(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return { ...DEFAULT_PREFERENCES };
    throw error;
  }
}

async function savePreferences(userDataRoot, preferences) {
  const normalized = normalizePreferences(preferences);
  const target = preferencesPath(userDataRoot);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  return normalized;
}

module.exports = {
  DEFAULT_PREFERENCES,
  PREFERENCES_SCHEMA,
  loadPreferences,
  mergePreferences,
  normalizePreferences,
  preferencesPath,
  resolveWindowCloseAction,
  savePreferences,
};
