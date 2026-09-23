/* =========================================================
   NIGHT AUDIT  (section 25)

   Closing a hotel's day: charge tonight's rooms, deal with the
   guests who never arrived, reconcile the money, and record what
   the day was. Once recorded it can never be changed — the rules
   make hotelNightAudits create-only, because a closing that can
   be rewritten afterwards is not a closing.

   THE SPEC IS EXPLICIT AND IT IS RIGHT: "Do NOT automatically
   close the day based purely on frontend time." So nothing here
   runs on a timer. The audit is a deliberate act by a manager,
   and this module's main job is to tell them what they are about
   to close over.

   That matters because closing a day does irreversible things.
   Marking a booking a no-show releases its room (rule 10) and may
   trigger a charge. Posting tonight's room charges puts money on
   folios. Doing any of that because a browser tab happened to be
   open past midnight — in the WRONG timezone, on a laptop
   somebody left on — is how a hotel wakes up to a day it cannot
   unwind.

   THE BUSINESS DATE COMES FROM THE PROPERTY (rule 20). A hotel in
   Kolkata closes on Kolkata's clock whether the manager is in
   Kolkata, London or on a phone with the wrong timezone set.

   WHAT THE AUDIT REFUSES TO DO SILENTLY is as important as what it
   does. A guest still in a room whose stay ended is not quietly
   checked out; an arrival that never came is not quietly voided.
   Both are surfaced as decisions, because both cost somebody
   money and both are somebody's judgement to make.
========================================================= */
import {
  RESERVATION_STATUS, normalizeReservationStatus, reservationHoldsRoom,
  asStayDate, addDays, nightsOf, round2, hotelKpis, frontDeskSnapshot,
  isSettledPayment, isRefund, normalizeHotelRole, propertyToday
} from "./hotel-core.js?v=s2p-20260922d";
import { normalizeShiftStatus, SHIFT_STATUS } from "./hotel-cashier.js?v=s2p-20260922d";

export const NIGHT_AUDITS = "hotelNightAudits";
export const FOLIO_ITEMS = "hotel_folio_items";
export const AUDIT_LOGS = "hotelAuditLogs";

/* ---------------------------------------------------------
   WHAT THE DAY IS CARRYING
--------------------------------------------------------- */

/**
 * Bookings that were due to arrive and did not.
 *
 * A booking whose check-in date has passed and which is still merely
 * confirmed never arrived. Rule 10 says a no-show releases the room — but
 * deciding it IS a no-show is a human call, because a guest stuck on a
 * delayed flight is not the same as one who never intended to come.
 */
export function pendingArrivals(reservations = [], businessDate) {
  const today = asStayDate(businessDate);
  if (!today) return [];
  return reservations.filter(reservation => {
    const status = normalizeReservationStatus(reservation.status);
    if (![RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.TENTATIVE, RESERVATION_STATUS.PENDING].includes(status)) return false;
    const checkIn = asStayDate(reservation.checkIn);
    return Boolean(checkIn) && checkIn <= today;
  });
}

/**
 * Guests whose stay has ended but who are still checked in.
 *
 * Usually a receptionist who forgot to check someone out; sometimes a guest
 * who extended verbally and nobody recorded it. Never resolved
 * automatically: one reading bills a night that was not agreed, the other
 * loses a night that was.
 */
export function overdueDepartures(reservations = [], businessDate) {
  const today = asStayDate(businessDate);
  if (!today) return [];
  return reservations.filter(reservation =>
    normalizeReservationStatus(reservation.status) === RESERVATION_STATUS.CHECKED_IN
    && asStayDate(reservation.checkOut) <= today);
}

