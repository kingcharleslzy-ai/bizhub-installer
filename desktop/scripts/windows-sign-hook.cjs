const path = require("node:path");
const { sign } = require("@electron/windows-sign");
const windowsSignOptions = require("./windows-sign-options.cjs");

const runtimeResourceSegment = `${path.sep}resources${path.sep}bizhub-runtime${path.sep}`.toLowerCase();

function preservesFixedRuntime(fileToSign) {
  return path.resolve(fileToSign).toLowerCase().includes(runtimeResourceSegment);
}

async function signWindowsFile(fileToSign) {
  // R1 signs and independently rebinds the Runtime Pack before packaging.
  // The packager must preserve those finalized bytes; other workflows keep
  // using their already reviewed fixed Runtime Pack without an R1 rebind.
  // Squirrel signs files inside its temporary NuGet tree too, so this hook must
  // be a serializable module shared by Packager and electron-winstaller.
  if (preservesFixedRuntime(fileToSign)) return;

  await sign({
    files: [fileToSign],
    ...windowsSignOptions(),
  });
}

signWindowsFile.preservesFixedRuntime = preservesFixedRuntime;

module.exports = signWindowsFile;
