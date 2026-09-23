/* =========================================================
   HOTEL DOMAIN CORE

   Section 56 of the specification lists twenty business rules.
   They are the ones that cost a hotel money or credibility when
   they break: overselling a room, a guest walking out with an
   unpaid folio, a room sold while it is still dirty, occupancy
   figures that cannot be reconciled.

   Each is tested here against the pure core, with no Firestore
   and no DOM, so the rule is verified rather than merely written
   down in a comment.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import {
  asStayDate, nightsBetween, nightsOf, addDays, staysOverlap, validateStayDates,
  ROOM_STATUS, normalizeRoomStatus, isSellableRoom, canChangeRoomStatus, normalizeHotelRole,
  RESERVATION_STATUS, normalizeReservationStatus, reservationHoldsRoom,
  conflictingReservations, isRoomAvailable, availableRooms, validateRoomAssignment,
  resolveNightlyRate, quoteStay, extraOccupancyCharge, overlappingRatePlans, dayKeyOf,
  chargeAmounts, folioTotals, isSettledPayment, canCheckOut, round2,
  sellableRoomNights, soldRoomNights, hotelKpis, frontDeskSnapshot,
  normalizeBookingSource, isOtaSource, propertyToday
} from "../public/js/hotel-core.js";

// getBusinessDate is INJECTED rather than imported. common.js holds
// module-scope timers that keep the event loop alive, which makes
// --test-force-exit truncate this file's report; and the helper's own
// correctness is already covered by business-date.test.mjs. What belongs
// here is that propertyToday asks it the right question.
const recordingBusinessDate = calls => (resetTime, timezone, date) => {
  calls.push({ resetTime, timezone, date });
  return "STUB";
};

const room = (id, patch = {}) => ({ id, roomNumber: id, status: ROOM_STATUS.AVAILABLE, ...patch });
const booking = (id, roomId, checkIn, checkOut, patch = {}) => ({
  id, bookingId: `BK${id}`, roomId, checkIn, checkOut, status: RESERVATION_STATUS.CONFIRMED, ...patch
});

/* =========================================================
   DATES AND NIGHTS
========================================================= */

test("a stay is counted in nights, not days", () => {
  // Three nights, four calendar days touched. Billing the fourth is the
  // single most common hotel invoicing complaint.
  assert.equal(nightsBetween("2026-10-01", "2026-10-04"), 3);
  assert.deepEqual(nightsOf("2026-10-01", "2026-10-04"), ["2026-10-01", "2026-10-02", "2026-10-03"]);
});

test("impossible dates are rejected rather than coerced", () => {
  assert.equal(asStayDate("2026-02-31"), "", "February has no 31st");
  assert.equal(asStayDate("2026-13-01"), "", "there is no month 13");
  assert.equal(asStayDate("01-10-2026"), "", "a day-first date is not a stay date");
  assert.equal(asStayDate(""), "");
  assert.equal(asStayDate(null), "");
  assert.equal(asStayDate("2026-10-01"), "2026-10-01");
  assert.equal(asStayDate("2026-10-01T18:30:00Z"), "2026-10-01", "an instant is truncated to its date");
});

test("date arithmetic crosses month and year boundaries", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(nightsBetween("2026-12-30", "2027-01-02"), 3);
});

test("a same-day turnover is not a clash", () => {
  // One guest out on the 5th, the next in on the 5th. Every hotel does this
  // daily; treating it as a double booking makes changeover days unsellable.
  assert.equal(staysOverlap("2026-10-01", "2026-10-05", "2026-10-05", "2026-10-09"), false);
  assert.equal(staysOverlap("2026-10-05", "2026-10-09", "2026-10-01", "2026-10-05"), false);
});

test("genuinely overlapping stays are caught from either direction", () => {
  const cases = [
    ["2026-10-01", "2026-10-05", "2026-10-04", "2026-10-08"], // tail overlaps head
    ["2026-10-04", "2026-10-08", "2026-10-01", "2026-10-05"], // and the reverse
    ["2026-10-01", "2026-10-10", "2026-10-03", "2026-10-05"], // fully contained
    ["2026-10-03", "2026-10-05", "2026-10-01", "2026-10-10"], // fully containing
    ["2026-10-01", "2026-10-05", "2026-10-01", "2026-10-05"]  // identical
  ];
  cases.forEach(([a1, a2, b1, b2]) => {
    assert.equal(staysOverlap(a1, a2, b1, b2), true, `${a1}..${a2} vs ${b1}..${b2} must clash`);
  });
});

test("a stay must be at least one night", () => {
  assert.equal(validateStayDates("2026-10-01", "2026-10-01").ok, false, "same-day is not a stay");
  assert.equal(validateStayDates("2026-10-05", "2026-10-01").ok, false, "checkout before check-in");
  assert.match(validateStayDates("2026-10-05", "2026-10-01").reason, /cannot be before/);
  assert.equal(validateStayDates("2026-10-01", "2026-10-02").ok, true);
  assert.equal(validateStayDates("2026-10-01", "2026-10-02").nights, 1);
});

