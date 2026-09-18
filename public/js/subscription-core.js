/* =========================================================
   SUBSCRIPTION / PLAN / OFFER CORE

   Pure logic shared by the Super Admin console, the pricing page
   and the business dashboard. No Firestore and no DOM in here, so
   the pricing a customer is shown, the pricing Super Admin
   previews and the amount the server charges all come from one
   implementation — and all of it is directly testable.

   Money is handled in whole rupees at this layer and converted to
   paise only at the Razorpay boundary, to avoid float drift.
========================================================= */
import { normalizeBusinessType } from "./business-types.js";

export const BILLING_CYCLES = ["monthly", "yearly"];

/** A plan with businessType "all" is offered to every business type. */
export const GLOBAL_BUSINESS_TYPE = "all";

/* ---------------------------------------------------------
   SUBSCRIPTION STATES
   Razorpay's own subscription states plus the two the product
   adds: "trial" before any charge, and "expired" once a
   cancelled/halted subscription is past its grace period.

   `created` and `authenticated` are kept DISTINCT rather than
   both collapsing into `pending`, because they mean very
   different things when auditing a subscription that never went
   live: `created` means checkout was never completed, while
   `authenticated` means the customer approved the mandate and
   the first charge is the thing that failed. Neither grants
   access, so telling them apart costs nothing and is the
   difference between "they walked away" and "their bank
   declined".

   Note that Razorpay's own `pending` means "a charge failed and
   is being retried", NOT "awaiting first payment" — which is why
   it maps to payment_failed below and is not what we store while
   waiting for checkout.
--------------------------------------------------------- */
export const SUBSCRIPTION_STATES = [
  "created", "authenticated", "trial", "pending", "active",
  "paused", "cancelled", "halted", "expired", "payment_failed"
];

/** States before any successful charge. None of them grant access. */
export const PRE_ACTIVE_STATES = ["created", "authenticated", "pending"];

// Razorpay event/status -> the state stored on the subscription.
const RAZORPAY_STATUS_MAP = {
  created: "created",
  authenticated: "authenticated",
  active: "active",
  pending: "payment_failed",
  halted: "halted",
  cancelled: "cancelled",
  completed: "expired",
  expired: "expired",
  paused: "paused"
};

export function mapRazorpayStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return RAZORPAY_STATUS_MAP[status] || "pending";
}

/** States in which the business keeps full access. */
export function isEntitled(subscription = {}, now = new Date()) {
  const status = String(subscription.status || "").toLowerCase();
  if (["active", "trial"].includes(status)) return !isPastEnd(subscription, now);
  // A failed payment keeps access until the grace period runs out, so a
  // card expiring never locks a restaurant out mid-service.
  if (["payment_failed", "halted", "cancelled", "paused"].includes(status)) return withinGracePeriod(subscription, now);
  return false;
}

export function isPastEnd(subscription = {}, now = new Date()) {
  const end = toDate(subscription.endDate);
  if (!end) return false;
  return end.getTime() < now.getTime();
}

export function withinGracePeriod(subscription = {}, now = new Date()) {
  const graceDays = Number(subscription.gracePeriodDays);
  const days = Number.isFinite(graceDays) && graceDays >= 0 ? graceDays : 7;
  const reference = toDate(subscription.paymentFailedAt) || toDate(subscription.endDate) || toDate(subscription.nextBillingDate);
  if (!reference) return false;
  return now.getTime() <= reference.getTime() + days * 86400000;
}

export function graceEndsAt(subscription = {}) {
  const graceDays = Number(subscription.gracePeriodDays);
  const days = Number.isFinite(graceDays) && graceDays >= 0 ? graceDays : 7;
  const reference = toDate(subscription.paymentFailedAt) || toDate(subscription.endDate) || toDate(subscription.nextBillingDate);
  return reference ? new Date(reference.getTime() + days * 86400000) : null;
}

export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/* ---------------------------------------------------------
   PLANS
--------------------------------------------------------- */

