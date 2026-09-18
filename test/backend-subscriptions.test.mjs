import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Boot the REAL backend routes with firebase-admin and razorpay stubbed.
process.env.PORT = String(4600 + Math.floor(Math.random() * 300));
process.env.RAZORPAY_KEY_ID = "rzp_test_stub";
process.env.RAZORPAY_KEY_SECRET = "secret_stub";
process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_stub";
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: "stub", client_email: "a@b.c", private_key: "k" });
process.env.FIREBASE_STORAGE_BUCKET = "stub.appspot.com";

register("./stubs/backend-loader.mjs", pathToFileURL(`${import.meta.dirname}/`));

const admin = await import("./stubs/firebase-admin-stub.mjs");
const rzp = await import("./stubs/razorpay-stub.mjs");
await import("../backend/server.js");
await new Promise(resolve => setTimeout(resolve, 300)); // let app.listen bind

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const SUPER = "super-token";
const OWNER = "owner-token";

function reset() {
  admin.resetStore();
  rzp.resetCalls();
  admin.authUsers.set(SUPER, { uid: "super-uid", email: "boss@scan2plate.com" });
  admin.authUsers.set(OWNER, { uid: "owner-uid", email: "owner@bistro.com" });
  admin.seed("users/super-uid", { uid: "super-uid", role: "super_admin", status: "active" });
  admin.seed("restaurants/rest-1", {
    restaurantName: "Test Bistro", businessType: "Restaurant",
    ownerEmail: "owner@bistro.com", ownerUid: "owner-uid", status: "active"
  });
}

const post = (path, body, token) => fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body)
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/* ================= Super Admin plan catalogue ================= */

test("only a Super Admin can create a plan", async () => {
  reset();
  const anon = await post("/api/admin/plans", { name: "X", monthlyPrice: 100 });
  assert.equal(anon.status, 401, "no token is rejected");
  const owner = await post("/api/admin/plans", { name: "X", monthlyPrice: 100 }, OWNER);
  assert.equal(owner.status, 403, "a business owner is not a Super Admin");
  assert.equal(rzp.calls.plans.length, 0, "no Razorpay plan created for a rejected request");
});

test("creating a plan creates one Razorpay plan per priced cycle", async () => {
  reset();
  const res = await post("/api/admin/plans", {
    name: "Restaurant Professional", businessType: "restaurant",
    monthlyPrice: 999, yearlyPrice: 9990, trialDays: 0
  }, SUPER);
  assert.equal(res.status, 200);
  assert.equal(rzp.calls.plans.length, 2, "one monthly, one yearly");
  assert.deepEqual(rzp.calls.plans.map(p => p.period), ["monthly", "yearly"]);
  assert.equal(rzp.calls.plans[0].item.amount, 99900, "rupees converted to paise");
  assert.equal(rzp.calls.plans[1].item.amount, 999000);
  assert.ok(res.body.razorpayMonthlyPlanId && res.body.razorpayYearlyPlanId);
});

test("a monthly-only plan creates only a monthly Razorpay plan", async () => {
  reset();
  await post("/api/admin/plans", { name: "Vendor Basic", businessType: "street_vendor", monthlyPrice: 199, yearlyPrice: 0 }, SUPER);
  assert.equal(rzp.calls.plans.length, 1);
  assert.equal(rzp.calls.plans[0].period, "monthly");
});

test("editing a plan's NAME does not create another Razorpay plan", async () => {
  reset();
  const created = await post("/api/admin/plans", { name: "Restaurant Pro", businessType: "restaurant", monthlyPrice: 999 }, SUPER);
  assert.equal(rzp.calls.plans.length, 1);
  const firstPlanId = created.body.razorpayMonthlyPlanId;

  const edited = await post("/api/admin/plans", {
    planId: created.body.planId,
    name: "Restaurant Professional",           // renamed
    description: "Now with more features",     // and re-described
    businessType: "restaurant", monthlyPrice: 999
  }, SUPER);

  assert.equal(rzp.calls.plans.length, 1, "no duplicate Razorpay plan for a text-only edit");
  assert.equal(edited.body.razorpayMonthlyPlanId, firstPlanId, "keeps billing against the same Razorpay plan");
});

test("a genuine price change creates a new Razorpay plan, because Razorpay plans are immutable", async () => {
  reset();
  const created = await post("/api/admin/plans", { name: "Restaurant Pro", businessType: "restaurant", monthlyPrice: 999 }, SUPER);
  const before = created.body.razorpayMonthlyPlanId;

  const repriced = await post("/api/admin/plans", {
    planId: created.body.planId, name: "Restaurant Pro", businessType: "restaurant", monthlyPrice: 1299
  }, SUPER);

  assert.equal(rzp.calls.plans.length, 2, "a new plan is required for a new amount");
  assert.notEqual(repriced.body.razorpayMonthlyPlanId, before);
  assert.equal(rzp.calls.plans[1].item.amount, 129900);
});

test("a plan with no price is rejected", async () => {
  reset();
  const res = await post("/api/admin/plans", { name: "Empty", monthlyPrice: 0, yearlyPrice: 0 }, SUPER);
  assert.equal(res.status, 400);
});

