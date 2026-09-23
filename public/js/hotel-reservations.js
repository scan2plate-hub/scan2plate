/* =========================================================
   RESERVATION SERVICE

   Every write that changes who holds a room goes through here, so
   there is exactly one place where double booking is prevented and
   exactly one place that records what happened.

   THE TRANSACTION IS THE PRODUCT. Each operation reads the night
   locks for the stay by id, checks them, then writes the locks and
   the reservation together. If another booking took one of those
   nights in between, Firestore aborts and retries; the retry reads
   the new lock and the booking fails with a clash the receptionist
   can act on. Nothing here trusts a prior availability check,
   because a prior check is exactly what a race defeats.

   Firestore is passed in rather than imported. The service then has
   no module-level dependency on a live database, which is what lets
   the transaction logic be tested against a stub — and the stub is
   where the race can actually be simulated.

   EVERY OPERATION LEAVES A TRAIL. Section 43 asks for an immutable
   log of reservation creation, modification, room change, check-in,
   check-out and cancellation. The entry is written inside the same
   transaction as the change, so a successful change cannot exist
   without its log entry and a failed one cannot leave a log entry
   behind claiming it happened.
========================================================= */
import {
  RESERVATION_STATUS, normalizeReservationStatus, validateStayDates,
  normalizeBookingSource, asStayDate, quoteStay, round2
} from "./hotel-core.js?v=s2p-20260922d";
import {
  roomNightKeysFor, validateLockRequest, lockConflicts, describeLockConflicts,
  planRoomNightChange, roomNightLock, releasesLocks
} from "./hotel-inventory.js?v=s2p-20260922d";

export const ROOM_NIGHTS = "hotel_room_nights";
export const RESERVATIONS = "hotel_reservations";
export const AUDIT_LOGS = "hotelAuditLogs";

/**
 * The Firestore functions this service needs, gathered in one object so a
 * caller wires it once and a test can substitute all of it.
 */
