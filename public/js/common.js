export function qs(sel, parent = document) {
  return parent.querySelector(sel);
}

export function qsa(sel, parent = document) {
  return [...parent.querySelectorAll(sel)];
}

export function fmtCurrency(v) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(Number(v || 0));
}

export function uid(prefix = "ID") {
  return `${prefix}${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 900 + 100)}`;
}

export function getParam(key) {
  return new URLSearchParams(location.search).get(key);
}

export function saveLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

export function toast(message) {
  alert(message);
}

export function isDevHost() {
  return ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
}

export function devError(...args) {
  if (isDevHost()) console.error(...args);
}

export function withTimeout(promise, ms = 20000, label = "Request timed out") {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export function readValidatedLocal(key, fallback, validator = value => value != null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    if (!validator(parsed)) throw new Error(`Invalid ${key}`);
    return parsed;
  } catch (error) {
    devError("Invalid localStorage entry removed", key, error);
    localStorage.removeItem(key);
    return fallback;
  }
}

const globalCleanupFns = new Set();

export function registerCleanup(fn) {
  if (typeof fn !== "function") return fn;
  globalCleanupFns.add(fn);
  return () => {
    try { fn(); } catch (error) { devError("Cleanup failed", error); }
    globalCleanupFns.delete(fn);
  };
}

export function cleanupRegisteredListeners() {
  [...globalCleanupFns].forEach(fn => {
    try { fn(); } catch (error) { devError("Cleanup failed", error); }
    globalCleanupFns.delete(fn);
  });
}

export function showStuckFallback(message = "This page is taking longer than expected.") {
  if (document.getElementById("scan2plateStuckFallback")) return;
  const box = document.createElement("div");
  box.id = "scan2plateStuckFallback";
  box.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;width:min(92vw,520px);padding:12px 14px;border:1px solid #fed7aa;border-radius:14px;background:#fff7ed;color:#9a3412;box-shadow:0 18px 50px rgba(0,0,0,.14);font:13px/1.45 Arial,sans-serif;";
  box.innerHTML = `<strong>${escapeHtml(message)}</strong><div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button id="scan2plateRefreshPageBtn" type="button" style="border:0;border-radius:9px;background:#e07c1a;color:#fff;padding:8px 11px;font-weight:800;cursor:pointer">Refresh Page</button><button id="scan2plateDismissStuckBtn" type="button" style="border:1px solid #fed7aa;border-radius:9px;background:#fff;color:#9a3412;padding:8px 11px;font-weight:800;cursor:pointer">Dismiss</button></div>`;
  document.body.appendChild(box);
  document.getElementById("scan2plateRefreshPageBtn")?.addEventListener("click", () => location.reload());
  document.getElementById("scan2plateDismissStuckBtn")?.addEventListener("click", () => box.remove());
}

export function closeStaleOverlays() {
  document.querySelectorAll(".modal-overlay.active").forEach(overlay => {
    const visibleModal = overlay.querySelector(".modal,.s2p-login-modal-card");
    if (!visibleModal || getComputedStyle(overlay).pointerEvents === "none") overlay.classList.remove("active", "open");
  });
  document.body.classList.remove("modal-open");
}

export function installAppSafety(options = {}) {
  const timeoutMs = Number(options.stuckTimeoutMs || 15000);
  const pageName = options.pageName || "Scan2Plate";
  window.addEventListener("error", event => {
    devError(`[${pageName}] uncaught error`, event.error || event.message);
    showStuckFallback("Something went wrong. Refresh if the page is stuck.");
    closeStaleOverlays();
  });
  window.addEventListener("unhandledrejection", event => {
    devError(`[${pageName}] unhandled promise`, event.reason);
    showStuckFallback("Network or app action failed. Refresh if buttons stop responding.");
    closeStaleOverlays();
  });
  window.addEventListener("offline", () => showStuckFallback("Internet connection lost. Reconnect, then refresh if needed."));
  window.addEventListener("pagehide", cleanupRegisteredListeners);
  window.addEventListener("beforeunload", cleanupRegisteredListeners);
  document.addEventListener("click", event => {
    const close = event.target.closest(".modal-close,[data-modal-close]");
    if (close) {
      close.closest(".modal-overlay,.s2p-login-modal")?.classList.remove("active", "open");
      setTimeout(closeStaleOverlays, 0);
    }
    if (event.target?.classList?.contains("modal-overlay")) {
      event.target.classList.remove("active", "open");
      setTimeout(closeStaleOverlays, 0);
    }
  });
  setTimeout(() => {
    const stillBusy = document.querySelector(".is-loading,.loading,.loading-spinner,[aria-busy='true'],#adminLoadingNotice,#tokenLoadNotice");
    if (document.visibilityState === "visible" && stillBusy) {
      showStuckFallback(`${pageName} is still loading. You can refresh safely if needed.`);
    }
  }, timeoutMs);
}

