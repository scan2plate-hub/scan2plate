"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { calculateOrderTotals } = require("../orderTotals");

// The production calculateOrderTotals() in common.js does not round
// intermediate values either, so plain multiplication artifacts like
// 287 * 0.05 === 14.350000000000001 are the real, correct behavior to
// match - asserting an exact value here would test a rounding step that
// doesn't actually exist in production.
function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ~${expected}, got ${actual}`);
}

// These numbers are worked out independently (not just re-deriving the
// implementation) so a copy-paste bug in the port would actually be caught.
test("matches hand-calculated totals for a simple no-discount 5% GST bill", () => {
  const items = [{ name: "Veg Burger", qty: 2, price: 99 }, { name: "Cold Coffee", qty: 1, price: 89 }];
  // itemsTotal = 198 + 89 = 287; tax = 287 * 0.05 = 14.35; grandTotal = 301.35
  const totals = calculateOrderTotals(items, 5, {});
  assert.equal(totals.itemsTotal, 287);
  assert.equal(totals.discountAmount, 0);
  assert.equal(totals.taxableAmount, 287);
  assertClose(totals.tax, 14.35, "tax");
  assertClose(totals.grandTotal, 301.35, "grandTotal");
});

test("applies a flat discount before computing tax, matching common.js's order", () => {
  const items = [{ qty: 1, price: 500 }];
  // itemsTotal = 500; discount 50 flat; taxable = 450; tax @ 10% = 45; grandTotal = 495
  const totals = calculateOrderTotals(items, 10, { discountType: "flat", discountValue: 50 });
  assert.equal(totals.discountAmount, 50);
  assert.equal(totals.taxableAmount, 450);
  assert.equal(totals.tax, 45);
  assert.equal(totals.grandTotal, 495);
});

test("clamps a percent discount at 100% and a flat discount at the item total, never going negative", () => {
  const items = [{ qty: 1, price: 100 }];
  const overPercent = calculateOrderTotals(items, 0, { discountType: "percent", discountValue: 150 });
  assert.equal(overPercent.discountAmount, 100);
  assert.equal(overPercent.grandTotal, 0);

  const overFlat = calculateOrderTotals(items, 0, { discountType: "flat", discountValue: 9999 });
  assert.equal(overFlat.discountAmount, 100);
  assert.equal(overFlat.grandTotal, 0);
});

test("zero tax percent (a restaurant with no GST) produces zero tax without erroring", () => {
  const totals = calculateOrderTotals([{ qty: 3, price: 40 }], 0, {});
  assert.equal(totals.itemsTotal, 120);
  assert.equal(totals.tax, 0);
  assert.equal(totals.grandTotal, 120);
});