/** True when this plan should be offered to this business type. */
export function planAppliesTo(plan = {}, businessType) {
  if (plan.active === false) return false;
  const target = normalizeBusinessType(businessType);
  const planType = String(plan.businessType || "").trim().toLowerCase();
  if (!planType || planType === GLOBAL_BUSINESS_TYPE) {
    // A global plan may still be restricted to a named subset.
    const allowed = Array.isArray(plan.businessTypes) ? plan.businessTypes.map(normalizeBusinessType) : [];
    return allowed.length ? allowed.includes(target) : true;
  }
  return normalizeBusinessType(planType) === target;
}

/** Plans for a business type, in the order Super Admin set. */
export function plansForBusinessType(plans = [], businessType) {
  return plans
    .filter(plan => planAppliesTo(plan, businessType))
    .sort((a, b) => (Number(a.displayOrder || 0) - Number(b.displayOrder || 0)) || String(a.name || "").localeCompare(String(b.name || "")));
}

export function planPrice(plan = {}, billingCycle = "monthly") {
  const value = billingCycle === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

export function toPaise(rupees) {
  return Math.round(Number(rupees || 0) * 100);
}

/* ---------------------------------------------------------
   OFFERS
--------------------------------------------------------- */

export function offerIsLive(offer = {}, now = new Date()) {
  if (offer.active === false) return false;
  const start = toDate(offer.startDate);
  const end = toDate(offer.endDate);
  if (start && now.getTime() < start.getTime()) return false;
  // endDate is inclusive: an offer valid to 31/12 runs to the end of that day.
  if (end && now.getTime() > endOfDay(end).getTime()) return false;
  const max = Number(offer.maxRedemptions);
  if (Number.isFinite(max) && max > 0 && Number(offer.redemptions || 0) >= max) return false;
  return true;
}

function endOfDay(date) {
  const copy = new Date(date.getTime());
  copy.setHours(23, 59, 59, 999);
  return copy;
}

/** An offer with a code is claimed by typing it, never applied automatically. */
export function isCouponOffer(offer = {}) {
  return Boolean(String(offer.code || "").trim());
}

/** Codes are compared case- and space-insensitively: "save50" === "SAVE 50". */
export function normalizeCouponCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "");
}

export function offerApplies(offer = {}, { businessType, planId, billingCycle } = {}, now = new Date()) {
  if (!offerIsLive(offer, now)) return false;
  const offerType = String(offer.businessType || "").trim().toLowerCase();
  if (offerType && offerType !== GLOBAL_BUSINESS_TYPE && normalizeBusinessType(offerType) !== normalizeBusinessType(businessType)) return false;
  if (offer.planId && planId && String(offer.planId) !== String(planId)) return false;
  const offerCycle = String(offer.billingCycle || "").trim().toLowerCase();
  if (offerCycle && offerCycle !== "any" && billingCycle && offerCycle !== String(billingCycle).toLowerCase()) return false;
  return true;
}

/**
 * The single offer to apply. Highest `priority` wins; ties break on the
 * larger saving, so two equally-ranked offers never show at random.
 */
export function bestOffer(offers = [], context = {}, now = new Date()) {
  // A coupon offer is deliberately excluded here. It is a code the owner has
  // to be given and type in; if it also applied on its own, every visitor
  // would get the discount and the code would mean nothing.
  const candidates = offers.filter(offer => !isCouponOffer(offer) && offerApplies(offer, context, now));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => {
    const byPriority = Number(b.priority || 0) - Number(a.priority || 0);
    if (byPriority) return byPriority;
    const savingA = discountAmount(a, Number(context.price || 0));
    const savingB = discountAmount(b, Number(context.price || 0));
    if (savingB !== savingA) return savingB - savingA;
    return Number(b.bonusMonths || 0) - Number(a.bonusMonths || 0);
  })[0];
}

