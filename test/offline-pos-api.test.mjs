import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { hashApiKey } from "../backend/offline-pos-core.js";

// Boot the REAL backend with firebase-admin and razorpay stubbed.
process.env.PORT = String(4900 + Math.floor(Math.random() * 300));
process.env.RAZORPAY_KEY_ID = "rzp_test_stub";
process.env.RAZORPAY_KEY_SECRET = "secret_stub";
process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_stub";
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "stub", client_email: "a@b.c", private_key: "k" });
process.env.FIREBASE_STORAGE_BUCKET = "stub.appspot.com";

register("./stubs/backend-loader.mjs", pathToFileURL(`${import.meta.dirname}/`));

const admin = await import("./stubs/firebase-admin-stub.mjs");
await import("../backend/server.js");
await new Promise(resolve => setTimeout(resolve, 300));

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const KEY_A = "s2p_pos_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "s2p_pos_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REVOKED = "s2p_pos_cccccccccccccccccccccccccccccccccccccccccccccccc";
const DEVICE = "11111111-2222-4333-8444-555555555555";

const uuid = n => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function reset() {
  admin.resetStore();
  admin.seed("restaurants/RST006", { restaurantName: "Old Monk Cafe", status: "active" });
  admin.seed("restaurants/RST007", { restaurantName: "Other Cafe", status: "active" });
  admin.seed(`offlinePosKeys/${hashApiKey(KEY_A)}`, { restaurant_code: "RST006", revoked_at: null, label: "Till 1" });
  admin.seed(`offlinePosKeys/${hashApiKey(KEY_B)}`, { restaurant_code: "RST007", revoked_at: null, label: "Till 1" });
  admin.seed(`offlinePosKeys/${hashApiKey(REVOKED)}`, { restaurant_code: "RST006", revoked_at: "2026-09-01T00:00:00.000Z" });
}

