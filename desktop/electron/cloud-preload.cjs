const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bizhubDesktop", {
  getInfo: () => ipcRenderer.invoke("desktop:cloud-get-info"),
  checkUpdate: () => ipcRenderer.invoke("desktop:cloud-check-update"),
  switchAccount: () => ipcRenderer.invoke("desktop:cloud-switch-account"),
});