/* ================= Subscription creation ================= */

async function makePlan(extra = {}) {
  const res = await post("/api/admin/plans", {
    name: "Restaurant Professional", businessType: "restaurant",
    monthlyPrice: 999, yearlyPrice: 9990, gracePeriodDays: 7, ...extra
  }, SUPER);
  return res.body.planId;
}

test("a subscription bills against the plan id resolved on the server", async () => {
  reset();
  const planId = await makePlan();
  const res = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "yearly" }, OWNER);
  assert.equal(res.status, 200);
  assert.equal(rzp.calls.subscriptions.length, 1);
  const sent = rzp.calls.subscriptions[0];
  assert.match(sent.plan_id, /^plan_stub_/);
  assert.equal(sent.notes.billingCycle, "yearly");
  assert.equal(sent.notes.businessId, "rest-1");
  assert.equal(res.body.amount, 999000, "the yearly amount, in paise, from the server catalogue");
});

test("a business cannot start a subscription for someone else's business", async () => {
  reset();
  const planId = await makePlan();
  admin.seed("restaurants/rest-2", { restaurantName: "Other", ownerEmail: "someone@else.com", ownerUid: "other-uid" });
  const res = await post("/api/subscriptions/create", { restaurantId: "rest-2", planId }, OWNER);
  assert.notEqual(res.status, 200);
  assert.equal(rzp.calls.subscriptions.length, 0);
});

test("a bonus-month offer is applied only when it genuinely matches", async () => {
  reset();
  const planId = await makePlan();
  admin.seed("offers/free2", {
    name: "2 Months Free", businessType: "restaurant", billingCycle: "yearly",
    bonusMonths: 2, active: true, startDate: "2026-01-01", endDate: "2030-12-31"
  });
  const yearly = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "yearly", offerId: "free2" }, OWNER);
  assert.equal(yearly.body.bonusMonths, 2);

  // The same offer claimed on a MONTHLY subscription must be ignored.
  const monthly = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "monthly", offerId: "free2" }, OWNER);
  assert.equal(monthly.body.bonusMonths, 0, "a yearly-only offer cannot be claimed on a monthly cycle");
});

test("an expired or inactive offer cannot be self-granted by the client", async () => {
  reset();
  const planId = await makePlan();
  admin.seed("offers/stale", { businessType: "restaurant", billingCycle: "yearly", bonusMonths: 6, active: true, startDate: "2020-01-01", endDate: "2020-12-31" });
  admin.seed("offers/off", { businessType: "restaurant", billingCycle: "yearly", bonusMonths: 6, active: false });

  const expired = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "yearly", offerId: "stale" }, OWNER);
  assert.equal(expired.body.bonusMonths, 0, "an out-of-window offer grants nothing");
  const disabled = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "yearly", offerId: "off" }, OWNER);
  assert.equal(disabled.body.bonusMonths, 0, "a deactivated offer grants nothing");
});

test("a trial plan starts in trial and defers the first charge", async () => {
  reset();
  const planId = await makePlan({ trialDays: 14 });
  const res = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "monthly" }, OWNER);
  assert.equal(res.body.trialDays, 14);
  assert.ok(rzp.calls.subscriptions[0].start_at > Math.floor(Date.now() / 1000), "Razorpay start_at is pushed past the trial");
  const stored = admin.readAll("subscriptions")[0].data;
  assert.equal(stored.status, "trial");
});

/* ================= Webhook ================= */

const sign = body => crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(JSON.stringify(body)).digest("hex");

const webhook = (body, { signature, eventId } = {}) => fetch(`${BASE}/api/webhooks/razorpay`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-razorpay-signature": signature === undefined ? sign(body) : signature,
    ...(eventId ? { "x-razorpay-event-id": eventId } : {})
  },
  body: JSON.stringify(body)
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

function chargedEvent(razorpaySubscriptionId) {
  return {
    event: "subscription.charged",
    payload: {
      subscription: { entity: { id: razorpaySubscriptionId, status: "active",
        current_start: Math.floor(Date.parse("2026-09-18T00:00:00Z") / 1000),
        current_end: Math.floor(Date.parse("2027-09-18T00:00:00Z") / 1000) } },
      payment: { entity: { id: "pay_1", amount: 999000 } }
    }
  };
}

async function activeSubscription({ billingCycle = "yearly", offerId = "" } = {}) {
  const planId = await makePlan();
  if (offerId) {
    admin.seed(`offers/${offerId}`, { businessType: "restaurant", billingCycle: "yearly", bonusMonths: 2, active: true, startDate: "2026-01-01", endDate: "2030-12-31" });
  }
  const res = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle, offerId }, OWNER);
  return res.body.razorpaySubscriptionId;
}

test("a webhook with a bad signature is rejected and changes nothing", async () => {
  reset();
  const subId = await activeSubscription();
  const res = await webhook(chargedEvent(subId), { signature: "deadbeef" });
  assert.equal(res.status, 400);
  const stored = admin.readAll("subscriptions")[0].data;
  assert.notEqual(stored.status, "active", "an unsigned event must not activate a subscription");
});

