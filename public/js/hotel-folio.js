/* =========================================================
   GUEST FOLIO AND CHECKOUT

   One account per stay. Room nights, the restaurant, room
   service, laundry and every other outlet post here, and checkout
   is the act of settling it.

   THREE RULES SHAPE EVERY FUNCTION IN THIS FILE.

   Rule 12 — a failed payment is never recorded as successful.
   Payments are written in two steps, never one: a record is
   created as PENDING before the gateway is called, and only the
   gateway's own answer moves it to settled or failed. A single
   write after the call cannot distinguish "declined" from "the
   browser closed while it was authorising", and both must be
   treated as unpaid.

   Rule 15 — invoice numbers must stay serial and unique. They
   come from a counter document incremented inside a transaction,
   the same mechanism the restaurant bills already use. A number
   allocated is never reused, even if the invoice that claimed it
   is later voided: a gap in a sequence is explainable to an
   auditor, a duplicate is not.

   Rules 16 and 17 — history survives people. An invoice records
   the staff member's name and id as TEXT at the moment it is
   raised, not as a reference to a user document; and a guest
   record being deleted cannot take financial records with it.
   Nothing here follows a reference to render a historical
   document.

   Firestore is injected, as in the reservation service, so the
   two-step payment and the counter can be tested against a stub.
========================================================= */
import {
  folioTotals, chargeAmounts, canCheckOut, round2, isSettledPayment,
  asStayDate, FOLIO_CHARGE_KINDS, normalizeHotelRole
} from "./hotel-core.js?v=s2p-20260922d";

export const FOLIOS = "hotel_folios";
export const FOLIO_ITEMS = "hotel_folio_items";

/*
   PAYMENTS AND INVOICES ARE TOP-LEVEL, AND NOT BY PREFERENCE.

   The recursive catch-all under restaurants/{rid} grants the owner write on
   every path beneath it, and Firestore grants access when ANY rule allows —
   so "a settled payment can never be edited" cannot hold there. It is the
   same constraint that moved the night audits out in phase 1.

   The split it forces turns out to be the right model anyway. A FOLIO is the
   working account for a stay: charges arrive, get discounted, get voided,
   and it changes all day. An INVOICE is the document handed to the guest at
   checkout — a fact about a moment, which must never change afterwards
   (rule 16). Keeping them as one record is what makes "reopen the folio"
   silently rewrite history.
*/
export const PAYMENTS = "hotelPayments";
export const INVOICES = "hotelInvoices";
export const COUNTERS = "counters";
export const AUDIT_LOGS = "hotelAuditLogs";

/** The counter document every hotel invoice number comes from. */
export const INVOICE_COUNTER = "hotel_invoice";

export const PAYMENT_STATUS = {
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
  REFUNDED: "refunded"
};

export const PAYMENT_METHODS = ["cash", "upi", "card", "bank_transfer", "razorpay", "credit"];

export function normalizePaymentMethod(value) {
  const method = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PAYMENT_METHODS.includes(method) ? method : "cash";
}

/**
 * The invoice number for a given serial.
 *
 * Prefix and width are settings so a property can match its existing books,
 * but the SERIAL itself is never formatted away — two invoices can never
 * share one, whatever the display format.
 */
export function formatInvoiceNumber(serial, { prefix = "INV", width = 5, financialYear = "" } = {}) {
  const number = String(Math.trunc(Number(serial) || 0)).padStart(Math.max(1, width), "0");
  return [prefix, financialYear, number].filter(Boolean).join("/");
}

