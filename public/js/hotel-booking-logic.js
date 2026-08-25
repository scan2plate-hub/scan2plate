// Hotel PMS — pure decision logic for room availability and folio totals.
// Deliberately free of any Firestore/network call (same split used by
// backend/lib/eventBookingLogic.js and mobile/www/offline-core.js's
// buildSyncPlan): given the exact state a transaction is about to commit,
// these functions are deterministic, so the same call inside a
// db.runTransaction() retry always sees and decides consistently against
// the latest committed data — that's what actually prevents double-booking,
// not any check made before the transaction starts.

const ACTIVE_BOOKING_STATUSES = new Set(["reserved", "confirmed", "checked_in"]);

export function isActiveBookingStatus(status = "") {
  return ACTIVE_BOOKING_STATUSES.has(String(status || "").toLowerCase());
}

export function nightsBetween(checkInDate, checkOutDate) {
  const inMs = new Date(`${checkInDate}T00:00:00`).getTime();
  const outMs = new Date(`${checkOutDate}T00:00:00`).getTime();
  if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) return 0;
  return Math.max(0, Math.round((outMs - inMs) / 86400000));
}

// Half-open interval overlap ([checkIn, checkOut)) — a checkout on the same
// day as another booking's check-in is not a conflict, matching normal
// hotel same-day turnover.
export function dateRangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function evaluateRoomAvailability(existingBookingsForRoom = [], requestedCheckIn, requestedCheckOut, excludeBookingId = null) {
  if (!requestedCheckIn || !requestedCheckOut || requestedCheckOut <= requestedCheckIn) {
    return { available: false, reason: "Check-out date must be after check-in date." };
  }
  const conflict = existingBookingsForRoom.find(booking =>
    booking.id !== excludeBookingId &&
    isActiveBookingStatus(booking.status) &&
    dateRangesOverlap(requestedCheckIn, requestedCheckOut, booking.checkInDate, booking.checkOutDate)
  );
  if (conflict) {
    return { available: false, reason: `Room is already booked ${conflict.checkInDate} to ${conflict.checkOutDate} (${conflict.guestName || "guest"}).`, conflictingBooking: conflict };
  }
  return { available: true };
}

export function computeRoomCharges(ratePerNight = 0, nights = 0, extraAdults = 0, extraAdultPrice = 0, extraChildren = 0, extraChildPrice = 0) {
  const base = Math.max(0, Number(ratePerNight || 0)) * Math.max(0, Number(nights || 0));
  const extraGuestCharges = (Math.max(0, Number(extraAdults || 0)) * Math.max(0, Number(extraAdultPrice || 0)) + Math.max(0, Number(extraChildren || 0)) * Math.max(0, Number(extraChildPrice || 0))) * Math.max(0, Number(nights || 0));
  return { roomCharges: base, extraGuestCharges, total: base + extraGuestCharges };
}

// discount: {type: "flat"|"percent", value}. Mirrors calculateOrderTotals's
// discount handling in common.js so hotel and restaurant billing agree on
// how a discount is applied.
export function computeFolioTotals(folioItems = [], taxPercent = 0, discount = {}, advancePaid = 0) {
  const subtotal = folioItems.reduce((sum, item) => sum + Number(item.quantity || 1) * Number(item.rate || 0), 0);
  const rawType = String(discount?.type || "").toLowerCase();
  const rawValue = Number(discount?.value || 0);
  let discountAmount = 0;
  if (rawType === "flat") discountAmount = Math.min(subtotal, Math.max(0, rawValue));
  else if (rawType === "percent") discountAmount = subtotal * Math.min(100, Math.max(0, rawValue)) / 100;
  const taxableAmount = Math.max(0, subtotal - discountAmount);
  const tax = taxableAmount * (Math.max(0, Number(taxPercent || 0)) / 100);
  const grandTotal = taxableAmount + tax;
  const paid = Math.max(0, Number(advancePaid || 0));
  const balance = Math.max(0, grandTotal - paid);
  return { subtotal, discountAmount, taxableAmount, tax, grandTotal, paid, balance };
}

export function folioItemFromRoomCharge(ratePerNight, nights, date) {
  return { date, description: `Room charge (${nights} night${nights === 1 ? "" : "s"} × ₹${ratePerNight})`, quantity: nights, rate: ratePerNight, category: "room" };
}
