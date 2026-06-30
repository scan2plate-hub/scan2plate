import { db } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const searchInput = document.getElementById("searchInput");
const trackBtn = document.getElementById("trackBtn");
const resultWrap = document.getElementById("trackResult");
const stickyRefreshBtn = document.getElementById("stickyRefreshBtn");
const stickyHelpBtn = document.getElementById("stickyHelpBtn");

let unsubscribeOrder = null;
let currentOrder = null;
let restaurantDetails = { id: null, name: "Restaurant", phone: "" };

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function money(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function formatDate(timestamp) {
  if (!timestamp) return "Waiting for an update";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Waiting for an update" : date.toLocaleString();
}

function normalizePhone(value = "") {
  return String(value).replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
}

function preferredRestaurantContact(data = {}) {
  return String(
    data.restaurantHelpNumber ||
    data.restaurantPhone ||
    data.phone ||
    data.kitchenWhatsapp ||
    data.kitchenWhatsApp ||
    ""
  ).trim();
}

function normalStatus(value) {
  const status = String(value || "pending").toLowerCase();
  return status === "served" ? "completed" : status;
}

function statusLabel(order) {
  const status = normalStatus(order.status);
  const labels = {
    pending: "Order placed",
    accepted: "Order accepted",
    preparing: "Preparing your food",
    ready: "Order ready",
    completed: "Completed",
    cancelled: "Order cancelled",
    rejected: "Order rejected"
  };
  return labels[status] || "Order placed";
}

function etaMessage(order) {
  const status = normalStatus(order.status);
  const eta = Number(order.etaMinutes);

  if (status === "preparing") return "Your food is being prepared.";
  if (status === "ready") return "Please collect/receive your order.";
  if (status === "completed") return "Your order is complete. Thank you for dining with us.";
  if (status === "cancelled" || status === "rejected") return "Please contact the restaurant for help with this order.";
  if (Number.isFinite(eta) && eta > 0) return `Estimated time: about ${eta} minutes.`;
  return "Your order has been placed and is waiting for the restaurant.";
}

function timelineHtml(order) {
  const steps = ["pending", "accepted", "preparing", "ready", "completed"];
  const labels = ["Order Placed", "Accepted", "Preparing", "Ready", "Completed"];
  const current = normalStatus(order.status);
  const currentIndex = steps.indexOf(current);
  const isException = current === "cancelled" || current === "rejected";

  return `
    <div class="status-timeline" aria-label="Order status timeline">
      ${steps.map((step, index) => {
        const state = !isException && index < currentIndex ? "done" :
          !isException && index === currentIndex ? "current" : "";
        return `<div class="timeline-step ${state}">
          <span class="timeline-dot">${index + 1}</span>
          <span>${labels[index]}</span>
        </div>`;
      }).join("")}
    </div>
    ${isException ? `<p class="status-note exception">${escapeHtml(statusLabel(order))}. ${escapeHtml(etaMessage(order))}</p>` : ""}
  `;
}

function paymentHtml(order) {
  const isPaid = String(order.paymentStatus || "unpaid").toLowerCase() === "paid";
  return `
    <section class="track-section">
      <div class="section-heading"><h2>Payment Status</h2><span class="payment-badge ${isPaid ? "paid" : "unpaid"}">${isPaid ? "Paid" : "Unpaid"}</span></div>
      ${isPaid
        ? "<p class=\"muted\">Payment has been received.</p>"
        : "<p class=\"muted\">Pay at Counter, or use online payment when it is available.</p><button class=\"btn btn-outline\" type=\"button\" disabled>Pay Online (coming soon)</button>"}
    </section>
  `;
}

function orderIsActiveForAddon(order = {}) {
  const status = String(order.status || "pending").toLowerCase();
  const payment = String(order.paymentStatus || "unpaid").toLowerCase();
  return payment !== "paid" && !["completed", "closed", "cancelled", "rejected", "delivered"].includes(status);
}

function orderMenuUrl(order = {}) {
  const params = new URLSearchParams();
  params.set("restaurantId", order.restaurantId || restaurantDetails.id || "");
  if (order.tableNo) params.set("table", order.tableNo);
  params.set("addToOrder", order.orderId || "");
  return `./index.html?${params.toString()}`;
}

function render(order) {
  currentOrder = order;
  const items = Array.isArray(order.items) ? order.items : [];
  const status = normalStatus(order.status);
  const restaurantName = order.restaurantName || restaurantDetails.name;
  const contact = restaurantDetails.phone
    ? `<a href="tel:${encodeURIComponent(restaurantDetails.phone)}">${escapeHtml(restaurantDetails.phone)}</a>`
    : "Contact restaurant staff";

  resultWrap.innerHTML = `
    <article class="track-card card">
      <div class="order-title-row">
        <div>
          <p class="eyebrow">Live order tracking</p>
          <h1>Order ${escapeHtml(order.orderId || "")}</h1>
          <p class="muted">${escapeHtml(restaurantName)} · Table ${escapeHtml(order.tableNo || "-")}</p>
        </div>
        <span class="live-indicator"><i></i> Live</span>
      </div>

      <section class="track-section live-status">
        <p class="eyebrow">Live Status</p>
        <div class="status-display ${escapeHtml(status)}">${escapeHtml(statusLabel(order))}</div>
        <p class="status-note">${escapeHtml(etaMessage(order))}</p>
        ${timelineHtml(order)}
      </section>

      <div class="track-grid">
        <section class="track-section">
          <h2>Order Summary</h2>
          <dl class="summary-list">
            <div><dt>Customer</dt><dd>${escapeHtml(order.customerName || "-")}</dd></div>
            <div><dt>Order placed</dt><dd>${escapeHtml(formatDate(order.createdAt))}</dd></div>
            <div><dt>Last updated</dt><dd>${escapeHtml(formatDate(order.updatedAt))}</dd></div>
          </dl>
        </section>
        ${paymentHtml(order)}
      </div>

      <div class="track-grid">
        <section class="track-section">
          <h2>Items Ordered</h2>
          <div class="items-list">${items.length ? items.map(item => `
            <div class="item-row"><span>${escapeHtml(item.name || "Item")} <small>×${Number(item.qty || 1)}</small></span><strong>${money(Number(item.price || 0) * Number(item.qty || 1))}</strong></div>
          `).join("") : "<p class=\"muted\">No item details available.</p>"}</div>
        </section>
        <section class="track-section">
          <h2>Bill Summary</h2>
          <dl class="summary-list bill-list">
            <div><dt>Items total</dt><dd>${money(order.itemsTotal)}</dd></div>
            <div><dt>Tax</dt><dd>${money(order.tax)}</dd></div>
            <div class="grand-total"><dt>Grand total</dt><dd>${money(order.grandTotal)}</dd></div>
          </dl>
        </section>
      </div>

      <section class="track-section help-section">
        <h2>Help / Restaurant Contact</h2>
        <p>${contact}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;">
          ${orderIsActiveForAddon(order) ? `<a class="btn btn-primary" href="${escapeHtml(orderMenuUrl(order))}">Add More Items</a>` : ""}
          <a class="btn btn-outline" href="./bill.html?orderId=${encodeURIComponent(order.orderId || "")}">View Bill</a>
          ${restaurantDetails.phone ? `<a class="btn btn-outline" href="tel:${encodeURIComponent(restaurantDetails.phone)}">Call Staff</a>` : ""}
        </div>
      </section>
    </article>
  `;
}

function showLoading(message = "Finding your order…") {
  resultWrap.innerHTML = `<div class="track-message loading"><span class="loading-spinner"></span>${escapeHtml(message)}</div>`;
}

function showError(message) {
  resultWrap.innerHTML = `<div class="track-message error">${escapeHtml(message)}</div>`;
}

function stopTracking() {
  if (unsubscribeOrder) {
    unsubscribeOrder();
    unsubscribeOrder = null;
  }
  currentOrder = null;
}

async function loadRestaurantDetails(restaurantId) {
  if (!restaurantId || restaurantDetails.id === restaurantId) return;
  restaurantDetails = { id: restaurantId, name: "Restaurant", phone: "" };
  try {
    const settings = await getDoc(doc(db, "restaurants", restaurantId, "settings", "general"));
    const root = await getDoc(doc(db, "restaurants", restaurantId));
    const rootData = root.exists() ? root.data() : {};
    if (settings.exists()) {
      const data = settings.data();
      restaurantDetails.name = data.restaurantName || rootData.restaurantName || restaurantDetails.name;
      restaurantDetails.phone = preferredRestaurantContact(data) || preferredRestaurantContact(rootData);
    } else {
      restaurantDetails.name = rootData.restaurantName || restaurantDetails.name;
      restaurantDetails.phone = preferredRestaurantContact(rootData);
    }
  } catch (error) {
    console.warn("Restaurant contact could not load:", error);
  }
}

function latestOrder(docs) {
  return docs
    .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))[0] || null;
}

