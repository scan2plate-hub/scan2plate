import test from "node:test";
import assert from "node:assert/strict";
import { canAccessModule, resolveAllowedModules, rolePermissions, debounce } from "../public/js/common.js";

// Per-staff permissions are an OVERRIDE layered on top of the existing role
// system. The critical property is that every account that does not use the
// new field behaves exactly as it did before, so no existing login silently
// gains or loses access when this ships.

test("accounts without custom permissions keep their role's access unchanged", () => {
  assert.equal(canAccessModule("owner", "settings"), true);
  assert.equal(canAccessModule("cashier", "quickBilling"), true);
  assert.equal(canAccessModule("cashier", "settings"), false);
  assert.equal(canAccessModule("kitchen", "kot"), true);
  assert.equal(canAccessModule("kitchen", "billing"), false);
  assert.equal(canAccessModule("waiter", "tables"), true);
});

test("an empty or missing permissions list falls back to the role default", () => {
  assert.deepEqual(resolveAllowedModules("cashier", []), rolePermissions("cashier"));
  assert.deepEqual(resolveAllowedModules("cashier", null), rolePermissions("cashier"));
  assert.deepEqual(resolveAllowedModules("cashier", undefined), rolePermissions("cashier"));
  assert.deepEqual(resolveAllowedModules("cashier", "not-an-array"), rolePermissions("cashier"));
});

test("a custom permission list replaces the role default", () => {
  assert.equal(canAccessModule("waiter", "reports"), false);
  assert.equal(canAccessModule("waiter", "reports", ["reports", "tables"]), true);
  // and narrowing works too: this waiter loses quickBilling
  assert.equal(canAccessModule("waiter", "quickBilling", ["reports", "tables"]), false);
});

test("owner-like roles keep full access even with a custom list", () => {
  // "all" must not be narrowed by a stray permissions array on an owner doc.
  assert.equal(resolveAllowedModules("owner", ["reports"]), "all");
  assert.equal(canAccessModule("admin", "settings", ["reports"]), true);
});

test("a custom list is de-duplicated and blank entries dropped", () => {
  assert.deepEqual(resolveAllowedModules("waiter", ["tables", "tables", " ", "", "reports"]), ["tables", "reports"]);
});

test("an unknown role still falls back to the owner default, as before", () => {
  assert.equal(resolveAllowedModules("some-legacy-role"), "all");
});

test("debounce collapses a burst of keystrokes into one run with the final value", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const search = debounce(value => calls.push(value), 180);
  search("p");
  search("pa");
  search("pan");
  search("paneer");
  assert.deepEqual(calls, [], "nothing renders while the user is still typing");
  t.mock.timers.tick(180);
  assert.deepEqual(calls, ["paneer"], "one render, with the final query");
});
