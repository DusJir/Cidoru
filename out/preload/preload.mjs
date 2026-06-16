import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require2("electron");
const fs = require2("fs");
const path = require2("path");
const userData = ipcRenderer.sendSync("get-user-data-path");
const sessionFile = path.join(userData, "session.json");
const presetsFile = path.join(userData, "presets.json");
let initialSession = null;
let initialPresets = [];
try {
  initialSession = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
} catch (_) {
}
try {
  initialPresets = JSON.parse(fs.readFileSync(presetsFile, "utf-8"));
} catch (_) {
}
const migrationFlagFile = path.join(userData, ".migrated-from-localstorage");
const needsMigration = !fs.existsSync(migrationFlagFile) && initialSession === null;
contextBridge.exposeInMainWorld("electronAPI", {
  // Marker so platform.js can detect Electron
  isElectron: true,
  // Synchronous init data (set once at startup)
  initialSession,
  initialPresets,
  // One-time migration: true if no session file found and never migrated before
  needsMigration,
  // Called by renderer after it reads localStorage and saves via session:save
  migrationComplete: () => {
    try {
      fs.writeFileSync(migrationFlagFile, (/* @__PURE__ */ new Date()).toISOString(), "utf-8");
    } catch (_) {
    }
  },
  // Session
  session: {
    save: (data) => ipcRenderer.invoke("session:save", data),
    load: () => ipcRenderer.invoke("session:load")
  },
  // Presets
  presets: {
    save: (data) => ipcRenderer.invoke("presets:save", data)
  },
  // File pickers (native dialogs)
  pick: {
    wav: () => ipcRenderer.invoke("pick:wav"),
    midi: () => ipcRenderer.invoke("pick:midi"),
    relink: (isMidi) => ipcRenderer.invoke("pick:relink", isMidi)
  },
  // Scan — verify cached paths still exist
  scan: {
    verify: (filePaths) => ipcRenderer.invoke("scan:verify", filePaths),
    folder: () => ipcRenderer.invoke("scan:folder")
  },
  fileCache: {
    save: (cacheObj) => ipcRenderer.invoke("filecache:save", cacheObj),
    load: () => ipcRenderer.invoke("filecache:load")
  },
  // SD card transfer
  transfer: {
    start: (project, mixerStates, filePaths) => ipcRenderer.invoke("transfer:start", project, mixerStates, filePaths),
    onProgress: (cb) => {
      const handler = (_, msg) => cb(msg);
      ipcRenderer.on("transfer:progress", handler);
      return () => ipcRenderer.removeListener("transfer:progress", handler);
    }
  },
  // Export / Import JSON
  exportJson: (jsonStr) => ipcRenderer.invoke("export:json", jsonStr),
  importJson: () => ipcRenderer.invoke("import:json"),
  importIdoru: () => ipcRenderer.invoke("import:idoru"),
  // Audio preview — read file bytes for Web Audio API
  audio: {
    readBuffer: (filePath) => ipcRenderer.invoke("audio:readBuffer", filePath)
  },
  // Open manual
  openManual: () => ipcRenderer.invoke("open:manual"),
  // Auto-updater
  updater: {
    install: () => ipcRenderer.invoke("updater:install"),
    onUpdateAvailable: (cb) => {
      const h = (_, info) => cb(info);
      ipcRenderer.on("updater:update-available", h);
      return () => ipcRenderer.removeListener("updater:update-available", h);
    },
    onDownloadProgress: (cb) => {
      const h = (_, pct) => cb(pct);
      ipcRenderer.on("updater:download-progress", h);
      return () => ipcRenderer.removeListener("updater:download-progress", h);
    },
    onUpdateDownloaded: (cb) => {
      const h = (_, info) => cb(info);
      ipcRenderer.on("updater:update-downloaded", h);
      return () => ipcRenderer.removeListener("updater:update-downloaded", h);
    }
  },
  // Firmware
  firmware: {
    check: () => ipcRenderer.invoke("firmware:check"),
    download: (url, version) => ipcRenderer.invoke("firmware:download", url, version),
    pick: () => ipcRenderer.invoke("firmware:pick"),
    pickSdRoot: () => ipcRenderer.invoke("firmware:pickSdRoot"),
    getCached: () => ipcRenderer.invoke("firmware:getCached"),
    clearCache: () => ipcRenderer.invoke("firmware:clearCache"),
    openPage: () => ipcRenderer.invoke("firmware:openPage"),
    writeToSd: (root, path2) => ipcRenderer.invoke("firmware:writeToSd", root, path2),
    onProgress: (cb) => {
      const handler = (_, pct) => cb(pct);
      ipcRenderer.on("firmware:progress", handler);
      return () => ipcRenderer.removeListener("firmware:progress", handler);
    }
  }
});
