/* =========================================================
   OFFLINE POS — pure logic
   ---------------------------------------------------------
   Validation, normalisation, counters and pagination for the
   Scan2Plate Billing offline app's backup/restore API.

   Nothing here touches Firestore, Express or the clock unless
   it is handed one, so every rule below is unit-testable and
   the route layer stays thin.

   Two rules run through all of it:

     * The client's `uuid` is the only identity. The app's local
       integer ids are not unique across reinstalls, so they are
       stored as `local_id` for reference and never keyed on.

     * The app may have been offline for days and its clock is
       its own. Timestamps arrive as local time with no zone and
       are stored exactly as sent, next to a server `received_at`
       in UTC. The server never reinterprets the app's clock.
========================================================= */

import crypto from "node:crypto";

export const MAX_BATCH = 500;
export const MAX_LOGO_BYTES = 500 * 1024;
export const API_KEY_PREFIX = "s2p_pos_";

/* ---------------- errors ---------------- */

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = message => new ApiError(400, "validation_error", message);
export const errorBody = (code, message) => ({ ok: false, error: code, message });

/* ---------------- api keys ---------------- */

/**
 * A key is shown to the owner exactly once. Only its SHA-256 lives in
 * Firestore, as the document id, so verifying a request is a single
 * document read and a stolen database yields no usable keys.
 */
export function generateApiKey(randomBytes = crypto.randomBytes) {
  return `${API_KEY_PREFIX}${randomBytes(24).toString("hex")}`;
}

export function hashApiKey(key) {
  return crypto.createHash("sha256").update(String(key || ""), "utf8").digest("hex");
}

/** What the dashboard may safely redisplay: enough to tell two keys apart. */
export function maskApiKey(key) {
  const text = String(key || "");
  if (text.length <= API_KEY_PREFIX.length + 8) return `${API_KEY_PREFIX}…`;
  return `${text.slice(0, API_KEY_PREFIX.length + 4)}…${text.slice(-4)}`;
}

export function bearerToken(headerValue = "") {
  const match = /^Bearer\s+(.+)$/i.exec(String(headerValue || "").trim());
  return match ? match[1].trim() : "";
}

/* ---------------- primitives ---------------- */

export function text(value, { max = 500 } = {}) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, max);
}

export function optionalText(value, options) {
  const result = text(value, options);
  return result === "" ? null : result;
}

/** Rupees, to 2 decimals. Anything unparseable becomes 0 rather than NaN. */
export function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

export function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

export function bool(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null || value === "") return fallback;
  return ["true", "yes", "1", "on"].includes(String(value).toLowerCase());
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value) {
  return UUID_RE.test(String(value || "").trim());
}

export function requireUuid(value, field) {
  const clean = text(value, { max: 64 });
  if (!isUuid(clean)) throw badRequest(`${field} must be a UUID v4.`);
  return clean.toLowerCase();
}

/**
 * The app sends local time with no zone ("2026-09-22T13:05:11.123"). It is
 * kept verbatim: reinterpreting it as UTC would silently shift every
 * timestamp by the device's offset. Only the shape is checked.
 */
