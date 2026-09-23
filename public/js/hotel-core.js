/* =========================================================
   HOTEL PMS — DOMAIN CORE

   Pure logic for the hotel business type. No Firestore, no DOM,
   no network. Everything a hotel gets wrong in production lives
   here — availability, the room status machine, folio arithmetic,
   rate priority and the KPI formulas — so it can be tested
   directly and so the front desk, the reports, the booking engine
   and the backend all answer the same question the same way.

   WHY A SEPARATE MODULE. The restaurant side of Scan2Plate is
   untouched by this file and cannot import it by accident. A hotel
   reuses the platform — auth, staff, billing serials, inventory,
   the POS, subscriptions — and adds these rules on top. Nothing
   here changes how any existing business type behaves.

   TWO CONVENTIONS, BOTH DELIBERATE.

   1. A stay is the half-open interval [checkIn, checkOut). The
      checkout day is NOT a night. This is what makes a guest
      leaving on the 5th and another arriving on the 5th a legal
      same-day turnover rather than a double booking, and it is why
      nights are counted, never days.

   2. Dates are plain YYYY-MM-DD strings, not Date objects. A hotel
      night is a calendar fact in the PROPERTY's timezone, not an
      instant. Storing instants is how a 11pm booking in Kolkata
      lands on the previous day for a server in UTC. Where a real
      instant is needed (an audit timestamp, an arrival time) it is
      kept separately and converted through the property timezone.
========================================================= */

export const HOTEL_BUSINESS_TYPE = "hotel";

/* ---------------------------------------------------------
   DATES AND NIGHTS
--------------------------------------------------------- */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A valid YYYY-MM-DD string, or "" — never a guess. */
export function asStayDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : toStayDate(value);
  }
  const text = String(value ?? "").trim().slice(0, 10);
  if (!DATE_PATTERN.test(text)) return "";
  // Rejects 2026-02-31 and 2026-13-01, which the pattern alone accepts.
  const [y, m, d] = text.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return "";
  return text;
}

/** A Date rendered as a stay date in UTC terms. */
function toStayDate(date) {
  return date.toISOString().slice(0, 10);
}