test("a correctly signed charge activates the subscription", async () => {
  reset();
  const subId = await activeSubscription();
  const res = await webhook(chargedEvent(subId), { eventId: "evt_1" });
  assert.equal(res.status, 200);
  assert.equal(res.body.matched, true);
  const stored = admin.readAll("subscriptions")[0].data;
  assert.equal(stored.status, "active");
  assert.equal(stored.lastPaymentAmount, 9990, "paise converted back to rupees");
});

test("a duplicate delivery of the same event is a no-op", async () => {
  reset();
  const subId = await activeSubscription();
  await webhook(chargedEvent(subId), { eventId: "evt_dup" });
  const first = admin.readAll("subscriptions")[0].data;

  const second = await webhook(chargedEvent(subId), { eventId: "evt_dup" });
  assert.equal(second.status, 200, "still 2xx, so Razorpay stops retrying");
  assert.equal(second.body.duplicate, true);
  assert.equal(admin.readAll("subscriptions").length, 1, "no second subscription record");
  assert.equal(admin.readAll("subscriptionEvents").length, 1, "one event record, not two");
  assert.deepEqual(admin.readAll("subscriptions")[0].data.lastPaymentId, first.lastPaymentId);
});

test("bonus months extend access beyond the paid period", async () => {
  reset();
  const subId = await activeSubscription({ offerId: "free2" });
  await webhook(chargedEvent(subId), { eventId: "evt_bonus" });
  const stored = admin.readAll("subscriptions")[0].data;
  // Paid period ends 2027-09-18; two bonus months take access to 2027-11-18.
  assert.equal(new Date(stored.endDate).toISOString().slice(0, 10), "2027-11-18");
  assert.equal(new Date(stored.nextBillingDate).toISOString().slice(0, 10), "2027-09-18", "billing date is unchanged by the bonus");
});

test("a failed recurring payment marks payment_failed without deleting anything", async () => {
  reset();
  const subId = await activeSubscription();
  await webhook(chargedEvent(subId), { eventId: "evt_ok" });
  const res = await webhook({ event: "subscription.pending", payload: { subscription: { entity: { id: subId, status: "pending" } } } }, { eventId: "evt_fail" });
  assert.equal(res.status, 200);
  const stored = admin.readAll("subscriptions")[0].data;
  assert.equal(stored.status, "payment_failed");
  assert.ok(stored.paymentFailedAt, "the clock for the grace period starts");
  assert.ok(admin.store.get("restaurants/rest-1"), "the business record still exists");
});

test("the business record mirrors status so existing access checks keep working", async () => {
  reset();
  const subId = await activeSubscription();
  await webhook(chargedEvent(subId), { eventId: "evt_mirror" });
  const business = admin.store.get("restaurants/rest-1");
  assert.equal(business.subscriptionStatus, "active");
  assert.equal(business.status, "active");
  assert.equal(business.planExpiryDate, "2027-09-18", "login.js and admin.js read this field");
  assert.equal(business.restaurantName, "Test Bistro", "existing business fields are untouched");
});

test("a webhook for an unknown subscription is acknowledged, not retried forever", async () => {
  reset();
  const res = await webhook(chargedEvent("sub_never_seen"), { eventId: "evt_unknown" });
  assert.equal(res.status, 200);
  assert.equal(res.body.matched, false);
});

test("cancelling goes through the server and records the state", async () => {
  reset();
  const planId = await makePlan();
  const created = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "monthly" }, OWNER);
  const res = await post(`/api/subscriptions/${created.body.subscriptionId}/cancel`, {}, OWNER);
  assert.equal(res.status, 200);
  assert.equal(rzp.calls.cancels.length, 1, "Razorpay was told, not just Firestore");
  assert.equal(rzp.calls.cancels[0].payload.cancel_at_cycle_end, 1, "defaults to end-of-cycle, not instant cut-off");
  assert.equal(admin.readAll("subscriptions")[0].data.status, "cancelled");
});

/* =========================================================
   MANUALLY CREATED RAZORPAY PLAN IDS

   The path a real operator takes: create the plan in the
   Razorpay dashboard, paste its id into Super Admin. Everything
   here is about what happens when the pasted id is WRONG,
   because a plan id that silently bills the wrong amount, in the
   wrong mode, is money.
========================================================= */

test("a pasted plan id is verified against Razorpay and stored with its mode", async () => {
  reset();
  rzp.seedPlan("plan_RealMonthly01", { period: "monthly", amount: 49900 });
  const res = await post("/api/admin/plans", {
    name: "Scan2Plate Monthly", businessType: "restaurant",
    monthlyPrice: 499, razorpayMonthlyPlanId: "plan_RealMonthly01"
  }, SUPER);
  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body.razorpayMonthlyPlanId, "plan_RealMonthly01");
  assert.equal(rzp.calls.plans.length, 0, "a pasted id must never trigger a duplicate plan creation");
  assert.ok(rzp.calls.fetches.includes("plan_RealMonthly01"), "the id was actually checked at Razorpay");

  const stored = admin.readAll("subscriptionPlans")[0].data;
  assert.equal(stored.razorpayMonthlyPlanId, "plan_RealMonthly01");
  assert.equal(stored.razorpayMonthlyAmountPaise, 49900, "the amount recorded is Razorpay's, not the typed one");
  assert.equal(stored.razorpayMonthlyPlanMode, "test", "recorded against the key mode in use");
  assert.equal(stored.razorpayMonthlyPlanSource, "manual");
});