export function createFolioService({ db, restaurantId, firestore, now = () => new Date() }) {
  const { doc, collection, runTransaction, serverTimestamp } = firestore;

  const folioRef = id => doc(db, "restaurants", restaurantId, FOLIOS, id);
  const itemRef = id => doc(db, "restaurants", restaurantId, FOLIO_ITEMS, id);
  const paymentRef = id => doc(db, PAYMENTS, id);
  const invoiceRef = id => doc(db, INVOICES, id);
  const counterRef = () => doc(db, "restaurants", restaurantId, COUNTERS, INVOICE_COUNTER);
  const auditRef = () => doc(collection(db, AUDIT_LOGS));

  function audit(transaction, { action, actor = {}, folioId, detail = {} }) {
    transaction.set(auditRef(), {
      restaurantId, action, folioId,
      userId: String(actor.uid || ""), userName: String(actor.name || ""), role: String(actor.role || ""),
      detail, createdAt: serverTimestamp(), at: now().toISOString()
    });
  }

  /* ---------------- charges ---------------- */

  /**
   * Post a charge to a folio.
   *
   * `chargeId` is supplied by the caller and is the idempotency key. A
   * restaurant bill posted to a room carries the order's own id, so the same
   * bill cannot land on the folio twice however many times the button is
   * pressed or the network retried — section 17's "post to room" depends on
   * this, because the POS and the folio are two writes that must behave as
   * one fact.
   */
  async function postCharge({ folioId, chargeId, actor, ...charge }) {
    if (!folioId) throw new FolioError("invalid", "This stay has no folio to post to.");
    if (!chargeId) throw new FolioError("invalid", "A charge must carry an id so it cannot post twice.");
    const kind = FOLIO_CHARGE_KINDS.includes(String(charge.kind)) ? String(charge.kind) : "other";

    return runTransaction(db, async transaction => {
      const folioSnapshot = await transaction.get(folioRef(folioId));
      if (!folioSnapshot.exists()) throw new FolioError("not_found", "This folio no longer exists.");
      const folio = folioSnapshot.data();
      if (folio.status === "closed") {
        // A closed folio is a settled account. Posting to it would change an
        // invoice the guest has already been given.
        throw new FolioError("closed", "This folio is closed. Raise a new charge against a fresh invoice instead.");
      }

      const existing = await transaction.get(itemRef(chargeId));
      if (existing.exists()) return { ok: true, duplicate: true, chargeId };

      const amounts = chargeAmounts(charge);
      transaction.set(itemRef(chargeId), {
        restaurantId, folioId, kind,
        description: String(charge.description || ""),
        quantity: Number(charge.quantity ?? 1),
        rate: Number(charge.rate ?? 0),
        discount: Number(charge.discount || 0),
        taxPercent: Number(charge.taxPercent || 0),
        taxInclusive: charge.taxInclusive === true,
        ...amounts,
        sourceType: String(charge.sourceType || "manual"),
        sourceId: String(charge.sourceId || ""),
        postedBy: String(actor?.name || ""),
        postedByUid: String(actor?.uid || ""),
        businessDate: asStayDate(charge.businessDate) || "",
        postedAt: serverTimestamp()
      });
      audit(transaction, { action: "folio_charge_posted", actor, folioId, detail: { chargeId, kind, total: amounts.total } });
      return { ok: true, chargeId, amounts };
    });
  }

  /**
   * Remove a charge. Permitted, but never silently: rule 14 asks for a
   * permission gate on discounts and this is the same class of act. The
   * removal is logged with what was removed, so a folio that shrank can
   * always be explained.
   */
  async function voidCharge({ folioId, chargeId, actor, reason = "" }) {
    const role = normalizeHotelRole(actor?.role);
    if (!["manager", "reception"].includes(role)) {
      throw new FolioError("forbidden", "Only a manager or the front desk can remove a charge from a folio.");
    }
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(itemRef(chargeId));
      if (!snapshot.exists()) return { ok: true, unchanged: true };
      const item = snapshot.data();
      transaction.delete(itemRef(chargeId));
      audit(transaction, {
        action: "folio_charge_voided", actor, folioId,
        detail: { chargeId, kind: item.kind, total: item.total, reason: String(reason || "") }
      });
      return { ok: true, removed: item };
    });
  }

  /* ---------------- payments ---------------- */

  /**
   * Step one of two: record the intent to take a payment.
   *
   * Written as PENDING. isSettledPayment() in hotel-core does not count it,
   * so the balance is unchanged until the money is confirmed. Rule 12 is not
   * a check somewhere — it is that this document starts out not counting.
   */
  async function beginPayment({ folioId, paymentId, amount, method, actor, reference = "", businessDate = "" }) {
    const value = round2(amount);
    if (!(value > 0)) throw new FolioError("invalid", "Enter an amount greater than zero.");
    if (!paymentId) throw new FolioError("invalid", "A payment must carry an id so a retry cannot double-charge.");

    return runTransaction(db, async transaction => {
      const existing = await transaction.get(paymentRef(paymentId));
      if (existing.exists()) return { ok: true, duplicate: true, paymentId, status: existing.data().status };

      transaction.set(paymentRef(paymentId), {
        restaurantId, folioId,
        amount: value,
        method: normalizePaymentMethod(method),
        status: PAYMENT_STATUS.PENDING,
        reference: String(reference || ""),
        takenBy: String(actor?.name || ""),
        takenByUid: String(actor?.uid || ""),
        businessDate: asStayDate(businessDate) || "",
        createdAt: serverTimestamp(),
        at: now().toISOString()
      });
      audit(transaction, { action: "payment_started", actor, folioId, detail: { paymentId, amount: value, method } });
      return { ok: true, paymentId, status: PAYMENT_STATUS.PENDING };
    });
  }

  /**
   * Step two: the gateway, the cash drawer or the card machine has answered.
   *
   * A payment already settled is not re-settled — a duplicate webhook or a
   * double-clicked Confirm must not credit the guest twice.
   */
  async function settlePayment({ folioId, paymentId, outcome, actor, reference = "", failureReason = "" }) {
    const status = outcome === true || outcome === PAYMENT_STATUS.SUCCESS
      ? PAYMENT_STATUS.SUCCESS : PAYMENT_STATUS.FAILED;

    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(paymentRef(paymentId));
      if (!snapshot.exists()) throw new FolioError("not_found", "That payment was never started.");
      const payment = snapshot.data();
      if (payment.status === PAYMENT_STATUS.SUCCESS) return { ok: true, unchanged: true, status: payment.status };
      if (payment.status === PAYMENT_STATUS.FAILED && status === PAYMENT_STATUS.FAILED) {
        return { ok: true, unchanged: true, status: payment.status };
      }

      transaction.set(paymentRef(paymentId), {
        status,
        reference: String(reference || payment.reference || ""),
        failureReason: status === PAYMENT_STATUS.FAILED ? String(failureReason || "") : "",
        settledAt: serverTimestamp()
      }, { merge: true });
      audit(transaction, {
        action: status === PAYMENT_STATUS.SUCCESS ? "payment_settled" : "payment_failed",
        actor, folioId, detail: { paymentId, amount: payment.amount, method: payment.method, failureReason }
      });
      return { ok: true, status };
    });
  }

  /**
   * A refund. Recorded as its own settled payment of kind "refund" rather
   * than by reducing what was collected — rule 13. "Took 5000, refunded
   * 1000" and "took 4000" reconcile to the same balance and are different
   * facts to an auditor.
   */
  async function recordRefund({ folioId, refundId, amount, method, actor, reason = "", businessDate = "" }) {
    const value = round2(amount);
    if (!(value > 0)) throw new FolioError("invalid", "Enter a refund amount greater than zero.");
    const role = normalizeHotelRole(actor?.role);
    if (!["manager", "reception"].includes(role)) {
      throw new FolioError("forbidden", "Only a manager or the front desk can record a refund.");
    }
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(paymentRef(refundId));
      if (existing.exists()) return { ok: true, duplicate: true };
      transaction.set(paymentRef(refundId), {
        restaurantId, folioId,
        amount: value,
        kind: "refund",
        method: normalizePaymentMethod(method),
        status: PAYMENT_STATUS.SUCCESS,
        reason: String(reason || ""),
        takenBy: String(actor?.name || ""), takenByUid: String(actor?.uid || ""),
        businessDate: asStayDate(businessDate) || "",
        createdAt: serverTimestamp(), at: now().toISOString()
      });
      audit(transaction, { action: "refund_recorded", actor, folioId, detail: { refundId, amount: value, reason } });
      return { ok: true, refundId };
    });
  }

  /* ---------------- checkout ---------------- */

  /**
   * Close the folio and raise the invoice.
   *
   * The caller passes the charges and payments it has already loaded; the
   * balance is recomputed here from those records rather than trusted from
   * the screen, so a stale total on a receptionist's display cannot let a
   * guest leave owing money.
   *
   * The invoice number is allocated inside the same transaction that closes
   * the folio, so a number is never taken by a checkout that then fails.
   */
  async function closeFolio({ folioId, charges, payments, actor, allowCredit = false, businessDate = "", invoiceFormat = {} }) {
    const totals = folioTotals(charges, payments);
    const permitted = canCheckOut(totals, { allowCredit, role: actor?.role });
    if (!permitted.ok) throw new FolioError("unsettled", permitted.reason, { balance: totals.balance });

    return runTransaction(db, async transaction => {
      const folioSnapshot = await transaction.get(folioRef(folioId));
      if (!folioSnapshot.exists()) throw new FolioError("not_found", "This folio no longer exists.");
      const folio = folioSnapshot.data();
      if (folio.status === "closed") {
        // Already invoiced. Returning the existing number rather than raising
        // a second one is what makes a retried checkout safe.
        return { ok: true, duplicate: true, invoiceNumber: folio.invoiceNumber, invoiceSerial: folio.invoiceSerial };
      }

      const counterSnapshot = await transaction.get(counterRef());
      const lastSerial = Number(counterSnapshot.exists() ? counterSnapshot.data().lastInvoiceSerial || 0 : 0);
      const serial = (Number.isFinite(lastSerial) && lastSerial > 0 ? Math.trunc(lastSerial) : 0) + 1;
      const invoiceNumber = formatInvoiceNumber(serial, invoiceFormat);

      transaction.set(counterRef(), { lastInvoiceSerial: serial, updatedAt: serverTimestamp() }, { merge: true });

      // The invoice: written once, never updated, never deleted. Everything
      // it needs to render is COPIED onto it — rules 16 and 17 mean it must
      // still print correctly after the guest record and the staff account
      // that raised it are gone, so it follows no references.
      transaction.set(invoiceRef(invoiceNumber.replace(/\//g, "_")), {
        restaurantId, folioId,
        invoiceSerial: serial,
        invoiceNumber,
        reservationId: String(folio.reservationId || ""),
        guestName: String(folio.guestName || ""),
        roomId: String(folio.roomId || ""),
        totals: {
          gross: totals.gross, discount: totals.discount, tax: totals.tax,
          total: totals.total, paid: totals.paid, refunded: totals.refunded,
          balance: totals.balance, byKind: totals.byKind
        },
        onCredit: totals.balance > 0,
        raisedBy: String(actor?.name || ""), raisedByUid: String(actor?.uid || ""),
        businessDate: asStayDate(businessDate) || "",
        createdAt: serverTimestamp(), at: now().toISOString()
      });

      transaction.set(folioRef(folioId), {
        status: "closed",
        invoiceSerial: serial,
        invoiceNumber,
        closedOnCredit: totals.balance > 0,
        closedBy: String(actor?.name || ""), closedByUid: String(actor?.uid || ""),
        closedBusinessDate: asStayDate(businessDate) || "",
        closedAt: serverTimestamp()
      }, { merge: true });
      audit(transaction, {
        action: "folio_closed", actor, folioId,
        detail: { invoiceNumber, total: totals.total, balance: totals.balance, onCredit: totals.balance > 0 }
      });
      return { ok: true, invoiceNumber, invoiceSerial: serial, totals };
    });
  }

  /** Opened at check-in, so every outlet has somewhere to post from minute one. */
  async function openFolio({ folioId, reservationId, guestId, guestName, roomId, actor, businessDate = "" }) {
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(folioRef(folioId));
      if (existing.exists()) return { ok: true, duplicate: true, folioId };
      transaction.set(folioRef(folioId), {
        restaurantId, reservationId: String(reservationId || ""),
        guestId: String(guestId || ""),
        // Denormalised on purpose — see rules 16 and 17 above.
        guestName: String(guestName || ""),
        roomId: String(roomId || ""),
        status: "open",
        openedBusinessDate: asStayDate(businessDate) || "",
        openedBy: String(actor?.name || ""),
        createdAt: serverTimestamp()
      });
      audit(transaction, { action: "folio_opened", actor, folioId, detail: { reservationId, roomId } });
      return { ok: true, folioId };
    });
  }

  return { openFolio, postCharge, voidCharge, beginPayment, settlePayment, recordRefund, closeFolio };
}

