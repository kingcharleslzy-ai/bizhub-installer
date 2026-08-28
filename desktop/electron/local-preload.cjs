const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bizhubLocalDesktop", {
  getSettings: () => ipcRenderer.invoke("desktop:local-settings"),
  getPreferences: () => ipcRenderer.invoke("desktop:local-get-preferences"),
  updatePreferences: (patch) => ipcRenderer.invoke("desktop:local-update-preferences", patch),
  createBackup: () => ipcRenderer.invoke("desktop:local-backup"),
  openBackupFolder: () => ipcRenderer.invoke("desktop:local-open-backups"),
  changePassword: (input) => ipcRenderer.invoke("desktop:local-change-password", input),
  switchAccount: () => ipcRenderer.invoke("desktop:local-switch-account"),
  forgetAccount: () => ipcRenderer.invoke("desktop:local-forget-account"),
  onPreferencesChange: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, preferences) => listener(preferences);
    ipcRenderer.on("desktop:preferences", handler);
    return () => ipcRenderer.removeListener("desktop:preferences", handler);
  },
});
