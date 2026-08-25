const { spawn } = require("node:child_process");
const path = require("node:path");

const SQUIRREL_EVENTS = new Set([
  "--squirrel-install",
  "--squirrel-updated",
  "--squirrel-uninstall",
  "--squirrel-obsolete",
]);

function squirrelAction(argv, execPath, platform = process.platform) {
  if (platform !== "win32") return null;
  const event = argv[1];
  if (!SQUIRREL_EVENTS.has(event)) return null;
  if (event === "--squirrel-obsolete") return { event, command: null, args: [] };
  const executableName = path.win32.basename(execPath);
  const updateExecutable = path.win32.resolve(path.win32.dirname(execPath), "..", "Update.exe");
  return {
    event,
    command: updateExecutable,
    args: [
      event === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut",
      executableName,
    ],
  };
}

function handleSquirrelStartup(app, options = {}) {
  const argv = options.argv || process.argv;
  const execPath = options.execPath || process.execPath;
  const platform = options.platform || process.platform;
  const launch = options.spawn || spawn;
  const defer = options.setTimeout || setTimeout;
  const action = squirrelAction(argv, execPath, platform);
  if (!action) return false;
  if (action.command) {
    const child = launch(action.command, action.args, { detached: true, stdio: "ignore" });
    child.once("error", () => {});
    child.unref();
  }
  defer(() => app.quit(), 1_000);
  return true;
}

module.exports = { handleSquirrelStartup, squirrelAction };
