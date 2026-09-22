import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiError, MAX_BATCH, generateApiKey, hashApiKey, maskApiKey, bearerToken,
  money, integer, isUuid, isoTimestamp, businessDate,
  normalizeSettings, normalizeMenuSnapshot, normalizeTablesSnapshot, normalizeOrder,
  legacyMenuView, validateBatch, isRevenueOrder, computeCounters,
  encodeCursor, decodeCursor, pageOrders, ordersAvailable, compareOrders
} from "../backend/offline-pos-core.js";

const U = n => `0000000${n}-0000-4000-8000-000000000000`.slice(-36);
const uuidA = "11111111-1111-4111-8111-111111111111";
const uuidB = "22222222-2222-4222-8222-222222222222";
const uuidC = "33333333-3333-4333-8333-333333333333";

const throwsWith = (fn, status) => {
  try { fn(); assert.fail("expected a throw"); }
  catch (error) { assert.ok(error instanceof ApiError, "must be an ApiError"); assert.equal(error.status, status); }
};

/* ================= api keys ================= */

test("a generated key is prefixed and long enough to be unguessable", () => {
  const key = generateApiKey();
  assert.match(key, /^s2p_pos_[0-9a-f]{48}$/);
});

test("two generated keys differ", () => {
  assert.notEqual(generateApiKey(), generateApiKey());
});

test("the stored form is a hash, never the key", () => {
  const key = generateApiKey();
  const hash = hashApiKey(key);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hash.includes(key), "the key must not be recoverable from what is stored");
});

test("hashing is stable, so a key keeps working across restarts", () => {
  assert.equal(hashApiKey("s2p_pos_abc"), hashApiKey("s2p_pos_abc"));
  assert.notEqual(hashApiKey("s2p_pos_abc"), hashApiKey("s2p_pos_abd"));
});

test("the masked form shows enough to tell keys apart and no more", () => {
  const masked = maskApiKey("s2p_pos_0123456789abcdef0123456789abcdef");
  assert.ok(masked.startsWith("s2p_pos_0123"));
  assert.ok(masked.endsWith("cdef"));
  assert.ok(masked.length < 30, "it must not be a usable key");
});

test("the bearer token is read case-insensitively and trimmed", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer  abc123  "), "abc123");
  assert.equal(bearerToken("Basic abc123"), "");
  assert.equal(bearerToken(""), "");
  assert.equal(bearerToken(undefined), "");
});

/* ================= primitives ================= */

test("money is rupees to two decimals and never NaN", () => {
  assert.equal(money("2520.005"), 2520.01);
  assert.equal(money(2520), 2520);
  assert.equal(money("abc"), 0);
  assert.equal(money(null), 0);
  assert.equal(money(undefined), 0);
});

test("a local timestamp with no zone is kept exactly as sent", () => {
  assert.equal(isoTimestamp("2026-09-22T13:05:11.123", "created_at"), "2026-09-22T13:05:11.123");
  assert.equal(isoTimestamp("2026-09-22T13:05:11", "created_at"), "2026-09-22T13:05:11");
});

test("a malformed timestamp is rejected rather than silently coerced", () => {
  throwsWith(() => isoTimestamp("yesterday", "created_at"), 400);
  throwsWith(() => isoTimestamp("2026-13-99T99:99:99", "created_at"), 400);
});

test("a business date must be YYYY-MM-DD", () => {
  assert.equal(businessDate("2026-09-22", "business_date"), "2026-09-22");
  throwsWith(() => businessDate("22-09-2026", "business_date"), 400);
});

test("only a real UUID is accepted as an identity", () => {
  assert.equal(isUuid(uuidA), true);
  assert.equal(isUuid("123"), false);
  assert.equal(isUuid(""), false);
});

/* ================= settings ================= */

const settingsBody = {
  restaurant_name: "Old Monk Cafe", address: "Darbhanga", phone: "+919876543210",
  gstin: "10ABCDE1234F1Z5", fssai_number: "12345", upi_id: "x@ybl",
  bill_footer_message: "Thank you", cgst_percent: 2.5, sgst_percent: 2.5,
  logo_base64: null, print_settings: { paper: "58mm" }, updated_at: "2026-09-22T13:05:11.123"
};

