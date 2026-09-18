import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

globalThis.location = { hostname: "scan2plate.com" };
register("./stubs/loader.mjs", pathToFileURL(`${import.meta.dirname}/`));

const { checkLimit, checkLimitFor, featureAllowed, loadPlanLimits, activePlan, resetPlanLimits } =
  await import("../public/js/plan-limits.js");

const starter = { name: "Restaurant Starter", limits: { maxTables: 20, maxStaff: 3, maxMenuItems: -1 }, features: { whatsapp: false, qrOrdering: true } };

/* ---------------------------------------------------------
   FAIL OPEN

   Every Scan2Plate business that exists today has no plan
   document. If these checks failed closed, shipping this would
   stop a live restaurant adding a table mid-service.
--------------------------------------------------------- */

test("a business with no plan is never blocked", () => {
  assert.equal(checkLimit("maxTables", 9_999, null).allowed, true);
  assert.equal(checkLimit("maxStaff", 9_999, null).allowed, true);
  assert.equal(checkLimitFor("maxTables", 500, 500, null).allowed, true);
  assert.equal(featureAllowed("whatsapp", null), true);
});

test("a blocked check carries no message when nothing is blocked", () => {
  assert.equal(checkLimit("maxMenuItems", 1_000_000, null).message, "");
});

test("a business with no subscription document loads as unlimited", async () => {
  resetPlanLimits();
  const plan = await loadPlanLimits("business-with-no-subscription");
  assert.equal(plan, null);
  assert.equal(activePlan(), null);
  assert.equal(checkLimit("maxTables", 9_999).allowed, true, "the cached (absent) plan still allows everything");
});

test("a read failure is treated as unlimited, not as zero", async () => {
  resetPlanLimits();
  // The stub has no data seeded for this id, which exercises the same
  // absent-plan path a permission error would take.
  await loadPlanLimits("unreadable-business");
  assert.equal(checkLimit("maxStaff", 500).allowed, true);
});

/* ---------------------------------------------------------
   ENFORCEMENT
--------------------------------------------------------- */

test("a numeric limit blocks only once it is reached", () => {
  assert.equal(checkLimit("maxTables", 19, starter).allowed, true);
  assert.equal(checkLimit("maxTables", 20, starter).allowed, false);
  assert.equal(checkLimit("maxTables", 21, starter).allowed, false);
});

test("-1 means unlimited even on a plan that limits other things", () => {
  assert.equal(checkLimit("maxMenuItems", 100_000, starter).allowed, true);
  assert.equal(checkLimit("maxStaff", 3, starter).allowed, false);
});

test("a limit the plan does not mention is unlimited", () => {
  assert.equal(checkLimit("maxInventoryItems", 99_999, starter).allowed, true);
});

test("the message names the plan, the limit and what to do", () => {
  const blocked = checkLimit("maxTables", 20, starter);
  assert.match(blocked.message, /Restaurant Starter/);
  assert.match(blocked.message, /20 tables/);
  assert.match(blocked.message, /Upgrade/);
});

test("limits are described in words, not field names", () => {
  assert.match(checkLimit("maxStaff", 3, starter).message, /staff accounts/);
  assert.match(checkLimit("maxInventoryItems", 5, { name: "P", limits: { maxInventoryItems: 5 } }).message, /inventory items/);
});

/* ---------------------------------------------------------
   BLOCK CREATION (adding several records at once)
--------------------------------------------------------- */

test("adding a block checks the whole block, not one record", () => {
  assert.equal(checkLimitFor("maxTables", 15, 5, starter).allowed, true, "15 + 5 lands exactly on the limit");
  assert.equal(checkLimitFor("maxTables", 15, 6, starter).allowed, false, "15 + 6 would exceed it");
});

test("a partial allowance tells the owner how many they can still add", () => {
  assert.match(checkLimitFor("maxTables", 15, 6, starter).message, /can add 5 more/);
});

test("at the limit there is no remainder to offer, so it says upgrade", () => {
  const blocked = checkLimitFor("maxTables", 20, 1, starter);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.message, /Upgrade/);
  assert.doesNotMatch(blocked.message, /can add/);
});

/* ---------------------------------------------------------
   FEATURES
--------------------------------------------------------- */

test("feature flags gate features and an unlisted feature stays on", () => {
  assert.equal(featureAllowed("whatsapp", starter), false);
  assert.equal(featureAllowed("qrOrdering", starter), true);
  assert.equal(featureAllowed("somethingAddedLater", starter), true, "a new feature is not blocked by an old plan");
});
