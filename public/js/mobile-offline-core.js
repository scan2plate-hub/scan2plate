// Pure, side-effect-free offline billing logic used by mobile-offline.js
// (the live-site hook that caches data for, and syncs bills from, the
// Android app's offline mode). Deliberately duplicated rather than shared
// with mobile/www/offline-core.js: the live site (this file, a normal ES
// module like everything else in public/js/) and the bundled
// offline-billing page (mobile/www/offline-core.js, a plain UMD script
// with no build step, loaded from a different WebView origin entirely)
// have no shared module graph to import through. Same reasoning as
// desktop/src/orderTotals.js being a deliberate duplicate of
// public/js/common.js's calculateOrderTotals - if one changes, so must the
// other. Parity is checked by test/mobile-offline-core-parity.test.mjs.
//
// Field-for-field port of desktop/src/offlineId.js, desktop/src/syncPlan.js
// and desktop/src/orderTotals.js - same OFF-<restaurantId>-<YYYYMMDD>-<uuid>
// ID format, same idempotent sync planning, same totals formula - so
// offline bills behave identically whether created on desktop or Android.

export function generateOfflineId(restaurantId, date = new Date()) {
  const safeRestaurantId = String(restaurantId || "unknown").trim().replace(/[^a-zA-Z0-9_-]/g, "") || "unknown";
  const yyyymmdd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  return `OFF-${safeRestaurantId}-${yyyymmdd}-${crypto.randomUUID()}`;
}

export function isOfflineId(value) {
  return /^OFF-[a-zA-Z0-9_-]+-\d{8}-[0-9a-f-]{36}$/i.test(String(value || ""));
}

// Given the locally pending orders and the set of offlineIds that already
// exist server-side, decide which still need uploading vs. were already
// synced (by this run or an interrupted previous one).
export function buildSyncPlan(pendingOrders = [], existingOfflineIds = new Set()) {
  const plan = { upload: [], alreadySynced: [] };
  const seen = new Set();
  for (const order of pendingOrders) {
    const offlineId = order && order.offlineId;
    if (!offlineId) continue; // malformed record - never guess an ID, skip it
    if (seen.has(offlineId)) continue; // defend against a caller passing duplicates
    seen.add(offlineId);
    if (existingOfflineIds.has(offlineId)) plan.alreadySynced.push(order);
    else plan.upload.push(order);
  }
  return plan;
}

// Field-for-field match of calculateOrderTotals() in public/js/common.js.
export function orderItemTotal(item = {}) {
  const qty = Number(item.qty ?? item.quantity);
  const price = Number(item.price ?? item.unitPrice);
  if (Number.isFinite(qty) && Number.isFinite(price)) return price * qty;
  return Number(item.total || 0);
}

export function calculateOrderTotals(items = [], taxPercent = 0, discount = {}) {
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
