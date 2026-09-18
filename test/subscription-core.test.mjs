import test from "node:test";
import assert from "node:assert/strict";
import {
  planAppliesTo, plansForBusinessType, quotePlan, bestOffer, offerIsLive, offerApplies,
  discountAmount, computeEndDate, computeNextBillingDate, addMonths, mapRazorpayStatus,
  isEntitled, withinGracePeriod, planAllowsFeature, planLimit, withinLimit, limitLabel, UNLIMITED,
  SUBSCRIPTION_STATES, statusLabel
} from "../public/js/subscription-core.js";

const restaurantPro = { id: "pro", name: "Restaurant Pro", businessType: "restaurant", monthlyPrice: 999, yearlyPrice: 9990, displayOrder: 2, active: true };
const restaurantStarter = { id: "starter", name: "Restaurant Starter", businessType: "restaurant", monthlyPrice: 499, yearlyPrice: 4990, displayOrder: 1, active: true };
const hostelBasic = { id: "hostel-basic", name: "Hostel Basic", businessType: "hostel", monthlyPrice: 699, yearlyPrice: 6990, active: true };
const globalPro = { id: "global", name: "Scan2Plate Business Pro", businessType: "all", monthlyPrice: 999, active: true };

/* ---------------- plan targeting ---------------- */

test("a business only sees plans for its own type", () => {
  assert.equal(planAppliesTo(restaurantPro, "restaurant"), true);
  assert.equal(planAppliesTo(restaurantPro, "hostel"), false, "a hostel must not be shown restaurant plans");
  assert.equal(planAppliesTo(hostelBasic, "hostel"), true);
});

test("legacy business-type spellings still match their plans", () => {
  // Existing records store "Street Vendor"/"Restaurant"; plans may store ids.
  assert.equal(planAppliesTo({ businessType: "street_vendor", active: true }, "Street Vendor"), true);
  assert.equal(planAppliesTo({ businessType: "Restaurant", active: true }, "restaurant"), true);
});

test("a global plan is offered to every business type", () => {
  assert.equal(planAppliesTo(globalPro, "restaurant"), true);
  assert.equal(planAppliesTo(globalPro, "hostel"), true);
  assert.equal(planAppliesTo(globalPro, "salon"), true);
});

test("a global plan can be restricted to a named subset", () => {
  const limited = { ...globalPro, businessTypes: ["restaurant", "cafe", "dhaba"] };
  assert.equal(planAppliesTo(limited, "cafe"), true);
  assert.equal(planAppliesTo(limited, "hostel"), false);
});

test("an inactive plan is never offered", () => {
  assert.equal(planAppliesTo({ ...restaurantPro, active: false }, "restaurant"), false);
});

test("plans come back in the order Super Admin set", () => {
  const list = plansForBusinessType([restaurantPro, hostelBasic, restaurantStarter], "restaurant");
  assert.deepEqual(list.map(p => p.id), ["starter", "pro"]);
});

/* ---------------- offers ---------------- */

const twoMonthsFree = { id: "free2", businessType: "restaurant", billingCycle: "yearly", bonusMonths: 2, priority: 2, active: true, offerText: "Pay for 12 months, get 2 months FREE" };
const twentyOff = { id: "off20", businessType: "restaurant", billingCycle: "yearly", discountType: "percent", discountValue: 20, priority: 1, active: true };

test("an offer outside its date window is not live", () => {
  const now = new Date("2026-11-15T10:00:00Z");
  assert.equal(offerIsLive({ ...twoMonthsFree, startDate: "2026-10-01", endDate: "2026-12-31" }, now), true);
  assert.equal(offerIsLive({ ...twoMonthsFree, startDate: "2026-12-01", endDate: "2026-12-31" }, now), false, "not started");
  assert.equal(offerIsLive({ ...twoMonthsFree, startDate: "2026-01-01", endDate: "2026-10-31" }, now), false, "already ended");
});

test("the end date is inclusive of its whole last day", () => {
  const offer = { ...twoMonthsFree, endDate: "2026-12-31" };
  assert.equal(offerIsLive(offer, new Date("2026-12-31T23:00:00")), true);
  assert.equal(offerIsLive(offer, new Date("2027-01-01T00:30:00")), false);
});

test("a deactivated offer stops applying immediately", () => {
  assert.equal(offerIsLive({ ...twoMonthsFree, active: false }), false);
});

test("an offer that hit its redemption cap stops applying", () => {
  assert.equal(offerIsLive({ ...twoMonthsFree, maxRedemptions: 100, redemptions: 100 }), false);
  assert.equal(offerIsLive({ ...twoMonthsFree, maxRedemptions: 100, redemptions: 99 }), true);
});

test("an offer only applies to its own business type, plan and cycle", () => {
  const ctx = { businessType: "restaurant", planId: "pro", billingCycle: "yearly" };
  assert.equal(offerApplies(twoMonthsFree, ctx), true);
  assert.equal(offerApplies(twoMonthsFree, { ...ctx, businessType: "hostel" }), false);
  assert.equal(offerApplies({ ...twoMonthsFree, planId: "starter" }, ctx), false);
  assert.equal(offerApplies(twoMonthsFree, { ...ctx, billingCycle: "monthly" }), false);
});