test("a plan id from the other Razorpay mode is rejected with a mode-specific reason", async () => {
  reset();
  // Not seeded: from Razorpay's point of view on these keys, it does not exist.
  const res = await post("/api/admin/plans", {
    name: "Live Plan On Test Keys", monthlyPrice: 499, razorpayMonthlyPlanId: "plan_LiveModeOnly1"
  }, SUPER);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /TEST/, "names the mode this server is actually using");
  assert.match(res.body.error, /LIVE/, "and the mode the plan was probably created in");
  assert.equal(admin.readAll("subscriptionPlans").length, 0, "nothing is stored on a rejected id");
});

test("a plan id whose amount disagrees with the advertised price is rejected", async () => {
  reset();
  rzp.seedPlan("plan_Cheap0001", { period: "monthly", amount: 49900 });   // Razorpay charges 499
  const res = await post("/api/admin/plans", {
    name: "Mismatch", monthlyPrice: 599, razorpayMonthlyPlanId: "plan_Cheap0001"
  }, SUPER);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /499/);
  assert.match(res.body.error, /599/, "both numbers are named, so the fix is obvious");
});

test("a monthly plan id pasted into the yearly field is rejected", async () => {
  reset();
  rzp.seedPlan("plan_Monthly0001", { period: "monthly", amount: 49900 });
  const res = await post("/api/admin/plans", {
    name: "Wrong Box", yearlyPrice: 499, razorpayYearlyPlanId: "plan_Monthly0001"
  }, SUPER);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /monthly/i);
});

test("something that is not a plan id fails before any Razorpay call", async () => {
  reset();
  for (const bad of ["your_plan_id", "sub_Abc123456", "https://dashboard.razorpay.com/plan_X", "plan_"]) {
    const res = await post("/api/admin/plans", { name: "Bad", monthlyPrice: 499, razorpayMonthlyPlanId: bad }, SUPER);
    assert.equal(res.status, 400, `"${bad}" should be rejected`);
    assert.match(res.body.error, /plan_/);
  }
  assert.equal(rzp.calls.fetches.length, 0, "no pointless API calls for an obviously wrong value");
});

test("a pasted id fills in a price that was left blank", async () => {
  reset();
  rzp.seedPlan("plan_Priced00001", { period: "monthly", amount: 49900 });
  const res = await post("/api/admin/plans", {
    name: "Price From Razorpay", razorpayMonthlyPlanId: "plan_Priced00001"
  }, SUPER);
  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body.monthlyPrice, 499);
});

test("renaming a plan leaves a manually entered id alone and calls nothing", async () => {
  reset();
  rzp.seedPlan("plan_Stable00001", { period: "monthly", amount: 49900 });
  const first = await post("/api/admin/plans", { name: "Before", monthlyPrice: 499, razorpayMonthlyPlanId: "plan_Stable00001" }, SUPER);
  const planId = first.body.planId;
  rzp.resetCalls();

  const res = await post("/api/admin/plans", { planId, name: "After", monthlyPrice: 499 }, SUPER);
  assert.equal(res.status, 200, res.body.error);
  assert.equal(res.body.razorpayMonthlyPlanId, "plan_Stable00001", "the id survives an edit that omits it");
  assert.equal(rzp.calls.plans.length, 0, "no new Razorpay plan");
  assert.equal(rzp.calls.fetches.length, 0, "no re-verification of an unchanged id");
  assert.equal(admin.readAll("subscriptionPlans")[0].data.name, "After");
});

test("changing the price of a hand-managed plan refuses rather than silently creating a second one", async () => {
  reset();
  rzp.seedPlan("plan_Manual000001", { period: "monthly", amount: 49900 });
  const first = await post("/api/admin/plans", { name: "Manual", monthlyPrice: 499, razorpayMonthlyPlanId: "plan_Manual000001" }, SUPER);
  rzp.resetCalls();

  const res = await post("/api/admin/plans", { planId: first.body.planId, name: "Manual", monthlyPrice: 599 }, SUPER);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot be edited/i);
  assert.equal(rzp.calls.plans.length, 0, "no plan is created behind an operator managing plans by hand");
  assert.equal(admin.readAll("subscriptionPlans")[0].data.monthlyPrice, 499, "the stored plan is unchanged");
});

test("auto-creation can be switched off entirely", async () => {
  reset();
  const res = await post("/api/admin/plans", {
    name: "Hand Managed", monthlyPrice: 499, autoCreateRazorpayPlans: false
  }, SUPER);
  assert.equal(res.status, 400);
  assert.equal(rzp.calls.plans.length, 0);
  assert.match(res.body.error, /Super Admin/);
});

