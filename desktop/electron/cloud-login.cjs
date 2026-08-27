const CLOUD_LOGIN_PATH = "/api/auth/login";
const CLOUD_LOGOUT_PATH = "/api/auth/logout";

function fail(code) {
  throw new Error(code);
}

function validateCloudLoginInput(input) {
  if (
    !input
    || typeof input !== "object"
    || Array.isArray(input)
    || Object.keys(input).sort().join(",") !== "accountId,password,remember"
    || typeof input.accountId !== "string"
    || typeof input.password !== "string"
    || typeof input.remember !== "boolean"
  ) {
    fail("desktop_cloud_login_shape_invalid");
  }
  if (!input.password || input.password.length > 1024) {
    fail("desktop_cloud_password_invalid");
  }
  return input;
}

function sessionStorageScript(session) {
  const encoded = Buffer.from(JSON.stringify(session), "utf8").toString("base64");
  return `(() => {
    const decode = (value) => new TextDecoder().decode(
      Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
    );
    const session = JSON.parse(decode(${JSON.stringify(encoded)}));
    localStorage.setItem("bizhub_access_profile", JSON.stringify({
      version: session.accessProfileVersion,
      roles: session.roles,
      permissions: session.permissions,
    }));
    localStorage.setItem("token", session.token);
    localStorage.setItem("bizhub_account_name", session.accountName);
    return true;
  })()`;
}

function cloudLoginScript(password) {
  if (typeof password !== "string" || !password || password.length > 1024) {
    fail("desktop_cloud_password_invalid");
  }
  const encodedPassword = Buffer.from(password, "utf8").toString("base64");
  return `(() => {
    const decode = (value) => new TextDecoder().decode(
      Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
    );
    let password = decode(${JSON.stringify(encodedPassword)});
    return fetch(new URL(${JSON.stringify(CLOUD_LOGIN_PATH)}, window.location.origin), {
      method: "POST",
      redirect: "error",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then(async (response) => {
      password = "";
      let payload = null;
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) return { ok: false, status: response.status };
      if (
        !payload
        || typeof payload.token !== "string"
        || !payload.token
        || !Array.isArray(payload.roles)
        || !Array.isArray(payload.permissions)
        || Number(payload.access_profile_version) !== 1
      ) {
        return { ok: false, status: 502 };
      }
      const session = {
        accessProfileVersion: 1,
        accountName: typeof payload.account_name === "string" && payload.account_name.trim()
          ? payload.account_name.trim()
          : "BizHub",
        roles: payload.roles,
        permissions: payload.permissions,
        token: payload.token,
      };
      localStorage.setItem("bizhub_access_profile", JSON.stringify({
        version: session.accessProfileVersion,
        roles: session.roles,
        permissions: session.permissions,
      }));
      localStorage.setItem("token", session.token);
      localStorage.setItem("bizhub_account_name", session.accountName);
      return { ok: true, status: response.status, session };
    }).catch(() => {
      password = "";
      return { ok: false, status: 0 };
    });
  })()`;
}

function cloudLoginError(result) {
  if (result?.ok === true) return null;
  if (result?.status === 401) return "desktop_cloud_login_invalid";
  if (result?.status === 429) return "desktop_cloud_login_rate_limited";
  if (result?.status === 503) return "desktop_cloud_login_unavailable";
  return "desktop_cloud_login_failed";
}

function cloudLogoutScript() {
  return `(() => {
    const token = localStorage.getItem("token") || "";
    const headers = token ? { Authorization: \`Bearer \${token}\` } : {};
    return fetch(new URL(${JSON.stringify(CLOUD_LOGOUT_PATH)}, window.location.origin), {
      method: "POST",
      redirect: "error",
      credentials: "include",
      headers,
    }).then(() => true).catch(() => false).finally(() => {
      localStorage.removeItem("bizhub_access_profile");
      localStorage.removeItem("bizhub_account_name");
      localStorage.removeItem("token");
    });
  })()`;
}

module.exports = {
  CLOUD_LOGIN_PATH,
  CLOUD_LOGOUT_PATH,
  cloudLoginError,
  cloudLoginScript,
  cloudLogoutScript,
  sessionStorageScript,
  validateCloudLoginInput,
};