export function createReservationService({ db, restaurantId, firestore, now = () => new Date() }) {
  const { doc, collection, runTransaction, serverTimestamp } = firestore;

  const reservationRef = id => doc(db, "restaurants", restaurantId, RESERVATIONS, id);
  const lockRef = key => doc(db, "restaurants", restaurantId, ROOM_NIGHTS, key);
  const auditRef = () => doc(collection(db, AUDIT_LOGS));

  /**
   * Applies a reservation change atomically with its night locks.
   *
   * `mutate` receives the reservation as it exists now and returns what it
   * should become. Returning null means "no change" and the transaction ends
   * without a write, which keeps an idempotent retry from logging twice.
   */
  async function applyChange({ reservationId, mutate, action, actor = {}, expectExisting = true }) {
    return runTransaction(db, async transaction => {
      const ref = reservationRef(reservationId);
      const snapshot = await transaction.get(ref);
      const existing = snapshot.exists() ? { id: reservationId, ...snapshot.data() } : null;

      if (expectExisting && !existing) {
        throw new ReservationError("not_found", "This booking no longer exists. Refresh and try again.");
      }
      if (!expectExisting && existing) {
        // The same booking id arriving twice is a retry, not a second booking.
        return { ok: true, duplicate: true, reservation: existing };
      }

      const next = mutate(existing);
      if (!next) return { ok: true, unchanged: true, reservation: existing };

      const plan = planRoomNightChange(existing, next);

      // READS BEFORE WRITES. Firestore requires it, and it is also the whole
      // safety property: the locks are read inside the transaction, so a
      // concurrent write to any of them aborts and retries this block.
      const held = {};
      for (const key of plan.acquire) {
        const lockSnapshot = await transaction.get(lockRef(key));
        held[key] = lockSnapshot.exists() ? lockSnapshot.data() : null;
      }

      const conflicts = lockConflicts(held, { reservationId });
      if (conflicts.length) {
        throw new ReservationError("room_taken", describeLockConflicts(conflicts), { conflicts });
      }

      plan.release.forEach(key => transaction.delete(lockRef(key)));
      plan.acquire.forEach(key => {
        const parsed = key.slice(key.lastIndexOf("__") + 2);
        transaction.set(lockRef(key), roomNightLock({
          restaurantId, roomId: next.roomId, stayDate: parsed,
          reservationId, bookingId: next.bookingId, guestName: next.guestName
        }));
      });

      transaction.set(ref, { ...next, updatedAt: serverTimestamp() }, { merge: true });
      transaction.set(auditRef(), auditEntry({ action, actor, reservationId, before: existing, after: next }));

      return { ok: true, reservation: { id: reservationId, ...next }, locks: plan };
    });
  }

  function auditEntry({ action, actor, reservationId, before, after }) {
    return {
      restaurantId,
      action,
      reservationId,
      userId: String(actor.uid || actor.userId || ""),
      userName: String(actor.name || ""),
      role: String(actor.role || ""),
      // Only the fields that decide who holds which room, and for how long.
      // A full copy of both documents would put guest details into a log that
      // is readable by anyone who may read the log.
      before: before ? summarise(before) : null,
      after: after ? summarise(after) : null,
      createdAt: serverTimestamp(),
      at: now().toISOString()
    };
  }

  /* ---------------- operations ---------------- */

  /**
   * A new booking. `bookingId` is generated by the caller so a retry after a
   * dropped connection reuses it and cannot create a second booking.
   */
  async function create(input, actor) {
    const draft = buildReservation(input);
    const check = validateLockRequest(draft);
    if (!check.ok) throw new ReservationError("invalid", check.reason);
    return applyChange({
      reservationId: draft.id,
      expectExisting: false,
      action: "reservation_created",
      actor,
      mutate: () => draft
    });
  }

  /** Move a booking to a different room, different dates, or both. */
  async function amend(reservationId, changes, actor) {
    return applyChange({
      reservationId,
      action: changes.roomId ? "reservation_room_changed" : "reservation_dates_changed",
      actor,
      mutate: existing => {
        const next = { ...existing, ...changes };
        const dates = validateStayDates(next.checkIn, next.checkOut);
        if (!dates.ok) throw new ReservationError("invalid", dates.reason);
        const check = validateLockRequest(next);
        if (!check.ok) throw new ReservationError("invalid", check.reason);
        // A departed guest's stay is history. Editing it would silently
        // rewrite a night already counted in a closed day's revenue.
        if (normalizeReservationStatus(existing.status) === RESERVATION_STATUS.CHECKED_OUT) {
          throw new ReservationError("closed", "This stay is already checked out and cannot be changed.");
        }
        return { ...next, nights: dates.nights };
      }
    });
  }

  async function checkIn(reservationId, { roomId, actor, arrivalTime } = {}) {
    return applyChange({
      reservationId,
      action: "check_in",
      actor,
      mutate: existing => {
        const status = normalizeReservationStatus(existing.status);
        if (status === RESERVATION_STATUS.CHECKED_IN) return null; // already in; a retry
        if (![RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.TENTATIVE, RESERVATION_STATUS.PENDING].includes(status)) {
          throw new ReservationError("bad_status", `A booking that is ${status.toLowerCase().replace(/_/g, " ")} cannot be checked in.`);
        }
        return {
          ...existing,
          roomId: roomId || existing.roomId,
          status: RESERVATION_STATUS.CHECKED_IN,
          checkedInAt: arrivalTime || now().toISOString()
        };
      }
    });
  }

  /**
   * Check-out. Releases the night locks, because the stay is over — see
   * LOCK_RELEASING_STATUSES. Whether the folio is settled is decided by the
   * caller through canCheckOut(); this is the write that follows that answer.
   */
  async function checkOut(reservationId, { actor, departureTime, onCredit = false } = {}) {
    return applyChange({
      reservationId,
      action: "check_out",
      actor,
      mutate: existing => {
        const status = normalizeReservationStatus(existing.status);
        if (status === RESERVATION_STATUS.CHECKED_OUT) return null;
        if (status !== RESERVATION_STATUS.CHECKED_IN) {
          throw new ReservationError("bad_status", "Only a guest who is checked in can be checked out.");
        }
        return {
          ...existing,
          status: RESERVATION_STATUS.CHECKED_OUT,
          checkedOutAt: departureTime || now().toISOString(),
          settledOnCredit: onCredit === true
        };
      }
    });
  }

  async function cancel(reservationId, { actor, reason = "", businessDate = "" } = {}) {
    return applyChange({
      reservationId,
      action: "reservation_cancelled",
      actor,
      mutate: existing => {
        const status = normalizeReservationStatus(existing.status);
        if (status === RESERVATION_STATUS.CANCELLED) return null;
        if (status === RESERVATION_STATUS.CHECKED_IN) {
          throw new ReservationError("bad_status", "This guest is in house. Check them out instead of cancelling.");
        }
        if (status === RESERVATION_STATUS.CHECKED_OUT) {
          throw new ReservationError("closed", "A completed stay cannot be cancelled.");
        }
        return {
          ...existing,
          status: RESERVATION_STATUS.CANCELLED,
          cancelledOn: asStayDate(businessDate) || asStayDate(now()),
          cancellationReason: String(reason || "")
        };
      }
    });
  }

  async function markNoShow(reservationId, { actor, businessDate = "" } = {}) {
    return applyChange({
      reservationId,
      action: "reservation_no_show",
      actor,
      mutate: existing => {
        const status = normalizeReservationStatus(existing.status);
        if (status === RESERVATION_STATUS.NO_SHOW) return null;
        if (![RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.TENTATIVE, RESERVATION_STATUS.PENDING].includes(status)) {
          throw new ReservationError("bad_status", "Only a booking that never arrived can be marked a no-show.");
        }
        return {
          ...existing,
          status: RESERVATION_STATUS.NO_SHOW,
          noShowOn: asStayDate(businessDate) || asStayDate(now())
        };
      }
    });
  }

  return { create, amend, checkIn, checkOut, cancel, markNoShow, applyChange };
}