export async function guardedAction(button, action, options = {}) {
  if (button?.dataset.busy === "true") return;
  const originalText = button?.textContent;
  const loadingText = options.loadingText;
  try {
    if (button) {
      button.dataset.busy = "true";
      button.disabled = true;
      if (loadingText) button.textContent = loadingText;
    }
    return await withTimeout(Promise.resolve().then(action), options.timeoutMs || 20000, options.timeoutMessage || "Action timed out. Please retry.");
  } catch (error) {
    devError("Action failed", error);
    if (options.errorMessage !== false) alert(error?.message || options.errorMessage || "Action failed. Please retry.");
    if (options.rethrow) throw error;
    return undefined;
  } finally {
    if (button) {
      button.disabled = false;
      button.dataset.busy = "false";
      if (loadingText) button.textContent = originalText;
    }
    closeStaleOverlays();
  }
}

export function normalizeCustomerPhone(value = "") {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length > 10 && digits.startsWith("91")) digits = digits.slice(2);
  while (digits.length > 10 && digits.startsWith("0")) digits = digits.slice(1);
  return digits.slice(-10);
}

export function isActiveUnpaidOrder(order = {}) {
  const status = String(order.status || "pending").toLowerCase();
  const payment = String(order.paymentStatus || "unpaid").toLowerCase();
  const active = new Set(["pending", "accepted", "preparing", "ready"]);
  if (order.billClosed === true || payment === "paid") return false;
  return active.has(status);
}

export function taxPercentFromSettings(settings = {}) {
  const tax = Number(settings.taxPercent || 0);
  return Number.isFinite(tax) ? Math.max(0, tax) : 0;
}

export function taxPercentForOrder(order = {}, settings = {}) {
  const snapshot = Number(order.taxPercentSnapshot);
  return Number.isFinite(snapshot) ? Math.max(0, snapshot) : taxPercentFromSettings(settings);
}

export function orderItemTotal(item = {}) {
  const qty = Number(item.qty ?? item.quantity);
  const price = Number(item.price ?? item.unitPrice);
  if (Number.isFinite(qty) && Number.isFinite(price)) return price * qty;
  return Number(item.total || 0);
}

export function calculateOrderTotals(items = [], settings = {}, order = {}) {
  const itemsTotal = (items || []).reduce((sum, item) => sum + orderItemTotal(item), 0);
  const rawType = String(order.discountType || "").toLowerCase();
  const rawValue = Number(order.discountValue || 0);
  let discountAmount = Number(order.discountAmount || 0);
  if (rawType === "flat") discountAmount = Math.min(itemsTotal, Math.max(0, rawValue));
  if (rawType === "percent") discountAmount = itemsTotal * Math.min(100, Math.max(0, rawValue)) / 100;
  discountAmount = Math.min(itemsTotal, Math.max(0, discountAmount));
  const taxableAmount = Math.max(0, itemsTotal - discountAmount);
  const taxPercent = taxPercentForOrder(order, settings);
  const tax = taxableAmount * (taxPercent / 100);
  return { itemsTotal, subtotal: itemsTotal, discountAmount, taxableAmount, tax, grandTotal: taxableAmount + tax, taxPercent };
}

export function normalizeResetTime(value = "04:00") {
  const raw = String(value || "").trim();
  const twelveHour = raw.match(/^(\d{1,2})(?::([0-5]\d))?\s*(AM|PM)$/i);
  if (twelveHour) {
    let hours = Number(twelveHour[1]);
    const minutes = twelveHour[2] || "00";
    const meridian = twelveHour[3].toUpperCase();
    if (hours < 1 || hours > 12) return "04:00";
    if (meridian === "AM") hours = hours === 12 ? 0 : hours;
    if (meridian === "PM") hours = hours === 12 ? 12 : hours + 12;
    return `${String(hours).padStart(2, "0")}:${minutes}`;
  }
  const twentyFourHour = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (twentyFourHour) {
    return `${String(Number(twentyFourHour[1])).padStart(2, "0")}:${twentyFourHour[2]}`;
  }
  return "04:00";
}

function timezoneParts(date = new Date(), timezone = "Asia/Kolkata") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function ymdFromParts({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getBusinessDate(resetTime = "04:00", timezone = "Asia/Kolkata", date = new Date()) {
  const [resetHour, resetMinute] = normalizeResetTime(resetTime).split(":").map(Number);
  const parts = timezoneParts(date, timezone);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const resetMinutes = resetHour * 60 + resetMinute;
  if (currentMinutes >= resetMinutes) return ymdFromParts(parts);
  const previousDayUtc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1));
  return previousDayUtc.toISOString().slice(0, 10);
}

const modulePermissions = {
  owner: "all",
  admin: "all",
  "restaurant admin": "all",
  staff: ["orders", "tables", "kot", "billing", "liveOrders", "quickBilling", "printBills", "kotManagement"],
  manager: ["liveOrders", "quickBilling", "tables", "printBills", "kotManagement", "kitchenDisplay", "orders", "billing", "kot"],
  cashier: ["quickBilling", "tables", "printBills", "liveOrders", "orders", "billing"],
  kitchen: ["kot", "kotManagement", "kitchenDisplay"],
  waiter: ["liveOrders", "tables", "quickBilling", "orders", "billing"]
};

