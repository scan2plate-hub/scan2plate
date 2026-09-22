export function qs(sel, parent = document) {
  return parent.querySelector(sel);
}

export function qsa(sel, parent = document) {
  return [...parent.querySelectorAll(sel)];
}

// Same problem as the date formatter: building an Intl.NumberFormat is the
// expensive part, formatting with it is cheap.
const currencyFormatters = new Map();

export function currencyFormatter(maximumFractionDigits = 2) {
  let formatter = currencyFormatters.get(maximumFractionDigits);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits });
    currencyFormatters.set(maximumFractionDigits, formatter);
  }
  return formatter;
}

export function fmtCurrency(v) {
  return currencyFormatter(2).format(Number(v || 0));
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

// A live onSnapshot listener on a frequently-written collection can deliver
// several events within milliseconds of each other (a burst of writes, or a
// local write followed immediately by its server ack). Without coalescing,
// each one re-runs whatever expensive render `run` does, back-to-back on
// the main thread, which is what made the Admin Dashboard freeze under
// load. The first call still runs immediately (so initial load isn't
// delayed); only rapid-fire follow-ups within `delayMs` of each other are
// batched into a single trailing call with the latest argument.
export function createCoalescedRunner(run, delayMs = 200) {
  let scheduled = false;
  let receivedFirst = false;
  let latestArg;
  return function schedule(arg) {
    latestArg = arg;
    if (!receivedFirst) {
      receivedFirst = true;
      run(latestArg);
      return;
    }
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      run(latestArg);
    }, delayMs);
  };
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

/* =========================================================
   CONNECTION NOTICE

   Replaces the old showStuckFallback banner, which offered a
   "Refresh Page" button and was shown for three things that are
   not faults at all (see installAppSafety below).

   This one fires ONLY on a genuine browser offline event, says
   nothing about refreshing, and removes itself the moment the
   connection is back.
========================================================= */
function connectionNoticeEl() {
  return document.getElementById("scan2plateConnectionNotice");
}

export function showOfflineNotice() {
  if (connectionNoticeEl()) return;
  const box = document.createElement("div");
  box.id = "scan2plateConnectionNotice";
  box.setAttribute("role", "status");
  box.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;width:max-content;max-width:92vw;padding:9px 14px;border:1px solid #fed7aa;border-radius:999px;background:#fff7ed;color:#9a3412;box-shadow:0 10px 30px rgba(0,0,0,.12);font:13px/1.4 Arial,sans-serif;font-weight:700;";
  box.textContent = "Offline — changes will sync when the connection returns.";
  document.body.appendChild(box);
}

export function hideOfflineNotice() {
  connectionNoticeEl()?.remove();
}

export function closeStaleOverlays() {
  document.querySelectorAll(".modal-overlay.active").forEach(overlay => {
    const visibleModal = overlay.querySelector(".modal,.s2p-login-modal-card");
    if (!visibleModal || getComputedStyle(overlay).pointerEvents === "none") overlay.classList.remove("active", "open");
  });
  document.body.classList.remove("modal-open");
}

// The admin dashboard loads admin.js AND admin-modules.js, and both called
// this. That installed two window error handlers, two document click handlers
// and — the expensive one — two 5-second watchdog intervals, each running four
// full-document querySelectorAll sweeps forever. One install per page is
// enough; the first caller's page name wins.
let appSafetyInstalled = false;

