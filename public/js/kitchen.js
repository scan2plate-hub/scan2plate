import { db, auth } from "./firebase.js";
import {
  collection,
  doc,
  onSnapshot,
  updateDoc,
  serverTimestamp,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  qs,
  escapeHtml,
  fmtCurrency,
  notifyBackend,
  getRestaurantContext,
  installAppSafety,
  withTimeout,
  registerCleanup,
  guardedAction
} from "./common.js";

installAppSafety({ pageName: "Kitchen Dashboard", stuckTimeoutMs: 15000 });

const newWrap       = qs("#newOrders");
const preparingWrap = qs("#preparingOrders");
const readyWrap     = qs("#readyOrders");
const logoutBtn     = qs("#logoutBtn");

const audioNewOrder = new Audio("./assets/notification.mp3");
audioNewOrder.loop = true;
audioNewOrder.preload = "auto";

const audioNewItems = new Audio("./assets/notification.mp3");
audioNewItems.loop = true;
audioNewItems.preload = "auto";
audioNewItems.playbackRate = 1.2;

let audioUnlocked        = false;
let firstLoadDone        = false;
let isPlaying            = false;
let activeAlertType      = "";
const orderAlertMap      = new Map();
// Stores item snapshot at the moment each order was accepted/last-seen
// key = Firestore doc id, value = Map<itemName, qty>
const acceptedSnapshots  = new Map();
let currentRenderedOrders = [];
let kitchenTimerInterval = null;

function itemDisplayName(item = {}) {
  const baseName = String(item.name || "Item").trim() || "Item";
  const variantName = String(item.variantName || "").trim();
  return variantName && !baseName.toLowerCase().endsWith(` ${variantName.toLowerCase()}`)
    ? `${baseName} ${variantName}`
    : baseName;
}

const ctx = getRestaurantContext();
const restaurantId =
  ctx.restaurantId ||
  localStorage.getItem("scan2plate_last_restaurant_id") ||
  "";

if (!restaurantId) {
  alert("Restaurant ID not found. Please login again.");
  window.location.href = "./admin-login.html";
  throw new Error("Missing restaurantId");
}

let cafeSettings = {
  kitchenWhatsApp: "",
  restaurantName:  "Restaurant"
};

function isPlanExpired(data = {}) {
  const status = String(data.status || "").toLowerCase();
  const expiryRaw = data.planExpiryDate || data.expiryDate;
  const expiry = expiryRaw?.toDate ? expiryRaw.toDate() : expiryRaw ? new Date(expiryRaw) : null;
  const today = new Date(); today.setHours(0,0,0,0);
  if (expiry) expiry.setHours(0,0,0,0);
  return ["expired", "suspended"].includes(status) || String(data.subscriptionStatus || "").toLowerCase() === "expired" || (expiry && !Number.isNaN(expiry.getTime()) && expiry < today);
}

function showKitchenPlanLock(message) {
  const lock = document.createElement("div");
  lock.style.cssText = "position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:20px;background:linear-gradient(135deg,#21170f,#3a2515);color:#fff;text-align:center;";
  lock.innerHTML = `<div style="max-width:460px;padding:34px;border-radius:24px;background:#fffaf3;color:#23170e;box-shadow:0 25px 70px rgba(0,0,0,.3)"><div style="font-size:38px;color:#e07c1a;margin-bottom:12px">♨</div><h1 style="margin:0 0 10px;font-size:27px">Kitchen dashboard unavailable</h1><p style="margin:0;color:#735e4a;line-height:1.6">${escapeHtml(message)}</p><a href="./admin-dashboard.html" style="display:inline-block;margin-top:20px;padding:12px 16px;border-radius:11px;background:#e07c1a;color:#fff;font-weight:800">Back to Admin</a></div>`;
  document.body.appendChild(lock);
}

/* ─────────────────────────────────────────
   LOGOUT
───────────────────────────────────────── */
logoutBtn?.addEventListener("click", async () => {
  try { await signOut(auth); } catch (err) { console.error(err); }
  localStorage.removeItem("scan2plate_user");
  localStorage.removeItem("scan2serve_user");
  localStorage.removeItem("scan2plate_last_restaurant_id");
  window.location.href = "./admin-login.html";
});

