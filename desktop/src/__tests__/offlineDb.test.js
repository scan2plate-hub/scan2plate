"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function freshDb() {
  // Each test gets its own throwaway SQLite file so tests never interfere
  // with each other or leave state behind.
  delete require.cache[require.resolve("../offlineDb")];
  const offlineDb = require("../offlineDb");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan2plate-offline-test-"));
  offlineDb.openDb(dir);
  return offlineDb;
}

test("createOfflineOrder persists all Part 6 required fields and assigns a valid offlineId", () => {
  const offlineDb = freshDb();
  const order = offlineDb.createOfflineOrder({
    restaurantId: "RST005",
    tableNo: "12",
    items: [{ name: "Paneer Tikka", qty: 2, price: 220 }],
    subtotal: 440,
    discount: 0,
    tax: 22,
    total: 462,
    paymentMethod: "cash",
    paymentStatus: "paid",
    businessDate: "2026-08-16"
  });

  assert.match(order.offlineId, /^OFF-RST005-\d{8}-[0-9a-f-]{36}$/i);
  assert.equal(order.restaurantId, "RST005");
  assert.equal(order.tableNo, "12");
  assert.equal(order.total, 462);
  assert.equal(order.syncStatus, "pending");
  assert.equal(order.firebaseOrderId, null);
  assert.deepEqual(order.items, [{ name: "Paneer Tikka", qty: 2, price: 220 }]);
});

test("listPendingOrders returns pending/failed orders but not already-synced ones", () => {
  const offlineDb = freshDb();
  const a = offlineDb.createOfflineOrder({ restaurantId: "RST005", items: [], subtotal: 300, discount: 0, tax: 0, total: 300, paymentMethod: "cash", paymentStatus: "paid", businessDate: "2026-08-16" });
  const b = offlineDb.createOfflineOrder({ restaurantId: "RST005", items: [], subtotal: 450, discount: 0, tax: 0, total: 450, paymentMethod: "cash", paymentStatus: "paid", businessDate: "2026-08-16" });
  offlineDb.createOfflineOrder({ restaurantId: "RST005", items: [], subtotal: 125, discount: 0, tax: 0, total: 125, paymentMethod: "cash", paymentStatus: "paid", businessDate: "2026-08-16" });

  assert.equal(offlineDb.countPendingOrders("RST005"), 3);

  offlineDb.markSynced(a.offlineId, "firebase-doc-a");
  assert.equal(offlineDb.countPendingOrders("RST005"), 2);

  offlineDb.markSyncFailed(b.offlineId, "network error");
  const pending = offlineDb.listPendingOrders("RST005");
  assert.equal(pending.length, 2); // b (failed) + the untouched third order are both still "pending sync"
  assert.ok(pending.every(o => o.offlineId !== a.offlineId));
});

test("orders from a different restaurantId never leak into another restaurant's pending list", () => {
  const offlineDb = freshDb();
  offlineDb.createOfflineOrder({ restaurantId: "RST005", items: [], subtotal: 100, discount: 0, tax: 0, total: 100, paymentMethod: "cash", paymentStatus: "paid", businessDate: "2026-08-16" });
  offlineDb.createOfflineOrder({ restaurantId: "RST006", items: [], subtotal: 200, discount: 0, tax: 0, total: 200, paymentMethod: "cash", paymentStatus: "paid", businessDate: "2026-08-16" });

  assert.equal(offlineDb.countPendingOrders("RST005"), 1);
  assert.equal(offlineDb.countPendingOrders("RST006"), 1);
});

test("menu/table cache round-trips through replaceMenuCache/replaceTablesCache correctly and only returns available items", () => {
  const offlineDb = freshDb();
  offlineDb.replaceMenuCache("RST005", [
    { id: "m1", name: "Veg Burger", category: "Burgers", price: 99, foodType: "veg", available: true },
    { id: "m2", name: "Discontinued Item", category: "Burgers", price: 50, foodType: "veg", available: false }
  ]);
  const menu = offlineDb.getCachedMenu("RST005");
  assert.equal(menu.length, 1);
  assert.equal(menu[0].name, "Veg Burger");

  offlineDb.replaceTablesCache("RST005", [{ id: "t1", tableNo: "01", active: true }, { id: "t2", tableNo: "02", disabled: true }]);
  const tables = offlineDb.getCachedTables("RST005");
  assert.equal(tables.length, 1);
  assert.equal(tables[0].tableNo, "01");
});

test("replaceMenuCache fully replaces the previous cache rather than accumulating stale rows", () => {
  const offlineDb = freshDb();
  offlineDb.replaceMenuCache("RST005", [{ id: "m1", name: "Item A", category: "Cat", price: 50, available: true }]);
  offlineDb.replaceMenuCache("RST005", [{ id: "m2", name: "Item B", category: "Cat", price: 60, available: true }]);
  const menu = offlineDb.getCachedMenu("RST005");
  assert.equal(menu.length, 1);
  assert.equal(menu[0].name, "Item B");
});
