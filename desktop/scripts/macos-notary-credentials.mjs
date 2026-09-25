import path from "node:path";

function fail(code) {
  throw new Error(code);
}

// Exactly one complete Apple notary credential kind is accepted: an App Store
// Connect API key (file, key id, issuer) or an Apple ID with an app-specific
// password bound to the publisher Team ID. Mixed or partial input fails closed.
export function resolveNotaryCredentials(environment, teamId) {
  const apiKey = {
    appleApiIssuer: environment.BIZHUB_APPLE_API_ISSUER || "",
    appleApiKey: environment.BIZHUB_APPLE_API_KEY_FILE || "",
    appleApiKeyId: environment.BIZHUB_APPLE_API_KEY_ID || "",
  };
  const appleId = {
    appleId: environment.BIZHUB_APPLE_ID || "",
    appleIdPassword: environment.BIZHUB_APPLE_APP_PASSWORD || "",
  };
  const apiKeyValues = Object.values(apiKey);
  const appleIdValues = Object.values(appleId);
  const apiKeyAny = apiKeyValues.some(Boolean);
  const appleIdAny = appleIdValues.some(Boolean);
  if (apiKeyAny && appleIdAny) fail("desktop_macos_notary_credentials_ambiguous");
  const apiKeyComplete = apiKeyValues.every(Boolean);
  const appleIdComplete = appleIdValues.every(Boolean);
  if (!apiKeyComplete && !appleIdComplete) fail("desktop_macos_notary_credentials_missing");
  for (const value of [...apiKeyValues, ...appleIdValues, teamId]) {
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
      fail("desktop_macos_notary_credentials_invalid");
    }
  }
  if (!/^[A-Z0-9]{10}$/.test(teamId)) fail("desktop_macos_notary_credentials_invalid");
  if (apiKeyComplete) {
    if (
      !path.isAbsolute(apiKey.appleApiKey)
      || !/^[A-Z0-9]{10}$/.test(apiKey.appleApiKeyId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(apiKey.appleApiIssuer)
    ) {
      fail("desktop_macos_notary_credentials_invalid");
    }
    return { kind: "api-key", ...apiKey };
  }
  if (!/^[^@\s]+@[^@\s]+$/.test(appleId.appleId)) {
    fail("desktop_macos_notary_credentials_invalid");
  }
  return { kind: "apple-id", ...appleId, teamId };
}

export function electronNotarizeOptions(appPath, credentials) {
  if (credentials.kind === "api-key") {
    return {
      appPath,
      appleApiIssuer: credentials.appleApiIssuer,
      appleApiKey: credentials.appleApiKey,
      appleApiKeyId: credentials.appleApiKeyId,
    };
  }
  if (credentials.kind === "apple-id") {
    return {
      appPath,
      appleId: credentials.appleId,
      appleIdPassword: credentials.appleIdPassword,
      teamId: credentials.teamId,
    };
  }
  return fail("desktop_macos_notary_credentials_invalid");
}

export function notarytoolCredentialArguments(credentials) {
  if (credentials.kind === "api-key") {
    return [
      "--key", credentials.appleApiKey,
      "--key-id", credentials.appleApiKeyId,
      "--issuer", credentials.appleApiIssuer,
    ];
  }
  if (credentials.kind === "apple-id") {
    return [
      "--apple-id", credentials.appleId,
      "--password", credentials.appleIdPassword,
      "--team-id", credentials.teamId,
    ];
  }
  return fail("desktop_macos_notary_credentials_invalid");
}
