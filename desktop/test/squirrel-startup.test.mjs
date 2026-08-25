import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { handleSquirrelStartup, squirrelAction } = require("../electron/squirrel-startup.cjs");

test("ignores non-Windows and ordinary Windows launches", () => {
  assert.equal(squirrelAction(["electron"], "/Applications/BizHub Desktop", "darwin"), null);
  assert.equal(squirrelAction(["BizHub Desktop.exe"], "C:\\app\\BizHub Desktop.exe", "win32"), null);
});

test("maps Squirrel install and uninstall events to bounded shortcut commands", () => {
  assert.deepEqual(
    squirrelAction(
      ["BizHub Desktop.exe", "--squirrel-install"],
      "C:\\Users\\test\\AppData\\Local\\bizhub_desktop\\app-0.1.0\\BizHub Desktop.exe",
      "win32",
    ),
    {
      event: "--squirrel-install",
      command: "C:\\Users\\test\\AppData\\Local\\bizhub_desktop\\Update.exe",
      args: ["--createShortcut", "BizHub Desktop.exe"],
    },
  );
  assert.deepEqual(
    squirrelAction(
      ["BizHub Desktop.exe", "--squirrel-uninstall"],
      "C:\\Users\\test\\AppData\\Local\\bizhub_desktop\\app-0.1.0\\BizHub Desktop.exe",
      "win32",
    )?.args,
    ["--removeShortcut", "BizHub Desktop.exe"],
  );
});

test("handles a Squirrel event without entering the normal Desktop lifecycle", () => {
  const launches = [];
  let quitCount = 0;
  const handled = handleSquirrelStartup(
    { quit: () => { quitCount += 1; } },
    {
      argv: ["BizHub Desktop.exe", "--squirrel-updated"],
      execPath: "C:\\Local\\bizhub_desktop\\app-0.1.0\\BizHub Desktop.exe",
      platform: "win32",
      spawn: (command, args, options) => {
        launches.push({ command, args, options });
        return { once: () => {}, unref: () => {} };
      },
      setTimeout: (callback, delay) => {
        assert.equal(delay, 1_000);
        callback();
      },
    },
  );
  assert.equal(handled, true);
  assert.equal(launches.length, 1);
  assert.equal(quitCount, 1);
});
