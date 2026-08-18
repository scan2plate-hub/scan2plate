import test from "node:test";
import assert from "node:assert/strict";
import * as webCore from "../public/js/mobile-offline-core.js";
import appCore from "../mobile/www/offline-core.js";

// public/js/mobile-offline-core.js (a normal ES module, matching the rest
// of public/js/) and mobile/www/offline-core.js (a plain UMD script with
// no build step, loaded by the bundled offline-billing page from a
// different WebView origin) are a deliberate duplicate pair - see either
// file's header comment for why. Nothing stops them drifting apart over an
// edit that only touches one copy. This doesn't compare source text (their
// header comments and export style differ on purpose) - it proves the two
// copies actually behave identically on the same inputs, which is the
// guarantee that matters: an offline bill must total the same whether it
// was cached from the live site or read back on the bundled offline-
// billing page.

test("generateOfflineId format matches between both copies", () => {
  const date = new Date(2026, 7, 16);
  assert.match(webCore.generateOfflineId("RST005", date), /^OFF-RST005-20260816-[0-9a-f-]{36}$/i);
  assert.match(appCore.generateOfflineId("RST005", date), /^OFF-RST005-20260816-[0-9a-f-]{36}$/i);
});

test("buildSyncPlan behaves identically between both copies", () => {
  const pending = [
    { offlineId: "OFF-RST005-20260816-aaa", total: 300 },
    { offlineId: "OFF-RST005-20260816-bbb", total: 450 }
  ];
  const existing = new Set(["OFF-RST005-20260816-aaa"]);
  const webPlan = webCore.buildSyncPlan(pending, existing);
  const appPlan = appCore.buildSyncPlan(pending, existing);
  assert.deepEqual(webPlan.upload.map(o => o.offlineId), appPlan.upload.map(o => o.offlineId));
  assert.deepEqual(webPlan.alreadySynced.map(o => o.offlineId), appPlan.alreadySynced.map(o => o.offlineId));
});

test("calculateOrderTotals produces identical totals between both copies", () => {
  const items = [{ qty: 2, price: 150 }, { qty: 1, price: 80 }];
  const webTotals = webCore.calculateOrderTotals(items, 5, { discountType: "flat", discountValue: 30 });
  const appTotals = appCore.calculateOrderTotals(items, 5, { discountType: "flat", discountValue: 30 });
  assert.deepEqual(webTotals, appTotals);
});
