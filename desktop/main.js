"use strict";

const { app, BrowserWindow, Menu, shell, ipcMain, session } = require("electron");
const path = require("node:path");
const url = require("node:url");

const { APP_URL, ALLOWED_HOSTS, APP_NAME } = require("./src/constants");
const { loadWindowState, saveWindowState } = require("./src/windowState");
const { installConnectivityBanner, installOfflineFallback } = require("./src/connectivity");
const { readSettings, writeSettings } = require("./src/settingsStore");

const isDev = process.env.SCAN2PLATE_DESKTOP_DEV === "1";
const startUrl = APP_URL;

let mainWindow = null;
let settingsWindow = null;

function isAllowedHost(targetUrl) {
  try {
    const host = new url.URL(targetUrl).hostname.toLowerCase();
    return ALLOWED_HOSTS.includes(host);
  } catch {
    return false;
  }
}

function platformIcon() {
  if (process.platform === "win32") return path.join(__dirname, "assets", "icon.ico");
  if (process.platform === "darwin") return path.join(__dirname, "assets", "icon.icns");
  return path.join(__dirname, "assets", "icon.png");
}

function createMainWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1024,
    minHeight: 700,
    title: APP_NAME,
    icon: platformIcon(),
    backgroundColor: "#0f172a",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: isDev
    }
  });

  const persist = () => saveWindowState(mainWindow);
  mainWindow.on("resize", persist);
  mainWindow.on("move", persist);
  mainWindow.on("close", persist);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    if (readSettings().posFullScreenByDefault) mainWindow.setFullScreen(true);
  });

  // Security: only ever navigate top-level frames within our own domain.
  // Everything else (support links, external "Powered by" links, etc.)
  // opens in the user's normal browser instead of inside the app.
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedHost(targetUrl)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isAllowedHost(targetUrl)) return { action: "allow" };
    shell.openExternal(targetUrl);
    return { action: "deny" };
  });

  installConnectivityBanner(mainWindow);
  installOfflineFallback(mainWindow, {
    offlineHtmlPath: path.join(__dirname, "windows", "offline.html"),
    startUrl
  });

  // Full Screen POS Mode: Esc exits it, matching the requirement for a
  // discoverable, reliable exit shortcut that doesn't depend on the menu.
  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "Escape" && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
  });

  mainWindow.loadURL(startUrl);
}

function openSettingsWindow(initialTab) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 620,
    height: 560,
    resizable: true,
    parent: mainWindow || undefined,
    title: "Scan2Plate Settings",
    icon: platformIcon(),
    webPreferences: {
      preload: path.join(__dirname, "windows", "settings-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDev
    }
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "windows", "settings.html"));
  settingsWindow.on("closed", () => { settingsWindow = null; });
  if (initialTab === "about") {
    settingsWindow.webContents.once("did-finish-load", () => {
      settingsWindow?.webContents.executeJavaScript(`document.querySelector('[data-tab="about"]').click();`).catch(() => {});
    });
  }
}

function buildMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { label: "Printer Settings…", click: () => openSettingsWindow("printer") },
        { label: "About Scan2Plate", click: () => openSettingsWindow("about") },
        { type: "separator" },
        {
          label: "Toggle Full Screen POS Mode",
          accelerator: process.platform === "darwin" ? "Cmd+Shift+F" : "F11",
          click: () => { if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); }
        },
        { role: "reload", label: "Reload" },
        { type: "separator" },
        { role: "quit" }
      ]
    }
  ];
  if (isDev) {
    template.push({ label: "Developer", submenu: [{ role: "toggleDevTools" }] });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpcHandlers() {
  ipcMain.handle("settings:get", () => readSettings());

  ipcMain.handle("settings:save", (_event, partial) => {
    // Validate shape rather than trusting the renderer blindly — this is a
    // local settings window, but every IPC input still gets checked.
    const safe = {};
    if (typeof partial?.billPrinter === "string") safe.billPrinter = partial.billPrinter;
    if (typeof partial?.kotPrinter === "string") safe.kotPrinter = partial.kotPrinter;
    if ([58, 80].includes(Number(partial?.paperWidthMm))) safe.paperWidthMm = Number(partial.paperWidthMm);
    if (typeof partial?.autoPrintKot === "boolean") safe.autoPrintKot = partial.autoPrintKot;
    if (typeof partial?.autoPrintBill === "boolean") safe.autoPrintBill = partial.autoPrintBill;
    if (["browser", "silent", "preview"].includes(partial?.printMode)) safe.printMode = partial.printMode;
    return writeSettings(safe);
  });

  ipcMain.handle("settings:listPrinters", async () => {
    if (!mainWindow) return [];
    try {
      return await mainWindow.webContents.getPrintersAsync();
    } catch {
      return [];
    }
  });

  ipcMain.handle("app:getInfo", () => ({
    name: APP_NAME,
    version: app.getVersion(),
    buildVersion: `${app.getVersion()}-${process.env.SCAN2PLATE_BUILD_ID || "dev"}`,
    electron: process.versions.electron,
    website: "https://scan2plate.com"
  }));

  ipcMain.handle("app:openWebsite", () => shell.openExternal("https://scan2plate.com"));
}

// Prevent accidental multiple instances — focus the existing window instead
// of launching a second full copy of the app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // Belt-and-braces alongside the per-window navigation guard: deny any
    // permission request from anything other than our own allowed hosts.
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    registerIpcHandlers();
    buildMenu();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Extra layer beyond will-navigate/setWindowOpenHandler: refuse to attach
  // a new webContents to anything that isn't our own preload/allowed hosts.
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", event => event.preventDefault());
  });
}