/* ─────────────────────────────────────────
   AUDIO UNLOCK
───────────────────────────────────────── */
async function unlockAudio() {
  if (audioUnlocked) return;
  try {
    audioNewOrder.muted = true;
    await audioNewOrder.play();
    audioNewOrder.pause();
    audioNewOrder.currentTime = 0;
    audioNewOrder.muted = false;

    audioNewItems.muted = true;
    await audioNewItems.play();
    audioNewItems.pause();
    audioNewItems.currentTime = 0;
    audioNewItems.muted = false;

    audioUnlocked = true;
  } catch (err) {
    console.log("Audio locked until user interaction");
  }
}

document.addEventListener("click",      unlockAudio, { once: true });
document.addEventListener("touchstart", unlockAudio, { once: true });
document.addEventListener("keydown",    unlockAudio, { once: true });

/* ─────────────────────────────────────────
   ALERT BANNER
───────────────────────────────────────── */
function ensureAlertBanner() {
  let banner = document.getElementById("kitchenAlertBanner");
  if (banner) return banner;

  banner = document.createElement("div");
  banner.id = "kitchenAlertBanner";
  banner.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:none;align-items:center;justify-content:center;padding:20px;";

  banner.innerHTML = `
    <div style="width:min(92vw,700px);background:#fff;border-radius:28px;padding:28px 22px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.28);">
      <div id="kitchenAlertEmoji" style="font-size:56px;line-height:1;margin-bottom:14px;">🔔</div>
      <div id="kitchenAlertTitle" style="font-size:30px;font-weight:800;margin-bottom:10px;">New Order</div>
      <div id="kitchenAlertText" style="font-size:18px;color:#555;margin-bottom:18px;">Please check kitchen dashboard now.</div>
      <button id="dismissKitchenAlertBtn" style="border:none;background:#111;color:#fff;padding:14px 24px;border-radius:14px;font-size:16px;font-weight:700;cursor:pointer;">Dismiss Alert</button>
    </div>`;

  document.body.appendChild(banner);
  document.getElementById("dismissKitchenAlertBtn")?.addEventListener("click", stopAlert);
  return banner;
}

function showFullScreenAlert(type = "new_order") {
  const banner = ensureAlertBanner();
  const emoji  = document.getElementById("kitchenAlertEmoji");
  const title  = document.getElementById("kitchenAlertTitle");
  const text   = document.getElementById("kitchenAlertText");

  if (type === "new_items") {
    if (emoji) emoji.textContent = "🆕";
    if (title) title.textContent = "New Items Added";
    if (text)  text.textContent  = "An existing order has been updated. Please check now.";
  } else {
    if (emoji) emoji.textContent = "🔔";
    if (title) title.textContent = "New Order Arrived";
    if (text)  text.textContent  = "A new customer order is waiting in kitchen dashboard.";
  }

  banner.style.display = "flex";
}

function hideFullScreenAlert() {
  const banner = document.getElementById("kitchenAlertBanner");
  if (banner) banner.style.display = "none";
}

function vibrateAlert(type = "new_order") {
  if (!navigator.vibrate) return;
  navigator.vibrate(type === "new_items" ? [200, 120, 200] : [350, 180, 350, 180, 350]);
}

function startAlert(type = "new_order") {
  if (isPlaying && activeAlertType === type) return;
  stopAlert(false);
  activeAlertType = type;
  try {
    const audio = type === "new_items" ? audioNewItems : audioNewOrder;
    audio.currentTime = 0;
    audio.play().catch(err => console.log("Audio blocked:", err));
    isPlaying = true;
    showFullScreenAlert(type);
    vibrateAlert(type);
    document.title = type === "new_items" ? "🆕 Items Updated!" : "🚨 NEW ORDER!";
  } catch (err) { console.log(err); }
}

function stopAlert(resetTitle = true) {
  try {
    audioNewOrder.pause(); audioNewOrder.currentTime = 0;
    audioNewItems.pause(); audioNewItems.currentTime = 0;
  } catch (err) { console.log(err); }
  isPlaying = false;
  activeAlertType = "";
  hideFullScreenAlert();
  if (resetTitle) document.title = "Kitchen Dashboard";
}

