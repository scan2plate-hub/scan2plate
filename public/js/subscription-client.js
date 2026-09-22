/* =========================================================
   SUBSCRIPTION CLIENT

   Firestore access for the plan catalogue, offers and a
   business's own subscription.

   Query shape is deliberately simple: each collection is fetched
   with a single equality filter on `active`, which Firestore
   serves from its automatic single-field index. Business-type
   matching then happens in memory via subscription-core. A
   composite `businessType in [...] + active + orderBy` query
   would need a hand-built index and would still return the same
   handful of documents — a plan catalogue is tens of rows, not
   thousands.

   Results are cached per page load, so opening the pricing page,
   the subscription panel and an offer popup costs one read of
   each collection rather than three.
========================================================= */
import { db, auth } from "./firebase.js?v=s2p-20260922d";
import {
  collection, doc, getDoc, getDocs, onSnapshot, query, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { plansForBusinessType, bestOffer, quotePlan } from "./subscription-core.js?v=s2p-20260922d";
import { businessTypeOf } from "./business-types.js?v=s2p-20260922d";
import { getBackendBaseUrl } from "./common.js?v=s2p-20260922d";

const cache = { plans: null, offers: null };

async function fetchActive(collectionName) {
  const snap = await getDocs(query(collection(db, collectionName), where("active", "==", true)));
  return snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
}

/** All active plans (cached). Pass force to re-read after an edit. */
export async function loadPlans({ force = false } = {}) {
  if (!cache.plans || force) cache.plans = await fetchActive("subscriptionPlans");
  return cache.plans;
}

export async function loadOffers({ force = false } = {}) {
  if (!cache.offers || force) cache.offers = await fetchActive("offers");
  return cache.offers;
}

export function clearSubscriptionCache() {
  cache.plans = null;
  cache.offers = null;
}

/** Plans this business type may buy, already ordered for display. */
export async function plansFor(businessType, options = {}) {
  return plansForBusinessType(await loadPlans(options), businessType);
}

/**
 * Everything the pricing page needs in one call: the plans for this business
 * type, each quoted for both cycles with the best applicable offer applied.
 */
export async function pricingFor(businessType, options = {}) {
  const [plans, offers] = await Promise.all([plansFor(businessType, options), loadOffers(options)]);
  return plans.map(plan => ({
    plan,
    monthly: quotePlan({ plan, billingCycle: "monthly", offers }),
    yearly: quotePlan({ plan, billingCycle: "yearly", offers })
  }));
}

/** The single offer to promote to this business, or null. */
export async function promotableOffer(businessType, options = {}) {
  const [plans, offers] = await Promise.all([plansFor(businessType, options), loadOffers(options)]);
  const offer = bestOffer(offers, { businessType }, new Date());
  if (!offer) return null;
  // An offer naming a plan is only worth promoting if that plan is on sale to
  // this business type.
  const plan = offer.planId ? plans.find(item => item.id === offer.planId) : plans.find(item => item.featured) || plans[0];
  if (offer.planId && !plan) return null;
  const cycle = String(offer.billingCycle || "yearly").toLowerCase() === "monthly" ? "monthly" : "yearly";
  return { offer, plan: plan || null, quote: plan ? quotePlan({ plan, billingCycle: cycle, offers: [offer] }) : null };
}

/* ---------------------------------------------------------
   A BUSINESS'S OWN SUBSCRIPTION
--------------------------------------------------------- */

/** The most recent subscription record for a business, or null. */
export async function currentSubscription(businessId) {
  if (!businessId) return null;
  const snap = await getDocs(query(collection(db, "subscriptions"), where("businessId", "==", String(businessId))));
  const rows = snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
  return pickCurrent(rows);
}

/**
 * Live subscription updates. After a payment the webhook writes the new
 * status and this fires, so the UI updates in place — no page reload.
 * Returns an unsubscribe function.
 */
export function watchSubscription(businessId, onChange, onError) {
  if (!businessId) return () => {};
  return onSnapshot(
    query(collection(db, "subscriptions"), where("businessId", "==", String(businessId))),
    snap => onChange(pickCurrent(snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() })))),
    error => onError?.(error)
  );
}

// A business may have several records over time (an upgrade creates a new
// one). The current one is the newest by creation, preferring an entitled
// status so a stale cancelled record never hides a live subscription.
function pickCurrent(rows = []) {
  if (!rows.length) return null;
  const rank = status => (["active", "trial"].includes(status) ? 2
    : ["created", "authenticated", "pending", "payment_failed", "paused"].includes(status) ? 1 : 0);
  return [...rows].sort((a, b) => {
    const byRank = rank(String(b.status || "")) - rank(String(a.status || ""));
    if (byRank) return byRank;
    return millis(b.createdAt) - millis(a.createdAt);
  })[0];
}

