/* =========================================================
   ROOM NIGHT LOCKS — HOW A ROOM IS ACTUALLY PREVENTED FROM
   BEING SOLD TWICE

   Section 7 says availability must always be calculated from
   real reservation data and never from UI state, and rule 2 says
   a room cannot be double-booked. Checking for a clash before
   writing does neither: between the check and the write, another
   receptionist — or the booking engine, or an OTA — can book the
   same room. The window is small and the failure is expensive,
   because it surfaces as two guests at the desk holding one room.

   THE OBVIOUS FIX IS NOT AVAILABLE. A Firestore client
   transaction can only `get` documents by id; it cannot run a
   query. So "re-check for conflicts inside the transaction" is
   not something the SDK can express, and any design that assumes
   it will quietly fall back to the racy check.

   WHAT WORKS INSTEAD. Give every sellable night its own document,
   at a deterministic id:

       hotel_room_nights/{roomId}__{YYYY-MM-DD}

   Holding a room for a stay means creating one lock per night.
   Those ids are computable without a query, so a transaction CAN
   read them, and Firestore guarantees at most one document per
   id. Two receptionists racing for the same night are two writes
   to the same document id: one wins, the other's transaction
   retries, sees the lock and fails with a clash. The database
   enforces it, not the UI.

   This module is the pure half: which locks a change needs, which
   it must release, and whether the locks it found permit it. No
   Firestore, so the decision is testable on its own.

   RELEASING IS AS IMPORTANT AS TAKING. Rules 9 and 10 say a
   cancellation and a no-show release inventory. Here that is
   literal: the locks are deleted, and the night is immediately
   sellable again.
========================================================= */
import { nightsOf, asStayDate, normalizeReservationStatus, reservationHoldsRoom, RESERVATION_STATUS } from "./hotel-core.js?v=s2p-20260922d";

/** Separator chosen so it cannot occur in a date and is legal in a doc id. */
const KEY_SEPARATOR = "__";

/**
 * The document id for one room on one night.
 * Returns "" for anything unusable, so a bad date can never produce a lock
 * id that silently collides with a real one.
 */
export function roomNightKey(roomId, stayDate) {
  const room = String(roomId ?? "").trim();
  const date = asStayDate(stayDate);
  if (!room || !date) return "";
  // A room id containing the separator would let two different rooms produce
  // the same key, which is the one way this scheme can be made unsafe.
  if (room.includes(KEY_SEPARATOR)) return "";
  return `${room}${KEY_SEPARATOR}${date}`;
}

/** Read a lock id back into its parts, for repair tools and reports. */
export function parseRoomNightKey(key) {
  const text = String(key ?? "");
  const at = text.lastIndexOf(KEY_SEPARATOR);
  if (at <= 0) return null;
  const roomId = text.slice(0, at);
  const stayDate = asStayDate(text.slice(at + KEY_SEPARATOR.length));
  return roomId && stayDate ? { roomId, stayDate } : null;
}

/** Every lock id a stay needs. Empty when the stay is not bookable. */
export function roomNightKeysFor({ roomId, checkIn, checkOut } = {}) {
  if (!roomId) return [];
  const keys = nightsOf(checkIn, checkOut).map(stayDate => roomNightKey(roomId, stayDate));
  // If any single night failed to key, the whole stay is unsafe to lock: a
  // partial hold would leave a night unprotected while the booking looked
  // complete. This is belt and braces — nightsOf only emits dates it has
  // already validated, so no current input reaches it with some nights
  // keyable and others not. It is kept because the cost of being wrong here
  // is a silently oversold night, and because nightsOf could change.
  return keys.every(Boolean) ? keys : [];
}

/**
 * A stay long enough to exceed what one transaction can hold.
 *
 * Firestore allows 500 writes per transaction, and each night costs one lock
 * plus the reservation document itself. The cap is deliberately far below
 * that: a stay beyond a few months is a long-stay contract, which is a
 * different product with different billing, not a booking the front desk
 * should be taking in one go.
 */
export const MAX_LOCKABLE_NIGHTS = 180;

/**
 * What a reservation change means for the locks.
 *
 * Given where the booking is now and where it is going, returns the locks to
 * take and the locks to release. Computing both together is what makes a room
 * move or a date change safe: the old nights are freed and the new ones taken
 * in ONE transaction, so the room is never briefly double-held and never
 * briefly free for someone else to grab.
 */
