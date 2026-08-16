"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { generateOfflineId, isOfflineId } = require("../offlineId");

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
  assert.equal(isOfflineId("ORD12345678"), false); // this is the format used by online orders, not offline ones
  assert.equal(isOfflineId(""), false);
  assert.equal(isOfflineId(null), false);
  assert.equal(isOfflineId("OFF-RST005-2026-08-16-not-a-uuid"), false);
});