test("only the highest-priority offer is used, never several at once", () => {
  const chosen = bestOffer([twentyOff, twoMonthsFree], { businessType: "restaurant", planId: "pro", billingCycle: "yearly", price: 9990 });
  assert.equal(chosen.id, "free2", "priority 2 beats priority 1");
});

test("equal priority breaks on the bigger saving, not at random", () => {
  const a = { id: "a", businessType: "restaurant", priority: 5, discountType: "percent", discountValue: 10, active: true };
  const b = { id: "b", businessType: "restaurant", priority: 5, discountType: "percent", discountValue: 30, active: true };
  assert.equal(bestOffer([a, b], { businessType: "restaurant", price: 1000 }).id, "b");
  assert.equal(bestOffer([b, a], { businessType: "restaurant", price: 1000 }).id, "b", "order of the input must not matter");
});

test("discounts never exceed the price", () => {
  assert.equal(discountAmount({ discountType: "flat", discountValue: 5000 }, 999), 999);
  assert.equal(discountAmount({ discountType: "percent", discountValue: 150 }, 1000), 1000);
  assert.equal(discountAmount({ discountType: "percent", discountValue: 20 }, 9990), 1998);
  assert.equal(discountAmount(null, 999), 0);
});

/* ---------------- quoting ---------------- */

test("the 12-paid-plus-2-free offer bills 12 months and grants 14", () => {
  const q = quotePlan({ plan: restaurantPro, billingCycle: "yearly", offers: [twoMonthsFree] });
  assert.equal(q.payable, 9990, "the customer pays the 12-month price");
  assert.equal(q.paidMonths, 12);
  assert.equal(q.bonusMonths, 2);
  assert.equal(q.totalMonths, 14, "access runs 14 months");
  assert.equal(q.offerId, "free2");
});

test("bonus months extend access but never the billing date", () => {
  const start = new Date("2026-01-15T00:00:00Z");
  assert.equal(computeEndDate({ startDate: start, paidMonths: 12, bonusMonths: 2 }).toISOString().slice(0, 10), "2027-03-15");
  assert.equal(
    computeNextBillingDate({ startDate: start, billingCycle: "yearly" }).toISOString().slice(0, 10),
    "2027-01-15",
    "Razorpay still charges at 12 months — the bonus is an entitlement, not a 14-month cycle"
  );
});

test("a percentage offer reduces the amount payable", () => {
  const q = quotePlan({ plan: restaurantPro, billingCycle: "yearly", offers: [twentyOff] });
  assert.equal(q.listPrice, 9990);
  assert.equal(q.discount, 1998);
  assert.equal(q.payable, 7992);
});

test("with no offer the customer pays list price", () => {
  const q = quotePlan({ plan: restaurantPro, billingCycle: "monthly", offers: [] });
  assert.equal(q.payable, 999);
  assert.equal(q.bonusMonths, 0);
  assert.equal(q.totalMonths, 1);
  assert.equal(q.offerId, null);
});

test("a monthly quote ignores a yearly-only offer", () => {
  const q = quotePlan({ plan: restaurantPro, billingCycle: "monthly", offers: [twoMonthsFree] });
  assert.equal(q.offerId, null);
  assert.equal(q.payable, 999);
});

test("month arithmetic clamps instead of rolling into the next month", () => {
  assert.equal(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString().slice(0, 10), "2026-02-28");
  assert.equal(addMonths(new Date("2024-01-31T00:00:00Z"), 1).toISOString().slice(0, 10), "2024-02-29", "leap year");
});

/* ---------------- subscription state ---------------- */

test("Razorpay statuses map onto the product's states", () => {
  assert.equal(mapRazorpayStatus("active"), "active");
  assert.equal(mapRazorpayStatus("halted"), "halted");
  assert.equal(mapRazorpayStatus("cancelled"), "cancelled");
  // "created" (checkout abandoned) and "authenticated" (mandate approved,
  // nothing charged yet) are kept apart rather than both reading as pending:
  // neither grants access, but they are different stories in an audit.
  assert.equal(mapRazorpayStatus("created"), "created");
  assert.equal(mapRazorpayStatus("authenticated"), "authenticated");
  // Razorpay's "pending" means a charge failed and it is retrying.
  assert.equal(mapRazorpayStatus("pending"), "payment_failed");
  assert.equal(mapRazorpayStatus("something-new"), "pending", "an unknown status must not grant access");
});

test("no pre-active state grants access", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  for (const status of ["created", "authenticated", "pending"]) {
    assert.equal(isEntitled({ status, endDate: "2026-12-31" }, now), false, `${status} must not unlock the product`);
  }
});

test("every state the product stores has a label", () => {
  SUBSCRIPTION_STATES.forEach(status => {
    assert.notEqual(statusLabel(status), "Unknown", `${status} renders as "Unknown" in the UI`);
  });
});