/**
 * Looks up a typed coupon code and says whether it can be used here.
 *
 * Returns { ok, offer, reason }. The reason is written for the customer
 * reading it, because "invalid code" when the code is real but yearly-only
 * is the kind of message that generates a support ticket.
 *
 * The browser calls this to price the cart. The SERVER calls the same
 * function again before charging, so a customer who edits the page cannot
 * award themselves a discount.
 */
export function findCouponOffer(offers = [], code, context = {}, now = new Date()) {
  const wanted = normalizeCouponCode(code);
  if (!wanted) return { ok: false, offer: null, reason: "Enter a coupon code." };

  const match = offers.find(offer => isCouponOffer(offer) && normalizeCouponCode(offer.code) === wanted);
  if (!match) return { ok: false, offer: null, reason: "That coupon code was not recognised." };
  if (match.active === false) return { ok: false, offer: null, reason: "That coupon is no longer active." };

  const now_ = now;
  const start = toDate(match.startDate);
  if (start && now_ < start) return { ok: false, offer: null, reason: "That coupon is not valid yet." };
  const end = endOfDay(toDate(match.endDate));
  if (end && now_ > end) return { ok: false, offer: null, reason: "That coupon has expired." };

  const max = Number(match.maxRedemptions);
  if (Number.isFinite(max) && max > 0 && Number(match.redemptions || 0) >= max) {
    return { ok: false, offer: null, reason: "That coupon has been fully claimed." };
  }

  const offerType = String(match.businessType || "").trim().toLowerCase();
  if (offerType && offerType !== GLOBAL_BUSINESS_TYPE && context.businessType
      && normalizeBusinessType(offerType) !== normalizeBusinessType(context.businessType)) {
    return { ok: false, offer: null, reason: "That coupon is for a different type of business." };
  }
  if (match.planId && context.planId && String(match.planId) !== String(context.planId)) {
    return { ok: false, offer: null, reason: "That coupon applies to a different plan." };
  }
  const offerCycle = String(match.billingCycle || "").trim().toLowerCase();
  if (offerCycle && offerCycle !== "any" && context.billingCycle && offerCycle !== String(context.billingCycle).toLowerCase()) {
    return { ok: false, offer: null, reason: `That coupon is only valid on ${offerCycle} billing.` };
  }
  return { ok: true, offer: match, reason: "" };
}

/**
 * Does this quote come to nothing to pay?
 *
 * Razorpay cannot create a subscription for zero, so a 100%-off coupon is not
 * a payment at all — it is a grant, and takes a different route entirely (see
 * /api/subscriptions/redeem). Treated as its own question rather than a
 * `payable === 0` check scattered around, because getting it wrong either
 * charges someone who was promised a free year or hands out free access.
 */
export function isFullyDiscounted(quote = {}) {
  return Number(quote.listPrice || 0) > 0 && Number(quote.payable || 0) <= 0;
}

export function discountAmount(offer, price) {
  const base = Number(price || 0);
  if (!offer || base <= 0) return 0;
  const type = String(offer.discountType || "").toLowerCase();
  const value = Number(offer.discountValue || 0);
  if (value <= 0) return 0;
  if (type === "percent") return Math.min(base, Math.round(base * Math.min(100, value)) / 100);
  if (type === "flat") return Math.min(base, value);
  return 0;
}

/* ---------------------------------------------------------
   PRICING

   One function decides what a customer pays and what they get, so
   the pricing page, the checkout summary and the server agree.
--------------------------------------------------------- */
export function quotePlan({ plan, billingCycle = "monthly", offers = [], now = new Date() } = {}) {
  const cycle = BILLING_CYCLES.includes(billingCycle) ? billingCycle : "monthly";
  const listPrice = planPrice(plan, cycle);
  const offer = bestOffer(offers, {
    businessType: plan?.businessType,
    planId: plan?.id,
    billingCycle: cycle,
    price: listPrice
  }, now);

  const discount = discountAmount(offer, listPrice);
  const payable = Math.max(0, Math.round((listPrice - discount) * 100) / 100);
  const paidMonths = cycle === "yearly" ? 12 : 1;
  const bonusMonths = Math.max(0, Number(offer?.bonusMonths || 0));

  return {
    planId: plan?.id || "",
    planName: plan?.name || "",
    billingCycle: cycle,
    listPrice,
    discount,
    payable,
    currency: "INR",
    paidMonths,
    bonusMonths,
    totalMonths: paidMonths + bonusMonths,
    trialDays: Math.max(0, Number(plan?.trialDays || 0)),
    offerId: offer?.id || null,
    offerText: offer?.offerText || "",
    offerBadge: offer?.badge || "",
    offer: offer || null
  };
}

