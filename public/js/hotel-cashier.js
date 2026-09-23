/* =========================================================
   CASHIER SHIFTS  (section 26)

       OPEN → ACTIVE → CLOSING → CLOSED

   A shift is a claim about cash: "I started with this much, I
   took this much, here is what is in the drawer." The product's
   job is to compute what SHOULD be there and show the difference
   without editorialising.

   THE VARIANCE IS NEVER HIDDEN. Expected cash is derived from the
   payments recorded during the shift, never typed; actual cash is
   typed and never derived. A cashier who is short is short, and a
   system that quietly rounds that away is worse than no system,
   because it removes the only signal that something is wrong.

   Nor is a variance an accusation. A note is required on any
   difference, which is how a genuine explanation — a float taken
   for change, a tip paid out — gets recorded at the moment
   somebody still remembers it.

   Only CASH is reconciled. A card or UPI payment reconciles
   against the gateway, not the drawer; counting it here would
   make every shift look wildly over.
========================================================= */
import { round2, asStayDate, normalizeHotelRole } from "./hotel-core.js?v=s2p-20260922d";
import { isSettledPayment, isRefund } from "./hotel-core.js?v=s2p-20260922d";

export const SHIFTS = "hotel_cashier_shifts";
export const PAYMENTS = "hotelPayments";
export const AUDIT_LOGS = "hotelAuditLogs";

export const SHIFT_STATUS = {
  OPEN: "OPEN",
  ACTIVE: "ACTIVE",
  CLOSING: "CLOSING",
  CLOSED: "CLOSED"
};

const FLOW = {
  OPEN: "ACTIVE",
  ACTIVE: "CLOSING",
  CLOSING: "CLOSED",
  CLOSED: null
};

export function normalizeShiftStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  return Object.values(SHIFT_STATUS).includes(status) ? status : SHIFT_STATUS.OPEN;
}

export function nextShiftStatus(status) {
  return FLOW[normalizeShiftStatus(status)];
}

/** Cash only. Everything else settles somewhere that is not a drawer. */
export function isCashPayment(payment = {}) {
  return String(payment.method || "").trim().toLowerCase() === "cash";
}

/**
 * What should be in the drawer, from the payments recorded against a shift.
 *
 * Only SETTLED payments count — a pending or failed one is not money in a
 * drawer, and counting it would make an honest cashier look short by exactly
 * the amount of a card that was declined.
 */
export function expectedCash(shift = {}, payments = []) {
  const opening = round2(shift.openingCash);
  const cash = payments.filter(payment => isCashPayment(payment) && isSettledPayment(payment));
  const taken = round2(cash.filter(payment => !isRefund(payment))
    .reduce((sum, payment) => sum + Math.abs(Number(payment.amount || 0)), 0));
  const refunded = round2(cash.filter(isRefund)
    .reduce((sum, payment) => sum + Math.abs(Number(payment.amount || 0)), 0));
  const paidOut = round2(shift.paidOut);
  return {
    opening,
    cashTaken: taken,
    cashRefunded: refunded,
    paidOut,
    expected: round2(opening + taken - refunded - paidOut),
    cashPaymentCount: cash.length,
    // Surfaced so a cashier can see that a card was attempted and failed,
    // rather than wondering why the drawer does not match the day.
    unsettledCount: payments.filter(payment => isCashPayment(payment) && !isSettledPayment(payment)).length
  };
}

/**
 * The reconciliation a cashier signs off.
 *
 * `actualCash` is counted by a human. It is never defaulted to the expected
 * figure: a screen that pre-fills the answer is a screen where nobody counts.
 */
export function reconcileShift(shift = {}, payments = [], { actualCash } = {}) {
  const expected = expectedCash(shift, payments);
  const counted = actualCash === "" || actualCash == null ? null : round2(actualCash);
  if (counted === null) {
    return { ...expected, actual: null, variance: null, counted: false, verdict: "uncounted" };
  }
  const variance = round2(counted - expected.expected);
  return {
    ...expected,
    actual: counted,
    variance,
    counted: true,
    verdict: variance === 0 ? "balanced" : variance > 0 ? "over" : "short"
  };
}

/** Plain words for the person closing, and for the report afterwards. */
export function describeVariance(reconciliation = {}) {
  if (!reconciliation.counted) return "Not counted yet.";
  const amount = Math.abs(reconciliation.variance);
  if (!amount) return "Drawer balances exactly.";
  return reconciliation.variance > 0
    ? `Drawer is over by ${amount}. Record why before closing.`
    : `Drawer is short by ${amount}. Record why before closing.`;
}

/**
 * May this shift close?
 *
 * A difference does not block a close — cash is messy and a shift that
 * cannot be closed is a shift that stays open forever, which is worse. What
 * IS required is a note, so the difference is explained while somebody still
 * remembers, and a manager for anything beyond a tolerance the property sets.
 */
