/* =========================================================
   REGRESSION: the two screens that disagreed about one business

   A real business — Super Admin listed it as an Active Restaurant
   with a plan running to 28 May 2027 — opened its own dashboard and
   was told it had no subscription and that no Street Vendor plans
   existed. Two separate defects produced that single screen:

   1. businessType was stored in more than one document and the
      screens ranked them oppositely. Super Admin reads and writes
      the business document; the owner's dashboard spread
      settings/general OVER it, so the sub-document won. Correcting
      the type in Super Admin therefore never reached the owner.

   2. The Subscription panel read only the `subscriptions`
      collection, which is written by the Razorpay webhook. A plan
      Scan2Plate activates or renews by hand lives on the business
      document instead, so every hand-activated business was told it
      had no subscription — on a dashboard that had just let it in
      on the strength of those same fields.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBusinessType, hasBusinessType, businessTypeOf, normalizeBusinessType
} from "../public/js/business-types.js";
import {
  legacySubscriptionFrom, isLegacyLocked, legacyPlanLabel, isEntitled, statusLabel
} from "../public/js/subscription-core.js";

const NOW = new Date("2026-09-22T10:00:00+05:30");

/* ---------------------------------------------------------
   1. BUSINESS TYPE RESOLUTION
--------------------------------------------------------- */

test("hasBusinessType tells a stored Restaurant apart from a defaulted one", () => {
  // businessTypeOf() answers "restaurant" to both, which is exactly why the
  // resolver cannot be built on it alone.
  assert.equal(businessTypeOf({ businessType: "Restaurant" }), "restaurant");
  assert.equal(businessTypeOf({}), "restaurant");
  assert.equal(hasBusinessType({ businessType: "Restaurant" }), true);
  assert.equal(hasBusinessType({}), false);
  assert.equal(hasBusinessType({ businessType: "   " }), false);
  assert.equal(hasBusinessType({ restaurantType: "Cafe" }), true);
  assert.equal(hasBusinessType({ panelType: "VendorMobile" }), true);
});

test("the business document wins over a stale settings/general", () => {
  // The exact shape of the reported bug: Super Admin corrected the type on
  // the root document, settings/general kept the old one.
  const root = { businessType: "Restaurant" };
  const general = { businessType: "Street Vendor", taxPercent: 5 };
  assert.equal(resolveBusinessType(root, general), "restaurant");
});

test("a business document with no type falls through to settings/general", () => {
  // Businesses that predate the root field must keep working.
  const general = { businessType: "Street Vendor" };
  assert.equal(resolveBusinessType({ taxPercent: 5 }, general), "street_vendor");
});

test("a business with the type nowhere reads as restaurant, not as the panel it was opened from", () => {
  assert.equal(resolveBusinessType({}, {}, {}), "restaurant");
  assert.equal(resolveBusinessType(), "restaurant");
  assert.equal(resolveBusinessType(null, undefined), "restaurant");
});

test("every stored spelling of one type resolves the same way", () => {
  for (const spelling of ["Street Vendor", "street_vendor", "streetvendor", "vendor", "VendorMobile"]) {
    assert.equal(
      resolveBusinessType({ businessType: spelling }), "street_vendor",
      `${spelling} should resolve to street_vendor`
    );
  }
  assert.equal(normalizeBusinessType("Restaurant"), "restaurant");
});

test("the resolver never lets a later document override an earlier one that has a type", () => {
  // Order is precedence. If this ever stops holding, the two screens diverge
  // again and nothing else in the suite would notice.
  const root = { businessType: "Cafe" };
  assert.equal(resolveBusinessType(root, { businessType: "Hotel" }, { businessType: "Salon" }), "cafe");
});

/* ---------------------------------------------------------
   2. HAND-ACTIVATED (LEGACY) SUBSCRIPTIONS
--------------------------------------------------------- */

const oldMonk = {
  id: "RST005",
  businessType: "Restaurant",
  plan: "advance",
  status: "active",
  subscriptionStatus: "active",
  planExpiryDate: "2027-05-28"
};