/**
 * Where a subscription's access ends.
 *
 * Bonus months are a promotional ENTITLEMENT, not extra billing cycles:
 * "pay 12, get 2 free" bills 12 months through Razorpay and extends access
 * by 2. It is never modelled as a 14-month recurring cycle, which Razorpay
 * would treat as the customer's real billing period.
 */
export function computeEndDate({ startDate, paidMonths = 1, bonusMonths = 0 } = {}) {
  const start = toDate(startDate) || new Date();
  return addMonths(start, Math.max(0, Number(paidMonths || 0)) + Math.max(0, Number(bonusMonths || 0)));
}

/** The next date Razorpay will charge — bonus months do not move it. */
export function computeNextBillingDate({ startDate, billingCycle = "monthly", trialDays = 0 } = {}) {
  const start = toDate(startDate) || new Date();
  const afterTrial = Number(trialDays) > 0 ? new Date(start.getTime() + Number(trialDays) * 86400000) : start;
  return addMonths(afterTrial, billingCycle === "yearly" ? 12 : 1);
}

export function addMonths(date, months) {
  const result = new Date(date.getTime());
  const targetDay = result.getDate();
  result.setMonth(result.getMonth() + Number(months || 0));
  // Clamp a rollover: 31 Jan + 1 month is 28/29 Feb, not 2/3 March.
  if (result.getDate() < targetDay) result.setDate(0);
  return result;
}

/* ---------------------------------------------------------
   FEATURES AND LIMITS
--------------------------------------------------------- */

/** -1 (or absent) means unlimited. */
export const UNLIMITED = -1;

export function planAllowsFeature(plan = {}, featureName) {
  const features = plan.features;
  if (!features || typeof features !== "object") return true; // no flags configured = everything on
  return features[featureName] !== false;
}

export function planLimit(plan = {}, limitName) {
  const limits = plan.limits;
  if (!limits || typeof limits !== "object") return UNLIMITED;
  const value = Number(limits[limitName]);
  return Number.isFinite(value) ? value : UNLIMITED;
}

export function withinLimit(plan, limitName, currentCount) {
  const limit = planLimit(plan, limitName);
  if (limit === UNLIMITED || limit < 0) return true;
  return Number(currentCount || 0) < limit;
}

export function limitLabel(plan, limitName) {
  const limit = planLimit(plan, limitName);
  return limit === UNLIMITED || limit < 0 ? "Unlimited" : String(limit);
}

/* ---------------------------------------------------------
   DISPLAY
--------------------------------------------------------- */
export function formatMoney(value, currency = "INR") {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(value || 0));
}

export function statusLabel(status) {
  return {
    created: "Awaiting Payment",
    authenticated: "Mandate Approved",
    trial: "Trial",
    pending: "Pending",
    active: "Active",
    paused: "Paused",
    cancelled: "Cancelled",
    halted: "Halted",
    expired: "Expired",
    payment_failed: "Payment Failed"
  }[String(status || "").toLowerCase()] || "Unknown";
}

export function statusTone(status) {
  const value = String(status || "").toLowerCase();
  if (["active", "trial"].includes(value)) return "success";
  if (["created", "authenticated", "pending", "paused"].includes(value)) return "warning";
  if (["payment_failed", "halted"].includes(value)) return "danger";
  return "muted";
}