export function planRoomNightChange(previous, next) {
  const before = previous && reservationHoldsRoom(previous) ? roomNightKeysFor(previous) : [];
  const after = next && reservationHoldsRoom(next) ? roomNightKeysFor(next) : [];
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    acquire: after.filter(key => !beforeSet.has(key)),
    release: before.filter(key => !afterSet.has(key)),
    keep: after.filter(key => beforeSet.has(key)),
    total: after.length
  };
}

/**
 * Why a stay cannot be locked, before any database work is attempted.
 * Cheap checks first, so an obviously wrong booking never opens a
 * transaction at all.
 */
export function validateLockRequest({ roomId, checkIn, checkOut } = {}) {
  if (!String(roomId ?? "").trim()) return { ok: false, reason: "Select a room before booking." };
  if (String(roomId).includes(KEY_SEPARATOR)) {
    return { ok: false, reason: "This room's id cannot be used for booking. Contact Scan2Plate support." };
  }
  const keys = roomNightKeysFor({ roomId, checkIn, checkOut });
  if (!keys.length) return { ok: false, reason: "Enter a valid check-in and check-out date." };
  if (keys.length > MAX_LOCKABLE_NIGHTS) {
    return { ok: false, reason: `A single booking covers at most ${MAX_LOCKABLE_NIGHTS} nights. Split a longer stay, or set it up as a long-stay contract.` };
  }
  return { ok: true, reason: "", keys };
}

/**
 * Do the locks read inside the transaction permit this booking?
 *
 * `existing` maps lock id to whatever the transaction read there — the stored
 * document, or null when the night is free. A lock already held by THIS
 * reservation is fine: that is what makes re-saving an unchanged booking, or
 * retrying after a network failure, succeed rather than conflict with itself.
 */
export function lockConflicts(existing = {}, { reservationId = "" } = {}) {
  const conflicts = [];
  Object.entries(existing).forEach(([key, held]) => {
    if (!held) return;
    if (reservationId && String(held.reservationId || "") === String(reservationId)) return;
    conflicts.push({ key, ...parseRoomNightKey(key), heldBy: String(held.reservationId || ""), bookingId: held.bookingId || "" });
  });
  return conflicts;
}

/** The message a receptionist sees when the race is lost. */
export function describeLockConflicts(conflicts = []) {
  if (!conflicts.length) return "";
  const dates = [...new Set(conflicts.map(conflict => conflict.stayDate).filter(Boolean))].sort();
  const booking = conflicts.find(conflict => conflict.bookingId)?.bookingId;
  const nights = dates.length === 1 ? `on ${dates[0]}` : `on ${dates.length} nights from ${dates[0]}`;
  return booking
    ? `This room was just taken ${nights} by booking ${booking}. Pick another room or another date.`
    : `This room was just taken ${nights}. Pick another room or another date.`;
}

/**
 * The lock document body.
 *
 * It carries enough to rebuild the calendar and to diagnose a stuck lock
 * without opening the reservation: which booking holds it, for which guest,
 * and under which business. restaurantId is repeated on every lock because
 * these are queried by collection group during a night audit.
 */
export function roomNightLock({ restaurantId, roomId, stayDate, reservationId, bookingId = "", guestName = "" }) {
  return {
    restaurantId: String(restaurantId || ""),
    roomId: String(roomId || ""),
    stayDate: asStayDate(stayDate),
    reservationId: String(reservationId || ""),
    bookingId: String(bookingId || ""),
    guestName: String(guestName || "")
  };
}

/**
 * Statuses whose locks must be released.
 *
 * Rules 9 and 10 name cancellation and no-show. CHECKED_OUT is here too: the
 * stay is over, and a guest who leaves early should free the nights they did
 * not use rather than have them sit unsellable until the original checkout
 * date. Whether those nights are still charged is a folio question, which is
 * deliberately separate from whether the room can be resold.
 */
export const LOCK_RELEASING_STATUSES = [
  RESERVATION_STATUS.CANCELLED,
  RESERVATION_STATUS.NO_SHOW,
  RESERVATION_STATUS.CHECKED_OUT
];

export function releasesLocks(status) {
  return LOCK_RELEASING_STATUSES.includes(normalizeReservationStatus(status));
}
