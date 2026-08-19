import { createHash } from "node:crypto";

// Pure decision logic for the Event Food Pre-Booking feature, deliberately
// kept free of any Firestore/Razorpay/network call so it can be unit-tested
// without a live database (this environment has no Java runtime, so the
// real Firestore emulator can't run here - see
// backend/__tests__/eventBookingLogic.test.mjs). The actual endpoints in
// server.js do nothing but read fresh data inside a db.runTransaction(),
// hand it to these functions, and apply the returned outcome - the same
// "pure planner, thin executor" split already used by
// mobile/www/offline-core.js's buildSyncPlan and desktop/src/syncPlan.js
// in this codebase.
//
// The correctness guarantee these functions exist to prove: given the
// *exact same booking/item state* a transaction is about to commit, the
// decision is deterministic and can never be tricked into confirming stock
// past capacity or redeeming a booking twice - because Firestore's
// transaction semantics guarantee that when two concurrent transactions
// touch the same document, one is retried with the *post-commit* state of
// the other, and it is exactly that retried call which must correctly see
// "sold_out" / "already_redeemed" the second time around for the whole
// system to be race-safe. These tests simulate that retry by calling the
// same function twice with the state as it would be after the first
// commit.

/**
 * Decide whether an event booking's item still has capacity, and what to
 * do if the stock confirmation is happening after Razorpay already
 * reported the payment as successful (Part 6/22: never permanently reduce
 * stock for a failed reservation, but an already-successful payment that
 * loses the stock race must be refunded, not silently dropped).
 *
 * @param {{availableQuantity:number, soldQuantity:number, active:boolean}} item
 * @returns {{ok:true} | {ok:false, code:"sold_out"|"item_inactive"}}
 */
export function evaluateStockConfirmation(item) {
  if (!item) return { ok: false, code: "item_missing" };
  if (item.active === false) return { ok: false, code: "item_inactive" };
  const available = Number(item.availableQuantity || 0);
  const sold = Number(item.soldQuantity || 0);
  if (sold >= available) return { ok: false, code: "sold_out" };
  return { ok: true };
}

/**
 * Decide whether a booking window (bookingStartAt/bookingEndAt, both
 * millisecond timestamps or null) is currently open, and whether the
 * event itself is in a bookable state.
 */
export function evaluateBookingWindow({ status, bookingStartAt, bookingEndAt }, nowMs = Date.now()) {
  if (status !== "active") return { ok: false, code: "event_not_active" };
  if (bookingStartAt && nowMs < bookingStartAt) return { ok: false, code: "booking_not_open_yet" };
  if (bookingEndAt && nowMs > bookingEndAt) return { ok: false, code: "booking_closed" };
  return { ok: true };
}

/**
 * The single most important guarantee in this feature: a paid pickup QR
 * is a one-time entitlement. Given the *freshly re-read, inside-the-
 * transaction* state of a booking, decide whether this redemption attempt
 * may proceed. Two concurrent redeem calls for the same booking will both
 * call this function, but Firestore's transaction retry means the second
 * one to actually commit is evaluated against state that already reflects
 * the first's write - so it deterministically falls into the
 * "already_redeemed" branch. This function has no side effects; the
 * caller applies transaction.update(...) only when ok:true.
 *
 * @param {object|null} booking - fresh transaction read of the booking doc, or null if not found
 * @param {{eventId?:string}} context - eventId the scanner is assigned to, if scoping to one event
 * @returns {{ok:true, booking} | {ok:false, code:string, booking?:object}}
 */
export function evaluateRedemption(booking, context = {}) {
  if (!booking) return { ok: false, code: "invalid_token" };
  if (context.eventId && booking.eventId !== context.eventId) return { ok: false, code: "wrong_event" };
  if (booking.bookingStatus === "cancelled") return { ok: false, code: "cancelled" };
  if (booking.redeemed === true) return { ok: false, code: "already_redeemed", booking };
  if (booking.paymentStatus !== "paid" || booking.bookingStatus !== "confirmed") return { ok: false, code: "not_paid" };
  return { ok: true, booking };
}

/**
 * Read-only preview used by the "scan first, then require a separate
 * confirm tap" flow (Part 12) - same eligibility rule as evaluateRedemption
 * but never mutates and is safe to call as many times as staff re-scan
 * before pressing "Redeem & Hand Over".
 */
export function evaluateValidation(booking, context = {}) {
  return evaluateRedemption(booking, context);
}

export function hashPickupToken(rawToken) {
  return createHash("sha256").update(String(rawToken || "")).digest("hex");
}

export function bookingCodeFromId(bookingId) {
  return `EVT-${String(bookingId || "").slice(-6).toUpperCase()}`;
}