const call = (method, path, { key = KEY_A, body = null, device = DEVICE } = {}) =>
  fetch(`${BASE}/api/v1/restaurants${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(device ? { "X-Device-Id": device, "X-App-Version": "1.4.2" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const ts = "2026-09-22T13:05:11.123";
const menuSnapshot = {
  categories: [{ uuid: uuid(1), name: "Starters", sort_order: 0 }],
  menu_items: [
    { uuid: uuid(2), category_uuid: uuid(1), name: "Paneer Tikka", price: 220, half_price: 120, veg: true, active: true, favorite: false },
    { uuid: uuid(3), category_uuid: uuid(1), name: "Fish Fry", price: 300, half_price: null, veg: false, active: true, favorite: false }
  ],
  updated_at: ts
};
const order = (n, over = {}) => ({
  uuid: uuid(100 + n), local_id: n, table_name: "Table 2", table_type: "table", table_uuid: null,
  status: "billed", order_number: n, business_date: "2026-09-22",
  created_at: `2026-09-22T10:${String(n).padStart(2, "0")}:00.000`, closed_at: null,
  kot_count: 1, discount: 0, discount_type: "flat", payment_mode: "Cash",
  subtotal: 100, cgst: 2.5, sgst: 2.5, total: 105,
  customer_name: null, company_name: null, customer_phone: null, customer_gst: null,
  items: [{ uuid: uuid(200 + n), menu_item_uuid: null, name: "Item", price: 100, qty: 1, kot_batch: 1 }],
  updated_at: ts, ...over
});

/* ================= auth ================= */

test("a request with no API key is 401", async () => {
  reset();
  const res = await call("GET", "/RST006/ping", { key: null });
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, "unauthorized");
});

test("an unknown API key is 401", async () => {
  reset();
  const res = await call("GET", "/RST006/ping", { key: "s2p_pos_nope" });
  assert.equal(res.status, 401);
});

test("a revoked API key is 401, not 403", async () => {
  reset();
  const res = await call("GET", "/RST006/ping", { key: REVOKED });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "key_revoked");
});

test("a valid key used against ANOTHER restaurant is 403", async () => {
  reset();
  const res = await call("GET", "/RST007/ping", { key: KEY_A });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, "forbidden");
});

test("each restaurant's own key works", async () => {
  reset();
  assert.equal((await call("GET", "/RST006/ping", { key: KEY_A })).status, 200);
  assert.equal((await call("GET", "/RST007/ping", { key: KEY_B })).status, 200);
});

test("one restaurant cannot read another's orders", async () => {
  reset();
  await call("POST", "/RST006/orders/batch", { body: { orders: [order(1)] } });
  const cross = await call("GET", "/RST007/orders", { key: KEY_A });
  assert.equal(cross.status, 403, "the key must not reach across restaurants");
  const own = await call("GET", "/RST007/orders", { key: KEY_B });
  assert.equal(own.body.orders.length, 0, "and the other restaurant sees none of it");
});

/* ================= ping ================= */

test("ping returns the restaurant name and a UTC server time", async () => {
  reset();
  const res = await call("GET", "/RST006/ping");
  assert.equal(res.status, 200);
  assert.equal(res.body.restaurant_name, "Old Monk Cafe");
  assert.match(res.body.server_time, /Z$/, "server_time must be UTC");
});

test("device info is recorded for the dashboard", async () => {
  reset();
  await call("GET", "/RST006/ping");
  const device = admin.store.get(`restaurants/RST006/offlinePosDevices/${DEVICE}`);
  assert.ok(device, "the device must be recorded");
  assert.equal(device.app_version, "1.4.2");
  assert.ok(device.last_seen_at);
});

/* ================= settings ================= */

const settings = {
  restaurant_name: "Old Monk Cafe", address: "Darbhanga", phone: "+919876543210",
  gstin: "10ABCDE1234F1Z5", fssai_number: "12345", upi_id: "x@ybl",
  bill_footer_message: "Thanks", cgst_percent: 2.5, sgst_percent: 2.5,
  logo_base64: null, print_settings: { paper: "58mm" }, updated_at: ts
};

test("settings round-trip, and 404 before anything is uploaded", async () => {
  reset();
  assert.equal((await call("GET", "/RST006/backup/settings")).status, 404);
  assert.equal((await call("PUT", "/RST006/backup/settings", { body: settings })).status, 200);
  const res = await call("GET", "/RST006/backup/settings");
  assert.equal(res.status, 200);
  assert.equal(res.body.restaurant_name, "Old Monk Cafe");
  assert.deepEqual(res.body.print_settings, { paper: "58mm" });
});

test("a settings PUT fully replaces, it does not merge", async () => {
  reset();
  await call("PUT", "/RST006/backup/settings", { body: settings });
  await call("PUT", "/RST006/backup/settings", { body: { ...settings, gstin: "", address: "" } });
  const res = await call("GET", "/RST006/backup/settings");
  assert.equal(res.body.gstin, "", "a cleared field must come back cleared");
  assert.equal(res.body.address, "");
});

test("an invalid settings body is 400 with a readable message", async () => {
  reset();
  const res = await call("PUT", "/RST006/backup/settings", { body: { ...settings, updated_at: "whenever" } });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.match(res.body.message, /updated_at/);
});

/* ================= menu ================= */

test("a menu snapshot round-trips", async () => {
  reset();
  assert.equal((await call("PUT", "/RST006/backup/menu", { body: menuSnapshot })).status, 200);
  const res = await call("GET", "/RST006/backup/menu");
  assert.equal(res.body.menu_items.length, 2);
  assert.equal(res.body.categories[0].name, "Starters");
});

test("a menu snapshot DELETES items missing from it", async () => {
  reset();
  await call("PUT", "/RST006/backup/menu", { body: menuSnapshot });
  const smaller = { ...menuSnapshot, menu_items: [menuSnapshot.menu_items[0]] };
  await call("PUT", "/RST006/backup/menu", { body: smaller });
  const res = await call("GET", "/RST006/backup/menu");
  assert.equal(res.body.menu_items.length, 1, "the removed item must be gone");
  assert.equal(res.body.menu_items[0].name, "Paneer Tikka");
});

test("the legacy GET /menu shape still works for older app builds", async () => {
  reset();
  await call("PUT", "/RST006/backup/menu", { body: menuSnapshot });
  const res = await call("GET", "/RST006/menu");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.categories));
  assert.ok(Array.isArray(res.body.menu_items));
  assert.equal(res.body.menu_items[0].name, "Paneer Tikka");
  assert.equal(res.body.menu_items[0].veg, true);
});

/* ================= tables ================= */

test("a tables snapshot round-trips and replaces", async () => {
  reset();
  const body = { tables: [{ uuid: uuid(9), name: "Table 1", type: "table", capacity: 4, sort_order: 0 }], updated_at: ts };
  await call("PUT", "/RST006/backup/tables", { body });
  assert.equal((await call("GET", "/RST006/backup/tables")).body.tables.length, 1);
  await call("PUT", "/RST006/backup/tables", { body: { tables: [], updated_at: ts } });
  assert.equal((await call("GET", "/RST006/backup/tables")).body.tables.length, 0);
});

/* ================= orders ================= */

test("re-uploading the same uuid produces ONE record, not two", async () => {
  reset();
  await call("POST", "/RST006/orders/batch", { body: { orders: [order(1)] } });
  await call("POST", "/RST006/orders/batch", { body: { orders: [order(1)] } });
  const res = await call("GET", "/RST006/orders");
  assert.equal(res.body.orders.length, 1, "the uuid is the idempotency key");
});

test("editing an order REPLACES its items rather than merging them", async () => {
  reset();
  const original = order(1);
  await call("POST", "/RST006/orders/batch", { body: { orders: [original] } });

  const edited = { ...original, total: 55, items: [
    { uuid: uuid(999), menu_item_uuid: null, name: "Replaced", price: 55, qty: 1, kot_batch: 1 }
  ] };
  await call("POST", "/RST006/orders/batch", { body: { orders: [edited] } });

  const res = await call("GET", "/RST006/orders");
  assert.equal(res.body.orders.length, 1);
  assert.equal(res.body.orders[0].items.length, 1, "the removed line must not survive");
  assert.equal(res.body.orders[0].items[0].name, "Replaced");
  assert.equal(res.body.orders[0].total, 55);
});

test("an upsert REPLACES the stored record, leaving no stale field behind", async () => {
  reset();
  await call("POST", "/RST006/orders/batch", { body: { orders: [order(1)] } });

  // A field from an older app version that the current payload no longer
  // sends. A merge would keep it forever; a replace must drop it.
  const path = `restaurants/RST006/offlinePosOrders/${uuid(101)}`;
  admin.store.set(path, { ...admin.store.get(path), legacy_field: "should not survive" });

  await call("POST", "/RST006/orders/batch", { body: { orders: [order(1)] } });
  assert.equal(admin.store.get(path).legacy_field, undefined,
    "re-sending an order must replace it entirely, not merge into it");
});

test("a batch reports per-record results so partial failures can be retried", async () => {
  reset();
  const bad = { ...order(2), status: "paid" };
  const res = await call("POST", "/RST006/orders/batch", { body: { orders: [order(1), bad, order(3)] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.saved, 2);
  assert.equal(res.body.failed, 1);
  assert.equal(res.body.results.filter(r => r.status === "error").length, 1);
  assert.equal((await call("GET", "/RST006/orders")).body.orders.length, 2, "the good ones still saved");
});

test("a batch over 500 orders is 413", async () => {
  reset();
  const orders = Array.from({ length: 501 }, (_, i) => order(i + 1));
  const res = await call("POST", "/RST006/orders/batch", { body: { orders } });
  assert.equal(res.status, 413);
  assert.equal(res.body.error, "batch_too_large");
});

test("an empty orders array is 400", async () => {
  reset();
  assert.equal((await call("POST", "/RST006/orders/batch", { body: { orders: [] } })).status, 400);
});

test("open orders come back, so running tables survive a reinstall", async () => {
  reset();
  await call("POST", "/RST006/orders/batch", { body: { orders: [order(1, { status: "open", closed_at: null })] } });
  const res = await call("GET", "/RST006/orders");
  assert.equal(res.body.orders[0].status, "open");
});

test("deleting an order removes it; deleting an unknown one is 404", async () => {
  reset();
  await call("POST", "/RST006/orders/batch", { body: { orders: [order(1)] } });
  assert.equal((await call("DELETE", `/RST006/orders/${uuid(101)}`)).status, 200);
  assert.equal((await call("GET", "/RST006/orders")).body.orders.length, 0);
  assert.equal((await call("DELETE", `/RST006/orders/${uuid(101)}`)).status, 404);
});

/* ================= pagination ================= */

test("orders paginate by cursor, returning every record exactly once", async () => {
  reset();
  const orders = Array.from({ length: 7 }, (_, i) => order(i + 1));
  await call("POST", "/RST006/orders/batch", { body: { orders } });

  const seen = [];
  let cursor = null;
  let guard = 0;
  do {
    const path = `/RST006/orders?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await call("GET", path);
    assert.equal(page.status, 200);
    seen.push(...page.body.orders.map(o => o.uuid));
    cursor = page.body.next_cursor;
  } while (cursor && ++guard < 10);

  assert.equal(seen.length, 7, "every order returned");
  assert.equal(new Set(seen).size, 7, "and none twice");
});