/* =========================================================
   APP SAFETY

   What was here before reported three NON-faults as faults, each
   with a "Refresh Page" button:

   1. A 5-second setInterval compared wall-clock drift and, past
      20s, declared "<page> is responding slowly". Wall-clock drift
      does not mean the main thread was blocked: a hidden tab has
      its timers throttled to roughly once a minute, and a sleeping
      machine skips hours. Both produce drift far past the
      threshold with the page completely idle. The
      visibilityState check did not help, because the callback
      runs once the tab is visible again. A dashboard left open
      all day — exactly how a POS is used — tripped this every
      time the operator came back to the tab.
   2. Any single unhandled promise rejection (a fetch to a
      sleeping backend, a request aborted during navigation).
   3. A brief offline blip — and the banner never cleared when
      the connection came back.

   Genuine faults are still handled: errors and rejections are
   logged for diagnosis, stale overlays are cleared so the UI
   cannot be left with a dead modal, and a real offline event
   shows a notice that clears itself. Nothing tells the user to
   refresh, and there is no longer a periodic timer here at all.
========================================================= */
export function installAppSafety(options = {}) {
  if (appSafetyInstalled) return;
  appSafetyInstalled = true;
  const pageName = options.pageName || "Scan2Plate";

  window.addEventListener("error", event => {
    devError(`[${pageName}] uncaught error`, event.error || event.message);
    closeStaleOverlays();
  });
  window.addEventListener("unhandledrejection", event => {
    devError(`[${pageName}] unhandled promise`, event.reason);
    closeStaleOverlays();
  });

  window.addEventListener("offline", showOfflineNotice);
  window.addEventListener("online", hideOfflineNotice);
  if (navigator.onLine === false) showOfflineNotice();

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

/* ---------------------------------------------------------
   Constructing an Intl.DateTimeFormat is expensive — it loads
   and resolves locale data — while formatting with an existing
   one is cheap. This built a NEW formatter on every call, and
   the call sits under getBusinessDate, which runs once per
   order in isOrderToday, orderBusinessDate, the table grid and
   the report filters. On a 1200-order dashboard that was over a
   thousand formatter constructions per snapshot: a CPU profile
   of live order traffic attributed 26.5% of ALL main-thread
   time to this one function, and it was the source of the
   >50ms blocks that made the UI stutter.

   The formatter is now built once per timezone and reused.
--------------------------------------------------------- */
const dateFormatters = new Map();

function formatterFor(timezone) {
  const zone = timezone || "Asia/Kolkata";
  let formatter = dateFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    dateFormatters.set(zone, formatter);
  }
  return formatter;
}