/* ---------------------------------------------------------
   SHAPING
--------------------------------------------------------- */

/** Only what a log needs to answer "who held this room, when". */
function summarise(reservation = {}) {
  return {
    roomId: String(reservation.roomId || ""),
    checkIn: asStayDate(reservation.checkIn),
    checkOut: asStayDate(reservation.checkOut),
    status: normalizeReservationStatus(reservation.status),
    total: round2(reservation.total || 0)
  };
}

/**
 * A reservation document from front-desk input.
 *
 * The rate is quoted here and stored per night. A stay priced only as a total
 * cannot be split across a month boundary without guessing, and section 37
 * asks for revenue by month — so the breakdown is recorded at the moment the
 * price is agreed, not reconstructed later.
 */
export function buildReservation(input = {}) {
  const {
    id, bookingId, roomId, roomTypeId, guestId, guestName = "", guestPhone = "", guestEmail = "",
    checkIn, checkOut, adults = 1, children = 0, source, ratePlans = [], roomType = {},
    status = RESERVATION_STATUS.CONFIRMED, notes = "", specialRequests = "", corporateId = ""
  } = input;

  const dates = validateStayDates(checkIn, checkOut);
  if (!dates.ok) throw new ReservationError("invalid", dates.reason);

  const quote = quoteStay(ratePlans, {
    checkIn, checkOut, roomType, roomTypeId, adults, children, corporateId,
    source: normalizeBookingSource(source)
  });

  return {
    id: String(id || bookingId),
    bookingId: String(bookingId || id),
    roomId: String(roomId || ""),
    roomTypeId: String(roomTypeId || roomType.id || ""),
    guestId: String(guestId || ""),
    guestName: String(guestName), guestPhone: String(guestPhone), guestEmail: String(guestEmail),
    checkIn: asStayDate(checkIn),
    checkOut: asStayDate(checkOut),
    nights: dates.nights,
    adults: Number(adults) || 1,
    children: Number(children) || 0,
    source: normalizeBookingSource(source),
    corporateId: String(corporateId || ""),
    status: normalizeReservationStatus(status),
    nightlyRates: quote.nights,
    roomTotal: quote.roomTotal,
    extraTotal: quote.extraTotal,
    total: quote.total,
    notes: String(notes),
    specialRequests: String(specialRequests)
  };
}

/** A failure a receptionist can be shown, with a code the UI can branch on. */
export class ReservationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ReservationError";
    this.code = code;
    Object.assign(this, details);
  }
}

export { roomNightKeysFor, releasesLocks };
