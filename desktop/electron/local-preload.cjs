const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bizhubLocalDesktop", {
  getSettings: () => ipcRenderer.invoke("desktop:local-settings"),
  createBackup: () => ipcRenderer.invoke("desktop:local-backup"),
  openBackupFolder: () => ipcRenderer.invoke("desktop:local-open-backups"),
  changePassword: (input) => ipcRenderer.invoke("desktop:local-change-password", input),
  switchAccount: () => ipcRenderer.invoke("desktop:local-switch-account"),
  forgetAccount: () => ipcRenderer.invoke("desktop:local-forget-account"),
});