function timezoneParts(date = new Date(), timezone = "Asia/Kolkata") {
  const parts = formatterFor(timezone).formatToParts(date).reduce((acc, part) => {
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

// getBusinessDate is pure, and the dashboard asks it the same question about
// the same order over and over across renders. Memoising it turns the repeat
// renders into map lookups. Bounded so a long shift cannot grow it without
// limit.
const businessDateCache = new Map();
const BUSINESS_DATE_CACHE_LIMIT = 20000;

export function getBusinessDate(resetTime = "04:00", timezone = "Asia/Kolkata", date = new Date()) {
  const stamp = date instanceof Date ? date.getTime() : new Date(date).getTime();
  // Keyed to the second: the business date depends on hour and minute only, so
  // every instant within a second maps to the same answer. Callers that pass
  // `new Date()` would otherwise add a fresh entry every millisecond.
  const cacheKey = Number.isFinite(stamp) ? `${Math.floor(stamp / 1000)}|${resetTime}|${timezone}` : null;
  if (cacheKey !== null) {
    const cached = businessDateCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const value = computeBusinessDate(resetTime, timezone, date);
  if (cacheKey !== null) {
    if (businessDateCache.size >= BUSINESS_DATE_CACHE_LIMIT) businessDateCache.clear();
    businessDateCache.set(cacheKey, value);
  }
  return value;
}

function computeBusinessDate(resetTime, timezone, date) {
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

export function rolePermissions(userRole = "") {
  const role = String(userRole || "owner").toLowerCase();
  return modulePermissions[role] || modulePermissions.owner;
}

// A staff document may carry an explicit `permissions` array that overrides
// the role default. An absent/empty array keeps the existing role-based
// behaviour exactly as before, so staff created before per-staff permissions
// existed are unaffected.
export function resolveAllowedModules(userRole = "", customPermissions = null) {
  const base = rolePermissions(userRole);
  if (base === "all") return "all";
  if (!Array.isArray(customPermissions) || !customPermissions.length) return base;
  return [...new Set(customPermissions.map(value => String(value || "").trim()).filter(Boolean))];
}

export function canAccessModule(userRole = "", moduleName = "", customPermissions = null) {
  const allowed = resolveAllowedModules(userRole, customPermissions);
  return allowed === "all" || allowed.includes(moduleName);
}

/* =========================================================
   CURRENT vs PAST STAFF

   Staff records carry `status` ("active"/"inactive") and the
   older boolean `isActive`. saveStaff and the deactivate path
   have always written BOTH, so they agree; this reads `status`
   first and falls back to `isActive`, and treats a record with
   neither as active so staff created before either field
   existed are still current employees.

   Every current-staff surface (Attendance, current Payroll,
   advance-salary and staff dropdowns) must decide membership
   with this — never with "a Firestore document exists".
========================================================= */
export function isActiveStaffRecord(staffMember = {}) {
  const status = String(staffMember.status || "").trim().toLowerCase();
  if (status) return status === "active";
  return staffMember.isActive !== false;
}

/**
 * Who appears on a payroll month.
 *
 * Current (or future) month -> current staff only. A person who has left is
 * not a current employee, so they must not appear in payroll being generated
 * now, even though their documents and history remain.
 *
 * A PAST month -> current staff PLUS any past staff who actually have
 * attendance or advance records in that month. That is historical accounting
 * data and has to stay reportable; it is never deleted to hide someone from
 * the current list.
 *
 * `historical: true` marks a row as a closed record, which the UI renders
 * without edit/delete actions.
 */
export function selectPayrollStaff({ staff = [], attendance = [], advances = [], month = "", currentMonth = "" } = {}) {
  const active = staff.filter(isActiveStaffRecord).map(member => ({ member, historical: false }));
  if (!month || !currentMonth || month >= currentMonth) return active;
  const inMonth = (rows, id) => rows.some(row => row.staffId === id && String(row.date || "").startsWith(month));
  const past = staff
    .filter(member => !isActiveStaffRecord(member))
    .filter(member => inMonth(attendance, member.id) || inMonth(advances, member.id))
    .map(member => ({ member, historical: true }));
  return [...active, ...past];
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

/* =========================================================
   SEARCH / FILTER DEBOUNCE
   Typing in a search box used to re-render the whole list on
   every keystroke. Debouncing collapses a burst of keystrokes
   into a single render once typing pauses.
========================================================= */
export function debounce(fn, delayMs = 180) {
  let timerId = null;
  const debounced = (...args) => {
    clearTimeout(timerId);
    timerId = setTimeout(() => fn(...args), delayMs);
  };
  debounced.cancel = () => clearTimeout(timerId);
  debounced.flush = (...args) => { clearTimeout(timerId); fn(...args); };
  return debounced;
}

/* =========================================================
   DOM WRITE GUARD
   Re-assigning innerHTML with byte-identical markup still
   destroys and rebuilds every child node: it drops focus,
   resets scroll position and makes the panel visibly flicker,
   which is what reads to staff as "the dashboard refreshed
   again". Skipping the write when nothing changed keeps a
   realtime snapshot from touching sections it did not affect.
========================================================= */
const htmlSignatures = new WeakMap();

export function setHtmlIfChanged(element, html) {
  if (!element) return false;
  if (htmlSignatures.get(element) === html) return false;
  htmlSignatures.set(element, html);
  element.innerHTML = html;
  return true;
}

/* =========================================================
   BILL SERIAL NUMBER
   Serial numbers are stored as plain integers in Firestore and
   only zero-padded for display, so sorting, reporting and
   "next number" arithmetic all stay numeric.
========================================================= */
export function formatBillSerial(value, minDigits = 3) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return String(Math.trunc(numeric)).padStart(minDigits, "0");
}

/**
 * The arithmetic behind a bill/order number allocation, split out from the
 * Firestore transaction so it is identical in every panel (admin dashboard,
 * customer ordering, vendor/token panel) and can be tested directly.
 *
 * `counter` is the current contents of restaurants/<id>/counters/<businessDate>.
 * The bill serial is seeded from lastDailyOrderNo when lastBillSerialNumber is
 * absent, so a business day that already had orders before bill serials
 * existed continues upward instead of restarting at 1 and colliding with a
 * bill that was already printed earlier the same day.
 *
 * Both numbers only ever move forward. A deleted or cancelled bill does not
 * release its number, so a serial is never reused.
 */
export function allocateFromCounter(counter = {}) {
  const lastOrderNo = Number(counter.lastDailyOrderNo || 0);
  const safeLastOrderNo = Number.isFinite(lastOrderNo) && lastOrderNo > 0 ? Math.trunc(lastOrderNo) : 0;
  const rawLastBill = Number(counter.lastBillSerialNumber ?? counter.lastDailyOrderNo ?? 0);
  const safeLastBill = Number.isFinite(rawLastBill) && rawLastBill > 0 ? Math.trunc(rawLastBill) : 0;
  return {
    dailyOrderNo: safeLastOrderNo + 1,
    billSerialNumber: safeLastBill + 1
  };
}

// Older bills (and any created by a client that predates the bill-serial
// field) have no billSerialNumber. They still have the daily order number,
// which was the de-facto bill number before this change, so fall back to it
// rather than rendering an empty Bill No on a printed bill.
export function billDisplayNumber(order = {}) {
  const serial = formatBillSerial(order.billSerialNumber ?? order.billSerial ?? order.billNo);
  if (serial) return serial;
  const legacy = formatBillSerial(order.displayOrderNo ?? order.dailyOrderNo ?? order.dailyOrderNumber);
  if (legacy) return legacy;
  return String(order.orderId || "-");
}

/* =========================================================
   WINDOWED LISTS

   Several screens rendered EVERY matching record in one
   synchronous pass: Online Orders built a card for every order
   (its default "Dine-in" tab matches any order without an
   explicit orderType), Reports built a row per order for the
   period, Print Bills a card per bill. On a real restaurant's
   order history that is thousands of cards plus thousands of
   addEventListener calls per render — the work that made
   switching sections feel slow.

   Nothing is removed: the first page renders immediately and a
   "Show more" control reveals the rest. Export/print paths call
   openWindowFully first so they still cover every record.
========================================================= */
export const LIST_PAGE_SIZE = 60;

const listWindows = new WeakMap();

export function windowSize(container, pageSize = LIST_PAGE_SIZE) {
  return listWindows.get(container) || pageSize;
}

export function takeWindow(container, items = [], pageSize = LIST_PAGE_SIZE) {
  const size = windowSize(container, pageSize);
  return { visible: items.slice(0, size), hidden: Math.max(0, items.length - size), total: items.length };
}

export function growWindow(container, pageSize = LIST_PAGE_SIZE) {
  listWindows.set(container, windowSize(container, pageSize) + pageSize);
}

/** Used before export/print so the produced document is never truncated. */
export function openWindowFully(container, total = Number.MAX_SAFE_INTEGER) {
  listWindows.set(container, Math.max(Number(total) || 0, 1));
}

/** Called when a filter/search changes, so the new result set starts at page 1. */
export function resetWindow(container) {
  listWindows.delete(container);
}

export function showMoreMarkup(hidden, total, noun = "records", asTableRow = false, colspan = 10) {
  if (hidden <= 0) return "";
  const inner = `<div style="text-align:center;padding:14px;">
      <button type="button" class="btn btn-outline s2p-show-more">Show more (${hidden} of ${total} ${noun} hidden)</button>
    </div>`;
  return asTableRow ? `<tr><td colspan="${colspan}">${inner}</td></tr>` : inner;
}

/**
 * Binds the "Show more" control once per container. `rerender` is called after
 * the window grows, so the caller keeps full control of how its list renders.
 */
export function bindShowMore(container, rerender, pageSize = LIST_PAGE_SIZE) {
  if (!container || container.dataset.s2pShowMoreBound === "true") return;
  container.dataset.s2pShowMoreBound = "true";
  container.addEventListener("click", event => {
    if (!event.target.closest(".s2p-show-more")) return;
    growWindow(container, pageSize);
    rerender();
  });
}

/* =========================================================
   KEYED LIST RECONCILER

   For grids where one record changes at a time — the Tables
   screen above all. Rebuilding the whole grid because Table 07
   went from "Customer Sitting" to "Paid" costs the full grid on
   every order write, which is what made returning to Tables slow
   on a restaurant with many tables.

   This replaces only the cards whose markup actually changed,
   leaves the rest of the DOM untouched, and keeps child order in
   step with `items`. Handlers must be delegated on the container
   (they are), since individual cards are swapped.
========================================================= */
const keyedCaches = new WeakMap();

export function resetKeyedList(container) {
  if (container) keyedCaches.delete(container);
}

export function reconcileKeyedList(container, items = [], keyOf, htmlOf) {
  if (!container) return { changed: 0, total: items.length };
  const cache = keyedCaches.get(container) || new Map();
  const existing = new Map();
  [...container.children].forEach(child => {
    const key = child.dataset?.s2pKey;
    // Anything not produced by this reconciler (e.g. a previous empty state)
    // is dropped, so the two rendering paths never fight over the container.
    if (key === undefined) child.remove();
    else existing.set(key, child);
  });

  const scratch = document.createElement("div");
  const keep = new Set();
  let previous = null;
  let changed = 0;

  items.forEach(item => {
    const key = String(keyOf(item));
    keep.add(key);
    const html = htmlOf(item);
    let node = existing.get(key);
    if (!node || cache.get(key) !== html) {
      scratch.innerHTML = html;
      const fresh = scratch.firstElementChild;
      if (!fresh) return;
      fresh.dataset.s2pKey = key;
      if (node) container.replaceChild(fresh, node);
      else container.appendChild(fresh);
      existing.set(key, fresh);
      cache.set(key, html);
      node = fresh;
      changed += 1;
    }
    const expected = previous ? previous.nextElementSibling : container.firstElementChild;
    if (expected !== node) container.insertBefore(node, expected);
    previous = node;
  });

  existing.forEach((node, key) => {
    if (keep.has(key)) return;
    node.remove();
    cache.delete(key);
  });

  keyedCaches.set(container, cache);
  return { changed, total: items.length };
}

/* =========================================================
   WHICH BUSINESS IS THIS PANEL SHOWING?

   Super Admin's "Open Admin" button opened a panel with no
   business attached to the link. Every panel resolves its id from
   localStorage, and a super admin's session deliberately clears
   the staff session, so the panel fell through to
   `scan2plate_last_restaurant_id` — whichever business this
   BROWSER last signed into. Clicking Open Admin on a Hotel opened
   the hotel panel showing a completely different business's data,
   and every row in the table opened that same one.

   The link now carries the id. These helpers decide when to
   honour it.

   This is not a security boundary and is not meant to be one. The
   id only says which document to ASK for; Firestore's rules
   decide whether the signed-in account may read it, and they check
   the real uid against the business's owner and staff records. A
   stranger appending ?restaurantId= to the URL gets a dashboard
   that cannot load anything.
========================================================= */

/** True when this browser holds a Super Admin console session. */
export function isSuperAdminSession() {
  try {
    const raw = localStorage.getItem("scan2serve_super_admin") || localStorage.getItem("scan2plate_super_admin");
    if (!raw) return false;
    return String(JSON.parse(raw)?.role || "").toLowerCase() === "super_admin";
  } catch {
    return false;
  }
}

/** The business id asked for in the URL, if any. */
export function requestedRestaurantId() {
  try {
    return new URLSearchParams(window.location.search).get("restaurantId")?.trim() || "";
  } catch {
    return "";
  }
}

/**
 * The business this panel should show, and where that answer came from.
 *
 * A signed-in owner or staff member is pinned to their OWN business: their
 * session wins, so a link cannot quietly move them somewhere else. A super
 * admin has no business of their own, so for them the link wins — that is the
 * entire point of Open Admin.
 *
 * `fromSuperAdminLink` is returned because the caller must not write this id
 * to `scan2plate_last_restaurant_id`. Doing so would leave the owner of this
 * browser pointed at whichever business the super admin last inspected.
 */
export function resolveActiveRestaurantId(sessionRestaurantId = "") {
  const requested = requestedRestaurantId();
  if (requested && isSuperAdminSession() && !sessionRestaurantId) {
    return { restaurantId: requested, fromSuperAdminLink: true };
  }
  const own = sessionRestaurantId
    || localStorage.getItem("restaurantId")
    || localStorage.getItem("scan2plate_last_restaurant_id")
    || "";
  return { restaurantId: own || requested, fromSuperAdminLink: false };
}