function millis(value) {
  if (!value) return 0;
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export async function loadPlan(planId) {
  if (!planId) return null;
  const snap = await getDoc(doc(db, "subscriptionPlans", String(planId)));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/** The business record, used for its businessType and legacy plan fields. */
export async function loadBusiness(businessId) {
  if (!businessId) return null;
  const snap = await getDoc(doc(db, "restaurants", String(businessId)));
  if (!snap.exists()) return null;
  const data = { id: snap.id, ...snap.data() };
  return { ...data, businessType: businessTypeOf(data) };
}

/* ---------------------------------------------------------
   OFFER POPUP DISMISSAL

   Per browser, per offer. An offer the owner dismissed stays
   dismissed until it changes, so the popup cannot follow them
   from page to page.
--------------------------------------------------------- */
const DISMISS_KEY = "scan2plate_dismissed_offers";

export function isOfferDismissed(offerId) {
  if (!offerId) return false;
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) || "{}");
    const until = Number(raw[offerId] || 0);
    return until > Date.now();
  } catch {
    return false;
  }
}

export function dismissOffer(offerId, days = 7) {
  if (!offerId) return;
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) || "{}");
    raw[offerId] = Date.now() + Math.max(1, Number(days) || 7) * 86400000;
    localStorage.setItem(DISMISS_KEY, JSON.stringify(raw));
  } catch {
    // A browser with storage disabled simply shows the offer again later.
  }
}

/* ---------------------------------------------------------
   BACKEND CALLS (money and secrets stay server-side)
--------------------------------------------------------- */
async function authHeaders() {
  const token = await auth.currentUser?.getIdToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function startSubscription({ businessId, planId, billingCycle, offerId = "", couponCode = "" }) {
  const response = await fetch(`${getBackendBaseUrl()}/api/subscriptions/create`, {
    method: "POST",
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ restaurantId: businessId, planId, billingCycle, offerId, couponCode })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw new Error(result.error || "Could not start the subscription.");
  return result;
}

export async function cancelSubscription(subscriptionId, { immediate = false } = {}) {
  const response = await fetch(`${getBackendBaseUrl()}/api/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    method: "POST",
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ immediate })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw new Error(result.error || "Could not cancel the subscription.");
  return result;
}

/**
 * Asks the SERVER whether a typed coupon is usable, and what it is worth.
 *
 * Priced server-side on purpose: the page could compute the same number from
 * the public offers collection, but then the figure a customer is shown would
 * come from code they can edit. This way the quote and the charge come from
 * one place.
 */
export async function validateCoupon({ businessId, planId, billingCycle, code }) {
  const response = await fetch(`${getBackendBaseUrl()}/api/coupons/validate`, {
    method: "POST",
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ restaurantId: businessId, planId, billingCycle, code })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok && !result.error) throw new Error("Could not check that coupon.");
  return result;
}

/** Claims a coupon that covers the whole price. No payment is involved. */
export async function redeemCoupon({ businessId, planId, billingCycle, code }) {
  const response = await fetch(`${getBackendBaseUrl()}/api/subscriptions/redeem`, {
    method: "POST",
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify({ restaurantId: businessId, planId, billingCycle, code })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw new Error(result.error || "Could not redeem that coupon.");
  return result;
}

export async function savePlan(payload) {
  const response = await fetch(`${getBackendBaseUrl()}/api/admin/plans`, {
    method: "POST",
    headers: { ...(await authHeaders()), "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw new Error(result.error || "Could not save the plan.");
  clearSubscriptionCache();
  return result;
}

/**
 * Opens Razorpay Checkout for a subscription. The SDK is loaded on demand so
 * the dashboard does not carry it on every page load.
 */
export async function openRazorpayCheckout({ publicKeyId, razorpaySubscriptionId, name, description, prefill = {}, onSuccess, onDismiss }) {
  await loadRazorpayScript();
  if (!window.Razorpay) throw new Error("Could not load the payment window. Please check your connection.");
  const checkout = new window.Razorpay({
    key: publicKeyId,
    subscription_id: razorpaySubscriptionId,
    name: name || "Scan2Plate",
    description: description || "Subscription",
    prefill,
    theme: { color: "#F97316" },
    // Payment is confirmed by the signed webhook, not by this callback. The
    // handler only tells the UI to expect an update.
    handler: response => onSuccess?.(response),
    modal: { ondismiss: () => onDismiss?.() }
  });
  checkout.open();
  return checkout;
}

let razorpayScriptPromise = null;
function loadRazorpayScript() {
  if (window.Razorpay) return Promise.resolve();
  if (razorpayScriptPromise) return razorpayScriptPromise;
  razorpayScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = resolve;
    script.onerror = () => { razorpayScriptPromise = null; reject(new Error("Razorpay checkout failed to load.")); };
    document.head.appendChild(script);
  });
  return razorpayScriptPromise;
}