test("RULE 20: the business date is asked for in the PROPERTY's timezone", () => {
  // The browser's timezone must never reach this calculation. A hotel in
  // Kolkata whose manager opens the dashboard from London still closes its
  // day on Kolkata time.
  const calls = [];
  const at = new Date("2026-10-01T20:00:00Z");
  propertyToday(recordingBusinessDate(calls), { timezone: "Asia/Kolkata", nightAuditTime: "03:00" }, at);
  assert.deepEqual(calls[0], { resetTime: "03:00", timezone: "Asia/Kolkata", date: at });
});

test("a property that has set no timezone still gets a hotel-sane default", () => {
  // Never the browser's zone, and never midnight: a hotel day rolls over
  // during the night audit, which is why arrivals after midnight belong to
  // the previous business day.
  const calls = [];
  propertyToday(recordingBusinessDate(calls), {}, new Date("2026-10-01T20:00:00Z"));
  assert.equal(calls[0].timezone, "Asia/Kolkata");
  assert.equal(calls[0].resetTime, "04:00");
});

test("the night audit hour overrides the restaurant reset time when both exist", () => {
  // A hotel that also runs a restaurant has two different day boundaries.
  const calls = [];
  propertyToday(recordingBusinessDate(calls), { nightAuditTime: "02:00", dailyOrderResetTime: "04:00" }, new Date());
  assert.equal(calls[0].resetTime, "02:00");
});

/* =========================================================
   ROOM STATUS — rules 4, 5, 6, 7, 8
========================================================= */

test("RULES 7 and 8: only sellable rooms count as inventory", () => {
  assert.equal(isSellableRoom(room("101")), true);
  assert.equal(isSellableRoom(room("102", { status: ROOM_STATUS.OUT_OF_ORDER })), false);
  assert.equal(isSellableRoom(room("103", { status: ROOM_STATUS.OUT_OF_SERVICE })), false);
  assert.equal(isSellableRoom(room("104", { status: ROOM_STATUS.BLOCKED })), false);
  assert.equal(isSellableRoom(room("105", { active: false })), false);
});

test("a dirty room is still sellable for a future date", () => {
  // Deliberate. A room dirty this morning is fine for next week, and blocking
  // it would cost real revenue. Same-day sale is stopped at check-in instead.
  assert.equal(isSellableRoom(room("101", { status: ROOM_STATUS.DIRTY })), true);
  assert.equal(isSellableRoom(room("101", { status: ROOM_STATUS.OCCUPIED })), true);
});

test("RULE 4: a room goes DIRTY after checkout, and the system may do it", () => {
  assert.equal(canChangeRoomStatus(ROOM_STATUS.OCCUPIED, ROOM_STATUS.DIRTY, "system").allowed, true);
  // It must NOT be able to go straight back to sellable.
  assert.equal(canChangeRoomStatus(ROOM_STATUS.OCCUPIED, ROOM_STATUS.AVAILABLE, "system").allowed, false);
  assert.equal(canChangeRoomStatus(ROOM_STATUS.OCCUPIED, ROOM_STATUS.AVAILABLE, "manager").allowed, false,
    "not even a manager can skip housekeeping — the room is physically dirty");
});

test("RULE 5: housekeeping cleans, RULE 6: only a supervisor inspects", () => {
  assert.equal(canChangeRoomStatus(ROOM_STATUS.DIRTY, ROOM_STATUS.CLEANING, "housekeeping").allowed, true);
  assert.equal(canChangeRoomStatus(ROOM_STATUS.CLEANING, ROOM_STATUS.INSPECTED, "supervisor").allowed, true);
  const byHousekeeping = canChangeRoomStatus(ROOM_STATUS.CLEANING, ROOM_STATUS.INSPECTED, "housekeeping");
  assert.equal(byHousekeeping.allowed, false, "the cleaner cannot sign off their own work");
  assert.match(byHousekeeping.reason, /supervisor/i);
});

test("the full housekeeping cycle reaches AVAILABLE and no further", () => {
  const cycle = [
    [ROOM_STATUS.OCCUPIED, ROOM_STATUS.DIRTY, "system"],
    [ROOM_STATUS.DIRTY, ROOM_STATUS.CLEANING, "housekeeping"],
    [ROOM_STATUS.CLEANING, ROOM_STATUS.INSPECTED, "supervisor"],
    [ROOM_STATUS.INSPECTED, ROOM_STATUS.AVAILABLE, "supervisor"]
  ];
  cycle.forEach(([from, to, role]) => {
    assert.equal(canChangeRoomStatus(from, to, role).allowed, true, `${from} -> ${to} as ${role}`);
  });
  // Reception cannot conjure a clean room out of a dirty one.
  assert.equal(canChangeRoomStatus(ROOM_STATUS.DIRTY, ROOM_STATUS.AVAILABLE, "reception").allowed, false);
});

