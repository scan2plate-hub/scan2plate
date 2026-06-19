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

export function getBackendBase() {
  return (
    localStorage.getItem("scan2plate_backend_url") ||
    localStorage.getItem("scan2serve_backend_url") ||
    ""
  );
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

    if (!backendUrl) {
      backendUrl = "https://scan2serve-backend.onrender.com";
    }

    backendUrl = backendUrl.replace(/\/+$/, "");

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