test("settings normalise to the documented shape", () => {
  const result = normalizeSettings(settingsBody);
  assert.equal(result.restaurant_name, "Old Monk Cafe");
  assert.equal(result.cgst_percent, 2.5);
  assert.deepEqual(result.print_settings, { paper: "58mm" });
});

test("print_settings is stored free-form, exactly as sent", () => {
  const weird = { a: [1, 2, { b: "c" }], nested: { deep: { deeper: true } } };
  assert.deepEqual(normalizeSettings({ ...settingsBody, print_settings: weird }).print_settings, weird);
});

test("print_settings must be an object, not an array or a string", () => {
  throwsWith(() => normalizeSettings({ ...settingsBody, print_settings: [1, 2] }), 400);
  throwsWith(() => normalizeSettings({ ...settingsBody, print_settings: "x" }), 400);
});

test("a logo over 500 KB is refused with 413, measured decoded", () => {
  const tooBig = "A".repeat(Math.ceil(500 * 1024 * 4 / 3) + 100);
  throwsWith(() => normalizeSettings({ ...settingsBody, logo_base64: tooBig }), 413);
});

test("a logo just under the limit is accepted", () => {
  const ok = "A".repeat(Math.floor(400 * 1024 * 4 / 3));
  assert.ok(normalizeSettings({ ...settingsBody, logo_base64: ok }).logo_base64);
});

test("settings without updated_at are rejected", () => {
  const { updated_at, ...rest } = settingsBody;
  throwsWith(() => normalizeSettings(rest), 400);
});

/* ================= menu ================= */

const menuBody = {
  categories: [{ uuid: uuidA, name: "Starters", sort_order: 0 }],
  menu_items: [{ uuid: uuidB, category_uuid: uuidA, name: "Paneer Tikka", price: 220, half_price: 120, veg: true, active: true, favorite: false }],
  updated_at: "2026-09-22T13:05:11.123"
};

test("a menu snapshot normalises categories and items", () => {
  const result = normalizeMenuSnapshot(menuBody);
  assert.equal(result.categories[0].name, "Starters");
  assert.equal(result.menu_items[0].price, 220);
  assert.equal(result.menu_items[0].half_price, 120);
  assert.equal(result.menu_items[0].veg, true);
});

test("half_price may be null", () => {
  const body = { ...menuBody, menu_items: [{ ...menuBody.menu_items[0], half_price: null }] };
  assert.equal(normalizeMenuSnapshot(body).menu_items[0].half_price, null);
});

test("an item pointing at a category not in the snapshot is rejected", () => {
  const body = { ...menuBody, menu_items: [{ ...menuBody.menu_items[0], category_uuid: uuidC }] };
  throwsWith(() => normalizeMenuSnapshot(body), 400);
});

test("a duplicate uuid inside one snapshot is rejected", () => {
  const body = { ...menuBody, categories: [menuBody.categories[0], menuBody.categories[0]] };
  throwsWith(() => normalizeMenuSnapshot(body), 400);
});

test("an item with no category is allowed", () => {
  const body = { ...menuBody, menu_items: [{ ...menuBody.menu_items[0], category_uuid: null }] };
  assert.equal(normalizeMenuSnapshot(body).menu_items[0].category_uuid, null);
});

test("the legacy menu view keeps the old shape for older app builds", () => {
  const legacy = legacyMenuView(normalizeMenuSnapshot(menuBody));
  assert.deepEqual(legacy.categories, [{ id: uuidA, name: "Starters" }]);
  assert.equal(legacy.menu_items[0].name, "Paneer Tikka");
  assert.equal(legacy.menu_items[0].price, 220);
  assert.equal(legacy.menu_items[0].veg, true);
});

test("the legacy view hides inactive items and survives an empty menu", () => {
  const body = { ...menuBody, menu_items: [{ ...menuBody.menu_items[0], active: false }] };
  assert.equal(legacyMenuView(normalizeMenuSnapshot(body)).menu_items.length, 0);
  assert.deepEqual(legacyMenuView(null), { categories: [], menu_items: [] });
});

/* ================= tables ================= */