test("a no-op status change is always allowed", () => {
  assert.equal(canChangeRoomStatus(ROOM_STATUS.DIRTY, ROOM_STATUS.DIRTY, "housekeeping").allowed, true);
});

test("role names from the existing staff system are understood", () => {
  assert.equal(normalizeHotelRole("Receptionist"), "reception");
  assert.equal(normalizeHotelRole("FRONT DESK"), "reception");
  assert.equal(normalizeHotelRole("owner"), "manager");
  assert.equal(normalizeHotelRole("housekeeper"), "housekeeping");
  assert.equal(normalizeHotelRole("chef"), "", "an unknown role grants nothing");
});

test("an unknown room status is never silently treated as out of order", () => {
  assert.equal(normalizeRoomStatus("available"), ROOM_STATUS.AVAILABLE);
  assert.equal(normalizeRoomStatus("out of order"), ROOM_STATUS.OUT_OF_ORDER);
  assert.equal(normalizeRoomStatus("out-of-service"), ROOM_STATUS.OUT_OF_SERVICE);
  assert.equal(normalizeRoomStatus("nonsense"), ROOM_STATUS.AVAILABLE);
});

/* =========================================================
   AVAILABILITY — rules 1, 2, 9, 10
========================================================= */

test("RULES 1 and 2: a held room cannot be sold twice", () => {
  const held = [booking("r1", "101", "2026-10-01", "2026-10-05")];
  assert.equal(isRoomAvailable(room("101"), held, { checkIn: "2026-10-03", checkOut: "2026-10-07" }), false);
  assert.equal(isRoomAvailable(room("101"), held, { checkIn: "2026-10-05", checkOut: "2026-10-07" }), true,
    "the turnover day is sellable");
  assert.equal(isRoomAvailable(room("102"), held, { checkIn: "2026-10-03", checkOut: "2026-10-07" }), true,
    "a different room is unaffected");
});

test("RULE 9: a cancelled booking releases the room immediately", () => {
  const stay = { checkIn: "2026-10-01", checkOut: "2026-10-05" };
  const held = [booking("r1", "101", stay.checkIn, stay.checkOut)];
  assert.equal(isRoomAvailable(room("101"), held, stay), false);
  const cancelled = [{ ...held[0], status: RESERVATION_STATUS.CANCELLED }];
  assert.equal(isRoomAvailable(room("101"), cancelled, stay), true);
});

test("RULE 10: a no-show releases the room too", () => {
  const stay = { checkIn: "2026-10-01", checkOut: "2026-10-05" };
  const noShow = [booking("r1", "101", stay.checkIn, stay.checkOut, { status: RESERVATION_STATUS.NO_SHOW })];
  assert.equal(isRoomAvailable(room("101"), noShow, stay), true);
});

test("a tentative booking DOES hold the room", () => {
  // An unconfirmed hold that does not block is not a hold. Overselling it is
  // worse than losing it.
  const stay = { checkIn: "2026-10-01", checkOut: "2026-10-05" };
  const tentative = [booking("r1", "101", stay.checkIn, stay.checkOut, { status: RESERVATION_STATUS.TENTATIVE })];
  assert.equal(isRoomAvailable(room("101"), tentative, stay), false);
  assert.equal(reservationHoldsRoom(tentative[0]), true);
});

test("a departed guest does not hold the room", () => {
  const stay = { checkIn: "2026-10-01", checkOut: "2026-10-05" };
  const gone = [booking("r1", "101", stay.checkIn, stay.checkOut, { status: RESERVATION_STATUS.CHECKED_OUT })];
  assert.equal(isRoomAvailable(room("101"), gone, stay), true);
});

test("editing a booking does not conflict with itself", () => {
  // Without this, changing the dates on an existing booking is impossible:
  // the booking blocks its own move.
  const existing = [booking("r1", "101", "2026-10-01", "2026-10-05")];
  const extended = { checkIn: "2026-10-01", checkOut: "2026-10-07", ignoreReservationId: "r1" };
  assert.equal(isRoomAvailable(room("101"), existing, extended), true);
  assert.equal(isRoomAvailable(room("101"), existing, { ...extended, ignoreReservationId: "" }), false);
});

test("an out-of-order room is refused with a reason a receptionist can act on", () => {
  const stay = { checkIn: "2026-10-01", checkOut: "2026-10-05" };
  const result = validateRoomAssignment(room("101", { status: ROOM_STATUS.OUT_OF_ORDER }), [], stay);
  assert.equal(result.ok, false);
  assert.match(result.reason, /out of order/i);
  assert.match(result.reason, /101/);
});

