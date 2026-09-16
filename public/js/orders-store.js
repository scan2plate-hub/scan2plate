/* =========================================================
   SHARED ORDERS STORE
   admin.js and admin-modules.js each used to open their own
   onSnapshot over the whole `orders` collection for this
   restaurant — two full live copies of the same data, two
   sets of Firestore reads, and two independent render
   pipelines firing on every single write.

   This module owns exactly one listener and fans the result
   out to every subscriber. It also:
     - coalesces bursts of snapshots into a single render pass
       (the first snapshot after subscribing renders instantly
       so initial load is not delayed),
     - keeps the last snapshot in memory so a late subscriber
       gets the current orders immediately, with no extra read,
     - performs the one-shot "refresh the ID token and
       resubscribe" recovery that a stale token needs.
========================================================= */
import { db, auth } from "./firebase.js";
import {
  collection,
  query,
  where,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { createCoalescedRunner, registerCleanup, devError } from "./common.js?v=freeze-fix-20260816";

const subscribers = new Set();
const errorHandlers = new Set();

let restaurantScope = "";
let unsubscribe = null;
let tokenRefreshRetried = false;
let latestOrders = null;
let hasLoadedOnce = false;
let notifySubscribers = null;

function emit(orders) {
  latestOrders = orders;
  hasLoadedOnce = true;
  subscribers.forEach(handler => {
    // One misbehaving consumer must never stop the others from updating.
    try { handler(orders); } catch (error) { devError("orders store subscriber failed", error); }
  });
}

function emitError(error) {
  errorHandlers.forEach(handler => {
    try { handler(error); } catch (handlerError) { devError("orders store error handler failed", handlerError); }
  });
}

function startListener() {
  if (unsubscribe || !restaurantScope) return;
  notifySubscribers = createCoalescedRunner(emit, 200);
  unsubscribe = onSnapshot(
    query(collection(db, "orders"), where("restaurantId", "==", restaurantScope)),
    snapshot => {
      tokenRefreshRetried = false;
      notifySubscribers(snapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() })));
    },
    async error => {
      devError("orders listener error", { code: error?.code, message: error?.message, restaurantId: restaurantScope });
      // A stale/expired ID token on a cold load surfaces as permission-denied
      // even for a legitimately authorized user. Refresh once and resubscribe
      // transparently; the guard stops this from looping.
      if (error?.code === "permission-denied" && auth.currentUser && !tokenRefreshRetried) {
        tokenRefreshRetried = true;
        try {
          await auth.currentUser.getIdToken(true);
          stopListener();
          startListener();
          return;
        } catch (refreshError) {
          devError("orders listener token refresh retry failed", refreshError);
        }
      }
      emitError(error);
    }
  );
  registerCleanup(stopListener);
}

function stopListener() {
  if (typeof unsubscribe === "function") {
    try { unsubscribe(); } catch (error) { devError("orders listener cleanup failed", error); }
  }
  unsubscribe = null;
  notifySubscribers = null;
}

/**
 * Subscribe to live orders. Returns an unsubscribe function.
 * The shared listener is created on the first subscribe and torn down when
 * the last subscriber leaves, so nothing keeps reading after a page/section
 * is closed.
 */
export function subscribeOrders(restaurantId, handler, onError = null) {
  if (typeof handler !== "function") return () => {};
  if (restaurantScope && restaurantScope !== restaurantId) {
    // Restaurant switched (re-login as another business): drop the old stream.
    stopListener();
    latestOrders = null;
    hasLoadedOnce = false;
  }
  restaurantScope = restaurantId;
  subscribers.add(handler);
  if (typeof onError === "function") errorHandlers.add(onError);

  // A subscriber that joins after the first snapshot arrived gets the current
  // data straight from memory — no extra Firestore read, no waiting.
  if (hasLoadedOnce && latestOrders) {
    try { handler(latestOrders); } catch (error) { devError("orders store subscriber failed", error); }
  }
  startListener();

  return () => {
    subscribers.delete(handler);
    if (typeof onError === "function") errorHandlers.delete(onError);
    if (!subscribers.size) stopListener();
  };
}

/** Orders already in memory — for code that needs a value synchronously. */
export function getLoadedOrders() {
  return latestOrders || [];
}

export function ordersLoaded() {
  return hasLoadedOnce;
}

/**
 * Force a fresh subscription. Used by the manual "Retry" affordance after a
 * load failure; normal operation never needs this because the listener is
 * already live.
 */
export function refreshOrders() {
  tokenRefreshRetried = false;
  stopListener();
  startListener();
}
