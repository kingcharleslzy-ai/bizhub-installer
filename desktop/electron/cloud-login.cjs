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

// 工作区接了 ERPNext 时（桌面版页面直读 ERPNext，ERPNext 的接口经门口网关转到同一网址），同一次登录顺带登上 ERPNext：
// 先不带密码问一下 ERPNext 的桌面版启动读口，回“没登录”（401/403）才说明这个工作区接了 ERPNext，再用同一个账号和
// 同一个密码走 ERPNext 自带的登录接口（账号见下面 erpnextLogin 的说明）；没接 ERPNext 的工作区不会收到这次登录。ERPNext 没登上不影响老系统登录。
// 密码只在这段脚本里用一次，两边都发完就清掉。
const ERPNEXT_PROBE_PATH = "/api/method/bizhub_erp.api.desktop_boot";
const ERPNEXT_LOGIN_PATH = "/api/method/login";
const ERPNEXT_LOGOUT_PATH = "/api/method/logout";

function cloudLoginScript(password, erpnextUser = null) {
  if (typeof password !== "string" || !password || password.length > 1024) {
    fail("desktop_cloud_password_invalid");
  }
  if (erpnextUser !== null && (typeof erpnextUser !== "string" || !erpnextUser || erpnextUser.length > 256)) {
    fail("desktop_cloud_account_invalid");
  }
  const encodedPassword = Buffer.from(password, "utf8").toString("base64");
  const encodedUser = erpnextUser === null ? null : Buffer.from(erpnextUser, "utf8").toString("base64");
  return `(() => {
    const decode = (value) => new TextDecoder().decode(
      Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
    );
    let password = decode(${JSON.stringify(encodedPassword)});
    const erpnextUser = ${encodedUser === null ? "null" : `decode(${JSON.stringify(encodedUser)})`};
    const origin = window.location.origin;
    // 登 ERPNext 用哪个账号：老系统登录回包里带了所有者的 ERPNext 账号（erpnext_user）就用它，没带才用登录框里的账号名。
    const erpnextLogin = async (accountForErpnext) => {
      if (!accountForErpnext) return false;
      const probe = await fetch(new URL(${JSON.stringify(ERPNEXT_PROBE_PATH)}, origin), {
        method: "GET", redirect: "error", credentials: "include", headers: { Accept: "application/json" },
      }).catch(() => null);
      if (!probe) return false;
      if (probe.ok) return true;
      if (probe.status !== 401 && probe.status !== 403) return false;
      const response = await fetch(new URL(${JSON.stringify(ERPNEXT_LOGIN_PATH)}, origin), {
        method: "POST",
        redirect: "error",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ usr: accountForErpnext, pwd: password }),
      }).catch(() => null);
      return Boolean(response && response.ok);
    };
    return fetch(new URL(${JSON.stringify(CLOUD_LOGIN_PATH)}, origin), {
      method: "POST",
      redirect: "error",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then(async (response) => {
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
      const erpnextAccount = typeof payload.erpnext_user === "string" && payload.erpnext_user.trim()
        ? payload.erpnext_user.trim()
        : erpnextUser;
      const erpnext = await erpnextLogin(erpnextAccount).catch(() => false);
      return { ok: true, status: response.status, session, erpnext };
    }).catch(() => ({ ok: false, status: 0 })).finally(() => {
      password = "";
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

function isCloudLogoutRequest(details, allowedOrigins) {
  if (
    !details
    || details.method !== "POST"
    || typeof details.url !== "string"
    || !Array.isArray(allowedOrigins)
  ) {
    return false;
  }
  try {
    const requestUrl = new URL(details.url);
    return allowedOrigins.includes(requestUrl.origin)
      && requestUrl.pathname === CLOUD_LOGOUT_PATH;
  } catch {
    return false;
  }
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
      // 同时退出 ERPNext（没接 ERPNext 的工作区这一下只是 404）。
      void fetch(new URL(${JSON.stringify(ERPNEXT_LOGOUT_PATH)}, window.location.origin), {
        method: "POST", redirect: "error", credentials: "include",
      }).catch(() => false);
      localStorage.removeItem("bizhub_access_profile");
      localStorage.removeItem("bizhub_account_name");
      localStorage.removeItem("token");
    });
  })()`;
}

// 页面自己点了退出（老后台退出）以后，再把 ERPNext 也退掉。
function erpnextLogoutScript() {
  return `fetch(new URL(${JSON.stringify(ERPNEXT_LOGOUT_PATH)}, window.location.origin), {
    method: "POST", redirect: "error", credentials: "include",
  }).then(() => true).catch(() => false)`;
}

module.exports = {
  CLOUD_LOGIN_PATH,
  ERPNEXT_LOGOUT_PATH,
  erpnextLogoutScript,
  CLOUD_LOGOUT_PATH,
  cloudLoginError,
  cloudLoginScript,
  cloudLogoutScript,
  isCloudLogoutRequest,
  sessionStorageScript,
  validateCloudLoginInput,
};