test("a business Super Admin activated by hand is not reported as unsubscribed", () => {
  const sub = legacySubscriptionFrom(oldMonk, NOW);
  assert.ok(sub, "a business with a plan and an expiry must produce a subscription view");
  assert.equal(sub.status, "active");
  assert.equal(sub.source, "legacy");
  assert.equal(sub.planName, "Advance Plan");
  assert.equal(sub.businessType, "restaurant");
  assert.equal(isEntitled(sub, NOW), true);
  assert.equal(statusLabel(sub.status), "Active");
});

test("a business with no plan at all still reports nothing — the one honest empty state", () => {
  assert.equal(legacySubscriptionFrom({ id: "RST900" }, NOW), null);
  assert.equal(legacySubscriptionFrom(null, NOW), null);
});

test("a hand-activated plan carries no mandate, so the panel cannot offer to cancel it", () => {
  const sub = legacySubscriptionFrom(oldMonk, NOW);
  // The panel gates the Cancel button on `id`, and cancelSubscription() needs
  // a Razorpay subscription id. An empty id is what keeps that button away.
  assert.equal(sub.id, "");
  assert.equal(sub.billingCycle, "");
  assert.equal(sub.gracePeriodDays, 0);
});

test("access ends on the expiry date, not a day either side of it", () => {
  const onExpiryDay = legacySubscriptionFrom({ ...oldMonk, planExpiryDate: "2026-09-22" }, NOW);
  assert.equal(onExpiryDay.status, "active", "the expiry date itself is still a paid day");
  const dayAfter = legacySubscriptionFrom({ ...oldMonk, planExpiryDate: "2026-09-21" }, NOW);
  assert.equal(dayAfter.status, "expired");
  assert.equal(isEntitled(dayAfter, NOW), false);
});

test("expiryDate is honoured when planExpiryDate is missing", () => {
  // Older records and the manual Renew modal have written one or the other.
  const sub = legacySubscriptionFrom({ id: "R", plan: "basic", expiryDate: "2027-01-01" }, NOW);
  assert.equal(sub.status, "active");
  assert.equal(sub.planName, "Basic Plan");
});

test("a suspended business is never shown as entitled", () => {
  for (const patch of [{ status: "suspended" }, { status: "expired" }, { subscriptionStatus: "expired" }]) {
    const sub = legacySubscriptionFrom({ ...oldMonk, ...patch }, NOW);
    assert.equal(sub.status, "expired", `${JSON.stringify(patch)} must not read as active`);
    assert.equal(isEntitled(sub, NOW), false);
  }
});

test("the legacy lock matches the gate the dashboard itself uses", () => {
  // isLegacyLocked mirrors isRestaurantExpired() in admin.js. If they drift,
  // the panel goes back to contradicting the screen it is drawn on.
  assert.equal(isLegacyLocked(oldMonk, NOW), false);
  assert.equal(isLegacyLocked({ ...oldMonk, status: "suspended" }, NOW), true);
  assert.equal(isLegacyLocked({ ...oldMonk, planExpiryDate: "2026-09-21" }, NOW), true);
  assert.equal(isLegacyLocked({ ...oldMonk, planExpiryDate: "2026-09-22" }, NOW), false);
  // No expiry recorded is not an expiry in the past.
  assert.equal(isLegacyLocked({ id: "R", plan: "advance", status: "active" }, NOW), false);
  assert.equal(isLegacyLocked({ planExpiryDate: "not a date" }, NOW), false);
});

test("the raw legacy values survive for display", () => {
  const sub = legacySubscriptionFrom({ ...oldMonk, subscriptionStatus: "paused" }, NOW);
  assert.equal(sub.legacyStatus, "paused");
  assert.equal(sub.legacyPlan, "advance");
});

test("plan labels stay readable for plans that are not in the catalogue", () => {
  assert.equal(legacyPlanLabel("advance"), "Advance Plan");
  assert.equal(legacyPlanLabel("trial"), "Trial");
  assert.equal(legacyPlanLabel("starter"), "Starter Plan");
  assert.equal(legacyPlanLabel(""), "");
});

test("a catalogued plan name on the business beats the legacy plan word", () => {
  const sub = legacySubscriptionFrom(
    { ...oldMonk, subscriptionPlanId: "plan_pro", subscriptionPlanName: "Pro Yearly" }, NOW
  );
  assert.equal(sub.planName, "Pro Yearly");
  assert.equal(sub.planId, "plan_pro");
});

