"use strict";
/* global window, document, Scan2PlateOfflineCore, Scan2PlateOfflineDb */

// Controller for the bundled offline-billing page. Structurally mirrors
// desktop/windows/offline-billing.js (same cart/menu/totals/print flow) -
// the two differences are the data source (Capacitor SQLite here instead
// of the Electron preload bridge) and how "back online" navigates (a
// native Capacitor plugin call instead of Electron's window management).

var Core = window.Scan2PlateOfflineCore;
var Db = window.Scan2PlateOfflineDb;

function money(v) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(v || 0));
}
function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

var restaurant = null; // cached restaurant_cache row
var menu = [];
var tables = [];
var cart = []; // [{ id, name, price, qty }]
var paymentMethod = "cash";

function renderMenu() {
  var pane = document.getElementById("menuPane");
  if (!menu.length) {
    pane.innerHTML = '<p class="empty">No cached menu available yet. Menu is cached automatically the next time this device is online.</p>';
    return;
  }
  var byCategory = new Map();
  menu.forEach(function (item) {
    var key = item.category || "Uncategorized";
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(item);
  });
  var html = "";
  byCategory.forEach(function (items, category) {
    html += '<div class="category">' + escapeHtml(category) + '</div><div class="menu-grid">' +
      items.map(function (item) {
        return '<button type="button" class="menu-item" data-id="' + escapeHtml(item.id) + '"><strong>' + escapeHtml(item.name) + "</strong><span>" + money(item.price) + "</span></button>";
      }).join("") + "</div>";
  });
  pane.innerHTML = html;
  pane.querySelectorAll(".menu-item").forEach(function (btn) {
    btn.addEventListener("click", function () { addToCart(btn.dataset.id); });
  });
}

function renderTables() {
  var select = document.getElementById("tableSelect");
  select.innerHTML = '<option value="">Select table</option>' + tables.map(function (t) {
    return '<option value="' + escapeHtml(t.tableNo) + '">Table ' + escapeHtml(t.tableNo) + "</option>";
  }).join("");
}

function addToCart(id) {
  var item = menu.find(function (m) { return m.id === id; });
  if (!item) return;
  var existing = cart.find(function (c) { return c.id === id; });
  if (existing) existing.qty += 1;
  else cart.push({ id: item.id, name: item.name, price: item.price, qty: 1 });
  renderCart();
}

function changeQty(id, delta) {
  var item = cart.find(function (c) { return c.id === id; });
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) cart = cart.filter(function (c) { return c.id !== id; });
  renderCart();
}

function renderCart() {
  var list = document.getElementById("cartList");
  list.innerHTML = cart.length ? cart.map(function (item) {
    return '<div class="cart-row"><span>' + escapeHtml(item.name) + '<br><span style="color:#94a3b8">' + money(item.price) + " × " + item.qty + '</span></span>' +
      '<span class="qty-btns"><button type="button" data-id="' + escapeHtml(item.id) + '" data-delta="-1">−</button>' +
      '<button type="button" data-id="' + escapeHtml(item.id) + '" data-delta="1">+</button></span></div>';
  }).join("") : '<p class="empty">Cart is empty. Tap a menu item to add it.</p>';
  list.querySelectorAll("button[data-delta]").forEach(function (btn) {
    btn.addEventListener("click", function () { changeQty(btn.dataset.id, Number(btn.dataset.delta)); });
  });
  renderTotals();
}

function renderTotals() {
  var taxPercent = restaurant ? Number(restaurant.taxPercent || 0) : 0;
  var discountValue = Number(document.getElementById("discountInput").value || 0);
  var totals = Core.calculateOrderTotals(cart, taxPercent, { discountType: "flat", discountValue: discountValue });
  document.getElementById("subtotalOut").textContent = money(totals.itemsTotal);
  document.getElementById("taxOut").textContent = money(totals.tax);
  document.getElementById("totalOut").textContent = money(totals.grandTotal);
  document.getElementById("placeBillBtn").disabled = cart.length === 0 || !document.getElementById("tableSelect").value;
  return totals;
}

