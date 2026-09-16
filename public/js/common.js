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

// The admin dashboard loads admin.js AND admin-modules.js, and both called
// this. That installed two window error handlers, two document click handlers
// and — the expensive one — two 5-second watchdog intervals, each running four
// full-document querySelectorAll sweeps forever. One install per page is
// enough; the first caller's page name wins.
let appSafetyInstalled = false;

export function installAppSafety(options = {}) {
  if (appSafetyInstalled) return;
  appSafetyInstalled = true;
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

  // Ongoing watchdog (not just the one-shot initial-load check above): every
  // 5s, verify the main thread actually got to run this tick close to on
  // schedule (a long synchronous block — a runaway render loop, a giant
  // list re-render, a slow third-party script — shows up as a large drift)
  // and force-reset any action button that's been stuck "busy" past a hard
  // ceiling. Without this, a hang partway through a click handler leaves the
  // button disabled and the user sees "I click Save and nothing happens"
  // with no way out short of guessing to refresh.
  const watchdogIntervalMs = 5000;
  const watchdogStuckAfterMs = 20000;
  const hardBusyCeilingMs = 60000;
  let lastTick = Date.now();
  const busySince = new WeakMap();
  setInterval(() => {
    const now = Date.now();
    const drift = now - lastTick - watchdogIntervalMs;
    lastTick = now;
    if (document.visibilityState === "visible" && drift > watchdogStuckAfterMs) {
      showStuckFallback(`${pageName} is responding slowly. Refresh if buttons stop working.`);
    }
    document.querySelectorAll("[data-busy='true']").forEach(button => {
      if (!busySince.has(button)) { busySince.set(button, now); return; }
      if (now - busySince.get(button) > hardBusyCeilingMs) {
        button.disabled = false;
        button.dataset.busy = "false";
        busySince.delete(button);
        devError(`[${pageName}] force-reset a button stuck busy past ${hardBusyCeilingMs}ms`, button);
      }
    });
    document.querySelectorAll("[data-busy='false'], [data-busy='']").forEach(button => busySince.delete(button));
  }, watchdogIntervalMs);
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