test("tables normalise, defaulting an unknown type to table", () => {
  const result = normalizeTablesSnapshot({
    tables: [{ uuid: uuidA, name: "Table 1", type: "cabin", capacity: 4, sort_order: 0 },
             { uuid: uuidB, name: "Table 2", type: "spaceship", capacity: 2, sort_order: 1 }],
    updated_at: "2026-09-22T13:05:11.123"
  });
  assert.equal(result.tables[0].type, "cabin");
  assert.equal(result.tables[1].type, "table");
});

/* ================= orders ================= */

const orderBody = {
  uuid: uuidA, local_id: 123, table_name: "Table 2", table_type: "table", table_uuid: uuidB,
  status: "billed", order_number: 14, business_date: "2026-09-22",
  created_at: "2026-09-22T13:05:11.123", closed_at: "2026-09-22T13:45:00.000",
  kot_count: 2, discount: 50, discount_type: "flat", payment_mode: "Cash",
  subtotal: 2520, cgst: 63, sgst: 63, total: 2646,
  customer_name: "A Person", company_name: null, customer_phone: "+919876543210", customer_gst: null,
  items: [{ uuid: uuidC, menu_item_uuid: null, name: "Butter Chicken (Half)", price: 320, qty: 3, kot_batch: 1 }],
  updated_at: "2026-09-22T13:45:00.000"
};

test("an order normalises to the documented shape", () => {
  const order = normalizeOrder(orderBody);
  assert.equal(order.uuid, uuidA);
  assert.equal(order.total, 2646);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].qty, 3);
});

test("the app's local_id is kept for reference but is never the identity", () => {
  const order = normalizeOrder(orderBody);
  assert.equal(order.local_id, 123);
  assert.equal(order.uuid, uuidA, "the uuid is what identifies the record");
});

test("an order with no uuid is rejected — there would be no idempotency key", () => {
  const { uuid, ...rest } = orderBody;
  throwsWith(() => normalizeOrder(rest), 400);
});

test("an unknown status is rejected rather than guessed", () => {
  throwsWith(() => normalizeOrder({ ...orderBody, status: "paid" }), 400);
});

test("closed_at may be null for a still-open order", () => {
  const order = normalizeOrder({ ...orderBody, status: "open", closed_at: null });
  assert.equal(order.closed_at, null);
  assert.equal(order.status, "open");
});

test("payment_mode may be null, and a known mode keeps its casing", () => {
  assert.equal(normalizeOrder({ ...orderBody, payment_mode: null }).payment_mode, null);
  assert.equal(normalizeOrder({ ...orderBody, payment_mode: "upi" }).payment_mode, "UPI");
});

test("takeaway and delivery are valid table types", () => {
  assert.equal(normalizeOrder({ ...orderBody, table_type: "takeaway" }).table_type, "takeaway");
  assert.equal(normalizeOrder({ ...orderBody, table_type: "delivery" }).table_type, "delivery");
});

test("a duplicate item uuid within one order is rejected", () => {
  const body = { ...orderBody, items: [orderBody.items[0], orderBody.items[0]] };
  throwsWith(() => normalizeOrder(body), 400);
});

test("only a billed order counts as revenue", () => {
  assert.equal(isRevenueOrder({ status: "billed" }), true);
  assert.equal(isRevenueOrder({ status: "open" }), false);
  assert.equal(isRevenueOrder({ status: "cancelled" }), false);
});

/* ================= batches ================= */

test("a batch over 500 records is refused with 413", () => {
  throwsWith(() => validateBatch(new Array(MAX_BATCH + 1).fill({}), "orders"), 413);
});

test("exactly 500 records is allowed", () => {
  assert.equal(validateBatch(new Array(MAX_BATCH).fill({}), "orders").length, MAX_BATCH);
});

test("an empty or non-array batch is a validation error", () => {
  throwsWith(() => validateBatch([], "orders"), 400);
  throwsWith(() => validateBatch("nope", "orders"), 400);
  throwsWith(() => validateBatch(undefined, "orders"), 400);
});

/* ================= counters ================= */

const counterOrders = [
  { business_date: "2026-09-22", order_number: 14, table_type: "table", table_name: "Table 2" },
  { business_date: "2026-09-22", order_number: 9, table_type: "takeaway", table_name: "Takeaway 37" },
  { business_date: "2026-09-22", order_number: 11, table_type: "delivery", table_name: "Delivery 12" },
  { business_date: "2026-09-21", order_number: 99, table_type: "table", table_name: "Table 1" }
];

