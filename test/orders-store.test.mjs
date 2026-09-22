import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// This is browser code: common.js's devError checks location.hostname to
// decide whether to log. A production-looking hostname keeps the test output
// clean while exercising the real code path.
globalThis.location = { hostname: "scan2plate.com" };

// Redirect the browser-only Firebase imports to an in-memory stub.
register("./stubs/loader.mjs", pathToFileURL(`${import.meta.dirname}/`));

const stub = await import("./stubs/firebase-stub.mjs");
const { subscribeOrders, getLoadedOrders, ordersLoaded } = await import("../public/js/orders-store.js");

// The admin dashboard and the admin modules bundle each used to open their own
// live query over the whole `orders` collection — two copies of the same data,
// twice the Firestore reads, and two render pipelines firing on every write.
// These tests pin the single-listener contract that replaced that.

test("two subscribers share ONE underlying listener", () => {
  stub.resetListeners();
  const a = [];
  const b = [];
  const offA = subscribeOrders("rest-1", orders => a.push(orders));
  const afterFirst = stub.liveListenerCount();
  const offB = subscribeOrders("rest-1", orders => b.push(orders));

  // The contract is that subscribers SHARE listeners, not that there is
  // exactly one: the store also watches the offline-POS subcollection. What
  // must never happen is a listener opening per subscriber.
  assert.equal(stub.liveListenerCount(), afterFirst, "a second subscriber must not open another query");
  assert.equal(stub.activeListeners.filter(l => l.active && stub.listenerPath(l) === "orders").length, 1,
    "exactly one listener on the orders collection, however many subscribers");

  stub.emitSnapshot([{ id: "o1", restaurantId: "rest-1", grandTotal: 100 }]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0][0].id, "o1");
  assert.deepEqual(a[0], b[0], "both subscribers see the same orders");

  offA();
  offB();
});

test("the listener is torn down when the last subscriber leaves", () => {
  stub.resetListeners();
  const offA = subscribeOrders("rest-1", () => {});
  const shared = stub.liveListenerCount();
  const offB = subscribeOrders("rest-1", () => {});
  assert.equal(stub.liveListenerCount(), shared);

  offA();
  assert.equal(stub.liveListenerCount(), shared, "still one subscriber left, keep reading");
  offB();
  assert.equal(stub.liveListenerCount(), 0, "nothing keeps reading after the last subscriber leaves");
});

test("a late subscriber gets the current orders from memory, with no extra read", () => {
  stub.resetListeners();
  const off = subscribeOrders("rest-1", () => {});
  stub.emitSnapshot([{ id: "o1", restaurantId: "rest-1" }, { id: "o2", restaurantId: "rest-1" }]);

  const late = [];
  const offLate = subscribeOrders("rest-1", orders => late.push(orders));

  assert.equal(stub.activeListeners.filter(l => l.active && stub.listenerPath(l) === "orders").length, 1,
    "joining late must not open another query");
  assert.equal(late.length, 1, "the late subscriber is handed the cached snapshot immediately");
  assert.equal(late[0].length, 2);

  off();
  offLate();
});

test("orders already loaded are readable synchronously", () => {
  stub.resetListeners();
  const off = subscribeOrders("rest-1", () => {});
  stub.emitSnapshot([{ id: "o9", restaurantId: "rest-1", grandTotal: 250 }]);

  assert.equal(ordersLoaded(), true);
  assert.equal(getLoadedOrders()[0].grandTotal, 250);
  off();
});

test("one failing subscriber does not stop the others from updating", () => {
  stub.resetListeners();
  const healthy = [];
  const offBad = subscribeOrders("rest-1", () => { throw new Error("render blew up"); });
  const offGood = subscribeOrders("rest-1", orders => healthy.push(orders));
  try {
    stub.emitSnapshot([{ id: "only-order", restaurantId: "rest-1" }]);
    // The healthy subscriber received this snapshot even though the other one
    // threw while rendering it.
    assert.equal(healthy.at(-1)[0].id, "only-order", "the healthy section still renders");
  } finally {
    offBad();
    offGood();
  }
});

test("a listener error reaches the error handler", () => {
  stub.resetListeners();
  const errors = [];
  const off = subscribeOrders("rest-1", () => {}, error => errors.push(error));
  try {
    stub.emitError({ code: "unavailable", message: "network down" });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "unavailable");
  } finally {
    off();
  }
});

/* ---------------- offline POS orders ---------------- */

const settle = () => new Promise(resolve => setTimeout(resolve, 260));

test("offline POS orders are merged in alongside online ones", async () => {
  stub.resetListeners();
  const seen = [];
  const off = subscribeOrders("rest-1", orders => seen.push(orders));

  stub.emitSnapshot([{ id: "o1", restaurantId: "rest-1", grandTotal: 100 }]);
  stub.emitSnapshot(
    [{ id: "p1", uuid: "p1", status: "billed", total: 250, table_name: "Table 3", table_type: "table", items: [] }],
    { path: "restaurants/rest-1/offlinePosOrders" }
  );
  await settle();   // the store coalesces a burst of snapshots over 200 ms

  const latest = seen[seen.length - 1];
  assert.equal(latest.length, 2, "both streams reach the subscriber");
  const offline = latest.find(order => order.isOfflinePosOrder);
  assert.ok(offline, "the offline order is present");
  assert.equal(offline.sourceLabel, "Offline POS");
  assert.equal(offline.grandTotal, 250);
  assert.equal(offline.paymentStatus, "paid", "a billed offline order counts as revenue");
  off();
});

test("an OPEN offline order reaches the dashboard but is not revenue", async () => {
  stub.resetListeners();
  const seen = [];
  const off = subscribeOrders("rest-1", orders => seen.push(orders));
  stub.emitSnapshot(
    [{ id: "p2", uuid: "p2", status: "open", total: 400, table_name: "Table 5", table_type: "table", items: [] }],
    { path: "restaurants/rest-1/offlinePosOrders" }
  );
  await settle();
  const order = seen[seen.length - 1].find(o => o.isOfflinePosOrder);
  assert.equal(order.status, "pending", "a running table is visible");
  assert.notEqual(order.paymentStatus, "paid", "but it is not money");
  off();
});

test("online orders are not double-counted by the offline listener", () => {
  stub.resetListeners();
  const seen = [];
  const off = subscribeOrders("rest-1", orders => seen.push(orders));
  stub.emitSnapshot([{ id: "o1", restaurantId: "rest-1", grandTotal: 100 }]);
  const latest = seen[seen.length - 1];
  assert.equal(latest.length, 1, "one online order must appear exactly once");
  off();
});

test("the offline stream is torn down with the online one", () => {
  stub.resetListeners();
  const off = subscribeOrders("rest-1", () => {});
  assert.ok(stub.liveListenerCount() >= 2, "both streams are open");
  off();
  assert.equal(stub.liveListenerCount(), 0, "and both are closed");
});
