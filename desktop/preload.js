"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// One preload for the whole lifetime of the main window - Electron cannot
// swap preload scripts per-navigation within the same BrowserWindow, so
// this single bridge has to cover both what's loaded on it: the live
// scan2plate.com site (which uses none of this - isDesktop/goOfflineBilling
// only) and the local offline-billing.html page (which uses the
// offlineBilling.* methods). Every offline:* handler validates its input
// and only operates on the currently cached restaurant context server-side
// (see main.js), so exposing it unconditionally here doesn't hand the live
// page anything it couldn't already do through its own normal Firestore
// writes as the logged-in restaurant.
contextBridge.exposeInMainWorld("scan2plateDesktop", {
  isDesktop: true,
  platform: process.platform,
  goOfflineBilling: () => ipcRenderer.send("offline:switchToBillingMode")
});

contextBridge.exposeInMainWorld("offlineBilling", {
  getContext: () => ipcRenderer.invoke("offline:getContext"),
  createOrder: order => ipcRenderer.invoke("offline:createOrder", order),
  getPendingCount: () => ipcRenderer.invoke("offline:getPendingCount"),
  print: () => ipcRenderer.invoke("offline:print")
});