function buildPrintHtml(order, totals) {
  var rows = order.items.map(function (item) {
    return "<tr><td>" + escapeHtml(item.name) + " x" + item.qty + '</td><td class="right">' + money(item.price * item.qty) + "</td></tr>";
  }).join("");
  var pendingLine = order.paymentMethod !== "cash" ? '<p class="center">*** PAYMENT CONFIRMATION PENDING ***</p>' : "";
  return (
    '<div class="center"><strong>' + escapeHtml((restaurant && restaurant.name) || "Restaurant") + "</strong></div>" +
    ((restaurant && restaurant.address) ? '<div class="center">' + escapeHtml(restaurant.address) + "</div>" : "") +
    ((restaurant && restaurant.gstNumber) ? '<div class="center">GSTIN: ' + escapeHtml(restaurant.gstNumber) + "</div>" : "") +
    "<hr /><div>Table: " + escapeHtml(order.tableNo) + " &nbsp; Bill #" + order.localOrderNo + "</div>" +
    "<div>" + new Date(order.createdAt).toLocaleString("en-IN") + "</div><hr /><table>" + rows + "</table><hr /><table>" +
    "<tr><td>Subtotal</td><td class=\"right\">" + money(totals.itemsTotal) + "</td></tr>" +
    (totals.discountAmount ? "<tr><td>Discount</td><td class=\"right\">-" + money(totals.discountAmount) + "</td></tr>" : "") +
    "<tr><td>Tax</td><td class=\"right\">" + money(totals.tax) + "</td></tr>" +
    "<tr><td><strong>Total</strong></td><td class=\"right\"><strong>" + money(totals.grandTotal) + "</strong></td></tr></table><hr />" +
    "<div>Payment: " + escapeHtml(order.paymentMethod.toUpperCase()) + "</div>" + pendingLine +
    '<p class="center">OFFLINE BILL — will sync automatically when internet returns</p>' +
    '<p class="center" style="font-size:10px">' + escapeHtml(order.offlineId) + "</p>"
  );
}

async function placeBill() {
  var btn = document.getElementById("placeBillBtn");
  var tableNo = document.getElementById("tableSelect").value;
  if (!cart.length || !tableNo || !restaurant) return;
  var totals = renderTotals();
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    var order = await Db.createOfflineOrder({
      restaurantId: restaurant.restaurantId,
      tableNo: tableNo,
      items: cart,
      subtotal: totals.itemsTotal,
      discount: totals.discountAmount,
      tax: totals.tax,
      total: totals.grandTotal,
      paymentMethod: paymentMethod,
      paymentStatus: paymentMethod === "cash" ? "paid" : "unpaid",
      businessDate: new Date().toISOString().slice(0, 10)
    }, Core.generateOfflineId);
    document.getElementById("printArea").innerHTML = buildPrintHtml(order, totals);
    // Supported by Android's WebView print framework on modern devices;
    // unverified on a real device in this environment (no
    // emulator/hardware available here) - falls back to no-op harmlessly
    // if unsupported, the bill is already saved either way.
    if (typeof window.print === "function") window.print();
    cart = [];
    document.getElementById("discountInput").value = "0";
    renderCart();
    updatePendingLabel();
  } catch (error) {
    alert("Could not save this offline bill: " + (error && error.message ? error.message : error));
  } finally {
    btn.disabled = false;
    btn.textContent = "Place Bill & Print";
  }
}

async function updatePendingLabel() {
  if (!restaurant) return;
  var count = await Db.countPendingOrders(restaurant.restaurantId);
  document.getElementById("pendingLabel").textContent = "🟠 Offline Mode — " + count + " bill" + (count === 1 ? "" : "s") + " waiting to sync";
}

function returnOnline() {
  var nav = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.OfflineNav;
  if (nav && nav.returnOnline) nav.returnOnline();
  else alert("Reopen the app to go back online.");
}

async function init() {
  try {
    restaurant = await Db.getMostRecentCachedRestaurant();
  } catch (error) {
    document.getElementById("menuPane").innerHTML = '<p class="empty">Offline storage is not ready yet (' + escapeHtml(error && error.message ? error.message : error) + "). Try reopening the app.</p>";
    return;
  }
  if (!restaurant) {
    document.getElementById("menuPane").innerHTML = '<p class="empty">No cached data yet. Open Scan2Plate while online at least once before using Offline Billing.</p>';
    document.getElementById("pendingLabel").textContent = "🟠 Offline Mode — no cached data";
    document.getElementById("returnOnlineBtn").addEventListener("click", returnOnline);
    return;
  }
  menu = await Db.getCachedMenu(restaurant.restaurantId);
  tables = await Db.getCachedTables(restaurant.restaurantId);
  renderMenu();
  renderTables();
  renderCart();
  updatePendingLabel();

  document.getElementById("discountInput").addEventListener("input", renderTotals);
  document.getElementById("tableSelect").addEventListener("change", renderTotals);
  document.querySelectorAll(".payment-methods button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      paymentMethod = btn.dataset.method;
      document.querySelectorAll(".payment-methods button").forEach(function (b) { b.classList.toggle("active", b === btn); });
      document.getElementById("pendingNote").style.display = paymentMethod === "cash" ? "none" : "block";
    });
  });
  document.getElementById("placeBillBtn").addEventListener("click", placeBill);
  document.getElementById("returnOnlineBtn").addEventListener("click", returnOnline);
}

init();