/* =========================================================
   BUSINESS TYPE ISOLATION
========================================================= */

test("a restaurant cannot subscribe to a hostel plan even by sending its id", async () => {
  reset();
  const hostelPlan = await makePlan({ name: "Hostel Basic", businessType: "hostel", monthlyPrice: 699, yearlyPrice: 0 });
  const res = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId: hostelPlan, billingCycle: "monthly" }, OWNER);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "plan_business_type_mismatch");
  assert.equal(rzp.calls.subscriptions.length, 0, "nothing is created at Razorpay for a mismatched plan");
  assert.equal(admin.readAll("subscriptions").length, 0, "and nothing is stored");
});

test("the business record's type decides, not the request body", async () => {
  reset();
  const hostelPlan = await makePlan({ name: "Hostel Basic", businessType: "hostel", monthlyPrice: 699, yearlyPrice: 0 });
  const res = await post("/api/subscriptions/create", {
    restaurantId: "rest-1", planId: hostelPlan, billingCycle: "monthly",
    businessType: "hostel"   // the client claiming to be a hostel changes nothing
  }, OWNER);
  assert.equal(res.status, 403);
});

test("a legacy business type spelling still matches its plan", async () => {
  reset();
  // Stored as the panel name older records use, not a clean id.
  admin.seed("restaurants/rest-1", {
    restaurantName: "Test Bistro", businessType: "RestaurantAdmin",
    ownerEmail: "owner@bistro.com", ownerUid: "owner-uid", status: "active"
  });
  const planId = await makePlan();
  const res = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "monthly" }, OWNER);
  assert.equal(res.status, 200, res.body.error);
  assert.equal(admin.readAll("subscriptions")[0].data.businessType, "restaurant", "normalised on the way in");
});

test("a global plan is sellable to every type, and its subset restriction is honoured", async () => {
  reset();
  const globalPlan = await makePlan({ name: "Global", businessType: "all", monthlyPrice: 299, yearlyPrice: 0 });
  const open = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId: globalPlan, billingCycle: "monthly" }, OWNER);
  assert.equal(open.status, 200, open.body.error);

  const narrowed = await makePlan({ name: "Hostels + Hotels", businessType: "all", businessTypes: ["hostel", "hotel"], monthlyPrice: 299, yearlyPrice: 0 });
  const blocked = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId: narrowed, billingCycle: "monthly" }, OWNER);
  assert.equal(blocked.status, 403, "a global plan narrowed to other types is not for a restaurant");
});

test("a plan configured for the other Razorpay mode is never billed", async () => {
  reset();
  const planId = await makePlan();
  // Simulate a deployment that was switched from live keys to test keys.
  admin.seed(`subscriptionPlans/${planId}`, {
    ...admin.store.get(`subscriptionPlans/${planId}`),
    razorpayMonthlyPlanMode: "live"
  });
  const res = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "monthly" }, OWNER);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "razorpay_mode_mismatch");
  assert.equal(rzp.calls.subscriptions.length, 0);
  assert.doesNotMatch(JSON.stringify(res.body), /rzp_|secret/i, "the owner is not shown key details");
});

test("checkout never invents a Razorpay plan for an unconfigured cycle", async () => {
  reset();
  const planId = await makePlan({ monthlyPrice: 499, yearlyPrice: 0 });
  // Yearly price added directly, bypassing the Super Admin route, so no
  // yearly Razorpay plan exists for it.
  admin.seed(`subscriptionPlans/${planId}`, { ...admin.store.get(`subscriptionPlans/${planId}`), yearlyPrice: 4990 });
  rzp.resetCalls();

  const res = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "yearly" }, OWNER);
  assert.notEqual(res.status, 200);
  assert.equal(rzp.calls.plans.length, 0, "a customer's checkout must not create plans");
  assert.equal(rzp.calls.subscriptions.length, 0);
});

/* =========================================================
   SUBSCRIPTION STATES AND THE AUDIT RECORD
========================================================= */

test("a subscription starts as created, not pending", async () => {
  reset();
  const planId = await makePlan();
  await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "monthly" }, OWNER);
  const stored = admin.readAll("subscriptions")[0].data;
  assert.equal(stored.status, "created", "nothing has been authorised or charged yet");
});

test("mandate approval is recorded as authenticated, distinct from a failed charge", async () => {
  reset();
  const subId = await activeSubscription({ billingCycle: "monthly" });
  await webhook({ event: "subscription.authenticated", payload: { subscription: { entity: { id: subId, status: "authenticated" } } } }, { eventId: "evt_auth" });
  assert.equal(admin.readAll("subscriptions")[0].data.status, "authenticated");

  await webhook({ event: "subscription.pending", payload: { subscription: { entity: { id: subId, status: "pending" } } } }, { eventId: "evt_pending" });
  assert.equal(admin.readAll("subscriptions")[0].data.status, "payment_failed", "Razorpay's 'pending' is a failed charge");
});

