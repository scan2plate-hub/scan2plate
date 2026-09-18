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
--------------------------------------------------------- */
export const SUBSCRIPTION_STATES = [
  "trial", "pending", "active", "paused", "cancelled", "halted", "expired", "payment_failed"
];

// Razorpay event/status -> the state stored on the subscription.
const RAZORPAY_STATUS_MAP = {
  created: "pending",
  authenticated: "pending",
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
  const candidates = offers.filter(offer => offerApplies(offer, context, now));
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
  if (["pending", "paused"].includes(value)) return "warning";
  if (["payment_failed", "halted"].includes(value)) return "danger";
  return "muted";
}
