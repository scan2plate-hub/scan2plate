import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateStockConfirmation,
  evaluateBookingWindow,
  evaluateRedemption,
  evaluateValidation,
  hashPickupToken,
  bookingCodeFromId
} from "../lib/eventBookingLogic.js";

// ===== Overselling protection (Part 6 / Part 34 test #5) =====

test("evaluateStockConfirmation allows a booking when stock remains", () => {
  const result = evaluateStockConfirmation({ availableQuantity: 100, soldQuantity: 99, active: true });
  assert.deepEqual(result, { ok: true });
});

test("evaluateStockConfirmation rejects the booking that would exceed capacity", () => {
  const result = evaluateStockConfirmation({ availableQuantity: 100, soldQuantity: 100, active: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, "sold_out");
});

test("evaluateStockConfirmation: simulated race for the last unit - only the first commit succeeds", () => {
  // Simulates two concurrent verify-payment transactions on the same item.
  // Firestore's real transaction retry means the second one is evaluated
  // against the item state *after* the first committed - this reproduces
  // that sequencing without a live database.
  const item = { availableQuantity: 1, soldQuantity: 0, active: true };
  const first = evaluateStockConfirmation(item);
  assert.equal(first.ok, true, "first transaction claims the last unit");
  const itemAfterFirstCommit = { ...item, soldQuantity: item.soldQuantity + 1 };
  const second = evaluateStockConfirmation(itemAfterFirstCommit);
  assert.equal(second.ok, false, "second transaction must lose the race");
  assert.equal(second.code, "sold_out");
});

test("evaluateStockConfirmation rejects a deactivated menu item even with stock left", () => {
  const result = evaluateStockConfirmation({ availableQuantity: 50, soldQuantity: 1, active: false });
  assert.equal(result.ok, false);
  assert.equal(result.code, "item_inactive");
});

test("evaluateStockConfirmation rejects a missing item", () => {
  assert.deepEqual(evaluateStockConfirmation(null), { ok: false, code: "item_missing" });
});

// ===== Booking window (Part 23 / Part 34 tests #2-3) =====

test("evaluateBookingWindow blocks a non-active event", () => {
  assert.deepEqual(evaluateBookingWindow({ status: "draft" }), { ok: false, code: "event_not_active" });
  assert.deepEqual(evaluateBookingWindow({ status: "completed" }), { ok: false, code: "event_not_active" });
});

test("evaluateBookingWindow blocks before bookingStartAt", () => {
  const result = evaluateBookingWindow({ status: "active", bookingStartAt: 2000, bookingEndAt: null }, 1000);
  assert.deepEqual(result, { ok: false, code: "booking_not_open_yet" });
});

test("evaluateBookingWindow blocks after bookingEndAt", () => {
  const result = evaluateBookingWindow({ status: "active", bookingStartAt: null, bookingEndAt: 1000 }, 2000);
  assert.deepEqual(result, { ok: false, code: "booking_closed" });
});

test("evaluateBookingWindow allows booking inside the open window", () => {
  const result = evaluateBookingWindow({ status: "active", bookingStartAt: 1000, bookingEndAt: 3000 }, 2000);
  assert.deepEqual(result, { ok: true });
});

// ===== One-time redemption (Part 13/14 / Part 34 tests #11-18) — the most
// important guarantee in this feature. =====

const paidConfirmedBooking = { eventId: "evt1", bookingStatus: "confirmed", paymentStatus: "paid", redeemed: false };

test("evaluateRedemption: valid paid, unredeemed booking may be redeemed (test #11/#12)", () => {
  const result = evaluateRedemption(paidConfirmedBooking, { eventId: "evt1" });
  assert.equal(result.ok, true);
});

test("evaluateRedemption: simulated concurrent double-scan - second call always loses (test #13/#14/#15)", () => {
  // First transaction reads the fresh, unredeemed booking and commits.
  const firstRead = { ...paidConfirmedBooking };
  const first = evaluateRedemption(firstRead, { eventId: "evt1" });
  assert.equal(first.ok, true, "first redemption must succeed");

  // A second staff device (or the same device scanning again) re-reads the
  // booking. Firestore's transaction semantics guarantee this second read
  // reflects the first transaction's committed write when they race on the
  // same document - this is exactly that post-commit state.
  const secondRead = { ...firstRead, redeemed: true, bookingStatus: "redeemed" };
  const second = evaluateRedemption(secondRead, { eventId: "evt1" });
  assert.equal(second.ok, false, "second redemption must be rejected");
  assert.equal(second.code, "already_redeemed");
});

test("evaluateRedemption rejects an already-redeemed booking on a different staff device (test #14)", () => {
  const result = evaluateRedemption({ ...paidConfirmedBooking, redeemed: true, bookingStatus: "redeemed" }, { eventId: "evt1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "already_redeemed");
});

test("evaluateRedemption rejects a cancelled booking (test #16)", () => {
  const result = evaluateRedemption({ ...paidConfirmedBooking, bookingStatus: "cancelled" }, { eventId: "evt1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "cancelled");
});

test("evaluateRedemption rejects an unpaid booking (test #17)", () => {
  const result = evaluateRedemption({ ...paidConfirmedBooking, paymentStatus: "pending" }, { eventId: "evt1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "not_paid");
});

test("evaluateRedemption rejects a token scanned in the wrong event's scanner (test #18)", () => {
  const result = evaluateRedemption(paidConfirmedBooking, { eventId: "evt-different" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "wrong_event");
});

test("evaluateRedemption rejects a token that doesn't resolve to any booking", () => {
  const result = evaluateRedemption(null, { eventId: "evt1" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_token");
});

test("evaluateRedemption always checks already_redeemed before not_paid, so a redeemed-then-somehow-unpaid record still reports already_redeemed", () => {
  // Defends the priority order itself: redeemed is the strongest terminal
  // state and must never be masked by a later validity check.
  const result = evaluateRedemption({ ...paidConfirmedBooking, redeemed: true, paymentStatus: "refunded" }, { eventId: "evt1" });
  assert.equal(result.code, "already_redeemed");
});

test("evaluateValidation (read-only preview) matches evaluateRedemption's eligibility exactly", () => {
  assert.deepEqual(evaluateValidation(paidConfirmedBooking, { eventId: "evt1" }), evaluateRedemption(paidConfirmedBooking, { eventId: "evt1" }));
  const redeemed = { ...paidConfirmedBooking, redeemed: true };
  assert.deepEqual(evaluateValidation(redeemed, { eventId: "evt1" }), evaluateRedemption(redeemed, { eventId: "evt1" }));
});

// ===== Pickup token hashing (Part 9) =====

test("hashPickupToken is deterministic for the same input", () => {
  const token = "abc-123-def-456";
  assert.equal(hashPickupToken(token), hashPickupToken(token));
});

test("hashPickupToken produces different hashes for different tokens (no collisions in practice)", () => {
  assert.notEqual(hashPickupToken("token-a"), hashPickupToken("token-b"));
});

test("hashPickupToken never returns the raw token itself", () => {
  const token = "super-secret-raw-token";
  assert.notEqual(hashPickupToken(token), token);
  assert.equal(hashPickupToken(token).length, 64); // sha256 hex digest
});

// ===== Booking code display formatting =====

test("bookingCodeFromId formats a readable EVT- code from the Firestore doc id", () => {
  assert.equal(bookingCodeFromId("aBcDef123456"), "EVT-123456");
});
