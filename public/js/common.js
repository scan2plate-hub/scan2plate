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
    return fallback;
  }
}

export function toast(message) {
  alert(message);
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