/* ---------------------------------------------------------
   3. THE TWO DEFECTS TOGETHER — the reported screen
--------------------------------------------------------- */

test("Old Monk: Super Admin and the owner's dashboard now agree", () => {
  const rootDoc = { ...oldMonk };                            // what Super Admin reads
  const generalSettings = { businessType: "Street Vendor" }; // the stale sub-document
  const session = {};                                        // login stores no type

  const superAdminSees = businessTypeOf(rootDoc);
  const ownerSees = resolveBusinessType(rootDoc, generalSettings, session);
  assert.equal(ownerSees, superAdminSees);
  assert.equal(ownerSees, "restaurant");

  const panel = legacySubscriptionFrom(rootDoc, NOW);
  assert.equal(isEntitled(panel, NOW), true, "the panel must not say 'No active subscription'");
  assert.equal(panel.businessType, "restaurant", "and must price the plans it offers as a Restaurant");
});

/* ---------------------------------------------------------
   4. THE WIRING

   The three modules that read these helpers touch the DOM and
   Firestore, so they cannot be imported here. Their source can be,
   and it is what the browser runs. Each assertion below stands for
   a way the fix silently comes undone while every unit test above
   still passes.
--------------------------------------------------------- */
import { readFileSync } from "node:fs";
const JS = file => readFileSync(`${import.meta.dirname}/../public/js/${file}`, "utf8");

test("the owner's dashboard resolves businessType instead of taking it from the spread", () => {
  const admin = JS("admin.js");
  assert.match(admin, /import \{ resolveBusinessType \} from "\.\/business-types\.js\?v=/);
  assert.match(
    admin,
    /restaurantSettings\.businessType = resolveBusinessType\(restaurantRoot, generalSettings, currentUser\)/,
    "settings/general must not be allowed to win on businessType again"
  );
  // And the assignment must come AFTER the spread, or the spread overwrites it.
  const spreadAt = admin.indexOf("restaurantSettings = { ...restaurantRoot, ...generalSettings }");
  const resolveAt = admin.indexOf("restaurantSettings.businessType = resolveBusinessType");
  assert.ok(spreadAt > -1 && resolveAt > spreadAt, "the resolved type must be applied after the spread");
});

test("Super Admin mirrors a business-type change into settings/general", () => {
  const superAdmin = JS("super-admin-dashboard.js");
  assert.match(superAdmin, /PANEL_SHAPE_FIELDS/, "the mirrored fields must be named explicitly");
  assert.match(
    superAdmin,
    /setDoc\(doc\(db,"restaurants",id,"settings","general"\)/,
    "a type saved only to the business document never reaches the owner"
  );
  assert.match(superAdmin, /setDoc[\s\S]{0,400}\{merge:true\}/, "mirroring must not overwrite the rest of settings/general");
  assert.match(superAdmin, /import \{[^}]*\bsetDoc\b[^}]*\} from "https:\/\/www\.gstatic\.com/, "setDoc must be imported");
});

test("the Subscription panel falls back to the business's own plan fields", () => {
  const panel = JS("business-subscription.js");
  assert.match(panel, /legacySubscriptionFrom/, "the panel must know about hand-activated plans");
  assert.match(
    panel,
    /subscription = await currentSubscription\(context\.businessId\)\.catch\(\(\) => null\) \|\| legacySubscription/,
    "an empty `subscriptions` collection must not mean 'No active subscription'"
  );
  assert.match(
    panel,
    /subscription = next \|\| legacySubscription/,
    "a live snapshot that arrives empty must not wipe a hand-activated plan off the panel"
  );
  assert.match(
    panel,
    /if \(business\?\.businessType\) context\.businessType = business\.businessType/,
    "the plans offered must be priced for the type the SERVER will check at checkout"
  );
  assert.match(
    panel,
    /subscription\.id && \["active", "trial", "payment_failed"\]\.includes\(subscription\.status\)/,
    "a plan with no Razorpay mandate must not offer a Cancel button that cannot work"
  );
});