test("the date range filter is applied", async () => {
  reset();
  await call("POST", "/RST006/orders/batch", { body: { orders: [
    order(1, { business_date: "2026-09-20" }),
    order(2, { business_date: "2026-09-22" })
  ] } });
  const res = await call("GET", "/RST006/orders?from=2026-09-21&to=2026-09-23");
  assert.equal(res.body.orders.length, 1);
  assert.equal(res.body.orders[0].business_date, "2026-09-22");
});

/* ================= restore ================= */

test("restore returns everything except orders, plus counters", async () => {
  reset();
  await call("PUT", "/RST006/backup/settings", { body: settings });
  await call("PUT", "/RST006/backup/menu", { body: menuSnapshot });
  await call("PUT", "/RST006/backup/tables", { body: { tables: [], updated_at: ts } });
  await call("POST", "/RST006/orders/batch", { body: { orders: [
    order(14, { business_date: "2026-09-22", order_number: 14 }),
    order(9, { business_date: "2026-09-22", order_number: 9, table_type: "takeaway", table_name: "Takeaway 37" })
  ] } });

  const res = await call("GET", "/RST006/restore?business_date=2026-09-22");
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.restaurant_name, "Old Monk Cafe");
  assert.equal(res.body.menu.menu_items.length, 2);
  assert.ok(res.body.tables);
  assert.equal(res.body.counters.order_number_counter, 14, "numbering must continue, not restart at 1");
  assert.equal(res.body.counters.takeaway_counter, 37);
  assert.equal(res.body.orders_available.count, 2);
  assert.equal(res.body.orders_available.first_date, "2026-09-22");
});