/* ─────────────────────────────────────────
   KOT PRINTER  ← NEW
   items = array of { name, qty, price }
   label = optional banner e.g. "NEW ITEMS ADDED"
───────────────────────────────────────── */
function printKOT(orderData, items, label = "") {
  const now  = new Date();
  const name = cafeSettings.restaurantName || "Restaurant";
  const modifierList = item => [item.addons,item.addOns,item.modifiers,item.customizations,item.variants,item.selectedAddons,item.options].flatMap(list => Array.isArray(list) ? list : []).map(extra => typeof extra === "string" ? { name:extra, qty:1 } : { name:extra?.name || extra?.title || extra?.label || "Customisation", qty:Number(extra?.qty || extra?.quantity || extra?.count || 1) });
  const rows = (items || []).map(item => `<div class="thermal-item-row"><div class="thermal-item-name"><strong>${escapeHtml(itemDisplayName(item))}</strong>${modifierList(item).map(extra => `<div class="thermal-modifier">* ${escapeHtml(String(extra.name))}${extra.qty > 1 ? ` ×${extra.qty}` : ""}</div>`).join("")}</div><div class="thermal-item-qty">${Number(item.qty || 0)}</div></div>`).join("");

  const w = window.open("", "_blank", "width=400,height=640");
  if (!w) { alert("Allow popups to print KOT."); return; }

  w.document.write(`<!DOCTYPE html>
<html><head><title>KOT</title>
<style>
  @page{margin:2mm}body{font-family:Arial,"Courier New",monospace;font-size:11px;font-weight:700;color:#000;padding:0;width:58mm;max-width:100%;margin:0 auto;line-height:1.25}
  h2{text-align:center;margin:0 0 4px;font-size:14px;overflow-wrap:anywhere;}
  .center{text-align:center;}
  hr{border:none;border-top:1px dashed #333;margin:8px 0;}
  table{width:100%;border-collapse:collapse;}
  .label{background:#111;color:#fff;text-align:center;padding:7px;font-weight:800;font-size:13px;border-radius:4px;margin-bottom:8px;letter-spacing:1px;}
  .meta td{padding:3px 0;font-size:10px;}.thermal-head{display:grid;grid-template-columns:minmax(0,1fr) 32px;gap:6px;padding:4px 0;border-bottom:2px solid #000;font-size:10px;text-transform:uppercase}.thermal-item-row{display:grid;grid-template-columns:minmax(0,1fr) 32px;gap:6px;padding:4px 0;border-bottom:1px dotted #777;break-inside:avoid}.thermal-item-name{min-width:0;white-space:normal;overflow-wrap:anywhere;word-break:break-word}.thermal-item-qty{text-align:center;font-weight:900}.thermal-modifier{padding:2px 0 0 8px;font-size:10px;overflow-wrap:anywhere}@media print and (min-width:70mm){body{width:80mm;font-size:13px}.thermal-head,.thermal-item-row{grid-template-columns:minmax(0,1fr) 42px}.thermal-modifier{font-size:11px}}
  .meta td:first-child{color:#555;width:80px;}
</style></head><body>
  <h2>${escapeHtml(name)}</h2>
  <div class="center" style="font-size:11px;margin-bottom:6px;">KITCHEN ORDER TICKET</div>
  <hr>
  ${label ? `<div class="label">${escapeHtml(label)}</div>` : ""}
  <table class="meta">
    <tr><td>Order No</td><td><strong>${escapeHtml(orderData.displayOrderNo || orderData.dailyOrderNo || "-")}</strong></td></tr>
    <tr><td>KOT ID</td><td><strong>${escapeHtml(orderData.orderId || "")}</strong></td></tr>
    <tr><td>${orderData.businessMode === "vendor" || orderData.orderMode === "token" ? "Token" : "Table"}</td><td><strong>${escapeHtml(orderData.businessMode === "vendor" || orderData.orderMode === "token" ? (orderData.tokenNo || `T-${orderData.tokenNumber || "-"}`) : orderData.tableNo || "-")}</strong></td></tr>
    <tr><td>Customer</td><td>${escapeHtml(orderData.customerName || "Walk-in")}</td></tr>
    <tr><td>Time</td><td>${now.toLocaleTimeString()}</td></tr>
    <tr><td>Date</td><td>${now.toLocaleDateString()}</td></tr>
  </table>
  <hr>
  <div class="thermal-head"><strong>Item</strong><strong style="text-align:center">Qty</strong></div>
  <div>${rows || "<div class='thermal-item-row'><span>No items</span><span>0</span></div>"}</div>
  <hr>
  <div class="center" style="font-size:11px;margin-top:6px;">--- END OF KOT ---</div>
</body></html>`);

  w.document.close();
  w.focus();
  setTimeout(() => { w.print(); w.close(); }, 450);
}

