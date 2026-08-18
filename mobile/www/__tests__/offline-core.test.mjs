import test from "node:test";
import assert from "node:assert/strict";
import offlineCore from "../offline-core.js";

const { generateOfflineId, isOfflineId, buildSyncPlan, calculateOrderTotals } = offlineCore;

// Mirrors desktop/src/__tests__/offlineId.test.js exactly - same format,
// same guarantees - since offline bills must behave identically whether
// created on desktop or Android.

test("generateOfflineId produces the OFF-<restaurantId>-<YYYYMMDD>-<uuid> format", () => {
  const id = generateOfflineId("RST005", new Date(2026, 7, 16)); // August 16 2026
  assert.match(id, /^OFF-RST005-20260816-[0-9a-f-]{36}$/i);
});

test("generateOfflineId sanitizes unsafe characters out of the restaurantId", () => {
  const id = generateOfflineId("RST 005/../etc", new Date(2026, 0, 1));
  assert.match(id, /^OFF-RST005etc-20260101-[0-9a-f-]{36}$/i);
});

test("generateOfflineId falls back to 'unknown' for an empty restaurantId", () => {
  const id = generateOfflineId("", new Date(2026, 0, 1));
  assert.match(id, /^OFF-unknown-20260101-[0-9a-f-]{36}$/i);
});

test("generateOfflineId is globally unique across many calls in the same millisecond", () => {
  const ids = new Set();
  for (let i = 0; i < 5000; i++) ids.add(generateOfflineId("RST005"));
  assert.equal(ids.size, 5000, "every generated ID must be unique, not just sequential");
});

test("isOfflineId accepts a well-formed ID and rejects malformed ones", () => {
  const valid = generateOfflineId("RST005");
  assert.equal(isOfflineId(valid), true);
  assert.equal(isOfflineId("ORD12345678"), false);
  assert.equal(isOfflineId(""), false);
  assert.equal(isOfflineId(null), false);
  assert.equal(isOfflineId("OFF-RST005-2026-08-16-not-a-uuid"), false);
});

// Mirrors desktop/src/__tests__/syncPlan.test.js exactly.

test("three fresh offline bills all need upload when nothing exists remotely yet", () => {
  const pending = [
    { offlineId: "OFF-RST005-20260816-aaa", total: 300 },
    { offlineId: "OFF-RST005-20260816-bbb", total: 450 },
    { offlineId: "OFF-RST005-20260816-ccc", total: 125 }
  ];
  const plan = buildSyncPlan(pending, new Set());
  assert.equal(plan.upload.length, 3);
  assert.equal(plan.alreadySynced.length, 0);
});

test("resuming after a mid-sync failure never re-uploads the bill that already made it through", () => {
  const pending = [
    { offlineId: "OFF-RST005-20260816-aaa", total: 300 },
    { offlineId: "OFF-RST005-20260816-bbb", total: 450 },
    { offlineId: "OFF-RST005-20260816-ccc", total: 125 }
  ];
  const alreadyOnServer = new Set(["OFF-RST005-20260816-aaa"]);
  const plan = buildSyncPlan(pending, alreadyOnServer);
  assert.deepEqual(plan.alreadySynced.map(o => o.offlineId), ["OFF-RST005-20260816-aaa"]);
  assert.deepEqual(plan.upload.map(o => o.offlineId), ["OFF-RST005-20260816-bbb", "OFF-RST005-20260816-ccc"]);
});

test("skips malformed pending records instead of guessing an identity for them", () => {
  const plan = buildSyncPlan([{ total: 99 }, { offlineId: "", total: 10 }, { offlineId: "OFF-RST005-20260816-ok", total: 50 }], new Set());
  assert.equal(plan.upload.length, 1);
  assert.equal(plan.upload[0].offlineId, "OFF-RST005-20260816-ok");
});

test("de-duplicates if the same offlineId somehow appears twice in the pending list", () => {
  const duplicated = [
    { offlineId: "OFF-RST005-20260816-aaa", total: 300 },
    { offlineId: "OFF-RST005-20260816-aaa", total: 300 }
  ];
  const plan = buildSyncPlan(duplicated, new Set());
  assert.equal(plan.upload.length, 1);
});

// Mirrors desktop/src/__tests__/orderTotals.test.js's intent: must agree
// with public/js/common.js's calculateOrderTotals to the cent (floating
// point tolerance only, never an artificially rounded expectation).

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.005, `${message}: expected ${expected}, got ${actual}`);
}

test("calculateOrderTotals matches hand-calculated values with flat discount and tax", () => {
  const items = [{ qty: 2, price: 150 }, { qty: 1, price: 80 }]; // itemsTotal = 380
  const totals = calculateOrderTotals(items, 5, { discountType: "flat", discountValue: 30 });
  assertClose(totals.itemsTotal, 380, "itemsTotal");
  assertClose(totals.discountAmount, 30, "discountAmount");
  assertClose(totals.taxableAmount, 350, "taxableAmount");
  assertClose(totals.tax, 17.5, "tax");
  assertClose(totals.grandTotal, 367.5, "grandTotal");
});

test("calculateOrderTotals matches hand-calculated values with percent discount and no tax", () => {
  const items = [{ qty: 3, price: 100 }]; // itemsTotal = 300
  const totals = calculateOrderTotals(items, 0, { discountType: "percent", discountValue: 10 });
  assertClose(totals.itemsTotal, 300, "itemsTotal");
  assertClose(totals.discountAmount, 30, "discountAmount");
  assertClose(totals.grandTotal, 270, "grandTotal");
});

test("calculateOrderTotals clamps discount to never exceed itemsTotal", () => {
  const items = [{ qty: 1, price: 50 }];
  const totals = calculateOrderTotals(items, 0, { discountType: "flat", discountValue: 999 });
  assertClose(totals.discountAmount, 50, "discountAmount clamped to itemsTotal");
  assertClose(totals.grandTotal, 0, "grandTotal");
});