/** In-house guests who owe a room charge for tonight. */
export function stayoverCharges(reservations = [], businessDate) {
  const today = asStayDate(businessDate);
  if (!today) return [];
  return reservations
    .filter(reservation => {
      if (normalizeReservationStatus(reservation.status) !== RESERVATION_STATUS.CHECKED_IN) return false;
      // Tonight is a night of this stay: on or after check-in, before
      // check-out. The checkout day is not a night, so a guest leaving
      // tomorrow is charged tonight and a guest leaving today is not.
      const from = asStayDate(reservation.checkIn);
      const to = asStayDate(reservation.checkOut);
      return Boolean(from) && Boolean(to) && today >= from && today < to;
    })
    .map(reservation => {
      const nightly = Array.isArray(reservation.nightlyRates)
        ? reservation.nightlyRates.find(night => night.stayDate === today)
        : null;
      const nights = nightsOf(reservation.checkIn, reservation.checkOut).length || 1;
      return {
        reservationId: reservation.id,
        roomId: reservation.roomId,
        guestName: reservation.guestName || "",
        stayDate: today,
        // The rate agreed when the booking was made, not tonight's price. A
        // stay spanning a rate change bills what was quoted.
        amount: round2(nightly ? nightly.amount : Number(reservation.roomTotal || 0) / nights),
        // The same key check-in uses, so a night can never post twice.
        chargeId: `room_${reservation.id}_${today}`
      };
    })
    .filter(charge => charge.amount > 0);
}

/** Folios still owing money as the day closes. */
export function outstandingFolios(folios = []) {
  return folios.filter(folio => folio.status === "open" && Number(folio.balance || 0) > 0);
}

/* ---------------------------------------------------------
   THE PRE-AUDIT CHECK
--------------------------------------------------------- */

/**
 * Everything standing between the manager and a closed day.
 *
 * Blocking items must be resolved. Warnings may be closed over deliberately,
 * and are recorded on the audit so tomorrow can see what yesterday chose to
 * live with. The distinction is whether closing over it corrupts the books:
 * an open cashier shift means the day's cash is unreconciled and the audit's
 * own cash figure would be a guess, so that blocks; an unpaid folio is a
 * fact about a guest still in the hotel, which is normal.
 */
export function auditReadiness({
  businessDate, reservations = [], folios = [], shifts = [], rooms = []
} = {}) {
  const today = asStayDate(businessDate);
  const arrivals = pendingArrivals(reservations, today);
  const departures = overdueDepartures(reservations, today);
  const charges = stayoverCharges(reservations, today);
  const unpaid = outstandingFolios(folios);
  const openShifts = shifts.filter(shift =>
    ![SHIFT_STATUS.CLOSED].includes(normalizeShiftStatus(shift.status)));

  const blocking = [];
  const warnings = [];

  if (!today) blocking.push({ id: "no_date", label: "The property's business date could not be determined." });
  if (openShifts.length) {
    blocking.push({
      id: "open_shifts",
      label: `${openShifts.length} cashier shift${openShifts.length === 1 ? " is" : "s are"} still open. Close them so the day's cash is reconciled.`,
      items: openShifts
    });
  }
  if (arrivals.length) {
    warnings.push({
      id: "pending_arrivals",
      label: `${arrivals.length} booking${arrivals.length === 1 ? "" : "s"} due to arrive and not checked in. Mark them no-show or move them.`,
      items: arrivals
    });
  }
  if (departures.length) {
    warnings.push({
      id: "overdue_departures",
      label: `${departures.length} guest${departures.length === 1 ? " is" : "s are"} past their checkout date and still in house.`,
      items: departures
    });
  }
  if (unpaid.length) {
    warnings.push({
      id: "outstanding",
      label: `${unpaid.length} folio${unpaid.length === 1 ? "" : "s"} carrying a balance.`,
      items: unpaid
    });
  }

  return {
    businessDate: today,
    blocking,
    warnings,
    canRun: blocking.length === 0,
    charges,
    counts: {
      roomChargesDue: charges.length,
      roomChargeTotal: round2(charges.reduce((sum, charge) => sum + charge.amount, 0)),
      pendingArrivals: arrivals.length,
      overdueDepartures: departures.length,
      outstandingFolios: unpaid.length,
      openShifts: openShifts.length,
      rooms: rooms.length
    }
  };
}