test("a late authenticated event cannot walk an active subscription backwards", async () => {
  reset();
  const subId = await activeSubscription();
  await webhook(chargedEvent(subId), { eventId: "evt_charge" });
  assert.equal(admin.readAll("subscriptions")[0].data.status, "active");

  await webhook({ event: "subscription.authenticated", payload: { subscription: { entity: { id: subId } } } }, { eventId: "evt_late_auth" });
  assert.equal(admin.readAll("subscriptions")[0].data.status, "active", "out-of-order delivery must not deactivate a paid subscription");
});

test("the subscription record carries what an audit needs", async () => {
  reset();
  const subId = await activeSubscription();
  const before = admin.readAll("subscriptions")[0].data;
  assert.equal(before.businessId, "rest-1");
  assert.equal(before.businessType, "restaurant");
  assert.ok(before.planId, "planId");
  assert.match(before.razorpayPlanId, /^plan_/);
  assert.equal(before.razorpaySubscriptionId, subId);
  assert.equal(before.razorpayMode, "test");
  assert.equal(before.currency, "INR");
  assert.equal(before.customer.email, "owner@bistro.com", "who it belongs to, captured at creation");
  assert.equal(before.customer.businessName, "Test Bistro");

  await webhook(chargedEvent(subId), { eventId: "evt_audit" });
  const after = admin.readAll("subscriptions")[0].data;
  assert.equal(after.currentPeriodStart.toISOString().slice(0, 10), "2026-09-18");
  assert.equal(after.currentPeriodEnd.toISOString().slice(0, 10), "2027-09-18");
  assert.equal(after.expiryDate.toISOString().slice(0, 10), "2027-09-18");
  assert.equal(after.paymentId, "pay_1");
  assert.equal(after.lastPaymentAmount, 9990);
});

test("no Razorpay secret reaches any subscription API response", async () => {
  reset();
  rzp.seedPlan("plan_Secrecy00001", { period: "monthly", amount: 49900 });
  const planRes = await post("/api/admin/plans", { name: "Secrecy", monthlyPrice: 499, razorpayMonthlyPlanId: "plan_Secrecy00001" }, SUPER);
  const createRes = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId: planRes.body.planId, billingCycle: "monthly" }, OWNER);
  const health = await fetch(`${BASE}/api/health`).then(r => r.json());

  for (const [label, body] of [["plans", planRes.body], ["create", createRes.body], ["health", health]]) {
    const json = JSON.stringify(body);
    assert.doesNotMatch(json, /secret_stub/, `${label} leaks RAZORPAY_KEY_SECRET`);
    assert.doesNotMatch(json, /whsec_stub/, `${label} leaks RAZORPAY_WEBHOOK_SECRET`);
    assert.doesNotMatch(json, /keySecret|key_secret/i, `${label} carries a secret field`);
  }
  assert.equal(createRes.body.publicKeyId, "rzp_test_stub", "only the public key id crosses to the browser");
  assert.equal(health.razorpayKeyIdPreview, "rzp_test_st…", "the health check masks even the public id");
});

/* =========================================================
   SUPER ADMIN RECOGNITION

   The console and the server must agree on who is a Super
   Admin. They did not: an account granted only through the
   `superAdmins` collection got into the console and was then
   refused by every route it called.
========================================================= */

const asSuper = (token, uid, email) => { admin.authUsers.set(token, { uid, email }); };

test("a grant in superAdmins is accepted, as the console already accepts it", async () => {
  reset();
  asSuper("t-sa", "sa-uid", "ops@scan2plate.com");
  admin.seed("superAdmins/sa-uid", { uid: "sa-uid", email: "ops@scan2plate.com", role: "super_admin", status: "active" });
  const res = await post("/api/admin/plans", { name: "Via superAdmins", monthlyPrice: 499 }, "t-sa");
  assert.equal(res.status, 200, res.body.error);
});

test("a superAdmins document with no role field still grants access", async () => {
  reset();
  asSuper("t-bare", "bare-uid", "bare@scan2plate.com");
  // Membership of a collection literally named superAdmins is the grant.
  admin.seed("superAdmins/bare-uid", { uid: "bare-uid", email: "bare@scan2plate.com" });
  const res = await post("/api/admin/plans", { name: "Bare", monthlyPrice: 499 }, "t-bare");
  assert.equal(res.status, 200, res.body.error);
});

test("the snake_case super_admins collection works too", async () => {
  reset();
  asSuper("t-snake", "snake-uid", "snake@scan2plate.com");
  admin.seed("super_admins/snake-uid", { uid: "snake-uid", role: "super_admin", status: "active" });
  const res = await post("/api/admin/plans", { name: "Snake", monthlyPrice: 499 }, "t-snake");
  assert.equal(res.status, 200, res.body.error);
});

test("a disabled super admin is refused even with a superAdmins document", async () => {
  reset();
  asSuper("t-off", "off-uid", "off@scan2plate.com");
  admin.seed("superAdmins/off-uid", { uid: "off-uid", role: "super_admin", status: "disabled" });
  const res = await post("/api/admin/plans", { name: "Disabled", monthlyPrice: 499 }, "t-off");
  assert.equal(res.status, 403);
  assert.equal(rzp.calls.plans.length, 0);
});

