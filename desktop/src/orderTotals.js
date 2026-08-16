"use strict";

// Deliberately mirrors calculateOrderTotals() in public/js/common.js field
// for field. Kept as a small, pure, side-effect-free port rather than an
// import specifically so the offline billing page (a local file:// page,
// not the live site) never depends on public/ at runtime - but the formula
// itself must never drift from the online one, or offline and online bills
// would disagree on tax. If common.js's calculateOrderTotals ever changes,
// this needs the same change.
function orderItemTotal(item = {}) {
  const qty = Number(item.qty ?? item.quantity);
  const price = Number(item.price ?? item.unitPrice);
  if (Number.isFinite(qty) && Number.isFinite(price)) return price * qty;
  return Number(item.total || 0);
}

function calculateOrderTotals(items = [], taxPercent = 0, discount = {}) {
  const itemsTotal = (items || []).reduce((sum, item) => sum + orderItemTotal(item), 0);
  const rawType = String(discount.discountType || "").toLowerCase();
  const rawValue = Number(discount.discountValue || 0);
  let discountAmount = Number(discount.discountAmount || 0);
  if (rawType === "flat") discountAmount = Math.min(itemsTotal, Math.max(0, rawValue));
  if (rawType === "percent") discountAmount = (itemsTotal * Math.min(100, Math.max(0, rawValue))) / 100;
  discountAmount = Math.min(itemsTotal, Math.max(0, discountAmount));
  const taxableAmount = Math.max(0, itemsTotal - discountAmount);
  const tax = taxableAmount * (Number(taxPercent || 0) / 100);
  return { itemsTotal, subtotal: itemsTotal, discountAmount, taxableAmount, tax, grandTotal: taxableAmount + tax };
}

module.exports = { calculateOrderTotals, orderItemTotal };
