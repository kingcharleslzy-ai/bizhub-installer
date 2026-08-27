const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bizhubDesktop", {
  loginAccount: (input) => ipcRenderer.invoke("desktop:login-account", input),
  resumeAccount: (accountId) => ipcRenderer.invoke("desktop:resume-account", { accountId }),
  switchAccount: (accountId = "") => ipcRenderer.invoke("desktop:switch-account", { accountId }),
  lookupAccount: (accountId) => ipcRenderer.invoke("desktop:lookup-account", { accountId }),
  loginEnterprise: (input) => ipcRenderer.invoke("desktop:login-enterprise", input),
  forgetRememberedLogin: () => ipcRenderer.invoke("desktop:forget-remembered-login"),
  resetAccountLookup: () => ipcRenderer.invoke("desktop:reset-account-lookup"),
  connectEnterpriseWorkspace: (connectionId) => ipcRenderer.invoke(
    "desktop:connect-enterprise-workspace",
    { connectionId },
  ),
  disconnectWorkspace: () => ipcRenderer.invoke("desktop:disconnect-workspace"),
  prepareLocal: () => ipcRenderer.invoke("desktop:prepare-local"),
  setupLocal: (input) => ipcRenderer.invoke("desktop:setup-local", input),
  loginLocal: (input) => ipcRenderer.invoke("desktop:login-local", input),
  backupLocal: () => ipcRenderer.invoke("desktop:backup-local"),
  stopLocal: () => ipcRenderer.invoke("desktop:stop-local"),
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  onStateChange: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("desktop:state", handler);
    return () => ipcRenderer.removeListener("desktop:state", handler);
  },
});
