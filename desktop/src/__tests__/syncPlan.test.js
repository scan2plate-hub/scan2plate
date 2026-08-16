"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSyncPlan } = require("../syncPlan");

test("Part 30 scenario: three fresh offline bills all need upload when nothing exists remotely yet", () => {
  const pending = [
    { offlineId: "OFF-RST005-20260816-aaa", total: 300 },
    { offlineId: "OFF-RST005-20260816-bbb", total: 450 },
    { offlineId: "OFF-RST005-20260816-ccc", total: 125 }
  ];
  const plan = buildSyncPlan(pending, new Set());
  assert.equal(plan.upload.length, 3);
  assert.equal(plan.alreadySynced.length, 0);
  assert.deepEqual(plan.upload.map(o => o.offlineId), pending.map(o => o.offlineId));
});

test("Part 31 scenario: resuming after a mid-sync failure never re-uploads the bill that already made it through", () => {
  const pending = [
    { offlineId: "OFF-RST005-20260816-aaa", total: 300 }, // uploaded before the network dropped
    { offlineId: "OFF-RST005-20260816-bbb", total: 450 },
    { offlineId: "OFF-RST005-20260816-ccc", total: 125 }
  ];
  // Simulates re-querying Firestore after reconnect: Bill A's offlineId is
  // already there because it made it through before the connection failed.
  const alreadyOnServer = new Set(["OFF-RST005-20260816-aaa"]);

  const plan = buildSyncPlan(pending, alreadyOnServer);

  assert.deepEqual(plan.alreadySynced.map(o => o.offlineId), ["OFF-RST005-20260816-aaa"]);
  assert.deepEqual(plan.upload.map(o => o.offlineId), ["OFF-RST005-20260816-bbb", "OFF-RST005-20260816-ccc"]);
});

test("never plans an upload for a bill whose offlineId already exists remotely, even if called repeatedly", () => {
  const order = { offlineId: "OFF-RST005-20260816-aaa", total: 300 };
  const existing = new Set([order.offlineId]);

  // Run the planner 5 times in a row (simulating 5 retry attempts) - the
  // upload list must stay empty every single time. This is the concrete
  // guarantee behind "never upload the same bill twice."
  for (let i = 0; i < 5; i++) {
    const plan = buildSyncPlan([order], existing);
    assert.equal(plan.upload.length, 0, `attempt ${i + 1} must not re-plan an upload`);
    assert.equal(plan.alreadySynced.length, 1);
  }
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
