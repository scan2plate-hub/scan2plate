"use strict";

const { app, BrowserWindow, Menu, shell, ipcMain, session } = require("electron");
const path = require("node:path");
const url = require("node:url");

const { APP_URL, ALLOWED_HOSTS, APP_NAME } = require("./src/constants");
const { loadWindowState, saveWindowState } = require("./src/windowState");
const { installConnectivityBanner, installOfflineFallback, pushSyncStatus } = require("./src/connectivity");
const { readSettings, writeSettings } = require("./src/settingsStore");
const offlineDb = require("./src/offlineDb");
const { refreshCacheFromLivePage } = require("./src/cacheSync");
const { runSyncPass } = require("./src/syncExecutor");

const isDev = process.env.SCAN2PLATE_DESKTOP_DEV === "1";
const startUrl = APP_URL;

let mainWindow = null;
let settingsWindow = null;
let currentRestaurantId = null;
let backgroundSyncTimer = null;
let backgroundSyncInProgress = false;

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

function isShowingLiveSite() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return !mainWindow.webContents.getURL().startsWith("file://");
}

function showOfflineBillingMode() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!currentRestaurantId || !offlineDb.getCachedMenu(currentRestaurantId).length) {
    // Nothing cached yet (first-ever launch offline, never logged in
    // before) - there is genuinely nothing to bill against, so fall back
    // to the plain waiting screen instead of an empty billing UI.
    mainWindow.loadFile(path.join(__dirname, "windows", "offline.html")).catch(() => {});
    return;
  }
  mainWindow.loadFile(path.join(__dirname, "windows", "offline-billing.html")).catch(() => {});
}

// ---- Background sync: runs in a hidden window so it never disrupts
// whatever the visible mainWindow is currently showing (a live dashboard
// page mid-use, or an active offline billing session). ----

function stopBackgroundSync() {
  if (backgroundSyncTimer) { clearInterval(backgroundSyncTimer); backgroundSyncTimer = null; }
}

function scheduleBackgroundSync() {
  if (backgroundSyncTimer) return;
  backgroundSyncTimer = setInterval(attemptBackgroundSync, 20000);
  attemptBackgroundSync();
}

async function attemptBackgroundSync() {
  if (backgroundSyncInProgress || !currentRestaurantId) return;
  if (offlineDb.countPendingOrders(currentRestaurantId) === 0) { stopBackgroundSync(); return; }

  backgroundSyncInProgress = true;
  const bg = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });

  try {
    await new Promise((resolve, reject) => {
      const onFail = (_e, _code, description) => reject(new Error(description || "load failed"));
      bg.webContents.once("did-finish-load", () => { bg.webContents.removeListener("did-fail-load", onFail); resolve(); });
      bg.webContents.once("did-fail-load", onFail);
      bg.loadURL(startUrl).catch(reject);
    });

    await refreshCacheFromLivePage(bg.webContents, offlineDb);

    const pendingBefore = offlineDb.countPendingOrders(currentRestaurantId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      pushSyncStatus(mainWindow, { state: "syncing", text: `🔵 Syncing 0 of ${pendingBefore}…` });
    }

    const summary = await runSyncPass(bg.webContents, offlineDb, currentRestaurantId);

    if (mainWindow && !mainWindow.isDestroyed()) {
      if (summary.failed > 0) {
        pushSyncStatus(mainWindow, { state: "error", text: `⚠ ${summary.failed} bill${summary.failed === 1 ? "" : "s"} could not sync` });
      } else if (summary.synced > 0) {
        pushSyncStatus(mainWindow, { state: "success", text: "✓ All offline bills synced" });
      }
    }

    if (offlineDb.countPendingOrders(currentRestaurantId) === 0) stopBackgroundSync();
  } catch {
    // Still offline, or the attempt failed for some other reason - the next
    // interval tick will simply try again. Pending orders are untouched.
  } finally {
    backgroundSyncInProgress = false;
    if (!bg.isDestroyed()) bg.destroy();
  }
}

