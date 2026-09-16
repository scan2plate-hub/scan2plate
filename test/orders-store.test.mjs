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
  const offB = subscribeOrders("rest-1", orders => b.push(orders));

  assert.equal(stub.liveListenerCount(), 1, "a second subscriber must not open a second query");

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
  const offB = subscribeOrders("rest-1", () => {});
  assert.equal(stub.liveListenerCount(), 1);

  offA();
  assert.equal(stub.liveListenerCount(), 1, "still one subscriber left, keep reading");
  offB();
  assert.equal(stub.liveListenerCount(), 0, "nothing keeps reading after the last subscriber leaves");
});

test("a late subscriber gets the current orders from memory, with no extra read", () => {
  stub.resetListeners();
  const off = subscribeOrders("rest-1", () => {});
  stub.emitSnapshot([{ id: "o1", restaurantId: "rest-1" }, { id: "o2", restaurantId: "rest-1" }]);

  const late = [];
  const offLate = subscribeOrders("rest-1", orders => late.push(orders));

  assert.equal(stub.liveListenerCount(), 1, "joining late must not open another query");
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
