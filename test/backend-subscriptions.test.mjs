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
