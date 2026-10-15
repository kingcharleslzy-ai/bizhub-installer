// Reuse @electron/windows-sign's native SignTool parameter support for a
// pre-existing CurrentUser/My identity; CI never exports a production key.
module.exports = function windowsSignOptions(environment = process.env) {
  const thumbprint = environment.BIZHUB_WINDOWS_CERTIFICATE_SHA1;
  if (thumbprint) {
    if (environment.BIZHUB_WINDOWS_SIGNING_MODE !== "production" || !/^[A-F0-9]{40}$/.test(thumbprint)) {
      throw new Error("desktop_windows_store_signing_identity_invalid");
    }
    return {
      hashes: ["sha256"],
      signWithParams: `/sha1 ${thumbprint} /s My /fd SHA256 /tr http://timestamp.digicert.com /td SHA256`,
    };
  }
  const certificateFile = environment.BIZHUB_WINDOWS_CERTIFICATE_FILE;
  const certificatePassword = environment.BIZHUB_WINDOWS_CERTIFICATE_PASSWORD;
  if (!certificateFile || !certificatePassword) {
    throw new Error("desktop_windows_signing_credentials_missing");
  }
  return { certificateFile, certificatePassword, hashes: ["sha256"] };
};