export function canAccessModule(userRole = "", moduleName = "") {
  const role = String(userRole || "owner").toLowerCase();
  const allowed = modulePermissions[role] || modulePermissions.owner;
  return allowed === "all" || allowed.includes(moduleName);
}

export function renderStatus(status = "pending") {
  const s = String(status).toLowerCase();
  return `<span class="status status-${s}">${s}</span>`;
}

export function nowStr(ts) {
  if (!ts) return "-";
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("en-IN");
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function calcEtaText(order) {
  const eta = Number(order?.etaMinutes || 10);
  const start = order?.etaUpdatedAt?.toDate
    ? order.etaUpdatedAt.toDate()
    : order?.createdAt?.toDate
      ? order.createdAt.toDate()
      : new Date();

  const etaEnd = new Date(start.getTime() + eta * 60000);
  const remain = Math.max(0, Math.ceil((etaEnd.getTime() - Date.now()) / 60000));
  return `${remain} min left`;
}

export const DEFAULT_BACKEND_URL = "https://scan2plate.onrender.com";

export function getBackendBaseUrl() {
  const saved =
    localStorage.getItem("scan2plateBackendUrl") ||
    localStorage.getItem("backendUrl") ||
    localStorage.getItem("scan2plate_backend_url") ||
    localStorage.getItem("scan2serve_backend_url") ||
    "";
  const clean = String(saved || "").trim().replace(/\/+$/, "");
  const oldBackend = /scan2serve-backend\.onrender\.com/i.test(clean);
  const validBackend = /^https:\/\/scan2plate\.onrender\.com$/i.test(clean);
  const backendUrl = validBackend && !oldBackend ? clean : DEFAULT_BACKEND_URL;
  localStorage.setItem("scan2plateBackendUrl", backendUrl);
  localStorage.setItem("backendUrl", backendUrl);
  localStorage.setItem("scan2plate_backend_url", backendUrl);
  if (oldBackend) localStorage.setItem("scan2plateBackendUrlFixed", "true");
  return backendUrl;
}

export function getBackendBase() {
  return getBackendBaseUrl();
}

export function getSafeLogoUrl(restaurant = {}) {
  return String(restaurant.restaurantLogoUrl || restaurant.logoUrl || restaurant.logo || "./logo.PNG").trim() || "./logo.PNG";
}

export function getRestaurantContext() {
  try {
    const oldUser =
      JSON.parse(
        localStorage.getItem("scan2plate_user") ||
        localStorage.getItem("scan2serve_user") ||
        "{}"
      ) || {};

    return {
      restaurantId:
        oldUser.restaurantId ||
        localStorage.getItem("restaurantId") ||
        localStorage.getItem("scan2plate_last_restaurant_id") ||
        localStorage.getItem("scan2serve_last_restaurant_id") ||
        "",
      restaurantName:
        oldUser.restaurantName ||
        localStorage.getItem("restaurantName") ||
        "",
      role:
        oldUser.role ||
        localStorage.getItem("userRole") ||
        "",
      name:
        oldUser.name ||
        localStorage.getItem("userName") ||
        "",
      email:
        oldUser.email ||
        localStorage.getItem("userEmail") ||
        ""
    };
  } catch {
    return {
      restaurantId:
        localStorage.getItem("restaurantId") ||
        localStorage.getItem("scan2plate_last_restaurant_id") ||
        localStorage.getItem("scan2serve_last_restaurant_id") ||
        "",
      restaurantName: localStorage.getItem("restaurantName") || "",
      role: localStorage.getItem("userRole") || "",
      name: localStorage.getItem("userName") || "",
      email: localStorage.getItem("userEmail") || ""
    };
  }
}

export function getRestaurantIdFromUrlOrStorage() {
  return (
    getParam("restaurantId") ||
    getParam("restaurant") ||
    getRestaurantContext().restaurantId ||
    localStorage.getItem("restaurantId") ||
    localStorage.getItem("scan2plate_last_restaurant_id") ||
    localStorage.getItem("scan2serve_last_restaurant_id") ||
    ""
  );
}

export async function notifyBackend(payload) {
  try {
    const saved =
      localStorage.getItem("scan2plate_settings") ||
      localStorage.getItem("scan2serve_settings");

    let backendUrl = "";

    if (saved) {
      try {
        backendUrl = JSON.parse(saved).backendUrl || "";
      } catch (e) {
        console.error("Settings parse error:", e);
      }
    }

    backendUrl = getBackendBaseUrl();

    const res = await fetch(`${backendUrl}/notify-order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data?.error || "Backend request failed");
    }

    return data;
  } catch (err) {
    console.error("notifyBackend error:", err);
    return null;
  }
}