test("restore on a brand-new restaurant returns nulls, not an error", async () => {
  reset();
  const res = await call("GET", "/RST006/restore?business_date=2026-09-22");
  assert.equal(res.status, 200);
  assert.equal(res.body.settings, null);
  assert.equal(res.body.menu, null);
  assert.equal(res.body.counters.order_number_counter, 0);
  assert.equal(res.body.orders_available.count, 0);
});

/* ================= stored shape ================= */

test("orders are stored marked as Offline POS with the device that sent them", async () => {
  reset();
  await call("POST", "/RST006/orders/batch", { body: { orders: [order(1)] } });
  const stored = admin.store.get(`restaurants/RST006/offlinePosOrders/${uuid(101)}`);
  assert.equal(stored.source, "offline_pos", "the dashboard marks these as Offline POS");
  assert.equal(stored.device_id, DEVICE);
  assert.equal(stored.app_version, "1.4.2");
  assert.ok(stored.received_at, "the server records its own receipt time in UTC");
  assert.equal(stored.created_at, "2026-09-22T10:01:00.000", "the app's local time is stored verbatim, not shifted to UTC");
});

test("the download shape does not leak server bookkeeping fields", async () => {
  reset();
  await call("POST", "/RST006/orders/batch", { body: { orders: [order(1)] } });
  const returned = (await call("GET", "/RST006/orders")).body.orders[0];
  assert.equal(returned.received_at, undefined);
  assert.equal(returned.device_id, undefined);
  assert.equal(returned.source, undefined);
  assert.equal(returned.uuid, uuid(101), "but the app's own fields come back");
});
