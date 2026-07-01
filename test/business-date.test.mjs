import test from "node:test";
import assert from "node:assert/strict";
import { getBusinessDate, normalizeResetTime } from "../public/js/common.js";

const resetTime = "04:00 AM";
const timezone = "Asia/Kolkata";

test("normalizes 12-hour restaurant reset time", () => {
  assert.equal(normalizeResetTime(resetTime), "04:00");
});

test("2:00 AM stays on previous business day", () => {
  assert.equal(
    getBusinessDate(resetTime, timezone, new Date("2026-07-01T20:30:00.000Z")),
    "2026-07-01"
  );
});

test("3:59 AM stays on previous business day", () => {
  assert.equal(
    getBusinessDate(resetTime, timezone, new Date("2026-07-01T22:29:00.000Z")),
    "2026-07-01"
  );
});

test("4:00 AM starts a new business day", () => {
  assert.equal(
    getBusinessDate(resetTime, timezone, new Date("2026-07-01T22:30:00.000Z")),
    "2026-07-02"
  );
});

test("4:01 AM stays on the new business day", () => {
  assert.equal(
    getBusinessDate(resetTime, timezone, new Date("2026-07-01T22:31:00.000Z")),
    "2026-07-02"
  );
});