test("counters continue from the highest number already used today", () => {
  const counters = computeCounters(counterOrders, "2026-09-22");
  assert.equal(counters.order_number_counter, 14);
  assert.equal(counters.takeaway_counter, 37);
  assert.equal(counters.delivery_counter, 12);
  assert.equal(counters.order_number_date, "2026-09-22");
});

test("yesterday's higher number does not leak into today's counter", () => {
  assert.equal(computeCounters(counterOrders, "2026-09-22").order_number_counter, 14,
    "yesterday's 99 must not become today's starting point");
});

test("a day with no orders starts at zero, not at one", () => {
  const counters = computeCounters(counterOrders, "2026-09-23");
  assert.equal(counters.order_number_counter, 0);
  assert.equal(counters.takeaway_counter, 0);
});

test("a Takeaway # style name is parsed for its number", () => {
  const counters = computeCounters(
    [{ business_date: "2026-09-22", order_number: 1, table_type: "takeaway", table_name: "Takeaway #37" }],
    "2026-09-22"
  );
  assert.equal(counters.takeaway_counter, 37);
});

test("an unnumbered takeaway name does not break the counter", () => {
  const counters = computeCounters(
    [{ business_date: "2026-09-22", order_number: 1, table_type: "takeaway", table_name: "Takeaway" }],
    "2026-09-22"
  );
  assert.equal(counters.takeaway_counter, 0);
});

/* ================= pagination ================= */

const makeOrder = (n, date = "2026-09-22") => ({
  uuid: U(n), created_at: `2026-09-22T10:${String(n).padStart(2, "0")}:00.000`, business_date: date
});

test("a page is sorted by created_at and capped at the limit", () => {
  const page = pageOrders([makeOrder(3), makeOrder(1), makeOrder(2)], { limit: 2 });
  assert.equal(page.orders.length, 2);
  assert.equal(page.orders[0].uuid, U(1));
  assert.equal(page.orders[1].uuid, U(2));
  assert.ok(page.next_cursor, "there is more to fetch");
});

test("the cursor resumes exactly after the last record, with no gap or repeat", () => {
  const all = [makeOrder(1), makeOrder(2), makeOrder(3), makeOrder(4)];
  const first = pageOrders(all, { limit: 2 });
  const second = pageOrders(all, { limit: 2, cursor: first.next_cursor });
  assert.deepEqual(second.orders.map(o => o.uuid), [U(3), U(4)]);
  assert.equal(second.next_cursor, null, "the last page has no cursor");
});

test("walking every page returns each order exactly once", () => {
  const all = Array.from({ length: 7 }, (_, i) => makeOrder(i + 1));
  const seen = [];
  let cursor = null;
  do {
    const page = pageOrders(all, { limit: 2, cursor });
    seen.push(...page.orders.map(o => o.uuid));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7, "no duplicates");
});

test("orders sharing a timestamp still paginate without loss", () => {
  const same = [
    { uuid: U(1), created_at: "2026-09-22T10:00:00.000", business_date: "2026-09-22" },
    { uuid: U(2), created_at: "2026-09-22T10:00:00.000", business_date: "2026-09-22" },
    { uuid: U(3), created_at: "2026-09-22T10:00:00.000", business_date: "2026-09-22" }
  ];
  const first = pageOrders(same, { limit: 2 });
  const second = pageOrders(same, { limit: 2, cursor: first.next_cursor });
  const seen = [...first.orders, ...second.orders].map(o => o.uuid);
  assert.equal(new Set(seen).size, 3, "a tie on created_at must not drop or repeat a record");
});

test("the date filter is inclusive at both ends", () => {
  const all = [makeOrder(1, "2026-09-20"), makeOrder(2, "2026-09-21"), makeOrder(3, "2026-09-22")];
  const page = pageOrders(all, { from: "2026-09-21", to: "2026-09-22" });
  assert.deepEqual(page.orders.map(o => o.business_date), ["2026-09-21", "2026-09-22"]);
});

test("a cursor round-trips", () => {
  const order = { created_at: "2026-09-22T10:00:00.000", uuid: uuidA };
  assert.deepEqual(decodeCursor(encodeCursor(order)), { created_at: order.created_at, uuid: order.uuid });
});