/* ---------------------------------------------------------
   POSTING A RESTAURANT BILL TO A ROOM  (section 17)
--------------------------------------------------------- */

/**
 * Turn an existing POS order into a folio charge.
 *
 * The order is NOT recomputed. Its totals were agreed when the bill was
 * raised, tax and all, and recalculating them here could produce a folio
 * line that disagrees with the printed restaurant bill the guest is holding.
 *
 * The charge id is derived from the order id, so pressing "post to room"
 * twice posts once.
 */
export function chargeFromPosOrder(order = {}, { kind = "food" } = {}) {
  const orderId = String(order.id || order.orderId || "");
  if (!orderId) return null;
  const total = round2(order.grandTotal ?? order.total ?? 0);
  if (!(total > 0)) return null;
  return {
    chargeId: `pos_${orderId}`,
    kind,
    description: `${order.outletName || "Restaurant"} bill ${order.billNumber || order.orderId || orderId}`,
    quantity: 1,
    rate: total,
    // Tax already sits inside the agreed total; adding a percentage here
    // would charge it twice.
    taxPercent: 0,
    sourceType: "pos_order",
    sourceId: orderId,
    businessDate: order.businessDate || order.dailyOrderDate || ""
  };
}

/**
 * Which rooms a restaurant bill may be posted to.
 *
 * Only a guest actually in house can charge to their room. Offering a
 * checked-out or merely-booked room is how a bill ends up on an account
 * nobody is going to settle.
 */