/* ---------------------------------------------------------
   THE DAY'S NUMBERS
--------------------------------------------------------- */

/**
 * Revenue and occupancy for the closing day.
 *
 * Payments are split by method because they reconcile in different places —
 * cash against a drawer, cards against a gateway — and a single "collected"
 * figure hides which of those is wrong when the day does not balance.
 */
export function auditTotals({ businessDate, rooms = [], reservations = [], folioItems = [], payments = [] } = {}) {
  const today = asStayDate(businessDate);
  const tomorrow = addDays(today, 1);
  const kpis = hotelKpis(rooms, reservations, today, tomorrow);
  const snapshot = frontDeskSnapshot(rooms, reservations, today);

  const todaysItems = folioItems.filter(item => asStayDate(item.businessDate) === today);
  const byKind = {};
  todaysItems.forEach(item => {
    const kind = String(item.kind || "other");
    byKind[kind] = round2((byKind[kind] || 0) + Number(item.total || 0));
  });

  const settled = payments.filter(payment => asStayDate(payment.businessDate) === today && isSettledPayment(payment));
  const byMethod = {};
  let collected = 0;
  let refunded = 0;
  settled.forEach(payment => {
    const method = String(payment.method || "other").toLowerCase();
    const amount = Math.abs(Number(payment.amount || 0));
    if (isRefund(payment)) {
      refunded = round2(refunded + amount);
      byMethod[method] = round2((byMethod[method] || 0) - amount);
    } else {
      collected = round2(collected + amount);
      byMethod[method] = round2((byMethod[method] || 0) + amount);
    }
  });

  return {
    businessDate: today,
    occupancy: kpis.occupancy,
    adr: kpis.adr,
    revpar: kpis.revpar,
    roomNightsSold: kpis.soldRoomNights,
    availableRoomNights: kpis.availableRoomNights,
    revenue: {
      byKind,
      total: round2(Object.values(byKind).reduce((sum, value) => sum + value, 0))
    },
    collection: { byMethod, collected, refunded, net: round2(collected - refunded) },
    rooms: snapshot.roomStatusCounts,
    inHouse: snapshot.inHouse,
    arrivals: snapshot.arrivalsToday,
    departures: snapshot.departuresToday
  };
}

/** Is this the day the property should be closing? */
export function expectedAuditDate(getBusinessDate, settings = {}, lastAuditDate = "", now = new Date()) {
  const today = propertyToday(getBusinessDate, settings, now);
  const last = asStayDate(lastAuditDate);
  // The day AFTER the last close is the next one to close. Without a previous
  // audit, the property closes today.
  const next = last ? addDays(last, 1) : today;
  return {
    today,
    next,
    // A property that has not closed for several days must work through them
    // in order, because each day's figures depend on the one before.
    behindBy: last && next < today ? nightsOf(next, today).length : 0,
    upToDate: Boolean(last) && last >= today
  };
}

/* ---------------------------------------------------------
   THE SERVICE
--------------------------------------------------------- */