test("an active subscription is entitled until its end date", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  assert.equal(isEntitled({ status: "active", endDate: "2026-12-31" }, now), true);
  assert.equal(isEntitled({ status: "active", endDate: "2026-01-01" }, now), false);
});

test("a failed payment keeps access through the grace period, then stops", () => {
  const failedAt = "2026-06-01T00:00:00Z";
  const sub = { status: "payment_failed", paymentFailedAt: failedAt, gracePeriodDays: 7 };
  assert.equal(isEntitled(sub, new Date("2026-06-05T00:00:00Z")), true, "day 4 of grace");
  assert.equal(isEntitled(sub, new Date("2026-06-09T00:00:00Z")), false, "past the 7-day grace");
});

test("the grace period is configurable", () => {
  const sub = { status: "payment_failed", paymentFailedAt: "2026-06-01T00:00:00Z", gracePeriodDays: 30 };
  assert.equal(withinGracePeriod(sub, new Date("2026-06-20T00:00:00Z")), true);
  assert.equal(withinGracePeriod({ ...sub, gracePeriodDays: 0 }, new Date("2026-06-02T00:00:00Z")), false);
});

test("an expired subscription is not entitled", () => {
  assert.equal(isEntitled({ status: "expired" }), false);
  assert.equal(isEntitled({}), false, "no subscription at all is not entitled");
});

/* ---------------- features and limits ---------------- */

test("a plan with no feature flags grants everything", () => {
  assert.equal(planAllowsFeature({}, "qrOrdering"), true);
});

test("feature flags gate individual modules", () => {
  const plan = { features: { qrOrdering: true, whatsapp: false } };
  assert.equal(planAllowsFeature(plan, "qrOrdering"), true);
  assert.equal(planAllowsFeature(plan, "whatsapp"), false);
  assert.equal(planAllowsFeature(plan, "unlisted"), true, "an unlisted feature is not blocked");
});

test("-1 means unlimited and is never hardcoded", () => {
  assert.equal(planLimit({ limits: { maxTables: -1 } }, "maxTables"), UNLIMITED);
  assert.equal(planLimit({}, "maxTables"), UNLIMITED, "no limits configured = unlimited");
  assert.equal(limitLabel({ limits: { maxTables: -1 } }, "maxTables"), "Unlimited");
  assert.equal(limitLabel({ limits: { maxTables: 20 } }, "maxTables"), "20");
});

test("a numeric limit blocks only once it is reached", () => {
  const plan = { limits: { maxTables: 20 } };
  assert.equal(withinLimit(plan, "maxTables", 19), true);
  assert.equal(withinLimit(plan, "maxTables", 20), false);
  assert.equal(withinLimit({ limits: { maxTables: -1 } }, "maxTables", 99999), true);
});

/* =========================================================
   MODULE GRAPH FRESHNESS

   These are about deployment, not pricing. The Super Admin
   billing sections once disappeared entirely because
   super-admin-billing.js imported subscription-core.js with no
   version string: the browser kept a cached copy from before two
   exports existed, the import failed to LINK, and the whole
   module graph died before any code ran. No error reached the
   page — the nav items simply were not there.
========================================================= */
import { readFileSync, readdirSync } from "node:fs";

const JS_DIR = `${import.meta.dirname}/../public/js`;
const GRAPH = [
  "subscription-core.js", "subscription-client.js", "super-admin-billing.js",
  "super-admin-billing-boot.js", "business-subscription.js", "business-types.js",
  "business-type-ui.js", "plan-limits.js", "renew.js"
];

test("every relative import in the subscription graph is version-stamped", () => {
  const offenders = [];
  GRAPH.forEach(file => {
    const source = readFileSync(`${JS_DIR}/${file}`, "utf8");
    // Both static `from "./x.js"` and dynamic `import("./x.js")`.
    for (const match of source.matchAll(/(?:from\s+|import\()\s*["'](\.\/[a-z0-9-]+\.js)(\?[^"']*)?["']/gi)) {
      if (!match[2]?.includes("v=")) offenders.push(`${file} -> ${match[1]}`);
    }
  });
  assert.deepEqual(offenders, [], "an unversioned link can serve a stale module and break the whole graph");
});

test("the whole graph shares one version token", () => {
  const tokens = new Set();
  GRAPH.forEach(file => {
    const source = readFileSync(`${JS_DIR}/${file}`, "utf8");
    for (const match of source.matchAll(/\?v=([a-z0-9-]+)/gi)) tokens.add(match[1]);
  });
  // Mixed tokens are how half a graph goes stale: one module updates, its
  // dependency does not, and the pair no longer agree on what is exported.
  assert.equal(tokens.size, 1, `expected one shared token, found: ${[...tokens].join(", ")}`);
});

test("the Super Admin console loads its billing sections dynamically", () => {
  const boot = readFileSync(`${JS_DIR}/super-admin-billing-boot.js`, "utf8");
  assert.match(boot, /import\(/, "a static import cannot be caught if it fails to link");
  assert.match(boot, /catch/, "and the failure must be handled rather than lost");
});
