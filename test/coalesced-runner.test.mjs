import test from "node:test";
import assert from "node:assert/strict";
import { createCoalescedRunner } from "../public/js/common.js";

// Regression test for the Admin Dashboard freeze: a live orders listener
// fires this on every Firestore snapshot, and each call used to trigger a
// full synchronous re-render of the dashboard/orders/reports/KOT/tables
// sections. A burst of near-simultaneous writes (several orders in quick
// succession, or a local write followed immediately by its server ack)
// fired that pipeline back-to-back and froze the tab.

test("runs the very first call immediately (initial load isn't delayed)", () => {
  const calls = [];
  const schedule = createCoalescedRunner(arg => calls.push(arg), 200);
  schedule("first");
  assert.deepEqual(calls, ["first"]);
});

test("coalesces a burst of rapid-fire calls into a single trailing run with the latest argument", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const schedule = createCoalescedRunner(arg => calls.push(arg), 200);

  schedule("first"); // leading call, runs immediately
  schedule("second"); // burst starts — scheduled, not run yet
  schedule("third");
  schedule("fourth"); // only the latest argument should survive

  assert.deepEqual(calls, ["first"]);

  t.mock.timers.tick(200);

  assert.deepEqual(calls, ["first", "fourth"]);
});

test("a call after the burst has settled schedules its own new trailing run", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const schedule = createCoalescedRunner(arg => calls.push(arg), 200);

  schedule("a");
  schedule("b");
  t.mock.timers.tick(200);
  assert.deepEqual(calls, ["a", "b"]);

  schedule("c");
  t.mock.timers.tick(200);
  assert.deepEqual(calls, ["a", "b", "c"]);
});

test("each createCoalescedRunner instance has independent state (resubscribe scenario)", () => {
  const calls = [];
  const first = createCoalescedRunner(arg => calls.push(["first-runner", arg]), 200);
  first("x");
  const second = createCoalescedRunner(arg => calls.push(["second-runner", arg]), 200);
  second("y"); // must run immediately — a fresh instance has no memory of the old one's burst state
  assert.deepEqual(calls, [["first-runner", "x"], ["second-runner", "y"]]);
});