test("a clash names the booking that holds the room", () => {
  const held = [booking("r1", "101", "2026-10-01", "2026-10-05")];
  const result = validateRoomAssignment(room("101"), held, { checkIn: "2026-10-02", checkOut: "2026-10-06" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /BKr1/, "the receptionist must be able to find the other booking");
  assert.equal(result.conflicts.length, 1);
});

test("bad dates are caught before any room is examined", () => {
  const result = validateRoomAssignment(room("101"), [], { checkIn: "2026-10-05", checkOut: "2026-10-01" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /check-out cannot be before/i);
});

test("availableRooms returns only what can actually be sold", () => {
  const rooms = [
    room("101"),
    room("102", { status: ROOM_STATUS.OUT_OF_ORDER }),
    room("103"),
    room("104", { active: false }),
    room("105", { status: ROOM_STATUS.DIRTY })
  ];
  const held = [booking("r1", "103", "2026-10-01", "2026-10-05")];
  const free = availableRooms(rooms, held, { checkIn: "2026-10-02", checkOut: "2026-10-04" });
  assert.deepEqual(free.map(r => r.id), ["101", "105"]);
});

test("conflict search ignores reservations for other rooms entirely", () => {
  const held = [booking("r1", "999", "2026-10-01", "2026-10-05")];
  assert.equal(conflictingReservations(held, { roomId: "101", checkIn: "2026-10-01", checkOut: "2026-10-05" }).length, 0);
  assert.equal(conflictingReservations(held, { roomId: "", checkIn: "2026-10-01", checkOut: "2026-10-05" }).length, 0);
});

/* =========================================================
   RATES — section 13
========================================================= */

const baseType = { id: "deluxe", baseRate: 2500, maxAdults: 2, extraAdultRate: 800, extraChildRate: 400 };

test("with no rate rules the room type's base rate applies", () => {
  const result = resolveNightlyRate([], { stayDate: "2026-10-05", roomType: baseType });
  assert.equal(result.amount, 2500);
  assert.equal(result.source, "base");
});

test("a seasonal rule beats the base rate inside its window and not outside", () => {
  const plans = [{ id: "oct", name: "October", roomTypeId: "deluxe", amount: 2800, priority: 1, validFrom: "2026-10-01", validTo: "2026-10-31" }];
  assert.equal(resolveNightlyRate(plans, { stayDate: "2026-10-05", roomType: baseType }).amount, 2800);
  assert.equal(resolveNightlyRate(plans, { stayDate: "2026-11-05", roomType: baseType }).amount, 2500);
});

test("priority decides when rules stack, and the winner is named", () => {
  const plans = [
    { id: "season", name: "Season", roomTypeId: "deluxe", amount: 2800, priority: 1, validFrom: "2026-10-01", validTo: "2026-10-31" },
    { id: "festival", name: "Diwali", roomTypeId: "deluxe", amount: 3500, priority: 5, validFrom: "2026-10-20", validTo: "2026-10-25" }
  ];
  const festival = resolveNightlyRate(plans, { stayDate: "2026-10-22", roomType: baseType });
  assert.equal(festival.amount, 3500);
  assert.equal(festival.plan.name, "Diwali", "the desk must be able to explain the price");
  assert.equal(resolveNightlyRate(plans, { stayDate: "2026-10-10", roomType: baseType }).amount, 2800);
});

test("a weekend rule applies only on its days", () => {
  // 2026-10-03 is a Saturday, 2026-10-05 a Monday.
  assert.equal(dayKeyOf("2026-10-03"), "sat");
  assert.equal(dayKeyOf("2026-10-05"), "mon");
  const plans = [{ id: "wknd", roomTypeId: "deluxe", amount: 3200, priority: 2, days: ["fri", "sat"] }];
  assert.equal(resolveNightlyRate(plans, { stayDate: "2026-10-03", roomType: baseType }).amount, 3200);
  assert.equal(resolveNightlyRate(plans, { stayDate: "2026-10-05", roomType: baseType }).amount, 2500);
});

test("a rule for another room type never leaks across", () => {
  const plans = [{ id: "suite", roomTypeId: "suite", amount: 9000, priority: 9 }];
  assert.equal(resolveNightlyRate(plans, { stayDate: "2026-10-05", roomType: baseType }).amount, 2500);
});

test("an inactive rate rule is ignored", () => {
  const plans = [{ id: "old", roomTypeId: "deluxe", amount: 1200, priority: 9, active: false }];
  assert.equal(resolveNightlyRate(plans, { stayDate: "2026-10-05", roomType: baseType }).amount, 2500);
});

test("a corporate contract applies only to that company", () => {
  const plans = [{ id: "acme", roomTypeId: "deluxe", corporateId: "ACME", amount: 1900, priority: 8 }];
  assert.equal(resolveNightlyRate(plans, { stayDate: "2026-10-05", roomType: baseType, corporateId: "ACME" }).amount, 1900);
  assert.equal(resolveNightlyRate(plans, { stayDate: "2026-10-05", roomType: baseType, corporateId: "OTHER" }).amount, 2500);
  assert.equal(resolveNightlyRate(plans, { stayDate: "2026-10-05", roomType: baseType }).amount, 2500);
});

test("a stay is quoted night by night, so a mixed-rate stay is explainable", () => {
  const plans = [{ id: "festival", name: "Diwali", roomTypeId: "deluxe", amount: 3500, priority: 5, validFrom: "2026-10-20", validTo: "2026-10-21" }];
  const quote = quoteStay(plans, { checkIn: "2026-10-19", checkOut: "2026-10-22", roomType: baseType, adults: 2 });
  assert.equal(quote.nightCount, 3);
  assert.deepEqual(quote.nights.map(n => n.amount), [2500, 3500, 3500]);
  assert.equal(quote.roomTotal, 9500);
});

test("extra occupancy is charged per night, above the included occupancy", () => {
  assert.equal(extraOccupancyCharge({ roomType: baseType, adults: 2, children: 0 }), 0);
  assert.equal(extraOccupancyCharge({ roomType: baseType, adults: 3, children: 0 }), 800);
  assert.equal(extraOccupancyCharge({ roomType: baseType, adults: 3, children: 2 }), 800 + 800);
  const quote = quoteStay([], { checkIn: "2026-10-01", checkOut: "2026-10-03", roomType: baseType, adults: 3 });
  assert.equal(quote.extraTotal, 1600, "two nights of one extra adult");
  assert.equal(quote.total, 5000 + 1600);
});

test("overlapping rules at the same priority are surfaced, not silently resolved", () => {
  const plans = [
    { id: "a", roomTypeId: "deluxe", amount: 2800, priority: 1, validFrom: "2026-10-01", validTo: "2026-10-31" },
    { id: "b", roomTypeId: "deluxe", amount: 3100, priority: 1, validFrom: "2026-10-15", validTo: "2026-11-15" },
    { id: "c", roomTypeId: "deluxe", amount: 3300, priority: 2, validFrom: "2026-10-15", validTo: "2026-11-15" },
    { id: "d", roomTypeId: "suite", amount: 9000, priority: 1, validFrom: "2026-10-01", validTo: "2026-10-31" }
  ];
  const clashes = overlappingRatePlans(plans);
  assert.equal(clashes.length, 1, "only the equal-priority, same-type pair clashes");
  assert.deepEqual(clashes[0].map(plan => plan.id), ["a", "b"]);
});

/* =========================================================
   FOLIO — rules 3, 11, 12, 13
========================================================= */

test("a charge line computes discount then tax, in that order", () => {
  const line = chargeAmounts({ quantity: 2, rate: 1000, discount: 200, taxPercent: 12 });
  assert.equal(line.gross, 2000);
  assert.equal(line.net, 1800);
  assert.equal(line.tax, 216, "tax is charged on the discounted amount, not the gross");
  assert.equal(line.total, 2016);
});

test("tax-inclusive pricing extracts the tax instead of adding it", () => {
  const inclusive = chargeAmounts({ quantity: 1, rate: 1120, taxPercent: 12, taxInclusive: true });
  assert.equal(inclusive.total, 1120, "the guest pays the shelf price");
  assert.equal(inclusive.tax, 120);
  const exclusive = chargeAmounts({ quantity: 1, rate: 1000, taxPercent: 12 });
  assert.equal(exclusive.total, 1120);
  assert.equal(exclusive.tax, 120);
});

test("a discount can never exceed the charge", () => {
  const line = chargeAmounts({ quantity: 1, rate: 500, discount: 900 });
  assert.equal(line.discount, 500);
  assert.equal(line.net, 0);
  assert.equal(line.total, 0);
});

test("RULE 12: only an explicitly successful payment counts", () => {
  assert.equal(isSettledPayment({ status: "success" }), true);
  assert.equal(isSettledPayment({ status: "CAPTURED" }), true);
  assert.equal(isSettledPayment({ status: "failed" }), false);
  assert.equal(isSettledPayment({ status: "pending" }), false);
  assert.equal(isSettledPayment({ status: "" }), false, "an unknown answer is not payment");
  assert.equal(isSettledPayment({}), false, "a missing status is not payment");
});

test("RULE 11: an advance shows on the folio and reduces the balance", () => {
  const charges = [{ kind: "room", quantity: 2, rate: 2500, taxPercent: 12 }];
  const totals = folioTotals(charges, [{ amount: 2000, status: "success", method: "upi" }]);
  assert.equal(totals.total, 5600);
  assert.equal(totals.paid, 2000);
  assert.equal(totals.balance, 3600);
});

test("RULE 12 again: a failed payment does not reduce the balance", () => {
  const charges = [{ kind: "room", quantity: 1, rate: 1000 }];
  const totals = folioTotals(charges, [
    { amount: 1000, status: "failed" },
    { amount: 1000, status: "pending" }
  ]);
  assert.equal(totals.paid, 0);
  assert.equal(totals.balance, 1000, "the guest still owes the money");
  assert.equal(totals.rejectedCount, 2);
});

test("RULE 13: refunds are recorded separately, not netted away", () => {
  const charges = [{ kind: "room", quantity: 1, rate: 5000 }];
  const totals = folioTotals(charges, [
    { amount: 5000, status: "success" },
    { amount: 1000, status: "success", kind: "refund" }
  ]);
  assert.equal(totals.paid, 5000, "what was collected stays visible");
  assert.equal(totals.refunded, 1000);
  assert.equal(totals.netPaid, 4000);
  assert.equal(totals.balance, 1000);
});

test("a negative payment amount is treated as a refund", () => {
  const totals = folioTotals([{ kind: "room", quantity: 1, rate: 5000 }], [
    { amount: 5000, status: "success" },
    { amount: -1500, status: "success" }
  ]);
  assert.equal(totals.refunded, 1500);
  assert.equal(totals.netPaid, 3500);
});

test("charges are grouped by kind for the checkout summary", () => {
  const totals = folioTotals([
    { kind: "room", quantity: 2, rate: 2500 },
    { kind: "food", quantity: 1, rate: 850 },
    { kind: "laundry", quantity: 1, rate: 200 },
    { kind: "nonsense", quantity: 1, rate: 100 }
  ], []);
  assert.equal(totals.byKind.room, 5000);
  assert.equal(totals.byKind.food, 850);
  assert.equal(totals.byKind.laundry, 200);
  assert.equal(totals.byKind.other, 100, "an unrecognised kind is shown, never dropped");
  assert.equal(totals.total, 6150);
});

test("RULE 3: checkout is blocked while the folio is unsettled", () => {
  const unpaid = folioTotals([{ kind: "room", quantity: 1, rate: 3000 }], []);
  const blocked = canCheckOut(unpaid);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /outstanding balance/i);

  const settled = folioTotals([{ kind: "room", quantity: 1, rate: 3000 }], [{ amount: 3000, status: "success" }]);
  assert.equal(canCheckOut(settled).ok, true);
});

test("checking out on credit is possible, but only deliberately and by the right role", () => {
  const unpaid = folioTotals([{ kind: "room", quantity: 1, rate: 3000 }], []);
  assert.equal(canCheckOut(unpaid, { allowCredit: true, role: "manager" }).ok, true);
  assert.equal(canCheckOut(unpaid, { allowCredit: true, role: "manager" }).onCredit, true);
  assert.equal(canCheckOut(unpaid, { allowCredit: true, role: "housekeeping" }).ok, false);
});

test("an overpaid folio does not block checkout", () => {
  const overpaid = folioTotals([{ kind: "room", quantity: 1, rate: 1000 }], [{ amount: 1500, status: "success" }]);
  assert.equal(overpaid.balance, -500);
  assert.equal(canCheckOut(overpaid).ok, true);
});

test("money rounds to paise without float drift", () => {
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2("2500.456"), 2500.46);
  assert.equal(round2(Number.NaN), 0);
  assert.equal(round2(undefined), 0);
});