async function findOrder(searchTerm) {
  const value = String(searchTerm || "").trim();
  if (!value) return null;
  const orders = collection(db, "orders");

  if (/^ORD/i.test(value)) {
    const results = await getDocs(query(orders, where("orderId", "==", value)));
    return latestOrder(results.docs);
  }

  const normalized = normalizePhone(value);
  if (!normalized) return null;
  const values = [...new Set([value, normalized, `91${normalized}`, `+91${normalized}`])];
  const snapshots = await Promise.all(values.map(phone =>
    getDocs(query(orders, where("customerPhone", "==", phone)))
  ));
  const unique = new Map();
  snapshots.flatMap(snapshot => snapshot.docs).forEach(snapshot => unique.set(snapshot.id, snapshot));
  return latestOrder([...unique.values()]);
}

async function beginTracking(searchTerm) {
  const value = String(searchTerm || "").trim();
  if (!value) {
    showError("Enter an Order ID or phone number to track an order.");
    return;
  }

  stopTracking();
  showLoading();
  trackBtn.disabled = true;

  try {
    // Search once to resolve the public order ID / phone number to its document ID.
    const foundOrder = await findOrder(value);
    if (!foundOrder) {
      showError("Order not found. Check the Order ID or phone number and try again.");
      return;
    }

    await loadRestaurantDetails(foundOrder.restaurantId);
    const orderRef = doc(db, "orders", foundOrder.id);
    unsubscribeOrder = onSnapshot(orderRef, snapshot => {
      if (!snapshot.exists()) {
        stopTracking();
        showError("This order is no longer available. Search again to track another order.");
        return;
      }
      render({ id: snapshot.id, ...snapshot.data() });
    }, error => {
      console.error("Live tracking error:", error);
      showError("Live updates could not load. Check your connection and try again.");
    });
  } catch (error) {
    console.error("Order lookup error:", error);
    showError("Unable to find this order right now. Please try again.");
  } finally {
    trackBtn.disabled = false;
  }
}

trackBtn.addEventListener("click", () => beginTracking(searchInput.value));
searchInput.addEventListener("keydown", event => {
  if (event.key === "Enter") beginTracking(searchInput.value);
});

stickyRefreshBtn?.addEventListener("click", () => {
  if (currentOrder) render(currentOrder);
  else beginTracking(searchInput.value);
});

stickyHelpBtn?.addEventListener("click", () => {
  document.querySelector(".help-section")?.scrollIntoView({ behavior: "smooth", block: "center" });
});

window.addEventListener("beforeunload", stopTracking);

const orderIdFromUrl = new URLSearchParams(window.location.search).get("orderId");
if (orderIdFromUrl) {
  searchInput.value = orderIdFromUrl;
  beginTracking(orderIdFromUrl);
}
