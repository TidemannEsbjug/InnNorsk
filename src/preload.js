const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("innnorsk", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  pickFolder: (which) => ipcRenderer.invoke("folder:pick", which),
  scanFolder: () => ipcRenderer.invoke("folder:scan"),
  openFolder: (which) => ipcRenderer.invoke("folder:open", which),
  testApi: () => ipcRenderer.invoke("api:test"),
  translate: () => ipcRenderer.invoke("job:translate"),
  cancel: () => ipcRenderer.invoke("job:cancel"),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  onProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("job:progress", listener);
    return () => ipcRenderer.removeListener("job:progress", listener);
  },
});
