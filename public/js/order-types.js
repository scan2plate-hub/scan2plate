/* =========================================================
   ORDER TYPES — dine-in, takeaway, delivery
   ---------------------------------------------------------
   One place that decides what an order type is called, what
   details it needs, and how a delivery fee is worked out.
   Imported by the admin billing screen, the order list, the
   KOT and the bill, so all four agree.

   Existing data has no orderType field at all. Everything here
   treats a missing value as dine-in, which is what those orders
   were, so nothing already in Firestore changes meaning.
========================================================= */

export const ORDER_TYPES = ["dine_in", "takeaway", "delivery"];

const LABELS = {
  dine_in: "Dine-in",
  takeaway: "Takeaway",
  delivery: "Delivery"
};

// Values other parts of the app already write for the same three things.
const ALIASES = {
  dine_in: "dine_in",
  "dine-in": "dine_in",
  dinein: "dine_in",
  table: "dine_in",
  preorder_dine_in: "dine_in",
  token: "dine_in",
  hybrid: "dine_in",
  room: "dine_in",
  takeaway: "takeaway",
  "take-away": "takeaway",
  "take away": "takeaway",
  pickup: "takeaway",
  parcel: "takeaway",
  delivery: "delivery",
  home_delivery: "delivery",
  "home delivery": "delivery",
  delivery_web: "delivery"
};

export function normalizeOrderType(value, fallback = "dine_in") {
  const key = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (ALIASES[key]) return ALIASES[key];
  return ORDER_TYPES.includes(fallback) ? fallback : "dine_in";
}

export function orderTypeLabel(value) {
  return LABELS[normalizeOrderType(value)];
}

/**
 * The order type of a stored order. Reads orderType first, then the
 * older orderMode/source fields, and only then falls back to dine-in.
 */
export function orderTypeOf(order = {}) {
  if (order.orderType) return normalizeOrderType(order.orderType);
  if (order.orderMode) return normalizeOrderType(order.orderMode);
  if (order.source) return normalizeOrderType(order.source);
  return "dine_in";
}

export function needsTable(value) {
  return normalizeOrderType(value) === "dine_in";
}

export function needsDeliveryAddress(value) {
  return normalizeOrderType(value) === "delivery";
}

/** Takeaway and delivery both need a number to call the customer back on. */
export function needsCustomerPhone(value) {
  return normalizeOrderType(value) !== "dine_in";
}

/**
 * Delivery fee for an order of this size.
 * Only delivery is ever charged. A free-delivery threshold of 0 means
 * "no threshold", matching how the settings screen describes it, so a
 * zero there never silently makes every delivery free.
 */
export function deliveryFeeFor(orderType, itemsTotal, settings = {}) {
  if (normalizeOrderType(orderType) !== "delivery") return 0;
  const fee = Number(settings.deliveryFee);
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  const threshold = Number(settings.freeDeliveryThreshold);
  const total = Number(itemsTotal);
  if (Number.isFinite(threshold) && threshold > 0 && Number.isFinite(total) && total >= threshold) return 0;
  return fee;
}

/** Single-line address as typed by staff or by the customer. */
export function formatDeliveryAddress(order = {}) {
  return [order.deliveryAddress, order.landmark, order.area, order.postalCode]
    .map(part => String(part ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * What to print where a dine-in order prints "Table 04": the short
 * destination for this order, for the order card, the KOT and the bill.
 */
export function orderDestinationText(order = {}) {
  const type = orderTypeOf(order);
  if (type === "delivery") return formatDeliveryAddress(order) || "Delivery";
  if (type === "takeaway") return "Takeaway / Pickup";
  if (order.businessMode === "vendor" || String(order.orderMode || "").toLowerCase() === "token") {
    return `Token ${String(order.tokenNo || `T-${order.tokenNumber || "-"}`)}`;
  }
  return `Table ${String(order.tableNo || "-")}`;
}

/**
 * Blocks a bill that cannot be fulfilled. Returns "" when the order is
 * good to save, otherwise the message to show the person at the counter.
 */
export function validateOrderTypeDetails(orderType, details = {}) {
  const type = normalizeOrderType(orderType);
  const phone = String(details.customerPhone ?? "").replace(/\D/g, "");
  if (type === "dine_in") {
    if (!String(details.tableNo ?? "").trim()) return "Select a table number for a dine-in order.";
    return "";
  }
  if (phone.length < 10) return `Enter a 10 digit contact number for a ${LABELS[type].toLowerCase()} order.`;
  if (type === "delivery" && !String(details.deliveryAddress ?? "").trim()) return "Enter the delivery address.";
  return "";
}
