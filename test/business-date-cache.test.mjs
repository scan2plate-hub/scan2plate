import test from "node:test";
import assert from "node:assert/strict";
import { getBusinessDate } from "../public/js/common.js";

// getBusinessDate is memoised because a CPU profile showed its Intl work at
// 26.5% of all main-thread time on a busy dashboard. It drives daily order
// numbering, bill serials, table state and report periods, so the cache must
// be invisible: same input, same answer, and never a stale answer when any
// input changes.

const IST = "Asia/Kolkata";

test("repeated calls return the same answer as the first", () => {
  const at = new Date("2026-07-01T22:31:00.000Z");
  const first = getBusinessDate("04:00", IST, at);
  for (let i = 0; i < 100; i += 1) assert.equal(getBusinessDate("04:00", IST, at), first);
  assert.equal(first, "2026-07-02");
});

test("distinct Date objects for the same instant agree", () => {
  const a = new Date("2026-07-01T22:31:00.000Z");
  const b = new Date("2026-07-01T22:31:00.000Z");
  assert.equal(getBusinessDate("04:00", IST, a), getBusinessDate("04:00", IST, b));
});

test("the reset-time boundary is not blurred by caching", () => {
  // One minute apart, on opposite sides of the 04:00 IST reset.
  assert.equal(getBusinessDate("04:00", IST, new Date("2026-07-01T22:29:00.000Z")), "2026-07-01");
  assert.equal(getBusinessDate("04:00", IST, new Date("2026-07-01T22:30:00.000Z")), "2026-07-02");
});

test("changing the reset time changes the answer for the same instant", () => {
  const at = new Date("2026-07-01T22:31:00.000Z"); // 04:01 IST
  assert.equal(getBusinessDate("04:00", IST, at), "2026-07-02");
  assert.equal(getBusinessDate("06:00", IST, at), "2026-07-01", "a later reset keeps it on the previous day");
});

test("changing the timezone changes the answer for the same instant", () => {
  const at = new Date("2026-07-01T22:31:00.000Z");
  assert.equal(getBusinessDate("04:00", IST, at), "2026-07-02");
  assert.equal(getBusinessDate("04:00", "UTC", at), "2026-07-01");
});

test("instants within the same second share a cache entry and agree", () => {
  const base = Date.parse("2026-07-01T22:31:00.000Z");
  const answers = new Set([0, 1, 250, 500, 999].map(ms => getBusinessDate("04:00", IST, new Date(base + ms))));
  assert.equal(answers.size, 1, "sub-second differences cannot change a business date");
});

test("consecutive seconds across the boundary are still distinguished", () => {
  const before = new Date("2026-07-01T22:29:59.000Z");
  const after = new Date("2026-07-01T22:30:00.000Z");
  assert.equal(getBusinessDate("04:00", IST, before), "2026-07-01");
  assert.equal(getBusinessDate("04:00", IST, after), "2026-07-02");
});

test("a day rollover far apart in time is computed independently", () => {
  assert.equal(getBusinessDate("04:00", IST, new Date("2026-03-15T12:00:00.000Z")), "2026-03-15");
  assert.equal(getBusinessDate("04:00", IST, new Date("2026-03-16T12:00:00.000Z")), "2026-03-16");
  assert.equal(getBusinessDate("04:00", IST, new Date("2026-03-15T12:00:00.000Z")), "2026-03-15", "still correct after other dates were cached");
});

test("caching survives far more distinct instants than a long shift produces", () => {
  // Exercises the cache's bounded-size path: it clears rather than growing
  // without limit, and correctness must not depend on a hit.
  const base = Date.parse("2026-05-01T06:00:00.000Z");
  for (let i = 0; i < 25000; i += 1) getBusinessDate("04:00", IST, new Date(base + i * 1000));
  assert.equal(getBusinessDate("04:00", IST, new Date("2026-07-01T22:31:00.000Z")), "2026-07-02");
  assert.equal(getBusinessDate("04:00", IST, new Date("2026-07-01T22:29:00.000Z")), "2026-07-01");
});