test("a superAdmins document that explicitly names a lesser role is refused", async () => {
  reset();
  asSuper("t-lesser", "lesser-uid", "lesser@scan2plate.com");
  admin.seed("superAdmins/lesser-uid", { uid: "lesser-uid", role: "admin", status: "active" });
  const res = await post("/api/admin/plans", { name: "Lesser", monthlyPrice: 499 }, "t-lesser");
  assert.equal(res.status, 403, "an explicit non-super role is honoured, unlike in the browser");
});

test("an ordinary business owner is still not a Super Admin", async () => {
  reset();
  const res = await post("/api/admin/plans", { name: "Nope", monthlyPrice: 499 }, OWNER);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "not_super_admin");
  assert.match(res.body.error, /Firestore/, "says where the missing record belongs");
  // Which account was checked. The console can show a stale localStorage
  // session, so "this account" is not always the one the operator assumes.
  assert.equal(res.body.uid, "owner-uid");
  assert.equal(res.body.email, "owner@bistro.com");
  assert.match(res.body.error, /owner@bistro\.com/);
  assert.match(res.body.error, /superAdmins\/owner-uid/, "names the exact document to create");
  assert.equal(rzp.calls.plans.length, 0);
});

/* =========================================================
   COUPON CODES

   A coupon is money. Most of these are about what happens when
   one is claimed that should not be.
========================================================= */

function seedCoupon(id, fields) {
  admin.seed(`offers/${id}`, { active: true, endDate: "2030-12-31", ...fields });
}

test("a coupon offer is never applied automatically", async () => {
  reset();
  const planId = await makePlan();
  seedCoupon("half", { name: "Half", code: "SAVE50", businessType: "restaurant", discountType: "percent", discountValue: 50, razorpayOfferId: "offer_x", priority: 99 });
  const res = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "monthly" }, OWNER);
  assert.equal(res.status, 200, res.body.error);
  const stored = admin.readAll("subscriptions")[0].data;
  assert.equal(stored.offerId, null, "a code nobody typed grants nothing");
  assert.equal(stored.couponCode, "");
});

test("a valid code is accepted and passed to Razorpay as a real discount", async () => {
  reset();
  const planId = await makePlan();
  seedCoupon("half", { name: "Half", code: "SAVE50", businessType: "restaurant", discountType: "percent", discountValue: 50, razorpayOfferId: "offer_real1" });
  const res = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "monthly", couponCode: "save 50" }, OWNER);
  assert.equal(res.status, 200, res.body.error);
  assert.equal(rzp.calls.subscriptions[0].offer_id, "offer_real1", "Razorpay applies it — a plan's amount cannot be edited");
  assert.equal(admin.readAll("subscriptions")[0].data.couponCode, "SAVE50");
});

test("a partial discount with no Razorpay offer is refused, not charged in full", async () => {
  reset();
  const planId = await makePlan();
  seedCoupon("broken", { name: "Broken", code: "HALFOFF", businessType: "restaurant", discountType: "percent", discountValue: 50 });
  const res = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "monthly", couponCode: "HALFOFF" }, OWNER);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "coupon_unbacked");
  assert.equal(rzp.calls.subscriptions.length, 0, "showing a discount and charging full price is the one unacceptable outcome");
});

test("an unknown, expired or inactive code is refused with a reason", async () => {
  reset();
  const planId = await makePlan();
  seedCoupon("old", { name: "Old", code: "LASTYEAR", discountType: "percent", discountValue: 100, startDate: "2020-01-01", endDate: "2020-12-31" });
  seedCoupon("off", { name: "Off", code: "DISABLED", discountType: "percent", discountValue: 100, active: false });

  const unknown = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, couponCode: "NOTREAL" }, OWNER);
  assert.match(unknown.body.error, /not recognised/i);
  const expired = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, couponCode: "LASTYEAR" }, OWNER);
  assert.match(expired.body.error, /expired/i);
  const disabled = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, couponCode: "DISABLED" }, OWNER);
  assert.match(disabled.body.error, /no longer active/i);
  assert.equal(rzp.calls.subscriptions.length, 0);
});

test("a coupon for another business type cannot be used", async () => {
  reset();
  const planId = await makePlan();
  seedCoupon("hostels", { name: "Hostels", code: "HOSTEL100", businessType: "hostel", discountType: "percent", discountValue: 100 });
  const res = await post("/api/subscriptions/redeem", { restaurantId: "rest-1", planId, billingCycle: "monthly", code: "HOSTEL100" }, OWNER);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /different type of business/i);
  assert.equal(admin.readAll("subscriptions").length, 0);
});