export function canCloseShift(reconciliation = {}, { role = "", note = "", toleranceAmount = 0 } = {}) {
  if (!reconciliation.counted) {
    return { ok: false, reason: "Count the drawer before closing the shift." };
  }
  const amount = Math.abs(Number(reconciliation.variance || 0));
  if (!amount) return { ok: true, reason: "" };
  if (!String(note || "").trim()) {
    return { ok: false, reason: `The drawer is ${reconciliation.verdict} by ${amount}. Record why before closing.` };
  }
  const tolerance = Math.max(0, Number(toleranceAmount) || 0);
  if (amount > tolerance && !["manager"].includes(normalizeHotelRole(role))) {
    return { ok: false, reason: `A difference of ${amount} needs a manager to close the shift.` };
  }
  return { ok: true, reason: "" };
}

/* ---------------------------------------------------------
   THE SERVICE
--------------------------------------------------------- */

export function createCashierService({ db, restaurantId, firestore, now = () => new Date() }) {
  const { doc, collection, runTransaction, serverTimestamp } = firestore;

  const shiftRef = id => doc(db, "restaurants", restaurantId, SHIFTS, String(id));
  const auditRef = () => doc(collection(db, AUDIT_LOGS));

  function audit(transaction, { action, actor = {}, detail }) {
    transaction.set(auditRef(), {
      restaurantId, action,
      userId: String(actor.uid || ""), userName: String(actor.name || ""), role: String(actor.role || ""),
      detail, createdAt: serverTimestamp(), at: now().toISOString()
    });
  }

  async function openShift({ shiftId, openingCash, actor, businessDate = "", counter = "front_desk" }) {
    if (!shiftId) throw new CashierError("invalid", "A shift needs an id.");
    const opening = round2(openingCash);
    if (opening < 0) throw new CashierError("invalid", "Opening cash cannot be negative.");
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(shiftRef(shiftId));
      if (existing.exists()) return { ok: true, duplicate: true, shiftId };
      transaction.set(shiftRef(shiftId), {
        restaurantId, counter: String(counter),
        status: SHIFT_STATUS.ACTIVE,
        openingCash: opening,
        paidOut: 0,
        cashierUid: String(actor?.uid || ""), cashierName: String(actor?.name || ""),
        businessDate: asStayDate(businessDate) || "",
        openedAt: serverTimestamp(), at: now().toISOString()
      });
      audit(transaction, { action: "shift_opened", actor, detail: { shiftId, openingCash: opening, counter } });
      return { ok: true, shiftId };
    });
  }

  /** Cash taken out mid-shift — a float for another till, a supplier paid. */
  async function recordPayOut({ shiftId, amount, reason, actor }) {
    const value = round2(amount);
    if (!(value > 0)) throw new CashierError("invalid", "Enter an amount above zero.");
    if (!String(reason || "").trim()) throw new CashierError("invalid", "Say what the cash was taken for.");
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(shiftRef(shiftId));
      if (!snapshot.exists()) throw new CashierError("not_found", "That shift no longer exists.");
      const shift = snapshot.data();
      if (normalizeShiftStatus(shift.status) === SHIFT_STATUS.CLOSED) {
        throw new CashierError("closed", "This shift is closed. Record it against the current shift instead.");
      }
      transaction.set(shiftRef(shiftId), {
        paidOut: round2(Number(shift.paidOut || 0) + value),
        updatedAt: serverTimestamp()
      }, { merge: true });
      audit(transaction, { action: "shift_pay_out", actor, detail: { shiftId, amount: value, reason: String(reason) } });
      return { ok: true, paidOut: round2(Number(shift.paidOut || 0) + value) };
    });
  }

  /**
   * Close a shift.
   *
   * The reconciliation is recomputed here from the payments the caller
   * loaded, so a stale screen cannot close a drawer against numbers that
   * have since changed.
   */
  async function closeShift({ shiftId, payments = [], actualCash, note = "", actor, toleranceAmount = 0 }) {
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(shiftRef(shiftId));
      if (!snapshot.exists()) throw new CashierError("not_found", "That shift no longer exists.");
      const shift = snapshot.data();
      if (normalizeShiftStatus(shift.status) === SHIFT_STATUS.CLOSED) {
        return { ok: true, duplicate: true, reconciliation: shift.reconciliation };
      }

      const reconciliation = reconcileShift(shift, payments, { actualCash });
      const permitted = canCloseShift(reconciliation, { role: actor?.role, note, toleranceAmount });
      if (!permitted.ok) throw new CashierError("unbalanced", permitted.reason, { reconciliation });

      transaction.set(shiftRef(shiftId), {
        status: SHIFT_STATUS.CLOSED,
        reconciliation,
        closingNote: String(note || ""),
        closedByUid: String(actor?.uid || ""), closedByName: String(actor?.name || ""),
        closedAt: serverTimestamp()
      }, { merge: true });
      audit(transaction, {
        action: "shift_closed", actor,
        detail: {
          shiftId, expected: reconciliation.expected, actual: reconciliation.actual,
          variance: reconciliation.variance, verdict: reconciliation.verdict, note: String(note || "")
        }
      });
      return { ok: true, reconciliation };
    });
  }

  return { openShift, recordPayOut, closeShift };
}

export class CashierError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CashierError";
    this.code = code;
    Object.assign(this, details);
  }
}