/* =========================================================
   KPIs — sections 3 and 37
========================================================= */

const tenRooms = Array.from({ length: 10 }, (unused, i) => room(String(101 + i)));

test("occupancy uses sellable room nights on both sides", () => {
  const rooms = [...tenRooms.slice(0, 9), room("110", { status: ROOM_STATUS.OUT_OF_ORDER })];
  // 9 sellable rooms x 10 nights = 90, not 100.
  assert.equal(sellableRoomNights(rooms, "2026-10-01", "2026-10-11"), 90);
});

test("a stay straddling the window counts only its nights inside it", () => {
  const reservations = [booking("r1", "101", "2026-09-28", "2026-10-03", {
    status: RESERVATION_STATUS.CHECKED_OUT, roomTotal: 5000
  })];
  // Nights 28, 29, 30, 1, 2 — two of them inside October.
  const sold = soldRoomNights(reservations, "2026-10-01", "2026-10-31");
  assert.equal(sold.roomNights, 2);
  assert.equal(sold.revenue, 2000, "5000 over five nights, two nights in window");
});

test("per-night rates are used when present instead of an even spread", () => {
  const reservations = [booking("r1", "101", "2026-09-30", "2026-10-02", {
    status: RESERVATION_STATUS.CHECKED_OUT,
    roomTotal: 6000,
    nightlyRates: [{ stayDate: "2026-09-30", amount: 2000 }, { stayDate: "2026-10-01", amount: 4000 }]
  })];
  const sold = soldRoomNights(reservations, "2026-10-01", "2026-10-31");
  assert.equal(sold.roomNights, 1);
  assert.equal(sold.revenue, 4000, "the actual rate for that night, not half the total");
});