test("a corrupt cursor is a validation error, not a crash", () => {
  throwsWith(() => decodeCursor("!!!not-base64!!!"), 400);
});

test("the limit is clamped to the batch maximum", () => {
  const all = Array.from({ length: 5 }, (_, i) => makeOrder(i + 1));
  assert.equal(pageOrders(all, { limit: 99999 }).orders.length, 5);
  assert.equal(pageOrders(all, { limit: 0 }).orders.length, 5, "a zero limit falls back rather than returning nothing");
});

/* ================= availability ================= */

test("orders_available reports the count and the date span", () => {
  const info = ordersAvailable([makeOrder(1, "2026-09-20"), makeOrder(2, "2026-09-22")]);
  assert.equal(info.count, 2);
  assert.equal(info.first_date, "2026-09-20");
  assert.equal(info.last_date, "2026-09-22");
});

test("an empty history reports zero, not null dates that look like data", () => {
  assert.deepEqual(ordersAvailable([]), { count: 0, first_date: null, last_date: null });
});

/* ================= dashboard view ================= */

import { toDashboardOrder } from "../backend/offline-pos-core.js";

const offlineOrder = {
  uuid: uuidA, status: "billed", table_name: "Table 2", table_type: "table",
  subtotal: 2520, cgst: 63, sgst: 63, total: 2646, discount: 50,
  order_number: 14, business_date: "2026-09-22", created_at: "2026-09-22T13:05:11.123",
  payment_mode: "Cash", customer_name: "A Person", customer_phone: "+919876543210",
  items: [{ uuid: uuidC, name: "Butter Chicken", price: 320, qty: 3 }],
  device_id: "device-1"
};

test("a billed offline order counts as revenue in the dashboard's terms", () => {
  const mapped = toDashboardOrder(offlineOrder);
  assert.equal(mapped.paymentStatus, "paid", "the dashboard counts revenue on paymentStatus paid");
  assert.equal(mapped.grandTotal, 2646);
  assert.equal(mapped.paidAmount, 2646);
});

test("an OPEN offline order is never counted as revenue", () => {
  const mapped = toDashboardOrder({ ...offlineOrder, status: "open" });
  assert.notEqual(mapped.paymentStatus, "paid", "a running table is not money");
  assert.equal(mapped.paidAmount, 0);
  assert.equal(mapped.billClosed, false);
});

test("a CANCELLED offline order is never counted as revenue", () => {
  const mapped = toDashboardOrder({ ...offlineOrder, status: "cancelled" });
  assert.notEqual(mapped.paymentStatus, "paid");
  assert.equal(mapped.status, "cancelled");
  assert.equal(mapped.paidAmount, 0);
});

test("the order is marked as Offline POS with its device", () => {
  const mapped = toDashboardOrder(offlineOrder, { deviceName: "Counter till" });
  assert.equal(mapped.source, "offline_pos");
  assert.equal(mapped.sourceLabel, "Offline POS");
  assert.equal(mapped.deviceName, "Counter till");
  assert.equal(mapped.isOfflinePosOrder, true);
});

test("the device id is the fallback name when the device has no label", () => {
  assert.equal(toDashboardOrder(offlineOrder).deviceName, "device-1");
});

test("tax is the sum of CGST and SGST", () => {
  assert.equal(toDashboardOrder(offlineOrder).tax, 126);
});

test("takeaway and delivery map to the dashboard's own order types", () => {
  assert.equal(toDashboardOrder({ ...offlineOrder, table_type: "takeaway" }).orderType, "takeaway");
  assert.equal(toDashboardOrder({ ...offlineOrder, table_type: "delivery" }).orderType, "delivery");
  assert.equal(toDashboardOrder({ ...offlineOrder, table_type: "cabin" }).orderType, "dine_in");
});

test("items carry both qty spellings the dashboard reads", () => {
  const item = toDashboardOrder(offlineOrder).items[0];
  assert.equal(item.qty, 3);
  assert.equal(item.quantity, 3);
  assert.equal(item.total, 960);
});

test("the uuid becomes the order id, never the app's local id", () => {
  const mapped = toDashboardOrder({ ...offlineOrder, local_id: 99 });
  assert.equal(mapped.id, uuidA);
  assert.equal(mapped.orderId, uuidA);
});
