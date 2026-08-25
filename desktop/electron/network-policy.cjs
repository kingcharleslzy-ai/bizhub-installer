function originForRemoteRequest(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol === "https:") return parsed.origin;
  if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
    return parsed.origin;
  }
  if (parsed.protocol === "blob:") return parsed.origin;
  if (parsed.protocol === "data:") return "data:";
  return null;
}

function remoteRequestAllowed(value, allowedOrigins) {
  const origin = originForRemoteRequest(value);
  return origin === "data:" || (origin !== null && allowedOrigins.includes(origin));
}

function normalizeLocalOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port
    || parsed.username
    || parsed.password
  ) {
    return null;
  }
  return parsed.origin;
}

function localRequestAllowed(value, localOrigin) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol === "data:") return true;
  if (parsed.protocol === "blob:") return parsed.origin === localOrigin;
  return normalizeLocalOrigin(value) === localOrigin;
}

module.exports = {
  localRequestAllowed,
  normalizeLocalOrigin,
  originForRemoteRequest,
  remoteRequestAllowed,
};