export function createNightAuditService({ db, restaurantId, firestore, now = () => new Date() }) {
  const { doc, collection, runTransaction, writeBatch, serverTimestamp } = firestore;

  const auditDocRef = id => doc(db, NIGHT_AUDITS, String(id));
  const itemRef = id => doc(db, "restaurants", restaurantId, FOLIO_ITEMS, String(id));
  const logRef = () => doc(collection(db, AUDIT_LOGS));

  const auditIdFor = businessDate => `${restaurantId}_${asStayDate(businessDate)}`;

  /**
   * Post tonight's room charges.
   *
   * Separate from closing the day, and run first, because it is the part
   * that can be retried safely: every charge is keyed by reservation and
   * date, so running it twice posts once.
   */
  async function postRoomCharges({ charges = [], folioIdFor, actor, taxPercent = 0 }) {
    if (!charges.length) return { ok: true, posted: 0 };
    const batch = writeBatch(db);
    charges.forEach(charge => {
      const folioId = folioIdFor(charge.reservationId);
      batch.set(itemRef(charge.chargeId), {
        restaurantId, folioId,
        kind: "room",
        description: `Room ${charge.roomId} · ${charge.stayDate}`,
        quantity: 1,
        rate: charge.amount,
        discount: 0,
        taxPercent: Number(taxPercent) || 0,
        net: charge.amount,
        tax: round2(charge.amount * (Number(taxPercent) || 0) / 100),
        total: round2(charge.amount * (1 + (Number(taxPercent) || 0) / 100)),
        sourceType: "night_audit",
        sourceId: charge.reservationId,
        businessDate: charge.stayDate,
        postedBy: String(actor?.name || "Night audit"),
        postedAt: serverTimestamp()
      }, { merge: true });
    });
    batch.set(logRef(), {
      restaurantId, action: "night_audit_room_charges_posted",
      userId: String(actor?.uid || ""), userName: String(actor?.name || ""), role: String(actor?.role || ""),
      detail: { count: charges.length, total: round2(charges.reduce((sum, charge) => sum + charge.amount, 0)) },
      createdAt: serverTimestamp(), at: now().toISOString()
    });
    await batch.commit();
    return { ok: true, posted: charges.length };
  }

  /**
   * Close the day.
   *
   * Refuses on anything blocking. Warnings must be acknowledged explicitly,
   * and what was acknowledged is written onto the audit — so a month later
   * it is possible to see that Tuesday closed with three unpaid folios and
   * that somebody chose that.
   */
  async function closeDay({ readiness, totals, actor, acknowledgedWarnings = [], notes = "" }) {
    if (!readiness?.businessDate) throw new AuditError("invalid", "No business date to close.");
    if (!readiness.canRun) {
      throw new AuditError("blocked", readiness.blocking[0]?.label || "This day cannot be closed yet.", {
        blocking: readiness.blocking
      });
    }
    if (!["manager"].includes(normalizeHotelRole(actor?.role))) {
      throw new AuditError("forbidden", "Only a manager can close the day.");
    }
    const unacknowledged = readiness.warnings.filter(warning => !acknowledgedWarnings.includes(warning.id));
    if (unacknowledged.length) {
      throw new AuditError("unacknowledged", unacknowledged[0].label, { warnings: unacknowledged });
    }

    const auditId = auditIdFor(readiness.businessDate);
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(auditDocRef(auditId));
      if (existing.exists()) {
        // Already closed. Returning it rather than raising a second one is
        // what makes a retried close safe — and the rules would refuse the
        // write anyway, because a night audit is create-only.
        return { ok: true, duplicate: true, auditId, businessDate: readiness.businessDate };
      }
      transaction.set(auditDocRef(auditId), {
        restaurantId,
        businessDate: readiness.businessDate,
        ...totals,
        roomChargesPosted: readiness.counts.roomChargesDue,
        roomChargeTotal: readiness.counts.roomChargeTotal,
        // Written down so tomorrow can see what yesterday chose to live with.
        acknowledgedWarnings: readiness.warnings
          .filter(warning => acknowledgedWarnings.includes(warning.id))
          .map(warning => ({ id: warning.id, label: warning.label, count: warning.items?.length || 0 })),
        notes: String(notes || ""),
        closedByUid: String(actor?.uid || ""), closedByName: String(actor?.name || ""),
        createdAt: serverTimestamp(), at: now().toISOString()
      });
      transaction.set(logRef(), {
        restaurantId, action: "night_audit_closed",
        userId: String(actor?.uid || ""), userName: String(actor?.name || ""), role: String(actor?.role || ""),
        detail: {
          auditId, businessDate: readiness.businessDate,
          occupancy: totals?.occupancy, collected: totals?.collection?.net
        },
        createdAt: serverTimestamp(), at: now().toISOString()
      });
      return { ok: true, auditId, businessDate: readiness.businessDate };
    });
  }

  return { postRoomCharges, closeDay, auditIdFor };
}

export class AuditError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AuditError";
    this.code = code;
    Object.assign(this, details);
  }
}