export function roomsAcceptingCharges(folios = []) {
  return folios
    .filter(folio => folio.status === "open" && folio.roomId)
    .map(folio => ({ folioId: folio.id, roomId: folio.roomId, guestName: folio.guestName || "Guest" }));
}

/* ---------------------------------------------------------
   THE CHECKOUT SUMMARY  (section 11)
--------------------------------------------------------- */

const SUMMARY_ORDER = [
  ["room", "Room charges"], ["food", "Food"], ["beverage", "Beverage"],
  ["room_service", "Room service"], ["laundry", "Laundry"], ["minibar", "Minibar"],
  ["extra_bed", "Extra bed"], ["transport", "Transport"], ["spa", "Spa"],
  ["event", "Events"], ["service", "Other services"], ["other", "Other"]
];

/** The bill a guest is shown at the desk, in the order section 11 lists it. */
export function checkoutSummary(charges = [], payments = []) {
  const totals = folioTotals(charges, payments);
  const lines = SUMMARY_ORDER
    .filter(([kind]) => totals.byKind[kind])
    .map(([kind, label]) => ({ kind, label, amount: totals.byKind[kind] }));
  const settled = payments.filter(isSettledPayment);
  return {
    lines,
    subtotal: round2(totals.gross - totals.discount),
    discount: totals.discount,
    tax: totals.tax,
    total: totals.total,
    paid: totals.paid,
    refunded: totals.refunded,
    balance: totals.balance,
    payments: settled,
    // Surfaced so a receptionist can see that a payment was attempted and
    // did not go through, rather than wondering why the balance is unchanged.
    unsettledAttempts: payments.length - settled.length
  };
}

export class FolioError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FolioError";
    this.code = code;
    Object.assign(this, details);
  }
}
