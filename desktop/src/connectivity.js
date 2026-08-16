"use strict";

// Purely a runtime-injected banner — this never touches the actual site's
// source files. It only reacts to the browser's native online/offline
// events, so it needs no polling loop of its own and adds no reload.
// Firebase's SDKs already reconnect their own listeners once the network
// returns; this banner is UI-only.
const BANNER_SCRIPT = `
(function () {
  var ID = "__scan2plateDesktopOfflineBanner";
  if (document.getElementById(ID)) return;
  var el = document.createElement("div");
  el.id = ID;
  el.setAttribute("role", "status");
  el.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:2147483647;display:none;text-align:center;padding:8px 14px;font:600 13px/1.4 -apple-system,Arial,sans-serif;background:#b91c1c;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.2);";
  el.textContent = "Internet connection lost. Scan2Plate will reconnect automatically.";
  document.documentElement.appendChild(el);
  function setState(online) { el.style.display = online ? "none" : "block"; }
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

module.exports = { installConnectivityBanner, installOfflineFallback };
