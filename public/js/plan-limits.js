/* =========================================================
   PLAN LIMITS AND FEATURE GATES (client side)

   Turns the limits a Super Admin configured on a plan into an
   actual check at the point where a record is created.

   THE RULE THAT MATTERS MOST: a business with no subscription, no
   plan, or a plan with no limits configured is NEVER blocked.
   Every existing Scan2Plate business is in exactly that state, so
   an unreachable backend, a missing plan document or a read error
   must all fail OPEN. A billing lookup is not allowed to stop a
   restaurant adding a table mid-service.

   This is a usability gate, not a security boundary. It stops an
   owner quietly exceeding what they bought; it is not what stops a
   determined attacker, which is Firestore rules and the backend.
========================================================= */
import { db } from "./firebase.js";
import { collection, getDoc, getDocs, doc, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { planLimit, planAllowsFeature, isEntitled, UNLIMITED } from "./subscription-core.js";

let cached = { businessId: "", plan: null, subscription: null, loaded: false };

/**
 * Loads the business's current plan once per page. Any failure leaves
 * `plan` null, which means unlimited.
 */
export async function loadPlanLimits(businessId) {
  if (!businessId) return null;
  if (cached.loaded && cached.businessId === businessId) return cached.plan;
  cached = { businessId, plan: null, subscription: null, loaded: true };
  try {
    const subs = await getDocs(query(collection(db, "subscriptions"), where("businessId", "==", String(businessId))));
    const rows = subs.docs.map(d => ({ id: d.id, ...d.data() }));
    // Only an entitled subscription's limits apply. A cancelled or expired
    // one must not start restricting a business that is still being wound
    // down or has reverted to a legacy arrangement.
    const active = rows.find(row => isEntitled(row)) || null;
    cached.subscription = active;
    if (active?.planId) {
      const planSnap = await getDoc(doc(db, "subscriptionPlans", String(active.planId)));
      if (planSnap.exists()) cached.plan = { id: planSnap.id, ...planSnap.data() };
    }
  } catch (error) {
    // Fail open, loudly in the console only.
    console.warn("Plan limits unavailable; treating as unlimited.", error?.message);
    cached.plan = null;
  }
  return cached.plan;
}

export function activePlan() {
  return cached.plan;
}

export function activeSubscription() {
  return cached.subscription;
}

/**
 * Can this business create one more of `limitName`?
 * Returns { allowed, limit, current, message }.
 *
 * `plan` defaults to the loaded plan; passing one explicitly lets a caller
 * (or a test) ask the same question about any plan.
 */
export function checkLimit(limitName, currentCount, plan = cached.plan) {
  if (!plan) return { allowed: true, limit: UNLIMITED, current: currentCount, message: "" };
  const limit = planLimit(plan, limitName);
  if (limit === UNLIMITED || limit < 0) return { allowed: true, limit, current: currentCount, message: "" };
  const current = Number(currentCount || 0);
  if (current < limit) return { allowed: true, limit, current, message: "" };
  return {
    allowed: false,
    limit,
    current,
    message: `Your ${plan.name || "current"} plan includes ${limit} ${LIMIT_NOUNS[limitName] || limitName}. Upgrade your plan to add more.`
  };
}

/**
 * Can this business create `count` more? Used where several records are
 * created at once, such as adding a block of tables.
 */
export function checkLimitFor(limitName, currentCount, count, plan = cached.plan) {
  if (!plan) return { allowed: true, limit: UNLIMITED, current: currentCount, message: "" };
  const limit = planLimit(plan, limitName);
  if (limit === UNLIMITED || limit < 0) return { allowed: true, limit, current: currentCount, message: "" };
  const current = Number(currentCount || 0);
  const wanted = Math.max(1, Number(count || 1));
  if (current + wanted <= limit) return { allowed: true, limit, current, message: "" };
  const remaining = Math.max(0, limit - current);
  return {
    allowed: false,
    limit,
    current,
    message: remaining
      ? `Your ${plan.name || "current"} plan includes ${limit} ${LIMIT_NOUNS[limitName] || limitName}. You can add ${remaining} more.`
      : `Your ${plan.name || "current"} plan includes ${limit} ${LIMIT_NOUNS[limitName] || limitName}. Upgrade your plan to add more.`
  };
}

export function featureAllowed(featureName, plan = cached.plan) {
  if (!plan) return true;
  return planAllowsFeature(plan, featureName);
}

const LIMIT_NOUNS = {
  maxTables: "tables",
  maxStaff: "staff accounts",
  maxMenuItems: "menu items",
  maxOrders: "orders per month",
  maxRooms: "rooms",
  maxInventoryItems: "inventory items",
  maxWhatsappNotifications: "WhatsApp notifications"
};

/** For tests and for a business switching account in the same tab. */
export function resetPlanLimits() {
  cached = { businessId: "", plan: null, subscription: null, loaded: false };
}
