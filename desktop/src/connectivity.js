"use strict";

// Purely a runtime-injected banner — this never touches the actual site's
// source files. It only reacts to the browser's native online/offline
// events, so it needs no polling loop of its own and adds no reload.
// Firebase's SDKs already reconnect their own listeners once the network
// returns; this banner is UI-only.
// A soft, non-blocking banner (Part 9: "do not show a blocking modal for
// normal temporary network loss"). Offline includes an opt-in link into
// Offline Billing mode - the app never forces that switch on its own while
// the page is still up and usable, since staff may be mid-task and forcing
// a navigation would violate "do not clear cart / do not force logout."
const BANNER_SCRIPT = `
(function () {
  var ID = "__scan2plateDesktopOfflineBanner";
  var existing = document.getElementById(ID);
  if (existing) return;
  var el = document.createElement("div");
  el.id = ID;
  el.setAttribute("role", "status");
  el.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:2147483647;display:none;align-items:center;justify-content:center;gap:12px;text-align:center;padding:8px 14px;font:600 13px/1.4 -apple-system,Arial,sans-serif;background:#b91c1c;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.2);";
  el.innerHTML = '<span>Internet connection lost. Scan2Plate will reconnect automatically.</span>' +
    (window.scan2plateDesktop && window.scan2plateDesktop.isDesktop
      ? '<button type="button" id="__scan2plateGoOfflineBtn" style="border:1px solid #fff;background:transparent;color:#fff;border-radius:6px;padding:3px 10px;font:inherit;cursor:pointer;">Continue Billing Offline</button>'
      : '');
  document.documentElement.appendChild(el);
  var goOfflineBtn = document.getElementById("__scan2plateGoOfflineBtn");
  if (goOfflineBtn) {
    goOfflineBtn.addEventListener("click", function () {
      if (window.scan2plateDesktop && window.scan2plateDesktop.goOfflineBilling) window.scan2plateDesktop.goOfflineBilling();
    });
  }
  function setState(online) { el.style.display = online ? "none" : "flex"; }
  window.addEventListener("online", function () { setState(true); });
  window.addEventListener("offline", function () { setState(false); });
  setState(navigator.onLine);
})();
`;

function installConnectivityBanner(win) {
  const inject = () => { win.webContents.executeJavaScript(BANNER_SCRIPT).catch(() => {}); };
  win.webContents.on("did-finish-load", inject);
  win.webContents.on("did-navigate", inject);
  win.webContents.on("did-navigate-in-page", inject);
}

// Part 9's states: 🟢 online/synced, 🟠 offline with a pending count, 🔵
// syncing progress, ✓ success, ⚠ failure with a retry affordance. Pushed
// as a small floating pill (separate element from the red offline banner
// above) so it never needs a blocking modal for routine sync activity.
function pushSyncStatus(win, { state, text }) {
  const safeText = JSON.stringify(String(text || ""));
  const safeState = JSON.stringify(String(state || "online"));
  const finalScript = `
    (function () {
      var ID = "__scan2plateSyncStatus";
      var el = document.getElementById(ID);
      if (!el) {
        el = document.createElement("div");
        el.id = ID;
        el.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483647;padding:7px 12px;border-radius:999px;font:600 12px/1.3 -apple-system,Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.18);";
        document.documentElement.appendChild(el);
      }
      var palettes = {
        online: ["#dcfce7", "#166534"], offline: ["#ffedd5", "#9a3412"],
        syncing: ["#dbeafe", "#1e40af"], success: ["#dcfce7", "#166534"], error: ["#fee2e2", "#991b1b"]
      };
      var p = palettes[${safeState}] || palettes.online;
      el.style.background = p[0]; el.style.color = p[1];
      el.textContent = ${safeText};
    })();
  `;
  win.webContents.executeJavaScript(finalScript).catch(() => {});
}

// Handles the harder case: the page itself never finished loading (app
// launched offline, or connectivity drops mid-navigation before the new
// page rendered). Falls back to a local offline screen and retries the
// real URL on an interval until it succeeds — never freezes, never shows
// a blank/broken Chromium error page to restaurant staff.
function installOfflineFallback(win, { offlineHtmlPath, startUrl, retryMs = 5000 }) {
  let retryTimer = null;

  const stopRetrying = () => { if (retryTimer) { clearInterval(retryTimer); retryTimer = null; } };
  const startRetrying = () => {
    if (retryTimer) return;
    retryTimer = setInterval(() => { win.loadURL(startUrl).catch(() => {}); }, retryMs);
  };

  win.webContents.on("did-fail-load", (_event, _errorCode, _description, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    if (String(validatedUrl || "").startsWith("file://")) return; // avoid looping on the offline page itself
    win.loadFile(offlineHtmlPath).catch(() => {});
    startRetrying();
  });

  win.webContents.on("did-finish-load", () => {
    const current = win.webContents.getURL();
    if (!current.startsWith("file://")) stopRetrying();
  });
}

module.exports = { installConnectivityBanner, installOfflineFallback, pushSyncStatus };
