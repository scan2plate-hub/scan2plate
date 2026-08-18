// Pure, side-effect-free offline billing logic shared between the bundled
// offline-billing page and the live-site sync hook (public/js/mobile-offline.js,
// which runs *inside* the same Capacitor WebView, just at the remote
// scan2plate.com origin instead of this bundled one). No Firebase, no
// Capacitor plugin calls, no DOM - so it can be unit-tested with plain
// Node (see __tests__/offline-core.test.mjs) and reused unmodified from a
// plain <script> tag here.
//
// This is a deliberate, field-for-field port of the desktop app's
// desktop/src/offlineId.js, desktop/src/syncPlan.js and
// desktop/src/orderTotals.js - same ID format, same idempotent sync
// planning, same totals formula - so offline bills behave identically
// whether they were created on a desktop or a phone. If any of those
// desktop files change, this needs the same change.
(function (root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.Scan2PlateOfflineCore = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // OFF-<restaurantId>-<YYYYMMDD>-<uuid>. The UUID alone is already
  // globally unique; restaurantId+date are prefixed purely so a support
  // agent can eyeball which restaurant/day an ID belongs to without a
  // lookup. Never used as the *only* uniqueness guarantee - the UUID is.
  function randomUuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    // Fallback for older WebViews without crypto.randomUUID (Android < 10 /
    // some WebView builds). RFC4122-ish v4 using crypto.getRandomValues,
    // which has far broader WebView support than randomUUID().
    var bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = [];
    for (var j = 0; j < 256; j++) hex.push((j < 16 ? "0" : "") + j.toString(16));
    var b = bytes;
    return (
      hex[b[0]] + hex[b[1]] + hex[b[2]] + hex[b[3]] + "-" +
      hex[b[4]] + hex[b[5]] + "-" + hex[b[6]] + hex[b[7]] + "-" +
      hex[b[8]] + hex[b[9]] + "-" +
      hex[b[10]] + hex[b[11]] + hex[b[12]] + hex[b[13]] + hex[b[14]] + hex[b[15]]
    );
  }

  function generateOfflineId(restaurantId, date) {
    date = date || new Date();
    var safeRestaurantId = String(restaurantId || "unknown").trim().replace(/[^a-zA-Z0-9_-]/g, "") || "unknown";
    var yyyymmdd = "" + date.getFullYear() +
      String(date.getMonth() + 1).padStart(2, "0") +
      String(date.getDate()).padStart(2, "0");
    return "OFF-" + safeRestaurantId + "-" + yyyymmdd + "-" + randomUuid();
  }

  function isOfflineId(value) {
    return /^OFF-[a-zA-Z0-9_-]+-\d{8}-[0-9a-f-]{36}$/i.test(String(value || ""));
  }

  // Given the locally pending orders and the set of offlineIds that already
  // exist server-side, decide which still need uploading vs. were already
  // synced (by this run or an interrupted previous one). This is what makes
  // resuming after a mid-sync failure safe: if a bill already made it to
  // Firestore before the connection dropped, the next run's
  // existingOfflineIds set already contains it, so it's classified as
  // alreadySynced (no re-upload).
  function buildSyncPlan(pendingOrders, existingOfflineIds) {
    pendingOrders = pendingOrders || [];
    existingOfflineIds = existingOfflineIds || new Set();
    var plan = { upload: [], alreadySynced: [] };
    var seen = new Set();
    for (var i = 0; i < pendingOrders.length; i++) {
      var order = pendingOrders[i];
      var offlineId = order && order.offlineId;
      if (!offlineId) continue; // malformed record - never guess an ID, skip it
      if (seen.has(offlineId)) continue; // defend against a caller passing duplicates
      seen.add(offlineId);
      if (existingOfflineIds.has(offlineId)) plan.alreadySynced.push(order);
      else plan.upload.push(order);
    }
    return plan;
  }

  // Field-for-field match of calculateOrderTotals() in public/js/common.js.
  function orderItemTotal(item) {
    item = item || {};
    var qty = Number(item.qty != null ? item.qty : item.quantity);
    var price = Number(item.price != null ? item.price : item.unitPrice);
    if (Number.isFinite(qty) && Number.isFinite(price)) return price * qty;
    return Number(item.total || 0);
  }

  function calculateOrderTotals(items, taxPercent, discount) {
    items = items || [];
    discount = discount || {};
    var itemsTotal = items.reduce(function (sum, item) { return sum + orderItemTotal(item); }, 0);
    var rawType = String(discount.discountType || "").toLowerCase();
    var rawValue = Number(discount.discountValue || 0);
    var discountAmount = Number(discount.discountAmount || 0);
    if (rawType === "flat") discountAmount = Math.min(itemsTotal, Math.max(0, rawValue));
    if (rawType === "percent") discountAmount = (itemsTotal * Math.min(100, Math.max(0, rawValue))) / 100;
    discountAmount = Math.min(itemsTotal, Math.max(0, discountAmount));
    var taxableAmount = Math.max(0, itemsTotal - discountAmount);
    var tax = taxableAmount * (Number(taxPercent || 0) / 100);
    return { itemsTotal: itemsTotal, subtotal: itemsTotal, discountAmount: discountAmount, taxableAmount: taxableAmount, tax: tax, grandTotal: taxableAmount + tax };
  }

  return {
    generateOfflineId: generateOfflineId,
    isOfflineId: isOfflineId,
    buildSyncPlan: buildSyncPlan,
    calculateOrderTotals: calculateOrderTotals,
    orderItemTotal: orderItemTotal
  };
});