test("a 100% coupon activates without any Razorpay call", async () => {
  reset();
  const planId = await makePlan();
  seedCoupon("free", { name: "Free Year", code: "WELCOME100", businessType: "restaurant", discountType: "percent", discountValue: 100 });
  const res = await post("/api/subscriptions/redeem", { restaurantId: "rest-1", planId, billingCycle: "monthly", code: "welcome100" }, OWNER);
  assert.equal(res.status, 200, res.body.error);
  assert.equal(rzp.calls.subscriptions.length, 0, "Razorpay cannot create a zero-rupee subscription");

  const stored = admin.readAll("subscriptions")[0].data;
  assert.equal(stored.status, "active");
  assert.equal(stored.amount, 0);
  assert.equal(stored.listPrice, 999, "what it would have cost, kept for the books");
  assert.equal(stored.grantedByCoupon, true, "revenue reporting must not read this as a sale");
  assert.equal(stored.couponCode, "WELCOME100");

  const business = admin.store.get("restaurants/rest-1");
  assert.equal(business.subscriptionStatus, "active", "no webhook is coming, so access is mirrored here");
  assert.ok(business.planExpiryDate, "and the existing login checks read this");
});

test("redeeming counts against maxRedemptions", async () => {
  reset();
  const planId = await makePlan();
  seedCoupon("one", { name: "One use", code: "ONCE", businessType: "restaurant", discountType: "percent", discountValue: 100, maxRedemptions: 1, redemptions: 0 });
  const first = await post("/api/subscriptions/redeem", { restaurantId: "rest-1", planId, billingCycle: "monthly", code: "ONCE" }, OWNER);
  assert.equal(first.status, 200, first.body.error);
  assert.equal(admin.store.get("offers/one").redemptions, 1);

  const second = await post("/api/subscriptions/redeem", { restaurantId: "rest-1", planId, billingCycle: "monthly", code: "ONCE" }, OWNER);
  assert.equal(second.status, 400, "a one-use code is not reusable");
  assert.match(second.body.error, /fully claimed/i);
  assert.equal(admin.readAll("subscriptions").length, 1);
});

test("redeem refuses a coupon that does not cover the whole price", async () => {
  reset();
  const planId = await makePlan();
  seedCoupon("half", { name: "Half", code: "SAVE50", businessType: "restaurant", discountType: "percent", discountValue: 50, razorpayOfferId: "offer_x" });
  const res = await post("/api/subscriptions/redeem", { restaurantId: "rest-1", planId, billingCycle: "monthly", code: "SAVE50" }, OWNER);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /requires payment/i, "free access is only ever granted for a genuinely free coupon");
  assert.equal(admin.readAll("subscriptions").length, 0);
});

test("a 100% coupon cannot be pushed through the paid route either", async () => {
  reset();
  const planId = await makePlan();
  seedCoupon("free", { name: "Free", code: "FREE100", businessType: "restaurant", discountType: "percent", discountValue: 100 });
  const res = await post("/api/subscriptions/create", { restaurantId: "rest-1", planId, billingCycle: "monthly", couponCode: "FREE100" }, OWNER);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "coupon_is_free");
  assert.equal(rzp.calls.subscriptions.length, 0, "a zero-rupee Razorpay subscription is impossible, so this must not be attempted");
});

test("redeeming needs ownership of the business", async () => {
  reset();
  const planId = await makePlan();
  admin.seed("restaurants/rest-2", { restaurantName: "Other", ownerEmail: "someone@else.com", ownerUid: "other-uid", businessType: "Restaurant" });
  seedCoupon("free", { name: "Free", code: "FREE100", businessType: "restaurant", discountType: "percent", discountValue: 100 });
  const res = await post("/api/subscriptions/redeem", { restaurantId: "rest-2", planId, billingCycle: "monthly", code: "FREE100" }, OWNER);
  assert.notEqual(res.status, 200, "a coupon does not grant access to someone else's business");
  assert.equal(admin.readAll("subscriptions").length, 0);
});

test("validate prices a coupon without granting anything", async () => {
  reset();
  const planId = await makePlan();
  seedCoupon("half", { name: "Half", code: "SAVE50", businessType: "restaurant", discountType: "percent", discountValue: 50, razorpayOfferId: "offer_x" });
  const res = await post("/api/coupons/validate", { restaurantId: "rest-1", planId, billingCycle: "monthly", code: "SAVE50" }, OWNER);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.listPrice, 999);
  assert.equal(res.body.discount, 499.5);
  assert.equal(res.body.payable, 499.5);
  assert.equal(res.body.free, false);
  assert.equal(admin.readAll("subscriptions").length, 0, "checking a coupon must not create anything");
  assert.equal(admin.store.get("offers/half").redemptions ?? 0, 0, "nor spend a redemption");
});

test("validate flags a free coupon so the page offers redeem, not pay", async () => {
  reset();
  const planId = await makePlan();
  seedCoupon("free", { name: "Free", code: "FREE100", businessType: "restaurant", discountType: "percent", discountValue: 100 });
  const res = await post("/api/coupons/validate", { restaurantId: "rest-1", planId, billingCycle: "monthly", code: "FREE100" }, OWNER);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.free, true);
  assert.equal(res.body.payable, 0);
});

test("a coupon is never checked for someone else's business", async () => {
  reset();
  const planId = await makePlan();
  admin.seed("restaurants/rest-2", { restaurantName: "Other", ownerEmail: "someone@else.com", ownerUid: "other-uid" });
  const res = await post("/api/coupons/validate", { restaurantId: "rest-2", planId, code: "ANY" }, OWNER);
  assert.notEqual(res.status, 200);
});