test("cancellations and no-shows never move ADR", () => {
  const reservations = [
    booking("r1", "101", "2026-10-01", "2026-10-03", { status: RESERVATION_STATUS.CHECKED_OUT, roomTotal: 5000 }),
    booking("r2", "102", "2026-10-01", "2026-10-03", { status: RESERVATION_STATUS.CANCELLED, roomTotal: 5000 }),
    booking("r3", "103", "2026-10-01", "2026-10-03", { status: RESERVATION_STATUS.NO_SHOW, roomTotal: 5000 })
  ];
  const sold = soldRoomNights(reservations, "2026-10-01", "2026-10-31");
  assert.equal(sold.roomNights, 2, "only the real stay");
  assert.equal(sold.revenue, 5000);
});

test("ADR, RevPAR and occupancy are each computed from their own numerator", () => {
  const reservations = [
    booking("r1", "101", "2026-10-01", "2026-10-03", { status: RESERVATION_STATUS.CHECKED_OUT, roomTotal: 6000 }),
    booking("r2", "102", "2026-10-01", "2026-10-02", { status: RESERVATION_STATUS.CHECKED_OUT, roomTotal: 2000 })
  ];
  const kpis = hotelKpis(tenRooms, reservations, "2026-10-01", "2026-10-03");
  assert.equal(kpis.availableRoomNights, 20);      // 10 rooms x 2 nights
  assert.equal(kpis.soldRoomNights, 3);            // 2 + 1
  assert.equal(kpis.roomRevenue, 8000);
  assert.equal(kpis.occupancy, 15);                // 3/20
  assert.equal(kpis.adr, round2(8000 / 3));        // revenue per SOLD night
  assert.equal(kpis.revpar, 400);                  // revenue per AVAILABLE night
  assert.equal(kpis.averageLengthOfStay, 1.5);
});