/* ─────────────────────────────────────────
   SETTINGS
───────────────────────────────────────── */
async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "restaurants", restaurantId, "settings", "general"));
    if (snap.exists()) cafeSettings = { ...cafeSettings, ...snap.data() };
  } catch (err) { console.error("loadSettings error", err); }
}

/* ─────────────────────────────────────────
   TIMER HELPERS
───────────────────────────────────────── */
function tsToDate(ts) {
  if (!ts) return new Date();
  if (ts.toDate) return ts.toDate();
  if (typeof ts === "number") return new Date(ts);
  return new Date(ts);
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  if (ts instanceof Date) return ts.getTime();
  const p = new Date(ts).getTime();
  return Number.isNaN(p) ? 0 : p;
}

function getTimerStartMs(x) { return tsToMs(x.etaStartedAt) || 0; }

function getRemainingSeconds(x) {
  const status     = String(x.status || "").toLowerCase();
  const etaMinutes = Number(x.etaMinutes || 10);
  const startMs    = getTimerStartMs(x);
  if (!startMs || !["accepted","preparing","ready"].includes(status)) return null;
  const endMs = startMs + etaMinutes * 60 * 1000;
  return Math.max(0, Math.floor((endMs - Date.now()) / 1000));
}

function formatRemaining(seconds) {
  if (seconds === null) return "Not Started";
  const safe = Math.max(0, Number(seconds || 0));
  return `${String(Math.floor(safe / 60)).padStart(2,"0")}:${String(safe % 60).padStart(2,"0")}`;
}

function getTimerBadgeStyle(seconds) {
  const base = "padding:4px 10px;border-radius:999px;font-weight:700;font-size:13px;";
  if (seconds === null) return base + "background:#f1f3f5;color:#495057;border:1px solid #dee2e6;";
  if (seconds <= 0)     return base + "background:#ffe3e3;color:#c92a2a;border:1px solid #ffc9c9;";
  if (seconds <= 300)   return base + "background:#fff3bf;color:#e67700;border:1px solid #ffec99;";
  return base + "background:#ebfbee;color:#2b8a3e;border:1px solid #c3e6cb;";
}

function refreshCountdowns() {
  currentRenderedOrders.forEach(d => {
    const x       = d.data();
    const timerEl = document.querySelector(`[data-timer-id="${d.id}"]`);
    if (!timerEl) return;
    const remaining = getRemainingSeconds(x);
    timerEl.textContent = remaining === null ? "Not Started" : remaining > 0 ? formatRemaining(remaining) : "Time Over";
    timerEl.setAttribute("style", getTimerBadgeStyle(remaining));
  });
}

function startKitchenCountdown() {
  if (kitchenTimerInterval) clearInterval(kitchenTimerInterval);
  refreshCountdowns();
  kitchenTimerInterval = setInterval(refreshCountdowns, 1000);
}

/* ─────────────────────────────────────────
   ALERT KEY
───────────────────────────────────────── */
function getAlertKey(x) {
  return JSON.stringify({
    status:        String(x.status || "pending").toLowerCase(),
    hasNewItems:   x.hasNewItems === true,
    pendingAddon:  pendingAddonItems(x).length,
    updatedSec:    x.updatedAt?.seconds || x.createdAt?.seconds || 0,
    etaMinutes:    Number(x.etaMinutes || 10),
    etaStartedSec: x.etaStartedAt?.seconds || 0
  });
}

function isAddonItem(item = {}) {
  return item.isAddon === true || item.isNewAddon === true;
}

function pendingAddonItems(order = {}) {
  return (order.items || []).filter(item => isAddonItem(item) && item.seenByKitchen !== true);
}

function newKotItems(order = {}) {
  return (order.items || []).filter(item => isAddonItem(item) && item.kotPrinted !== true);
}