function updateIdleConnectivityIndicator() {
  if (!mainWindow || mainWindow.isDestroyed() || !currentRestaurantId) return;
  const pending = offlineDb.countPendingOrders(currentRestaurantId);
  if (pending > 0) {
    pushSyncStatus(mainWindow, { state: "offline", text: `🟠 Offline Mode — ${pending} bill${pending === 1 ? "" : "s"} waiting to sync` });
  } else {
    pushSyncStatus(mainWindow, { state: "online", text: "🟢 Online — All data synced" });
  }
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

  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "Escape" && mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
  });

  // The generic did-fail-load handler (installOfflineFallback) always shows
  // offline.html first; if we already have a usable cache, immediately
  // upgrade that to the real offline billing screen so staff aren't stuck
  // on a waiting screen when they could already be taking orders.
  mainWindow.webContents.on("did-fail-load", (_event, _code, _description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || String(validatedUrl || "").startsWith("file://")) return;
    setTimeout(showOfflineBillingMode, 50);
  });

  mainWindow.webContents.on("did-finish-load", async () => {
    if (isShowingLiveSite()) {
      const restaurantId = await refreshCacheFromLivePage(mainWindow.webContents, offlineDb);
      if (restaurantId) {
        currentRestaurantId = restaurantId;
        updateIdleConnectivityIndicator();
        if (offlineDb.countPendingOrders(restaurantId) > 0) scheduleBackgroundSync();
      }
    } else if (mainWindow.webContents.getURL().includes("offline-billing.html")) {
      updateIdleConnectivityIndicator();
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
  if (isDev) template.push({ label: "Developer", submenu: [{ role: "toggleDevTools" }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpcHandlers() {
  ipcMain.handle("settings:get", () => readSettings());

  ipcMain.handle("settings:save", (_event, partial) => {
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
    try { return await mainWindow.webContents.getPrintersAsync(); } catch { return []; }
  });

  ipcMain.handle("app:getInfo", () => ({
    name: APP_NAME,
    version: app.getVersion(),
    buildVersion: `${app.getVersion()}-${process.env.SCAN2PLATE_BUILD_ID || "dev"}`,
    electron: process.versions.electron,
    website: "https://scan2plate.com"
  }));

  ipcMain.handle("app:openWebsite", () => shell.openExternal("https://scan2plate.com"));

  // ---- Offline billing IPC (windows/offline-billing.html) ----

  ipcMain.handle("offline:getContext", () => {
    if (!currentRestaurantId) return { restaurant: null, menu: [], tables: [] };
    return {
      restaurant: offlineDb.getCachedRestaurant(currentRestaurantId),
      menu: offlineDb.getCachedMenu(currentRestaurantId),
      tables: offlineDb.getCachedTables(currentRestaurantId)
    };
  });

  ipcMain.handle("offline:createOrder", (_event, orderInput) => {
    if (!currentRestaurantId) throw new Error("No cached restaurant context is available on this device yet.");
    // Recompute businessDate/validate shape server-side (main-process side)
    // rather than trusting the renderer's numbers outright.
    const items = Array.isArray(orderInput?.items) ? orderInput.items : [];
    if (!items.length) throw new Error("Cannot save an empty bill.");
    const businessDate = new Date().toISOString().slice(0, 10);
    const order = offlineDb.createOfflineOrder({
      restaurantId: currentRestaurantId,
      tableNo: String(orderInput.tableNo || ""),
      items,
      subtotal: Number(orderInput.subtotal || 0),
      discount: Number(orderInput.discount || 0),
      tax: Number(orderInput.tax || 0),
      total: Number(orderInput.total || 0),
      paymentMethod: ["cash", "upi", "card"].includes(orderInput.paymentMethod) ? orderInput.paymentMethod : "cash",
      paymentStatus: orderInput.paymentStatus === "paid" ? "paid" : "unpaid",
      businessDate
    });
    updateIdleConnectivityIndicator();
    scheduleBackgroundSync();
    return order;
  });

  ipcMain.handle("offline:getPendingCount", () => currentRestaurantId ? offlineDb.countPendingOrders(currentRestaurantId) : 0);

  ipcMain.handle("offline:print", () => { mainWindow?.webContents.print(); });

  ipcMain.on("offline:switchToBillingMode", () => showOfflineBillingMode());
}

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
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

    offlineDb.openDb(app.getPath("userData"));
    registerIpcHandlers();
    buildMenu();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    stopBackgroundSync();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", event => event.preventDefault());
  });
}