function stayDateToUtcMillis(value) {
  const date = asStayDate(value);
  if (!date) return NaN;
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Calendar days between two stay dates. Negative when out precedes in. */
export function nightsBetween(checkIn, checkOut) {
  const a = stayDateToUtcMillis(checkIn);
  const b = stayDateToUtcMillis(checkOut);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** Stay date plus N days. */
export function addDays(stayDate, days) {
  const base = stayDateToUtcMillis(stayDate);
  if (!Number.isFinite(base)) return "";
  return toStayDate(new Date(base + Math.trunc(days) * 86400000));
}

/** Every night in [checkIn, checkOut) — the checkout day excluded. */
export function nightsOf(checkIn, checkOut) {
  const count = nightsBetween(checkIn, checkOut);
  if (count <= 0) return [];
  const start = asStayDate(checkIn);
  return Array.from({ length: count }, (unused, index) => addDays(start, index));
}

/**
 * Do two stays overlap?
 *
 * Half-open on both sides, so [1st, 5th) and [5th, 9th) do NOT overlap —
 * that is a same-day turnover, which every hotel does daily. Treating it as
 * a clash would make the property unsellable on changeover days.
 */
export function staysOverlap(aIn, aOut, bIn, bOut) {
  const a1 = stayDateToUtcMillis(aIn);
  const a2 = stayDateToUtcMillis(aOut);
  const b1 = stayDateToUtcMillis(bIn);
  const b2 = stayDateToUtcMillis(bOut);
  if (![a1, a2, b1, b2].every(Number.isFinite)) return false;
  // A zero-or-negative-length stay occupies nothing and can clash with
  // nothing; validateStayDates is what rejects it as a booking.
  if (a2 <= a1 || b2 <= b1) return false;
  return a1 < b2 && b1 < a2;
}

/** The property's current business date, via the shared reset-time helper. */
export function propertyToday(getBusinessDate, settings = {}, now = new Date()) {
  const resetTime = String(settings.nightAuditTime || settings.dailyOrderResetTime || "04:00");
  const timezone = String(settings.timezone || settings.timeZone || "Asia/Kolkata");
  return getBusinessDate(resetTime, timezone, now);
}

/* ---------------------------------------------------------
   ROOM STATUS

   The lifecycle a physical room moves through, independent of who
   is booked into it. Occupancy is a reservation fact; cleanliness
   and serviceability are room facts. Conflating the two is how a
   room gets sold while it is still dirty.
--------------------------------------------------------- */

export const ROOM_STATUS = {
  AVAILABLE: "AVAILABLE",
  RESERVED: "RESERVED",
  OCCUPIED: "OCCUPIED",
  DIRTY: "DIRTY",
  CLEANING: "CLEANING",
  INSPECTED: "INSPECTED",
  OUT_OF_ORDER: "OUT_OF_ORDER",
  OUT_OF_SERVICE: "OUT_OF_SERVICE",
  BLOCKED: "BLOCKED"
};

export const ROOM_STATUSES = Object.values(ROOM_STATUS);

/**
 * Statuses a room can NEVER be sold in, whatever the calendar says.
 *
 * Business rules 7 and 8: only sellable rooms count toward availability, and
 * an out-of-order room must not accept a new booking. DIRTY is deliberately
 * NOT here — a room dirty today is perfectly sellable for next week, and
 * blocking it would cost the hotel real revenue. Same-day sale of a dirty
 * room is stopped by the housekeeping workflow at check-in, not by pretending
 * the room does not exist.
 */
export const UNSELLABLE_ROOM_STATUSES = [
  ROOM_STATUS.OUT_OF_ORDER,
  ROOM_STATUS.OUT_OF_SERVICE,
  ROOM_STATUS.BLOCKED
];

export function normalizeRoomStatus(value) {
  const status = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return ROOM_STATUSES.includes(status) ? status : ROOM_STATUS.AVAILABLE;
}

/**
 * Is this room part of sellable inventory at all?
 * An inactive room is excluded too — that is what "Active/Inactive" is for,
 * and it must not silently inflate occupancy denominators.
 */
export function isSellableRoom(room = {}) {
  if (room.active === false) return false;
  return !UNSELLABLE_ROOM_STATUSES.includes(normalizeRoomStatus(room.status));
}

// Who may drive each transition. Business rules 5 and 6: housekeeping takes a
// room from DIRTY to clean, and only a supervisor may declare it INSPECTED.
// Letting the same person do both removes the only check on the process.
const ROOM_TRANSITIONS = {
  AVAILABLE: { RESERVED: ["system", "reception"], OCCUPIED: ["reception"], DIRTY: ["housekeeping", "reception"], BLOCKED: ["reception", "manager"], OUT_OF_ORDER: ["maintenance", "manager"], OUT_OF_SERVICE: ["maintenance", "manager"] },
  RESERVED: { AVAILABLE: ["system", "reception"], OCCUPIED: ["reception"], BLOCKED: ["manager"], OUT_OF_ORDER: ["maintenance", "manager"], OUT_OF_SERVICE: ["maintenance", "manager"] },
  OCCUPIED: { DIRTY: ["system", "reception"], OUT_OF_ORDER: ["maintenance", "manager"] },
  DIRTY: { CLEANING: ["housekeeping"], OUT_OF_ORDER: ["maintenance", "manager"], OUT_OF_SERVICE: ["maintenance", "manager"], BLOCKED: ["manager"] },
  CLEANING: { INSPECTED: ["supervisor", "manager"], AVAILABLE: ["supervisor", "manager"], DIRTY: ["housekeeping", "supervisor"], OUT_OF_ORDER: ["maintenance", "manager"] },
  INSPECTED: { AVAILABLE: ["supervisor", "manager", "reception", "system"], DIRTY: ["housekeeping", "supervisor"], OCCUPIED: ["reception"], OUT_OF_ORDER: ["maintenance", "manager"] },
  OUT_OF_ORDER: { AVAILABLE: ["maintenance", "manager"], DIRTY: ["maintenance", "manager"], OUT_OF_SERVICE: ["maintenance", "manager"] },
  OUT_OF_SERVICE: { AVAILABLE: ["manager"], DIRTY: ["manager"], OUT_OF_ORDER: ["maintenance", "manager"] },
  BLOCKED: { AVAILABLE: ["manager", "reception"], DIRTY: ["manager", "housekeeping"], OUT_OF_ORDER: ["maintenance", "manager"] }
};

// One role per hotel job, plus "system" for transitions the software itself
// performs (checkout dirtying a room, a cancellation releasing one).
const ROLE_ALIASES = {
  owner: "manager", admin: "manager", manager: "manager", supervisor: "supervisor",
  receptionist: "reception", reception: "reception", "front desk": "reception", frontdesk: "reception",
  housekeeping: "housekeeping", housekeeper: "housekeeping",
  maintenance: "maintenance", engineer: "maintenance",
  system: "system"
};

export function normalizeHotelRole(value) {
  return ROLE_ALIASES[String(value || "").trim().toLowerCase()] || "";
}

/**
 * May this actor move the room from one status to another?
 * Returns { allowed, reason } — the reason is shown to the person, so it
 * says what to do, not merely that they cannot.
 */
export function canChangeRoomStatus(fromStatus, toStatus, role) {
  const from = normalizeRoomStatus(fromStatus);
  const to = normalizeRoomStatus(toStatus);
  if (from === to) return { allowed: true, reason: "" };
  const actor = normalizeHotelRole(role);
  // An owner or manager is not exempt from the machine itself: the machine
  // encodes what is physically coherent, not merely who is senior.
  const allowedRoles = ROOM_TRANSITIONS[from]?.[to];
  if (!allowedRoles) return { allowed: false, reason: `A room cannot go from ${from} to ${to}.` };
  if (actor === "manager" || allowedRoles.includes(actor)) return { allowed: true, reason: "" };
  return { allowed: false, reason: `${to === ROOM_STATUS.INSPECTED ? "Only a supervisor" : `Only ${allowedRoles.join(" or ")}`} can mark a room ${to}.` };
}

/* ---------------------------------------------------------
   RESERVATION STATUS
--------------------------------------------------------- */

export const RESERVATION_STATUS = {
  CONFIRMED: "CONFIRMED",
  TENTATIVE: "TENTATIVE",
  PENDING: "PENDING",
  CHECKED_IN: "CHECKED_IN",
  CHECKED_OUT: "CHECKED_OUT",
  CANCELLED: "CANCELLED",
  NO_SHOW: "NO_SHOW"
};

export const RESERVATION_STATUSES = Object.values(RESERVATION_STATUS);

/**
 * Statuses that hold a room against the calendar.
 *
 * Business rules 9 and 10: a cancellation releases inventory, and so does a
 * no-show. Both are absent here, which is the whole mechanism — nothing else
 * needs to "free" the room, because availability is recomputed from
 * reservations every time rather than cached in a field that can drift.
 *
 * TENTATIVE holds the room on purpose: an unconfirmed enquiry that does not
 * block is not a hold at all, and overselling it is worse than losing it.
 * CHECKED_OUT does not hold — the stay is over.
 */
export const BLOCKING_RESERVATION_STATUSES = [
  RESERVATION_STATUS.CONFIRMED,
  RESERVATION_STATUS.TENTATIVE,
  RESERVATION_STATUS.PENDING,
  RESERVATION_STATUS.CHECKED_IN
];

export function normalizeReservationStatus(value) {
  const status = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return RESERVATION_STATUSES.includes(status) ? status : RESERVATION_STATUS.PENDING;
}

export function reservationHoldsRoom(reservation = {}) {
  return BLOCKING_RESERVATION_STATUSES.includes(normalizeReservationStatus(reservation.status));
}

/* ---------------------------------------------------------
   AVAILABILITY

   Always computed from reservation records. Never from a flag on
   the room, which is the single most common way a PMS oversells:
   a status field drifts, and nobody notices until two guests are
   standing at the desk holding the same room number.
--------------------------------------------------------- */

/**
 * Reservations that block this room over [checkIn, checkOut).
 * `ignoreReservationId` lets an EDIT of an existing booking not conflict
 * with itself — without it, changing a date on a booking is impossible.
 */
export function conflictingReservations(reservations = [], { roomId, checkIn, checkOut, ignoreReservationId = "" } = {}) {
  if (!roomId) return [];
  return reservations.filter(reservation => {
    if (!reservation) return false;
    if (ignoreReservationId && String(reservation.id) === String(ignoreReservationId)) return false;
    if (String(reservation.roomId || "") !== String(roomId)) return false;
    if (!reservationHoldsRoom(reservation)) return false;
    return staysOverlap(checkIn, checkOut, reservation.checkIn, reservation.checkOut);
  });
}

/** Business rules 1 and 2, in one call. */
export function isRoomAvailable(room, reservations, { checkIn, checkOut, ignoreReservationId = "" } = {}) {
  if (!isSellableRoom(room)) return false;
  if (nightsBetween(checkIn, checkOut) <= 0) return false;
  return conflictingReservations(reservations, {
    roomId: room.id, checkIn, checkOut, ignoreReservationId
  }).length === 0;
}

/** Every sellable, unbooked room for a date range. */
export function availableRooms(rooms = [], reservations = [], range = {}) {
  return rooms.filter(room => isRoomAvailable(room, reservations, range));
}

/**
 * Why a room cannot take this booking, in words a receptionist can act on.
 * Returns { ok, reason, conflicts }.
 */
export function validateRoomAssignment(room, reservations, { checkIn, checkOut, ignoreReservationId = "" } = {}) {
  const dates = validateStayDates(checkIn, checkOut);
  if (!dates.ok) return { ok: false, reason: dates.reason, conflicts: [] };
  if (!room) return { ok: false, reason: "Select a room.", conflicts: [] };
  if (room.active === false) return { ok: false, reason: "This room is inactive and cannot be sold.", conflicts: [] };
  const status = normalizeRoomStatus(room.status);
  if (UNSELLABLE_ROOM_STATUSES.includes(status)) {
    return { ok: false, reason: `Room ${room.roomNumber || room.id} is ${status.replace(/_/g, " ").toLowerCase()} and cannot be booked.`, conflicts: [] };
  }
  const conflicts = conflictingReservations(reservations, { roomId: room.id, checkIn, checkOut, ignoreReservationId });
  if (conflicts.length) {
    const clash = conflicts[0];
    return {
      ok: false,
      conflicts,
      reason: `Room ${room.roomNumber || room.id} is already held by booking ${clash.bookingId || clash.id} from ${clash.checkIn} to ${clash.checkOut}.`
    };
  }
  return { ok: true, reason: "", conflicts: [] };
}

export function validateStayDates(checkIn, checkOut) {
  const from = asStayDate(checkIn);
  const to = asStayDate(checkOut);
  if (!from) return { ok: false, reason: "Enter a valid check-in date." };
  if (!to) return { ok: false, reason: "Enter a valid check-out date." };
  const nights = nightsBetween(from, to);
  if (nights === 0) return { ok: false, reason: "Check-out must be at least one night after check-in." };
  if (nights < 0) return { ok: false, reason: "Check-out cannot be before check-in." };
  return { ok: true, reason: "", nights };
}

/* ---------------------------------------------------------
   RATE RESOLUTION

   A hotel stacks rate rules — season over weekend over standard,
   with a corporate contract cutting across all of them. The rule
   that wins must be predictable and explainable, because the
   guest is standing at the desk asking why.
--------------------------------------------------------- */

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function dayKeyOf(stayDate) {
  const millis = stayDateToUtcMillis(stayDate);
  return Number.isFinite(millis) ? DAY_KEYS[new Date(millis).getUTCDay()] : "";
}

function ratePlanApplies(plan = {}, { stayDate, roomTypeId, source = "", corporateId = "" }) {
  if (plan.active === false) return false;
  if (plan.roomTypeId && String(plan.roomTypeId) !== String(roomTypeId)) return false;
  if (plan.corporateId && String(plan.corporateId) !== String(corporateId)) return false;
  if (plan.source && String(plan.source).toLowerCase() !== String(source).toLowerCase()) return false;
  const from = asStayDate(plan.validFrom);
  const to = asStayDate(plan.validTo);
  if (from && stayDate < from) return false;
  if (to && stayDate > to) return false;
  if (Array.isArray(plan.days) && plan.days.length) {
    if (!plan.days.map(day => String(day).toLowerCase().slice(0, 3)).includes(dayKeyOf(stayDate))) return false;
  }
  return true;
}

/**
 * The nightly rate for one date, and WHICH rule produced it.
 *
 * Highest `priority` wins; ties break on the narrower rule (one with an end
 * date beats an open-ended one), then on the later start date. The winning
 * plan is returned alongside the amount so the desk can say "festival rate,
 * 25 Oct to 5 Nov" instead of an unexplained number.
 */
export function resolveNightlyRate(ratePlans = [], context = {}) {
  const { stayDate, roomType = {}, baseRate } = context;
  const date = asStayDate(stayDate);
  const fallback = Number(baseRate ?? roomType.baseRate ?? 0) || 0;
  if (!date) return { amount: fallback, plan: null, source: "base" };

  const candidates = ratePlans
    .filter(plan => ratePlanApplies(plan, { ...context, stayDate: date, roomTypeId: context.roomTypeId ?? roomType.id }))
    .sort((a, b) => {
      const byPriority = Number(b.priority || 0) - Number(a.priority || 0);
      if (byPriority) return byPriority;
      const aBounded = asStayDate(a.validTo) ? 1 : 0;
      const bBounded = asStayDate(b.validTo) ? 1 : 0;
      if (aBounded !== bBounded) return bBounded - aBounded;
      return String(asStayDate(b.validFrom) || "").localeCompare(String(asStayDate(a.validFrom) || ""));
    });

  const winner = candidates[0];
  if (!winner) return { amount: fallback, plan: null, source: "base" };
  const amount = Number(winner.amount ?? winner.rate ?? fallback) || 0;
  return { amount, plan: winner, source: "plan" };
}

/** Per-night rates for a whole stay, so a quote can be itemised. */
export function quoteStay(ratePlans = [], context = {}) {
  const { checkIn, checkOut } = context;
  const nights = nightsOf(checkIn, checkOut).map(stayDate => {
    const resolved = resolveNightlyRate(ratePlans, { ...context, stayDate });
    return { stayDate, amount: round2(resolved.amount), planId: resolved.plan?.id || "", planName: resolved.plan?.name || "" };
  });
  const extras = extraOccupancyCharge(context);
  return {
    nights,
    nightCount: nights.length,
    roomTotal: round2(nights.reduce((sum, night) => sum + night.amount, 0)),
    extraTotal: round2(extras * nights.length),
    total: round2(nights.reduce((sum, night) => sum + night.amount, 0) + extras * nights.length)
  };
}

/** Per-night charge for guests beyond the room type's included occupancy. */
export function extraOccupancyCharge({ roomType = {}, adults = 0, children = 0 } = {}) {
  const includedAdults = Number(roomType.includedAdults ?? roomType.maxAdults ?? 2) || 0;
  const includedChildren = Number(roomType.includedChildren ?? 0) || 0;
  const extraAdults = Math.max(0, Number(adults || 0) - includedAdults);
  const extraChildren = Math.max(0, Number(children || 0) - includedChildren);
  return round2(extraAdults * (Number(roomType.extraAdultRate || 0) || 0)
    + extraChildren * (Number(roomType.extraChildRate || 0) || 0));
}

/**
 * Rate rules that overlap for the same room type at the same priority.
 * Section 13 asks for overlaps to be prevented or clearly shown; silently
 * picking one of two equal rules is how a hotel charges two guests
 * differently for the same night and cannot explain why.
 */
export function overlappingRatePlans(ratePlans = []) {
  const clashes = [];
  const plans = ratePlans.filter(plan => plan && plan.active !== false);
  for (let i = 0; i < plans.length; i += 1) {
    for (let j = i + 1; j < plans.length; j += 1) {
      const a = plans[i];
      const b = plans[j];
      if (Number(a.priority || 0) !== Number(b.priority || 0)) continue;
      if (String(a.roomTypeId || "") !== String(b.roomTypeId || "")) continue;
      if (String(a.corporateId || "") !== String(b.corporateId || "")) continue;
      const aFrom = asStayDate(a.validFrom) || "0000-01-01";
      const aTo = asStayDate(a.validTo) || "9999-12-31";
      const bFrom = asStayDate(b.validFrom) || "0000-01-01";
      const bTo = asStayDate(b.validTo) || "9999-12-31";
      // Rate windows are INCLUSIVE of their end date, unlike a stay.
      if (aFrom <= bTo && bFrom <= aTo) clashes.push([a, b]);
    }
  }
  return clashes;
}

/* ---------------------------------------------------------
   GUEST FOLIO

   One account per stay. Room nights, restaurant, room service,
   laundry and every other outlet post here, and checkout is the
   act of settling it.
--------------------------------------------------------- */

export const FOLIO_CHARGE_KINDS = [
  "room", "food", "beverage", "room_service", "laundry", "minibar",
  "extra_bed", "transport", "spa", "event", "service", "tax", "other"
];

export function round2(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  // Scaling before rounding avoids the classic 1.005 -> 1.00 float result.
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

/** Line total for one folio charge, tax computed on the discounted amount. */
export function chargeAmounts(charge = {}) {
  const quantity = Number(charge.quantity ?? 1) || 0;
  const rate = Number(charge.rate ?? charge.amount ?? 0) || 0;
  const gross = round2(quantity * rate);
  const discount = Math.min(round2(Number(charge.discount || 0)), gross);
  const net = round2(gross - discount);
  const taxPercent = Number(charge.taxPercent || 0) || 0;
  // Tax-inclusive pricing means the net already contains the tax, so it is
  // extracted rather than added — charging on top would bill the guest twice.
  const tax = charge.taxInclusive
    ? round2(net - net / (1 + taxPercent / 100))
    : round2(net * taxPercent / 100);
  const total = charge.taxInclusive ? net : round2(net + tax);
  return { gross, discount, net, tax, total };
}

/**
 * Payments that actually count.
 *
 * Business rule 12: a failed payment is never recorded as successful. Only an
 * explicit success counts — an unknown or missing status is NOT treated as
 * paid, because the safe default when a gateway's answer is unclear is that
 * the money did not arrive.
 */
const SETTLED_PAYMENT_STATUSES = ["success", "successful", "captured", "paid", "completed", "settled"];

export function isSettledPayment(payment = {}) {
  const status = String(payment.status || "").trim().toLowerCase();
  return SETTLED_PAYMENT_STATUSES.includes(status);
}

export function isRefund(payment = {}) {
  return String(payment.kind || payment.type || "").trim().toLowerCase() === "refund"
    || Number(payment.amount || 0) < 0;
}

/**
 * The folio, totalled.
 *
 * Refunds are tracked separately (business rule 13) rather than netted into
 * payments, because "collected 5000, refunded 1000" and "collected 4000" are
 * different facts to an auditor even though the balance matches.
 */
export function folioTotals(charges = [], payments = []) {
  const lines = charges.map(charge => ({ ...charge, ...chargeAmounts(charge) }));
  const byKind = {};
  lines.forEach(line => {
    const kind = FOLIO_CHARGE_KINDS.includes(String(line.kind)) ? String(line.kind) : "other";
    byKind[kind] = round2((byKind[kind] || 0) + line.total);
  });

  const settled = payments.filter(isSettledPayment);
  const paid = round2(settled.filter(payment => !isRefund(payment))
    .reduce((sum, payment) => sum + Math.abs(Number(payment.amount || 0)), 0));
  const refunded = round2(settled.filter(isRefund)
    .reduce((sum, payment) => sum + Math.abs(Number(payment.amount || 0)), 0));

  const gross = round2(lines.reduce((sum, line) => sum + line.gross, 0));
  const discount = round2(lines.reduce((sum, line) => sum + line.discount, 0));
  const tax = round2(lines.reduce((sum, line) => sum + line.tax, 0));
  const total = round2(lines.reduce((sum, line) => sum + line.total, 0));
  const netPaid = round2(paid - refunded);

  return {
    lines, byKind, gross, discount, tax, total,
    paid, refunded, netPaid,
    balance: round2(total - netPaid),
    settledCount: settled.length,
    rejectedCount: payments.length - settled.length
  };
}

/**
 * Business rule 3: checkout cannot happen without the folio being handled.
 * An unsettled balance is not automatically fatal — a corporate guest leaves
 * on credit every day — but it must be a deliberate, authorised act rather
 * than something that slips through because a button was clicked.
 */
export function canCheckOut(folio, { allowCredit = false, role = "" } = {}) {
  const totals = folio && folio.balance !== undefined ? folio : folioTotals(folio?.charges, folio?.payments);
  if (totals.balance <= 0) return { ok: true, reason: "", balance: totals.balance };
  if (!allowCredit) {
    return { ok: false, balance: totals.balance, reason: `Outstanding balance of ${totals.balance}. Settle the folio or authorise credit before checkout.` };
  }
  const actor = normalizeHotelRole(role);
  if (!["manager", "reception"].includes(actor)) {
    return { ok: false, balance: totals.balance, reason: "Only a manager or the front desk can check a guest out with a balance outstanding." };
  }
  return { ok: true, reason: "", balance: totals.balance, onCredit: true };
}

/* ---------------------------------------------------------
   KPIs

   Computed from room nights, never from a running total that can
   drift. Every denominator here is SELLABLE room nights: counting
   an out-of-order room in the denominator understates occupancy
   and makes the hotel look worse than it is, while leaving it out
   of both sides tells the truth about what could be sold.
--------------------------------------------------------- */

/** Sellable room nights available across a date range. */
export function sellableRoomNights(rooms = [], checkIn, checkOut) {
  const nights = nightsBetween(checkIn, checkOut);
  if (nights <= 0) return 0;
  return rooms.filter(isSellableRoom).length * nights;
}

/**
 * Room nights actually sold in a range, and the revenue they earned.
 * A stay is counted only for the nights inside the window, so a booking that
 * straddles month end contributes to both months correctly.
 */
export function soldRoomNights(reservations = [], checkIn, checkOut) {
  const windowNights = new Set(nightsOf(checkIn, checkOut));
  let roomNights = 0;
  let revenue = 0;
  let stays = 0;
  let stayNights = 0;

  reservations.forEach(reservation => {
    const status = normalizeReservationStatus(reservation.status);
    // Revenue-earning stays only. A cancellation or no-show may carry a fee,
    // but that fee is not room revenue and must not move ADR.
    if (![RESERVATION_STATUS.CHECKED_IN, RESERVATION_STATUS.CHECKED_OUT, RESERVATION_STATUS.CONFIRMED].includes(status)) return;
    const allNights = nightsOf(reservation.checkIn, reservation.checkOut);
    if (!allNights.length) return;
    stays += 1;
    stayNights += allNights.length;
    const inWindow = allNights.filter(night => windowNights.has(night));
    if (!inWindow.length) return;
    roomNights += inWindow.length;
    const nightly = Array.isArray(reservation.nightlyRates) && reservation.nightlyRates.length
      ? reservation.nightlyRates
      : null;
    if (nightly) {
      revenue += inWindow.reduce((sum, night) => {
        const row = nightly.find(entry => entry.stayDate === night);
        return sum + (row ? Number(row.amount || 0) : 0);
      }, 0);
    } else {
      // No per-night breakdown: spread the room total evenly. Stated plainly
      // because an even spread is an assumption, not a measurement.
      const perNight = Number(reservation.roomTotal || 0) / allNights.length;
      revenue += perNight * inWindow.length;
    }
  });

  return { roomNights, revenue: round2(revenue), stays, stayNights };
}

/**
 * The four numbers every hotel owner asks for.
 *
 * RevPAR is revenue over AVAILABLE room nights, computed directly and NOT as
 * ADR x occupancy. The two are algebraically the same but numerically are
 * not: ADR and occupancy are each rounded for display, and multiplying two
 * rounded figures compounds their error. On a 9-room, 2-night sample the
 * derived value comes out 10 paise above the true one, and a month of that
 * is a RevPAR an owner cannot reconcile against the revenue report.
 *
 * All three share one pair of denominators by construction, which is what
 * makes them reconcilable at all. A PMS that counts occupancy over every room
 * and ADR over sellable ones produces a RevPAR matching neither, and nobody
 * can tell which of the three is the wrong one.
 */
export function hotelKpis(rooms = [], reservations = [], checkIn, checkOut) {
  const available = sellableRoomNights(rooms, checkIn, checkOut);
  const sold = soldRoomNights(reservations, checkIn, checkOut);
  return {
    availableRoomNights: available,
    soldRoomNights: sold.roomNights,
    roomRevenue: sold.revenue,
    occupancy: available ? round2(sold.roomNights / available * 100) : 0,
    adr: sold.roomNights ? round2(sold.revenue / sold.roomNights) : 0,
    revpar: available ? round2(sold.revenue / available) : 0,
    averageLengthOfStay: sold.stays ? round2(sold.stayNights / sold.stays) : 0,
    stays: sold.stays
  };
}

/** Today's front-desk counters, from records rather than cached flags. */
export function frontDeskSnapshot(rooms = [], reservations = [], businessDate) {
  const today = asStayDate(businessDate);
  const counts = ROOM_STATUSES.reduce((all, status) => ({ ...all, [status]: 0 }), {});
  rooms.forEach(room => { counts[normalizeRoomStatus(room.status)] += 1; });

  const byStatus = status => reservations.filter(r => normalizeReservationStatus(r.status) === status);
  return {
    totalRooms: rooms.length,
    sellableRooms: rooms.filter(isSellableRoom).length,
    roomStatusCounts: counts,
    arrivalsToday: reservations.filter(r => asStayDate(r.checkIn) === today && reservationHoldsRoom(r)).length,
    departuresToday: reservations.filter(r => asStayDate(r.checkOut) === today
      && [RESERVATION_STATUS.CHECKED_IN, RESERVATION_STATUS.CHECKED_OUT].includes(normalizeReservationStatus(r.status))).length,
    inHouse: byStatus(RESERVATION_STATUS.CHECKED_IN).length,
    expectedCheckIns: reservations.filter(r => asStayDate(r.checkIn) === today
      && [RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.TENTATIVE, RESERVATION_STATUS.PENDING].includes(normalizeReservationStatus(r.status))).length,
    expectedCheckOuts: reservations.filter(r => asStayDate(r.checkOut) === today
      && normalizeReservationStatus(r.status) === RESERVATION_STATUS.CHECKED_IN).length,
    cancelledToday: reservations.filter(r => normalizeReservationStatus(r.status) === RESERVATION_STATUS.CANCELLED
      && asStayDate(r.cancelledOn) === today).length,
    noShows: byStatus(RESERVATION_STATUS.NO_SHOW).length
  };
}

/* ---------------------------------------------------------
   BOOKING SOURCES
--------------------------------------------------------- */

export const BOOKING_SOURCES = [
  { id: "walk_in", label: "Walk-in", ota: false },
  { id: "direct", label: "Direct Website", ota: false },
  { id: "phone", label: "Phone", ota: false },
  { id: "whatsapp", label: "WhatsApp", ota: false },
  { id: "google", label: "Google", ota: false },
  { id: "makemytrip", label: "MakeMyTrip", ota: true },
  { id: "goibibo", label: "Goibibo", ota: true },
  { id: "booking_com", label: "Booking.com", ota: true },
  { id: "agoda", label: "Agoda", ota: true },
  { id: "expedia", label: "Expedia", ota: true },
  { id: "airbnb", label: "Airbnb", ota: true },
  { id: "travel_agent", label: "Travel Agent", ota: false },
  { id: "corporate", label: "Corporate", ota: false },
  { id: "other", label: "Other", ota: false }
];

const SOURCE_ALIASES = new Map(BOOKING_SOURCES.flatMap(source => [
  [source.id, source.id],
  [source.label.toLowerCase(), source.id],
  [source.label.toLowerCase().replace(/[^a-z]/g, ""), source.id]
]));

export function normalizeBookingSource(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "walk_in";
  return SOURCE_ALIASES.get(raw) || SOURCE_ALIASES.get(raw.replace(/[^a-z]/g, "")) || "other";
}

export function isOtaSource(value) {
  const id = normalizeBookingSource(value);
  return BOOKING_SOURCES.find(source => source.id === id)?.ota === true;
}