test("the three KPIs reconcile against each other", () => {
  // ADR x occupancy equals RevPAR only because all three are computed over
  // one consistent pair of denominators. A PMS that measures occupancy over
  // ALL rooms and ADR over sellable ones fails this, and then nobody can say
  // which of its three numbers is the wrong one.
  const rooms = [...tenRooms.slice(0, 9), room("110", { status: ROOM_STATUS.OUT_OF_ORDER })];
  const reservations = [
    booking("r1", "101", "2026-10-01", "2026-10-03", { status: RESERVATION_STATUS.CHECKED_OUT, roomTotal: 6000 }),
    booking("r2", "102", "2026-10-01", "2026-10-02", { status: RESERVATION_STATUS.CHECKED_OUT, roomTotal: 2500 })
  ];
  const kpis = hotelKpis(rooms, reservations, "2026-10-01", "2026-10-03");
  assert.equal(kpis.availableRoomNights, 18, "the out-of-order room is excluded from BOTH sides");
  assert.equal(kpis.revpar, round2(kpis.roomRevenue / kpis.availableRoomNights));

  // And NOT derived from the other two. ADR and occupancy are each rounded
  // for display; multiplying two rounded numbers compounds the error. Here
  // that is 472.32 against a true 472.22 — small per day, but a RevPAR the
  // owner cannot reconcile against the revenue report at month end.
  const derived = round2(kpis.adr * kpis.occupancy / 100);
  assert.notEqual(derived, kpis.revpar, "this sample is chosen because the two disagree");
  assert.ok(Math.abs(derived - kpis.revpar) < 1, "and they disagree only by rounding, not by definition");
});

test("an empty hotel reports zeroes, never NaN or Infinity", () => {
  const kpis = hotelKpis([], [], "2026-10-01", "2026-10-02");
  assert.deepEqual(
    [kpis.occupancy, kpis.adr, kpis.revpar, kpis.averageLengthOfStay],
    [0, 0, 0, 0]
  );
  const noNights = hotelKpis(tenRooms, [], "2026-10-01", "2026-10-01");
  assert.equal(noNights.availableRoomNights, 0);
  assert.equal(noNights.occupancy, 0);
});

