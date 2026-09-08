const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { getSettings, saveSettings, defaultOutputFolder } = require("./settings");
const { scanFolder, translateFile } = require("./pipeline");
const { testConnection } = require("./grok");

app.setName("InnNorsk");
if (process.platform === "win32") {
  app.setAppUserModelId("no.innnorsk.app");
}

let mainWindow;
let translating = false;
let cancelRequested = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: "#0E2A3A",
    title: "InnNorsk",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, "..", "assets", "icon.png"),
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

ipcMain.handle("settings:get", () => {
  const s = getSettings();
  return {
    ...s,
    apiKey: s.apiKey,
  };
});

ipcMain.handle("settings:save", (_e, patch) => saveSettings(patch || {}));

ipcMain.handle("folder:pick", async (_e, which) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: which === "output" ? "Velg ut-mappe" : "Velg inn-mappe",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const folder = result.filePaths[0];
  if (which === "output") {
    saveSettings({ outputFolder: folder });
  } else {
    const current = getSettings();
    const patch = { inputFolder: folder };
    if (!current.outputFolder) patch.outputFolder = defaultOutputFolder(folder);
    saveSettings(patch);
  }
  return getSettings();
});

ipcMain.handle("folder:scan", () => {
  const s = getSettings();
  if (!s.inputFolder) return { files: [], error: "Velg en inn-mappe først." };
  const outputFolder = s.outputFolder || defaultOutputFolder(s.inputFolder);
  return scanFolder({ inputFolder: s.inputFolder, outputFolder });
});

ipcMain.handle("folder:open", async (_e, which) => {
  const s = getSettings();
  const target =
    which === "output"
      ? s.outputFolder || defaultOutputFolder(s.inputFolder)
      : s.inputFolder;
  if (!target) return { ok: false, error: "Ingen mappe valgt." };
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  await shell.openPath(target);
  return { ok: true };
});

ipcMain.handle("api:test", async () => {
  const s = getSettings();
  if (!s.apiKey) throw new Error("Lim inn xAI API-nøkkel under Innstillinger.");
  return testConnection({ apiKey: s.apiKey, model: s.model });
});

ipcMain.handle("job:cancel", () => {
  cancelRequested = true;
  return { ok: true };
});

ipcMain.handle("job:translate", async () => {
  if (translating) throw new Error("En oversettelse kjører allerede.");
  const s = getSettings();
  if (!s.apiKey) throw new Error("Lim inn xAI API-nøkkel under Innstillinger.");
  if (!s.inputFolder) throw new Error("Velg en inn-mappe først.");

  const outputFolder = s.outputFolder || defaultOutputFolder(s.inputFolder);
  const { files, error } = scanFolder({
    inputFolder: s.inputFolder,
    outputFolder,
  });
  if (error) throw new Error(error);
  if (!files.length) throw new Error("Fant ingen støttede dokumenter i mappen.");

  translating = true;
  cancelRequested = false;
  const results = [];

  try {
    for (let i = 0; i < files.length; i++) {
      if (cancelRequested) break;
      const file = files[i];
      send("job:progress", {
        index: i,
        total: files.length,
        name: file.name,
        status: "working",
        message: "Oversetter…",
      });
      try {
        const result = await translateFile(file.path, {
          inputFolder: s.inputFolder,
          outputFolder,
          skipExisting: s.skipExisting,
          apiKey: s.apiKey,
          model: s.model,
          targetLanguage: s.targetLanguage,
          onProgress: (p) => {
            send("job:progress", {
              index: i,
              total: files.length,
              name: file.name,
              status: "working",
              message: `Oversetter avsnitt ${p.done} av ${p.total}`,
            });
          },
        });
        results.push({
          name: file.name,
          dest: result.dest,
          skipped: result.skipped,
          ok: true,
        });
        send("job:progress", {
          index: i,
          total: files.length,
          name: file.name,
          status: result.skipped ? "skipped" : "done",
          message: result.skipped ? "Hoppet over (finnes fra før)" : "Ferdig",
        });
      } catch (err) {
        results.push({
          name: file.name,
          ok: false,
          error: err.message || String(err),
        });
        send("job:progress", {
          index: i,
          total: files.length,
          name: file.name,
          status: "error",
          message: err.message || String(err),
        });
      }
    }
    return {
      cancelled: cancelRequested,
      results,
      outputFolder,
    };
  } finally {
    translating = false;
    cancelRequested = false;
  }
});

ipcMain.handle("shell:open-external", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});
