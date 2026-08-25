const path = require("node:path");
const { sign } = require("@electron/windows-sign");

const runtimeResourceSegment = `${path.sep}resources${path.sep}bizhub-runtime${path.sep}`.toLowerCase();

function preservesFixedRuntime(fileToSign) {
  return path.resolve(fileToSign).toLowerCase().includes(runtimeResourceSegment);
}

async function signWindowsFile(fileToSign) {
  // The fixed Runtime Pack is independently identity-bound before packaging.
  // Squirrel signs files inside its temporary NuGet tree too, so this hook must
  // be a serializable module shared by Packager and electron-winstaller.
  if (preservesFixedRuntime(fileToSign)) return;

  const certificateFile = process.env.BIZHUB_WINDOWS_CERTIFICATE_FILE;
  const certificatePassword = process.env.BIZHUB_WINDOWS_CERTIFICATE_PASSWORD;
  if (!certificateFile || !certificatePassword) {
    throw new Error("desktop_windows_signing_credentials_missing");
  }
  await sign({
    files: [fileToSign],
    certificateFile,
    certificatePassword,
    hashes: ["sha256"],
  });
}

signWindowsFile.preservesFixedRuntime = preservesFixedRuntime;

module.exports = signWindowsFile;
