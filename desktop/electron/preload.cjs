const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bizhubDesktop", {
  chooseConnectionProfile: () => ipcRenderer.invoke("desktop:choose-connection-profile"),
  disconnectWorkspace: () => ipcRenderer.invoke("desktop:disconnect-workspace"),
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  onStateChange: (listener) => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("desktop:state", handler);
    return () => ipcRenderer.removeListener("desktop:state", handler);
  },
});
