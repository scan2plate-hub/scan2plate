"use strict";
/* global window, document */

// Same formula as desktop/src/orderTotals.js (itself a deliberate port of
// public/js/common.js's calculateOrderTotals) - duplicated here because
// this file runs in a plain browser context with no require(). If the
// online formula ever changes, both this and src/orderTotals.js need the
// same change.
function calcTotals(items, taxPercent, discountAmount) {
  const itemsTotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const clampedDiscount = Math.min(itemsTotal, Math.max(0, Number(discountAmount) || 0));
  const taxableAmount = Math.max(0, itemsTotal - clampedDiscount);
  const tax = taxableAmount * (Number(taxPercent || 0) / 100);
  return { itemsTotal, discountAmount: clampedDiscount, taxableAmount, tax, grandTotal: taxableAmount + tax };
}

function money(v) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(v || 0));
}

let context = null; // { restaurant, menu, tables }
let cart = []; // [{ id, name, price, qty }]
let paymentMethod = "cash";

function renderMenu() {
  const pane = document.getElementById("menuPane");
  if (!context || !context.menu.length) {
    pane.innerHTML = '<p class="empty">No cached menu available yet. Menu is cached automatically the next time this device is online.</p>';
    return;
  }
  const byCategory = new Map();
  context.menu.forEach(item => {
    const key = item.category || "Uncategorized";
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(item);
  });
  pane.innerHTML = [...byCategory.entries()].map(([category, items]) => `
    <div class="category">${escapeHtml(category)}</div>
    <div class="menu-grid">
      ${items.map(item => `<button type="button" class="menu-item" data-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.name)}</strong><span>${money(item.price)}</span></button>`).join("")}
    </div>
  `).join("");
  pane.querySelectorAll(".menu-item").forEach(btn => {
    btn.addEventListener("click", () => addToCart(btn.dataset.id));
  });
}

function renderTables() {
  const select = document.getElementById("tableSelect");
  const tables = (context && context.tables) || [];
  select.innerHTML = '<option value="">Select table</option>' + tables.map(t => `<option value="${escapeHtml(t.tableNo)}">Table ${escapeHtml(t.tableNo)}</option>`).join("");
}

function addToCart(id) {
  const item = context.menu.find(m => m.id === id);
  if (!item) return;
  const existing = cart.find(c => c.id === id);
  if (existing) existing.qty += 1;
  else cart.push({ id: item.id, name: item.name, price: item.price, qty: 1 });
  renderCart();
}

function changeQty(id, delta) {
  const item = cart.find(c => c.id === id);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) cart = cart.filter(c => c.id !== id);
  renderCart();
}

function renderCart() {
  const list = document.getElementById("cartList");
  list.innerHTML = cart.length ? cart.map(item => `
    <div class="cart-row">
      <span>${escapeHtml(item.name)}<br><span style="color:#94a3b8">${money(item.price)} × ${item.qty}</span></span>
      <span class="qty-btns">
        <button type="button" data-id="${escapeHtml(item.id)}" data-delta="-1">−</button>
        <button type="button" data-id="${escapeHtml(item.id)}" data-delta="1">+</button>
      </span>
    </div>
  `).join("") : '<p class="empty">Cart is empty. Tap a menu item to add it.</p>';
  list.querySelectorAll("button[data-delta]").forEach(btn => {
    btn.addEventListener("click", () => changeQty(btn.dataset.id, Number(btn.dataset.delta)));
  });
  renderTotals();
}

function renderTotals() {
  const taxPercent = context ? Number(context.restaurant?.taxPercent || 0) : 0;
  const discount = Number(document.getElementById("discountInput").value || 0);
  const totals = calcTotals(cart, taxPercent, discount);
  document.getElementById("subtotalOut").textContent = money(totals.itemsTotal);
  document.getElementById("taxOut").textContent = money(totals.tax);
  document.getElementById("totalOut").textContent = money(totals.grandTotal);
  document.getElementById("placeBillBtn").disabled = cart.length === 0 || !document.getElementById("tableSelect").value;
  return totals;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function buildPrintHtml(order, totals, restaurant) {
  const rows = order.items.map(item => `<tr><td>${escapeHtml(item.name)} x${item.qty}</td><td class="right">${money(item.price * item.qty)}</td></tr>`).join("");
  const pendingLine = order.paymentMethod !== "cash"
    ? `<p class="center">*** PAYMENT CONFIRMATION PENDING ***</p>`
    : "";
  return `
    <div class="center"><strong>${escapeHtml(restaurant?.name || "Restaurant")}</strong></div>
    ${restaurant?.address ? `<div class="center">${escapeHtml(restaurant.address)}</div>` : ""}
    ${restaurant?.gstNumber ? `<div class="center">GSTIN: ${escapeHtml(restaurant.gstNumber)}</div>` : ""}
    <hr />
    <div>Table: ${escapeHtml(order.tableNo)} &nbsp; Bill #${order.localOrderNo}</div>
    <div>${new Date(order.createdAt).toLocaleString("en-IN")}</div>
    <hr />
    <table>${rows}</table>
    <hr />
    <table>
      <tr><td>Subtotal</td><td class="right">${money(totals.itemsTotal)}</td></tr>
      ${totals.discountAmount ? `<tr><td>Discount</td><td class="right">-${money(totals.discountAmount)}</td></tr>` : ""}
      <tr><td>Tax</td><td class="right">${money(totals.tax)}</td></tr>
      <tr><td><strong>Total</strong></td><td class="right"><strong>${money(totals.grandTotal)}</strong></td></tr>
    </table>
    <hr />
    <div>Payment: ${escapeHtml(order.paymentMethod.toUpperCase())}</div>
    ${pendingLine}
    <p class="center">OFFLINE BILL — will sync automatically when internet returns</p>
    <p class="center" style="font-size:10px">${escapeHtml(order.offlineId)}</p>
  `;
}

async function placeBill() {
  const btn = document.getElementById("placeBillBtn");
  const tableNo = document.getElementById("tableSelect").value;
  if (!cart.length || !tableNo) return;
  const totals = renderTotals();
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const order = await window.offlineBilling.createOrder({
      tableNo,
      items: cart,
      subtotal: totals.itemsTotal,
      discount: totals.discountAmount,
      tax: totals.tax,
      total: totals.grandTotal,
      paymentMethod,
      paymentStatus: paymentMethod === "cash" ? "paid" : "unpaid"
    });
    document.getElementById("printArea").innerHTML = buildPrintHtml(order, totals, context.restaurant);
    window.print();
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
  const count = await window.offlineBilling.getPendingCount();
  document.getElementById("pendingLabel").textContent = `🟠 Offline Mode — ${count} bill${count === 1 ? "" : "s"} waiting to sync`;
}

async function init() {
  context = await window.offlineBilling.getContext();
  renderMenu();
  renderTables();
  renderCart();
  updatePendingLabel();

  document.getElementById("discountInput").addEventListener("input", renderTotals);
  document.getElementById("tableSelect").addEventListener("change", renderTotals);
  document.querySelectorAll(".payment-methods button").forEach(btn => {
    btn.addEventListener("click", () => {
      paymentMethod = btn.dataset.method;
      document.querySelectorAll(".payment-methods button").forEach(b => b.classList.toggle("active", b === btn));
      document.getElementById("pendingNote").style.display = paymentMethod === "cash" ? "none" : "block";
    });
  });
  document.getElementById("placeBillBtn").addEventListener("click", placeBill);
}

init();
