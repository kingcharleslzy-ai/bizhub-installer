function mediaPermissionAllowed({ permission, mediaTypes, requestingOrigin, allowedOrigins } = {}) {
  if (permission !== "media") return false;
  if (!Array.isArray(mediaTypes) || mediaTypes.length !== 1 || mediaTypes[0] !== "audio") return false;
  if (typeof requestingOrigin !== "string" || !Array.isArray(allowedOrigins)) return false;
  return allowedOrigins.includes(requestingOrigin);
}

function permissionOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

module.exports = { mediaPermissionAllowed, permissionOrigin };