test("the front desk snapshot counts from records, not cached flags", () => {
  const rooms = [
    room("101", { status: ROOM_STATUS.OCCUPIED }),
    room("102", { status: ROOM_STATUS.DIRTY }),
    room("103", { status: ROOM_STATUS.OUT_OF_ORDER }),
    room("104")
  ];
  const reservations = [
    booking("r1", "101", "2026-10-05", "2026-10-08", { status: RESERVATION_STATUS.CHECKED_IN }),
    booking("r2", "104", "2026-10-05", "2026-10-09", { status: RESERVATION_STATUS.CONFIRMED }),
    booking("r3", "102", "2026-10-01", "2026-10-05", { status: RESERVATION_STATUS.CHECKED_IN }),
    booking("r4", "103", "2026-10-05", "2026-10-06", { status: RESERVATION_STATUS.CANCELLED, cancelledOn: "2026-10-05" })
  ];
  const snap = frontDeskSnapshot(rooms, reservations, "2026-10-05");
  assert.equal(snap.totalRooms, 4);
  assert.equal(snap.sellableRooms, 3, "the out-of-order room is not inventory");
  assert.equal(snap.roomStatusCounts.OCCUPIED, 1);
  assert.equal(snap.roomStatusCounts.DIRTY, 1);
  assert.equal(snap.arrivalsToday, 2, "the cancelled one is not an arrival");
  assert.equal(snap.departuresToday, 1);
  assert.equal(snap.inHouse, 2);
  assert.equal(snap.expectedCheckIns, 1);
  assert.equal(snap.expectedCheckOuts, 1);
  assert.equal(snap.cancelledToday, 1);
});

/* =========================================================
   BOOKING SOURCES
========================================================= */

test("booking sources normalise across the spellings an OTA feed sends", () => {
  assert.equal(normalizeBookingSource("Booking.com"), "booking_com");
  assert.equal(normalizeBookingSource("bookingcom"), "booking_com");
  assert.equal(normalizeBookingSource("MakeMyTrip"), "makemytrip");
  assert.equal(normalizeBookingSource("Walk-in"), "walk_in");
  assert.equal(normalizeBookingSource(""), "walk_in", "a blank source is a walk-in");
  assert.equal(normalizeBookingSource("carrier pigeon"), "other");
});

test("OTA sources are distinguishable, for commission and channel reporting", () => {
  assert.equal(isOtaSource("Goibibo"), true);
  assert.equal(isOtaSource("Agoda"), true);
  assert.equal(isOtaSource("walk_in"), false);
  assert.equal(isOtaSource("corporate"), false);
});

/* =========================================================
   THE LIFECYCLE, END TO END (spec section 58, tests 1-17)
========================================================= */

test("a full stay: book, check in, post charges, check out, clean, resell", () => {
  const rooms = [room("101"), room("102")];
  let reservations = [];

  // TEST 4 — reserve
  const stay = { checkIn: "2026-10-05", checkOut: "2026-10-08" };
  assert.equal(validateRoomAssignment(rooms[0], reservations, stay).ok, true);
  reservations = [booking("r1", "101", stay.checkIn, stay.checkOut)];

  // A second booking for the same nights must be refused (TEST 17's inverse)
  assert.equal(validateRoomAssignment(rooms[0], reservations, stay).ok, false);

  // TEST 5 — check in
  reservations = [{ ...reservations[0], status: RESERVATION_STATUS.CHECKED_IN }];
  let roomStatus = ROOM_STATUS.OCCUPIED;

  // TESTS 6-8 — restaurant posted to room, room service, laundry
  const charges = [
    { kind: "room", quantity: 3, rate: 2500, taxPercent: 12 },
    { kind: "food", quantity: 1, rate: 850, taxPercent: 5 },
    { kind: "room_service", quantity: 1, rate: 300, taxPercent: 5 },
    { kind: "laundry", quantity: 1, rate: 200, taxPercent: 18 }
  ];
  const folio = folioTotals(charges, [{ amount: 2000, status: "success", method: "upi" }]);
  assert.equal(folio.byKind.room, 8400);
  assert.equal(folio.byKind.food, 892.5);
  assert.ok(folio.balance > 0);

  // TEST 10 — checkout is refused until the folio is handled
  assert.equal(canCheckOut(folio).ok, false);

  // TEST 12 — pay the balance
  const settled = folioTotals(charges, [
    { amount: 2000, status: "success", method: "upi" },
    { amount: folio.balance, status: "success", method: "card" }
  ]);
  assert.equal(settled.balance, 0);
  assert.equal(canCheckOut(settled).ok, true);

  // TESTS 13-16 — checkout dirties the room, housekeeping cycles it back
  reservations = [{ ...reservations[0], status: RESERVATION_STATUS.CHECKED_OUT }];
  assert.equal(canChangeRoomStatus(roomStatus, ROOM_STATUS.DIRTY, "system").allowed, true);
  roomStatus = ROOM_STATUS.DIRTY;
  [[ROOM_STATUS.CLEANING, "housekeeping"], [ROOM_STATUS.INSPECTED, "supervisor"], [ROOM_STATUS.AVAILABLE, "supervisor"]]
    .forEach(([next, role]) => {
      assert.equal(canChangeRoomStatus(roomStatus, next, role).allowed, true, `${roomStatus} -> ${next}`);
      roomStatus = next;
    });
  assert.equal(roomStatus, ROOM_STATUS.AVAILABLE);

  // TEST 17 — the room sells again for the same nights, the stay being over
  assert.equal(validateRoomAssignment(room("101", { status: roomStatus }), reservations, stay).ok, true);
});