/* ─────────────────────────────────────────
   CARD HTML
───────────────────────────────────────── */
function cardHtml(d) {
  const x         = d.data();
  const pendingAddons = pendingAddonItems(x);
  const items     = (x.items || []).map(i => `${escapeHtml(itemDisplayName(i))} x ${i.qty}${isAddonItem(i) && i.seenByKitchen !== true ? " NEW ADD ON" : ""}`).join(", ");
  const eta       = Number(x.etaMinutes || 10);
  const hasNew    = x.hasNewItems === true;
  const newText   = escapeHtml(x.newlyAddedItemsText || "");
  const newNote   = escapeHtml(x.newlyAddedNote || "");
  const remaining = getRemainingSeconds(x);

  return `
    <div class="card" style="margin-bottom:12px;padding:14px">
      <strong>Order No: ${escapeHtml(x.displayOrderNo || x.dailyOrderNo || "-")}</strong><br>
      <span class="muted small">Order ID: ${escapeHtml(x.orderId || d.id)}</span><br>
      ${escapeHtml(x.customerName || "Guest")} • ${x.businessMode === "vendor" ? `Token #${escapeHtml(x.tokenNumber || "--")}` : `Table ${escapeHtml(x.tableNo || "--")}`}<br>
      <span class="muted small">${tsToDate(x.createdAt).toLocaleString()}</span><br>
      <span>${items}</span><br>
      <strong>${fmtCurrency(x.grandTotal || 0)}</strong><br>
      <span>Phone: ${escapeHtml(x.customerPhone || "-")}</span><br>
      <span>Status: ${escapeHtml(x.businessMode === "vendor" && String(x.status || "").toLowerCase() === "pending" ? "New" : x.status || "pending")}</span><br>
      ${x.note ? `<span>Note: ${escapeHtml(x.note)}</span><br>` : ""}

      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px">
        <span>ETA: ${eta} min</span>
        <span data-timer-id="${d.id}" style="${getTimerBadgeStyle(remaining)}">
          ${remaining === null ? "Not Started" : remaining > 0 ? formatRemaining(remaining) : "Time Over"}
        </span>
      </div>

      ${hasNew ? `
        <div style="margin-top:10px;padding:10px 12px;border-radius:14px;background:#fff7e6;border:1px solid #f4d9a6">
          <div style="font-weight:800;color:#b96f09;font-size:13px;margin-bottom:6px;">NEW ADD ON · Add on order received</div>
          <div style="font-size:14px;color:#333;margin-bottom:${newNote ? "6px" : "0"}">${pendingAddons.length ? pendingAddons.map(item => `${escapeHtml(itemDisplayName(item))} x ${Number(item.qty || item.quantity || 0)} NEW`).join("<br>") : newText}</div>
          ${newNote ? `<div style="font-size:13px;color:#666"><strong>Note:</strong> ${newNote}</div>` : ""}
        </div>` : ""}

      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
        <button class="btn btn-outline" data-status="${d.id}" data-val="accepted">Accept</button>
        <button class="btn btn-outline" data-status="${d.id}" data-val="preparing">Preparing</button>
        <button class="btn btn-outline" data-status="${d.id}" data-val="ready">Ready</button>
        <button class="btn btn-danger"  data-status="${d.id}" data-val="rejected">Reject</button>
        <button class="btn btn-dark"    data-addtime="${d.id}">+10 min</button>
        ${hasNew
          ? `<button class="btn btn-green" data-seenaddons="${d.id}">Seen</button>
             <button class="btn btn-outline" data-printnew="${d.id}">Print New KOT</button>`
          : ""}
        <button class="btn btn-outline" data-printall="${d.id}" title="Print full KOT">Print KOT All Items</button>
      </div>
    </div>`;
}

/* ─────────────────────────────────────────
   BACKEND NOTIFY
───────────────────────────────────────── */
async function sendOrderUpdate(orderDoc, nextStatus, nextEta) {
  try {
    const x = orderDoc.data();
    await notifyBackend({
      restaurantId,
      restaurantName: cafeSettings.restaurantName || "Restaurant",
      orderId:       x.orderId || orderDoc.id,
      tableNo:       x.tableNo || "",
      customerName:  x.customerName || "Guest",
      customerPhone: x.whatsappConsent === false ? "" : (x.customerPhone || ""),
      kitchenPhone:  cafeSettings.kitchenWhatsApp || "",
      items:         x.items || [],
      grandTotal:    Number(x.grandTotal || 0),
      status:        nextStatus || x.status || "pending",
      etaMinutes:    Number(nextEta ?? x.etaMinutes ?? 10),
      billUrl:       `${location.origin}/bill.html?orderId=${encodeURIComponent(x.orderId || "")}`
    });
  } catch (err) { console.error("sendOrderUpdate error", err); }
}

/* ─────────────────────────────────────────
   BIND ACTIONS  ← KOT PRINT ADDED HERE
───────────────────────────────────────── */
function bindActions(orderDocs, root = document) {

  /* ── Status buttons (Accept / Preparing / Ready / Reject) ── */
  root.querySelectorAll("[data-status]").forEach(btn => {
    btn.onclick = async () => {
      stopAlert();

      const docId      = btn.dataset.status;
      const nextStatus = btn.dataset.val;
      const found      = orderDocs.find(d => d.id === docId);
      if (!found) return;

      const current = found.data();
      const eta     = Number(current.etaMinutes || 10);

      const payload = {
        status:              nextStatus,
        updatedAt:           serverTimestamp()
      };

      // Start timer only first time on accept
      if (nextStatus === "accepted" && !current.etaStartedAt) {
        payload.etaStartedAt = serverTimestamp();
      }

      await withTimeout(updateDoc(doc(db, "orders", docId), payload), 15000, "Could not update order status.");
      await withTimeout(sendOrderUpdate(found, nextStatus, eta), 15000, "Kitchen notification timed out.");

      // ── PRINT KOT when order is ACCEPTED + save item snapshot ──
      if (nextStatus === "accepted") {
        printKOT(current, current.items || []);
        // Save snapshot of all items at accept time so Seen Update can diff later
        const snapshot = new Map();
        (current.items || []).forEach(i => snapshot.set(itemDisplayName(i), Number(i.qty || 0)));
        acceptedSnapshots.set(docId, snapshot);
      }
    };
    const handler = btn.onclick;
    btn.onclick = () => guardedAction(btn, handler, { loadingText: "Saving...", timeoutMs: 25000, errorMessage: false });
  });

  /* ── +10 min ── */
  root.querySelectorAll("[data-addtime]").forEach(btn => {
    btn.onclick = async () => {
      stopAlert();
      const docId  = btn.dataset.addtime;
      const found  = orderDocs.find(d => d.id === docId);
      if (!found) return;

      const current        = found.data();
      const nextEtaMinutes = Number(current.etaMinutes || 10) + 10;

      await withTimeout(updateDoc(doc(db, "orders", docId), {
        etaMinutes:          nextEtaMinutes,
        updatedAt:           serverTimestamp()
      }), 15000, "Could not add time.");

      await withTimeout(sendOrderUpdate(found, current.status || "pending", nextEtaMinutes), 15000, "Kitchen notification timed out.");
    };
    const handler = btn.onclick;
    btn.onclick = () => guardedAction(btn, handler, { loadingText: "Saving...", timeoutMs: 25000, errorMessage: false });
  });

  root.querySelectorAll("[data-seenaddons]").forEach(btn => {
    btn.onclick = async () => {
      stopAlert();
      const docId = btn.dataset.seenaddons;
      const found = orderDocs.find(d => d.id === docId);
      if (!found) return;

      const current     = found.data();
      const currItems   = current.items || [];
      const nextItems = currItems.map(item => isAddonItem(item) ? { ...item, seenByKitchen: true } : item);
      await withTimeout(updateDoc(doc(db, "orders", docId), {
        items: nextItems,
        hasNewItems:         false,
        newlyAddedItems:     [],
        newlyAddedItemsText: "",
        newlyAddedNote:      "",
        updatedAt:           serverTimestamp()
      }), 15000, "Could not mark add-on items as seen.");
    };
    const handler = btn.onclick;
    btn.onclick = () => guardedAction(btn, handler, { loadingText: "Saving...", timeoutMs: 25000, errorMessage: false });
  });

  root.querySelectorAll("[data-printnew]").forEach(btn => {
    btn.onclick = async () => {
      const docId = btn.dataset.printnew;
      const found = orderDocs.find(d => d.id === docId);
      if (!found) return;
      const current = found.data();
      const itemsToPrint = newKotItems(current);
      if (!itemsToPrint.length) return alert("No new add-on items to print.");
      printKOT(current, itemsToPrint, "NEW ITEMS ONLY");
      const printedAt = new Date().toISOString();
      await withTimeout(updateDoc(doc(db, "orders", docId), {
        items: (current.items || []).map(item => isAddonItem(item) && item.kotPrinted !== true ? { ...item, kotPrinted: true, kotPrintedAt: printedAt } : item),
        updatedAt: serverTimestamp()
      }), 15000, "Could not mark KOT as printed.");
    };
    const handler = btn.onclick;
    btn.onclick = () => guardedAction(btn, handler, { loadingText: "Printing...", timeoutMs: 25000, errorMessage: false });
  });

  /* ── Manual Print KOT button (full order) ── */
  root.querySelectorAll("[data-printall]").forEach(btn => {
    btn.onclick = () => {
      const docId = btn.dataset.printall;
      const found = orderDocs.find(d => d.id === docId);
      if (!found) return;
      const current = found.data();
      printKOT(current, current.items || []);
    };
  });
}

/* ─────────────────────────────────────────
   RENDER ORDERS
───────────────────────────────────────── */
function renderOrders(orderDocs) {
  const scoped = orderDocs.filter(d => {
    const x = d.data();
    return (
      String(x.restaurantId || "") === restaurantId &&
      !["cancelled","rejected","delivered"].includes(String(x.status || "").toLowerCase())
    );
  });

  currentRenderedOrders = scoped;

  const newOrders       = scoped.filter(d => ["pending","accepted"].includes(String(d.data().status || "pending").toLowerCase()));
  const preparingOrders = scoped.filter(d => String(d.data().status || "").toLowerCase() === "preparing");
  const readyOrders     = scoped.filter(d => String(d.data().status || "").toLowerCase() === "ready");

  newWrap.innerHTML       = newOrders.length       ? newOrders.map(cardHtml).join("")       : `<div class="empty-box">No new orders.</div>`;
  preparingWrap.innerHTML = preparingOrders.length ? preparingOrders.map(cardHtml).join("") : `<div class="empty-box">No preparing orders.</div>`;
  readyWrap.innerHTML     = readyOrders.length     ? readyOrders.map(cardHtml).join("")     : `<div class="empty-box">No ready orders.</div>`;

  bindActions(scoped, document);
  startKitchenCountdown();
}

/* ─────────────────────────────────────────
   REAL-TIME LISTENER
───────────────────────────────────────── */
const kitchenRestaurantSnap = await withTimeout(getDoc(doc(db, "restaurants", restaurantId)), 15000, "Restaurant details timed out.");
const kitchenRestaurant = kitchenRestaurantSnap.exists() ? kitchenRestaurantSnap.data() : {};
if (String(kitchenRestaurant.plan || "").toLowerCase() === "basic") {
  showKitchenPlanLock("Kitchen dashboard is available only in Advance plan.");
} else if (isPlanExpired(kitchenRestaurant)) {
  showKitchenPlanLock("Your plan has expired. Please renew to continue.");
} else {
await withTimeout(loadSettings(), 15000, "Kitchen settings load timed out.");

registerCleanup(onSnapshot(
  collection(db, "orders"),
  snap => {
    const activeDocs = snap.docs.filter(d => {
      const x = d.data();
      return (
        String(x.restaurantId || "") === restaurantId &&
        !["delivered","cancelled","rejected"].includes(String(x.status || "pending").toLowerCase())
      );
    });

    let shouldAlert = false;
    let alertType   = "new_order";

    activeDocs.forEach(d => {
      const x          = d.data();
      const currentKey = getAlertKey(x);
      const oldKey     = orderAlertMap.get(d.id);

      if (firstLoadDone) {
        if (!oldKey) {
          shouldAlert = true;
          alertType   = "new_order";
        } else if (oldKey !== currentKey) {
          if (x.hasNewItems === true) {
            shouldAlert = true;
            alertType   = "new_items";
          } else if (String(x.status || "").toLowerCase() === "pending") {
            shouldAlert = true;
            alertType   = "new_order";
          }
        }
      }

      orderAlertMap.set(d.id, currentKey);
    });

    // Prune stale entries
    const liveIds = new Set(activeDocs.map(d => d.id));
    [...orderAlertMap.keys()].forEach(id => {
      if (!liveIds.has(id)) orderAlertMap.delete(id);
    });

    if (shouldAlert) startAlert(alertType);

    firstLoadDone = true;
    renderOrders(snap.docs);
  },
  err => {
    console.error(err);
    newWrap.innerHTML = `<div class="empty-box">Unable to load kitchen orders. <button class="btn btn-outline" type="button" onclick="location.reload()">Retry</button></div>`;
  }
));
}
