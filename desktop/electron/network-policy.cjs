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

module.exports = {
  originForRemoteRequest,
  remoteRequestAllowed,
};
