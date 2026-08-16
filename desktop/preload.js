"use strict";

const { contextBridge } = require("electron");

// Deliberately tiny surface. The loaded page is the real scan2plate.com
// website — it does not need, and must never be given, filesystem/process/
// IPC access. This only lets the page detect it's running in the desktop
// shell, which nothing currently depends on but is useful for future,
// explicitly-opt-in desktop-only UI (e.g. hiding a "download the app" banner).
contextBridge.exposeInMainWorld("scan2plateDesktop", {
  isDesktop: true,
  platform: process.platform
});
