const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bizhubDesktop", {
  getInfo: () => ipcRenderer.invoke("desktop:cloud-get-info"),
  getPreferences: () => ipcRenderer.invoke("desktop:cloud-get-preferences"),
  updatePreferences: (patch) => ipcRenderer.invoke("desktop:cloud-update-preferences", patch),
  checkUpdate: () => ipcRenderer.invoke("desktop:cloud-check-update"),
  switchAccount: () => ipcRenderer.invoke("desktop:cloud-switch-account"),
  showNotification: (notification) => ipcRenderer.invoke("desktop:cloud-show-notification", notification),
  setBadgeCount: (count) => ipcRenderer.invoke("desktop:cloud-set-badge-count", count),
  onPreferencesChange: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, preferences) => listener(preferences);
    ipcRenderer.on("desktop:preferences", handler);
    return () => ipcRenderer.removeListener("desktop:preferences", handler);
  },
});
