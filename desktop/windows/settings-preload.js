"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Only the exact channels this local settings window needs. Every handler on
// the main-process side validates its input — see main.js ipcMain.handle.
contextBridge.exposeInMainWorld("settingsBridge", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: partial => ipcRenderer.invoke("settings:save", partial),
  listPrinters: () => ipcRenderer.invoke("settings:listPrinters"),
  getAppInfo: () => ipcRenderer.invoke("app:getInfo"),
  openWebsite: () => ipcRenderer.invoke("app:openWebsite")
});
