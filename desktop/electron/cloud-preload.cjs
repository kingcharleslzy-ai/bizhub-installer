const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bizhubDesktop", {
  getInfo: () => ipcRenderer.invoke("desktop:cloud-get-info"),
  getPreferences: () => ipcRenderer.invoke("desktop:cloud-get-preferences"),
  updatePreferences: (patch) => ipcRenderer.invoke("desktop:cloud-update-preferences", patch),
  checkUpdate: () => ipcRenderer.invoke("desktop:cloud-check-update"),
  switchAccount: () => ipcRenderer.invoke("desktop:cloud-switch-account"),
  onPreferencesChange: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, preferences) => listener(preferences);
    ipcRenderer.on("desktop:preferences", handler);
    return () => ipcRenderer.removeListener("desktop:preferences", handler);
  },
});