// Ranges, not just shape: "2026-13-99T99:99:99" is the right shape and is
// not a time, and storing it verbatim would poison every later sort.
const LOCAL_ISO_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ](([01]\d|2[0-3]):[0-5]\d)(:[0-5]\d)?(\.\d{1,6})?(Z|[+-](0\d|1[0-4]):?[0-5]\d)?$/;
export function isoTimestamp(value, field, { required = true } = {}) {
  const clean = text(value, { max: 40 });
  if (!clean) {
    if (required) throw badRequest(`${field} is required.`);
    return null;
  }
  if (!LOCAL_ISO_RE.test(clean)) throw badRequest(`${field} must be an ISO-8601 timestamp.`);
  return clean;
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export function businessDate(value, field, { required = true } = {}) {
  const clean = text(value, { max: 10 });
  if (!clean) {
    if (required) throw badRequest(`${field} is required.`);
    return null;
  }
  if (!DATE_RE.test(clean)) throw badRequest(`${field} must be YYYY-MM-DD.`);
  return clean;
}

export function oneOf(value, allowed, field, { fallback = null } = {}) {
  const clean = text(value, { max: 40 }).toLowerCase();
  if (allowed.includes(clean)) return clean;
  if (fallback !== null) return fallback;
  throw badRequest(`${field} must be one of: ${allowed.join(", ")}.`);
}

/* ---------------- settings ---------------- */

export function normalizeSettings(body = {}) {
  const logo = body.logo_base64 === undefined || body.logo_base64 === null ? null : String(body.logo_base64);
  if (logo !== null) {
    // base64 expands by 4/3; measure the decoded size, which is what a
    // 500 KB limit actually means to the person uploading a logo.
    const decodedBytes = Math.floor(logo.replace(/^data:[^,]*,/, "").length * 3 / 4);
    if (decodedBytes > MAX_LOGO_BYTES) {
      throw new ApiError(413, "logo_too_large", `logo_base64 must decode to at most ${MAX_LOGO_BYTES / 1024} KB.`);
    }
  }
  const print = body.print_settings;
  if (print !== undefined && print !== null && (typeof print !== "object" || Array.isArray(print))) {
    throw badRequest("print_settings must be a JSON object.");
  }
  return {
    restaurant_name: text(body.restaurant_name, { max: 200 }),
    address: text(body.address, { max: 500 }),
    phone: text(body.phone, { max: 40 }),
    gstin: text(body.gstin, { max: 20 }),
    fssai_number: text(body.fssai_number, { max: 30 }),
    upi_id: text(body.upi_id, { max: 120 }),
    bill_footer_message: text(body.bill_footer_message, { max: 500 }),
    cgst_percent: money(body.cgst_percent),
    sgst_percent: money(body.sgst_percent),
    logo_base64: logo,
    print_settings: print ?? {},
    updated_at: isoTimestamp(body.updated_at, "updated_at")
  };
}

/* ---------------- menu ---------------- */

export function normalizeMenuSnapshot(body = {}) {
  const categories = Array.isArray(body.categories) ? body.categories : [];
  const items = Array.isArray(body.menu_items) ? body.menu_items : [];
  if (categories.length > MAX_BATCH || items.length > MAX_BATCH) {
    throw new ApiError(413, "batch_too_large", `A menu snapshot may contain at most ${MAX_BATCH} categories and ${MAX_BATCH} items.`);
  }

  const seenCategories = new Set();
  const normalizedCategories = categories.map((category, index) => {
    const uuid = requireUuid(category?.uuid, `categories[${index}].uuid`);
    if (seenCategories.has(uuid)) throw badRequest(`Duplicate category uuid ${uuid} in snapshot.`);
    seenCategories.add(uuid);
    return {
      uuid,
      name: text(category?.name, { max: 120 }),
      sort_order: integer(category?.sort_order, 0)
    };
  });

  const seenItems = new Set();
  const normalizedItems = items.map((item, index) => {
    const uuid = requireUuid(item?.uuid, `menu_items[${index}].uuid`);
    if (seenItems.has(uuid)) throw badRequest(`Duplicate menu item uuid ${uuid} in snapshot.`);
    seenItems.add(uuid);
    const categoryUuid = item?.category_uuid === null || item?.category_uuid === undefined || item?.category_uuid === ""
      ? null
      : requireUuid(item.category_uuid, `menu_items[${index}].category_uuid`);
    // A snapshot that points an item at a category it did not send would
    // restore as an orphan, so it is rejected while the app can still fix it.
    if (categoryUuid && !seenCategories.has(categoryUuid)) {
      throw badRequest(`menu_items[${index}].category_uuid ${categoryUuid} is not in this snapshot's categories.`);
    }
    return {
      uuid,
      category_uuid: categoryUuid,
      name: text(item?.name, { max: 200 }),
      price: money(item?.price),
      half_price: item?.half_price === null || item?.half_price === undefined ? null : money(item.half_price),
      veg: bool(item?.veg, false),
      active: bool(item?.active, true),
      favorite: bool(item?.favorite, false)
    };
  });

  return {
    categories: normalizedCategories,
    menu_items: normalizedItems,
    updated_at: isoTimestamp(body.updated_at, "updated_at")
  };
}

/** The legacy GET /menu shape, kept working for older app builds. */
export function legacyMenuView(snapshot) {
  if (!snapshot) return { categories: [], menu_items: [] };
  const categoryNames = new Map(snapshot.categories.map(category => [category.uuid, category.name]));
  return {
    categories: [...snapshot.categories]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(category => ({ id: category.uuid, name: category.name })),
    menu_items: snapshot.menu_items
      .filter(item => item.active !== false)
      .map(item => ({
        category_id: item.category_uuid,
        category_name: categoryNames.get(item.category_uuid) || "",
        name: item.name,
        price: item.price,
        veg: item.veg
      }))
  };
}

/* ---------------- tables ---------------- */

export function normalizeTablesSnapshot(body = {}) {
  const tables = Array.isArray(body.tables) ? body.tables : [];
  if (tables.length > MAX_BATCH) {
    throw new ApiError(413, "batch_too_large", `A tables snapshot may contain at most ${MAX_BATCH} entries.`);
  }
  const seen = new Set();
  return {
    tables: tables.map((table, index) => {
      const uuid = requireUuid(table?.uuid, `tables[${index}].uuid`);
      if (seen.has(uuid)) throw badRequest(`Duplicate table uuid ${uuid} in snapshot.`);
      seen.add(uuid);
      return {
        uuid,
        name: text(table?.name, { max: 120 }),
        type: oneOf(table?.type, ["table", "cabin"], `tables[${index}].type`, { fallback: "table" }),
        capacity: integer(table?.capacity, 0),
        sort_order: integer(table?.sort_order, 0)
      };
    }),
    updated_at: isoTimestamp(body.updated_at, "updated_at")
  };
}

/* ---------------- orders ---------------- */

export const ORDER_STATUSES = ["open", "billed", "cancelled"];
export const TABLE_TYPES = ["table", "cabin", "takeaway", "delivery"];
export const PAYMENT_MODES = ["Cash", "UPI", "Card"];

export function normalizeOrder(raw = {}) {
  const uuid = requireUuid(raw?.uuid, "uuid");
  const items = Array.isArray(raw?.items) ? raw.items : [];
  if (items.length > MAX_BATCH) {
    throw new ApiError(413, "batch_too_large", `An order may contain at most ${MAX_BATCH} items.`);
  }

  const seenItems = new Set();
  const normalizedItems = items.map((item, index) => {
    const itemUuid = requireUuid(item?.uuid, `items[${index}].uuid`);
    if (seenItems.has(itemUuid)) throw badRequest(`Duplicate item uuid ${itemUuid} in order ${uuid}.`);
    seenItems.add(itemUuid);
    return {
      uuid: itemUuid,
      menu_item_uuid: item?.menu_item_uuid === null || item?.menu_item_uuid === undefined || item?.menu_item_uuid === ""
        ? null
        : requireUuid(item.menu_item_uuid, `items[${index}].menu_item_uuid`),
      name: text(item?.name, { max: 200 }),
      price: money(item?.price),
      qty: integer(item?.qty, 0),
      kot_batch: integer(item?.kot_batch, 0)
    };
  });

  const paymentModeRaw = text(raw?.payment_mode, { max: 20 });
  const paymentMode = paymentModeRaw
    ? (PAYMENT_MODES.find(mode => mode.toLowerCase() === paymentModeRaw.toLowerCase()) || paymentModeRaw)
    : null;

  return {
    uuid,
    local_id: raw?.local_id === null || raw?.local_id === undefined ? null : integer(raw.local_id, 0),
    table_name: text(raw?.table_name, { max: 120 }),
    table_type: oneOf(raw?.table_type, TABLE_TYPES, "table_type", { fallback: "table" }),
    table_uuid: raw?.table_uuid === null || raw?.table_uuid === undefined || raw?.table_uuid === ""
      ? null
      : requireUuid(raw.table_uuid, "table_uuid"),
    status: oneOf(raw?.status, ORDER_STATUSES, "status"),
    order_number: integer(raw?.order_number, 0),
    business_date: businessDate(raw?.business_date, "business_date"),
    created_at: isoTimestamp(raw?.created_at, "created_at"),
    closed_at: isoTimestamp(raw?.closed_at, "closed_at", { required: false }),
    kot_count: integer(raw?.kot_count, 0),
    discount: money(raw?.discount),
    discount_type: oneOf(raw?.discount_type, ["flat", "percent"], "discount_type", { fallback: "flat" }),
    payment_mode: paymentMode,
    subtotal: money(raw?.subtotal),
    cgst: money(raw?.cgst),
    sgst: money(raw?.sgst),
    total: money(raw?.total),
    customer_name: optionalText(raw?.customer_name, { max: 200 }),
    company_name: optionalText(raw?.company_name, { max: 200 }),
    customer_phone: optionalText(raw?.customer_phone, { max: 40 }),
    customer_gst: optionalText(raw?.customer_gst, { max: 20 }),
    items: normalizedItems,
    updated_at: isoTimestamp(raw?.updated_at, "updated_at")
  };
}

export function validateBatch(list, field) {
  if (!Array.isArray(list)) throw badRequest(`${field} must be an array.`);
  if (list.length === 0) throw badRequest(`${field} must contain at least one record.`);
  if (list.length > MAX_BATCH) {
    throw new ApiError(413, "batch_too_large", `At most ${MAX_BATCH} records per request; received ${list.length}.`);
  }
  return list;
}

/** Only a billed order is money. Open and cancelled orders are not revenue. */
export function isRevenueOrder(order = {}) {
  return String(order.status || "").toLowerCase() === "billed";
}

/* ---------------- counters ---------------- */

/**
 * Rebuilds the app's numbering so a reinstalled device carries on instead of
 * restarting at 1 and colliding with bills that already exist.
 *
 * All three counters are scoped to one business date, the date passed in,
 * because the app's order numbering resets daily. If takeaway and delivery
 * numbering is meant to run continuously rather than per day, this is the
 * one place that changes.
 */
export function computeCounters(orders = [], forDate) {
  const date = businessDate(forDate, "business_date");
  const sameDay = orders.filter(order => order.business_date === date);

  const maxNumberIn = (list, pattern) => list.reduce((highest, order) => {
    const match = pattern.exec(String(order.table_name || ""));
    const value = match ? Number(match[1]) : 0;
    return Number.isFinite(value) && value > highest ? value : highest;
  }, 0);

  return {
    order_number_date: date,
    order_number_counter: sameDay.reduce((highest, order) => Math.max(highest, integer(order.order_number, 0)), 0),
    takeaway_counter: maxNumberIn(sameDay.filter(o => o.table_type === "takeaway"), /(\d+)\s*$/),
    delivery_counter: maxNumberIn(sameDay.filter(o => o.table_type === "delivery"), /(\d+)\s*$/)
  };
}

/* ---------------- pagination ---------------- */

/**
 * Orders sort by created_at, with uuid breaking ties so the order is total
 * and a cursor can never skip or repeat a record when two orders share a
 * timestamp — which they do, on a busy till.
 */
export function compareOrders(a, b) {
  const left = String(a.created_at || "");
  const right = String(b.created_at || "");
  if (left !== right) return left < right ? -1 : 1;
  const leftId = String(a.uuid || "");
  const rightId = String(b.uuid || "");
  // Equal must return 0. Returning 1 here would make a record compare as
  // greater than itself, so the cursor pointing at it would hand it back
  // on the next page — every page would repeat its own last row.
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

export function encodeCursor(order) {
  return Buffer.from(`${order.created_at}|${order.uuid}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  const decoded = Buffer.from(String(cursor), "base64url").toString("utf8");
  const separator = decoded.lastIndexOf("|");
  if (separator < 1) throw badRequest("cursor is not valid.");
  return { created_at: decoded.slice(0, separator), uuid: decoded.slice(separator + 1) };
}

export function pageOrders(orders, { from = null, to = null, cursor = null, limit = MAX_BATCH } = {}) {
  const size = Math.max(1, Math.min(MAX_BATCH, integer(limit, MAX_BATCH) || MAX_BATCH));
  let rows = [...orders];
  if (from) rows = rows.filter(order => String(order.business_date || "") >= from);
  if (to) rows = rows.filter(order => String(order.business_date || "") <= to);
  rows.sort(compareOrders);

  const after = decodeCursor(cursor);
  if (after) rows = rows.filter(order => compareOrders(order, after) > 0);

  const page = rows.slice(0, size);
  const next = rows.length > size && page.length ? encodeCursor(page[page.length - 1]) : null;
  return { orders: page, next_cursor: next };
}

export function ordersAvailable(orders = []) {
  if (!orders.length) return { count: 0, first_date: null, last_date: null };
  const dates = orders.map(order => String(order.business_date || "")).filter(Boolean).sort();
  return { count: orders.length, first_date: dates[0] || null, last_date: dates[dates.length - 1] || null };
}


/* ---------------- dashboard view ---------------- */

// Re-exported, not reimplemented. The browser cannot import from backend/,
// so the mapping lives in public/js/ and the server imports it from there —
// the same arrangement this backend already uses for business-types.js and
// subscription-core.js. One implementation means what the API stores and
// what the dashboard renders cannot drift apart.
export { toDashboardOrder } from "../public/js/offline-pos-view.js";
