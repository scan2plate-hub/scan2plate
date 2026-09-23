/* =========================================================
   PROPERTY SETUP — ROOMS, ROOM TYPES AND TARIFFS

   Until this existed a hotel could not create a room, which made
   every other screen a demonstration. This is what turns an empty
   property into one that can take a booking.

   THREE THINGS IT REFUSES TO DO.

   Rule 18 — deleting a room must preserve historical reservations.
   So a room is never deleted. It is deactivated: it leaves
   sellable inventory immediately, and every stay, folio and
   invoice that names it still resolves. A hard delete would leave
   last year's invoices pointing at nothing, and a hotel's books
   are not ours to break for the sake of a tidy list.

   Room numbers are unique within a property. Two rooms called 101
   makes "which 101 is the guest in?" unanswerable at the desk, and
   silently corrupts the night-lock ids that prevent double
   booking.

   Section 51 — limits come from the plan, centrally. maxRooms is
   checked through plan-limits.js, which already fails open for a
   business with no plan. A billing lookup must never stop a hotel
   adding a room mid-shift; it exists to stop an owner quietly
   exceeding what they bought.

   Bulk creation is the normal case. A hotel with 40 rooms adds 40
   rooms, not one. Each is keyed deterministically from its number,
   so a retry after a dropped connection creates the ones that are
   missing and leaves the rest alone.
========================================================= */
import {
  ROOM_STATUS, normalizeRoomStatus, isSellableRoom, round2, asStayDate,
  overlappingRatePlans, dayKeyOf
} from "./hotel-core.js?v=s2p-20260922d";

export const ROOMS = "hotel_rooms";
export const ROOM_TYPES = "hotel_room_types";
export const RATE_PLANS = "hotel_rate_plans";
export const AUDIT_LOGS = "hotelAuditLogs";

/* ---------------------------------------------------------
   ROOM TYPES
--------------------------------------------------------- */

/** The starting set section 5 names. A property may add its own. */
export const STARTER_ROOM_TYPES = [
  { id: "single", name: "Single", maxAdults: 1, maxChildren: 1, bedType: "single", beds: 1 },
  { id: "double", name: "Double", maxAdults: 2, maxChildren: 1, bedType: "double", beds: 1 },
  { id: "twin", name: "Twin", maxAdults: 2, maxChildren: 1, bedType: "twin", beds: 2 },
  { id: "deluxe", name: "Deluxe", maxAdults: 2, maxChildren: 2, bedType: "queen", beds: 1 },
  { id: "super_deluxe", name: "Super Deluxe", maxAdults: 3, maxChildren: 2, bedType: "king", beds: 1 },
  { id: "suite", name: "Suite", maxAdults: 4, maxChildren: 2, bedType: "king", beds: 2 },
  { id: "family", name: "Family Room", maxAdults: 4, maxChildren: 3, bedType: "mixed", beds: 3 },
  { id: "dormitory", name: "Dormitory", maxAdults: 8, maxChildren: 0, bedType: "bunk", beds: 8 }
];

export const AMENITIES = [
  "ac", "tv", "wifi", "geyser", "minibar", "safe", "balcony", "sea_view",
  "kettle", "desk", "wheelchair_access", "bathtub", "room_service"
];

export function normalizeRoomType(input = {}) {
  const maxAdults = Math.max(1, Math.trunc(Number(input.maxAdults ?? 2)) || 2);
  return {
    name: String(input.name || "").trim(),
    bedType: String(input.bedType || "").trim(),
    beds: Math.max(1, Math.trunc(Number(input.beds ?? 1)) || 1),
    maxAdults,
    maxChildren: Math.max(0, Math.trunc(Number(input.maxChildren ?? 0)) || 0),
    // What the base rate covers. Anyone beyond this pays the extra-person
    // rate; defaulting it to maxAdults means a room quoted for two does not
    // secretly charge extra for the second guest.
    includedAdults: Math.max(1, Math.trunc(Number(input.includedAdults ?? maxAdults)) || maxAdults),
    includedChildren: Math.max(0, Math.trunc(Number(input.includedChildren ?? 0)) || 0),
    baseRate: round2(input.baseRate),
    extraAdultRate: round2(input.extraAdultRate),
    extraChildRate: round2(input.extraChildRate),
    amenities: Array.isArray(input.amenities) ? input.amenities.filter(item => AMENITIES.includes(item)) : [],
    description: String(input.description || "").trim(),
    images: Array.isArray(input.images) ? input.images.filter(Boolean).map(String) : [],
    active: input.active !== false
  };
}

export function validateRoomType(input = {}) {
  const type = normalizeRoomType(input);
  if (!type.name) return { ok: false, reason: "Give this room type a name." };
  if (!(type.baseRate > 0)) return { ok: false, reason: "Enter a base rate. A room type with no price cannot be sold." };
  if (type.includedAdults > type.maxAdults) {
    return { ok: false, reason: "The rate cannot include more adults than the room holds." };
  }
  return { ok: true, reason: "", type };
}

/* ---------------------------------------------------------
   ROOMS
--------------------------------------------------------- */

export function normalizeRoom(input = {}) {
  return {
    roomNumber: String(input.roomNumber ?? "").trim(),
    name: String(input.name || "").trim(),
    floor: String(input.floor ?? "").trim(),
    building: String(input.building || "").trim(),
    roomTypeId: String(input.roomTypeId || "").trim(),
    // A per-room override. Empty means "use the room type's rate", which is
    // the normal case; a corner suite that costs more is the exception.
    baseRate: input.baseRate === "" || input.baseRate == null ? null : round2(input.baseRate),
    amenities: Array.isArray(input.amenities) ? input.amenities.filter(item => AMENITIES.includes(item)) : [],
    description: String(input.description || "").trim(),
    images: Array.isArray(input.images) ? input.images.filter(Boolean).map(String) : [],
    status: normalizeRoomStatus(input.status || ROOM_STATUS.AVAILABLE),
    active: input.active !== false
  };
}

/**
 * A room id derived from its number.
 *
 * Deterministic so bulk creation is idempotent, and constrained so it can
 * never contain the separator the night-lock keys use — a room id holding
 * "__" would let one room forge another's lock. hotel-inventory.js refuses
 * such an id; this makes sure one is never created.
 */
export function roomIdFor(roomNumber) {
  const cleaned = String(roomNumber ?? "").trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned ? `R${cleaned}` : "";
}

export function validateRoom(input = {}, { existingRooms = [], editingId = "" } = {}) {
  const room = normalizeRoom(input);
  if (!room.roomNumber) return { ok: false, reason: "Enter a room number." };
  const id = roomIdFor(room.roomNumber);
  if (!id) return { ok: false, reason: "That room number cannot be used. Use letters, numbers and hyphens." };
  if (!room.roomTypeId) return { ok: false, reason: "Choose a room type." };

  const clash = existingRooms.find(other =>
    String(other.id) !== String(editingId)
    && String(other.roomNumber || "").trim().toLowerCase() === room.roomNumber.toLowerCase());
  if (clash) {
    return { ok: false, reason: `Room ${room.roomNumber} already exists. Two rooms with one number cannot be told apart at the desk.` };
  }
  return { ok: true, reason: "", room, id };
}

/**
 * Expand a range into room numbers: 101–110, optionally per floor.
 *
 * Front desks describe their property as "rooms 101 to 110 on the first
 * floor, 201 to 210 on the second". Making them type forty numbers is how a
 * setup screen gets abandoned half-finished.
 */
export function expandRoomNumbers({ from, to, prefix = "", floor = "" } = {}) {
  const start = Math.trunc(Number(from));
  const end = Math.trunc(Number(to));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  if (end < start) return [];
  // A cap, because "1 to 100000" is a typo, not a hotel.
  if (end - start >= 500) return [];
  const width = String(from).trim().startsWith("0") ? String(from).trim().length : 0;
  return Array.from({ length: end - start + 1 }, (unused, index) => {
    const number = start + index;
    const text = width ? String(number).padStart(width, "0") : String(number);
    return { roomNumber: `${prefix}${text}`, floor: String(floor ?? "") };
  });
}

/** Which of a planned batch already exist, so a retry adds only the rest. */
export function splitExistingRooms(planned = [], existingRooms = []) {
  const taken = new Set(existingRooms.map(room => String(room.roomNumber || "").trim().toLowerCase()));
  const create = [];
  const skip = [];
  planned.forEach(entry => {
    const key = String(entry.roomNumber || "").trim().toLowerCase();
    if (!key || taken.has(key)) skip.push(entry);
    else { taken.add(key); create.push(entry); }
  });
  return { create, skip };
}

/* ---------------------------------------------------------
   RATE PLANS
--------------------------------------------------------- */

export const RATE_PLAN_KINDS = [
  { id: "standard", label: "Standard", priority: 0 },
  { id: "weekend", label: "Weekend", priority: 2 },
  { id: "seasonal", label: "Seasonal", priority: 3 },
  { id: "festival", label: "Festival", priority: 5 },
  { id: "corporate", label: "Corporate", priority: 8 },
  { id: "agent", label: "Travel agent", priority: 7 },
  { id: "group", label: "Group", priority: 6 },
  { id: "promotional", label: "Promotional", priority: 4 },
  { id: "long_stay", label: "Long stay", priority: 4 },
  { id: "early_booking", label: "Early booking", priority: 1 },
  { id: "last_minute", label: "Last minute", priority: 1 }
];

/**
 * Default priority for a kind of rate.
 *
 * Section 13 wants a predictable answer when rules stack. A festival beating
 * a season beating a weekend beating standard is the order a hotel already
 * thinks in; a corporate contract sits above all of them because it is a
 * negotiated price, not a public one.
 */
export function defaultPriorityFor(kind) {
  return RATE_PLAN_KINDS.find(entry => entry.id === kind)?.priority ?? 0;
}

export function normalizeRatePlan(input = {}) {
  const kind = RATE_PLAN_KINDS.some(entry => entry.id === input.kind) ? input.kind : "standard";
  return {
    name: String(input.name || "").trim(),
    kind,
    roomTypeId: String(input.roomTypeId || "").trim(),
    corporateId: String(input.corporateId || "").trim(),
    amount: round2(input.amount),
    priority: Number.isFinite(Number(input.priority)) ? Math.trunc(Number(input.priority)) : defaultPriorityFor(kind),
    validFrom: asStayDate(input.validFrom),
    validTo: asStayDate(input.validTo),
    days: Array.isArray(input.days) ? input.days.map(day => String(day).toLowerCase().slice(0, 3)) : [],
    active: input.active !== false
  };
}

export function validateRatePlan(input = {}) {
  const plan = normalizeRatePlan(input);
  if (!plan.name) return { ok: false, reason: "Give this rate a name, so the desk can explain it to a guest." };
  if (!(plan.amount > 0)) return { ok: false, reason: "Enter an amount above zero." };
  if (plan.validFrom && plan.validTo && plan.validTo < plan.validFrom) {
    return { ok: false, reason: "The end date is before the start date." };
  }
  if (input.validFrom && !plan.validFrom) return { ok: false, reason: "Enter a valid start date." };
  if (input.validTo && !plan.validTo) return { ok: false, reason: "Enter a valid end date." };
  return { ok: true, reason: "", plan };
}

/**
 * Warn about rules that will fight each other.
 *
 * Section 13 asks for overlaps to be prevented or clearly shown. Refusing
 * them outright would block legitimate setups, so they are SHOWN: a hotel
 * may genuinely want two equal-priority rules and then decide which to
 * change. Silently picking one is the only unacceptable option, because the
 * desk cannot then explain the price.
 */
export function ratePlanWarnings(plans = []) {
  return overlappingRatePlans(plans).map(([a, b]) => ({
    plans: [a, b],
    message: `"${a.name || a.id}" and "${b.name || b.id}" both apply at priority ${Number(a.priority || 0)} for the same rooms and overlapping dates. Raise one priority so the desk can explain which price wins.`
  }));
}

/** A plain-English description of when a rate applies, for the list. */
export function describeRatePlan(plan = {}) {
  const parts = [];
  if (plan.validFrom || plan.validTo) {
    parts.push(`${plan.validFrom || "any date"} to ${plan.validTo || "open-ended"}`);
  }
  if (Array.isArray(plan.days) && plan.days.length) parts.push(plan.days.join(", "));
  if (plan.corporateId) parts.push(`contract ${plan.corporateId}`);
  return parts.length ? parts.join(" · ") : "always";
}

/* ---------------------------------------------------------
   READINESS  (section 50)
--------------------------------------------------------- */

/**
 * Can this property take a booking yet, and if not, what is missing?
 *
 * The front desk is useless without rooms, and a room with no priced type
 * cannot be quoted. Saying so plainly on arrival beats an empty grid that
 * looks broken.
 */
export function setupReadiness({ rooms = [], roomTypes = [], ratePlans = [] } = {}) {
  const activeTypes = roomTypes.filter(type => type.active !== false);
  const sellable = rooms.filter(isSellableRoom);
  const pricedTypeIds = new Set(activeTypes.filter(type => Number(type.baseRate) > 0).map(type => String(type.id)));
  const roomsWithoutPrice = sellable.filter(room =>
    !(Number(room.baseRate) > 0) && !pricedTypeIds.has(String(room.roomTypeId)));

  const steps = [
    { id: "types", label: "Create at least one room type", done: activeTypes.length > 0 },
    { id: "rates", label: "Give every room type a base rate", done: activeTypes.length > 0 && pricedTypeIds.size === activeTypes.length },
    { id: "rooms", label: "Add your rooms", done: sellable.length > 0 },
    { id: "priced", label: "Every sellable room has a price", done: sellable.length > 0 && roomsWithoutPrice.length === 0 }
  ];
  return {
    steps,
    ready: steps.every(step => step.done),
    roomsWithoutPrice,
    counts: { rooms: rooms.length, sellable: sellable.length, roomTypes: activeTypes.length, ratePlans: ratePlans.length }
  };
}

/* ---------------------------------------------------------
   THE SERVICE
--------------------------------------------------------- */

export function createSetupService({ db, restaurantId, firestore, now = () => new Date() }) {
  const { doc, collection, writeBatch, runTransaction, serverTimestamp } = firestore;

  const roomRef = id => doc(db, "restaurants", restaurantId, ROOMS, String(id));
  const typeRef = id => doc(db, "restaurants", restaurantId, ROOM_TYPES, String(id));
  const planRef = id => doc(db, "restaurants", restaurantId, RATE_PLANS, String(id));
  const auditRef = () => doc(collection(db, AUDIT_LOGS));

  function auditPayload({ action, actor = {}, detail }) {
    return {
      restaurantId, action,
      userId: String(actor.uid || ""), userName: String(actor.name || ""), role: String(actor.role || ""),
      detail, createdAt: serverTimestamp(), at: now().toISOString()
    };
  }

  async function saveRoomType({ typeId, input, actor }) {
    const check = validateRoomType(input);
    if (!check.ok) throw new SetupError("invalid", check.reason);
    const id = String(typeId || input.id || "").trim() || slug(check.type.name);
    if (!id) throw new SetupError("invalid", "That room type name cannot be used.");
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(typeRef(id));
      transaction.set(typeRef(id), {
        restaurantId, ...check.type,
        ...(existing.exists() ? {} : { createdAt: serverTimestamp() }),
        updatedAt: serverTimestamp()
      }, { merge: true });
      transaction.set(auditRef(), auditPayload({
        action: existing.exists() ? "room_type_updated" : "room_type_created",
        actor, detail: { typeId: id, name: check.type.name, baseRate: check.type.baseRate }
      }));
      return { ok: true, typeId: id, created: !existing.exists() };
    });
  }

  /**
   * Create many rooms at once, after checking the plan allows it.
   *
   * `limitCheck` is passed in rather than imported so the caller owns the
   * plan lookup — plan-limits.js caches per page and fails open, and this
   * service must not quietly acquire a second opinion about entitlements.
   */
  async function createRooms({ planned = [], existingRooms = [], defaults = {}, actor, limitCheck = null }) {
    const { create, skip } = splitExistingRooms(planned, existingRooms);
    if (!create.length) {
      return { ok: true, created: 0, skipped: skip.length, reason: "Every room in that range already exists." };
    }
    if (limitCheck && !limitCheck.allowed) throw new SetupError("plan_limit", limitCheck.message);

    const prepared = [];
    for (const entry of create) {
      const check = validateRoom({ ...defaults, ...entry }, { existingRooms: [...existingRooms, ...prepared.map(item => item.room)] });
      if (!check.ok) throw new SetupError("invalid", check.reason);
      prepared.push({ id: check.id, room: { ...check.room, id: check.id } });
    }

    // A batch, not a transaction: these are independent creates with no read
    // to protect, and forty rooms in one transaction would be needless
    // contention on a property that is also taking bookings.
    const batch = writeBatch(db);
    prepared.forEach(({ id, room }) => {
      batch.set(roomRef(id), { restaurantId, ...room, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    });
    batch.set(auditRef(), auditPayload({
      action: "rooms_created", actor,
      detail: { count: prepared.length, from: prepared[0].room.roomNumber, to: prepared[prepared.length - 1].room.roomNumber }
    }));
    await batch.commit();
    return { ok: true, created: prepared.length, skipped: skip.length };
  }

  async function saveRoom({ roomId, input, existingRooms = [], actor }) {
    const check = validateRoom(input, { existingRooms, editingId: roomId });
    if (!check.ok) throw new SetupError("invalid", check.reason);
    const id = String(roomId || check.id);
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(roomRef(id));
      // A room's own status belongs to housekeeping and maintenance. Setup
      // edits its description, not where it is in the cleaning cycle.
      const { status, ...editable } = check.room;
      transaction.set(roomRef(id), {
        restaurantId, ...editable,
        ...(existing.exists() ? {} : { status, createdAt: serverTimestamp() }),
        updatedAt: serverTimestamp()
      }, { merge: true });
      transaction.set(auditRef(), auditPayload({
        action: existing.exists() ? "room_updated" : "room_created",
        actor, detail: { roomId: id, roomNumber: check.room.roomNumber }
      }));
      return { ok: true, roomId: id, created: !existing.exists() };
    });
  }

  /**
   * RULE 18. A room is retired, never deleted.
   *
   * It leaves sellable inventory at once, and every reservation, folio and
   * invoice that names it still resolves. A hard delete would leave last
   * year's invoices pointing at nothing.
   */
  async function retireRoom({ roomId, actor, reason = "", upcomingReservations = [] }) {
    const held = upcomingReservations.filter(reservation => String(reservation.roomId) === String(roomId));
    if (held.length) {
      throw new SetupError("in_use",
        `This room has ${held.length} booking${held.length === 1 ? "" : "s"} still to come. Move or cancel ${held.length === 1 ? "it" : "them"} first.`);
    }
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(roomRef(roomId));
      if (!existing.exists()) return { ok: true, unchanged: true };
      if (existing.data().active === false) return { ok: true, unchanged: true };
      transaction.set(roomRef(roomId), {
        active: false,
        retiredReason: String(reason || ""),
        retiredBy: String(actor?.name || ""),
        retiredAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      }, { merge: true });
      transaction.set(auditRef(), auditPayload({
        action: "room_retired", actor,
        detail: { roomId, roomNumber: existing.data().roomNumber || "", reason: String(reason || "") }
      }));
      return { ok: true, retired: true };
    });
  }

  async function restoreRoom({ roomId, actor }) {
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(roomRef(roomId));
      if (!existing.exists()) throw new SetupError("not_found", "That room no longer exists.");
      transaction.set(roomRef(roomId), { active: true, updatedAt: serverTimestamp() }, { merge: true });
      transaction.set(auditRef(), auditPayload({ action: "room_restored", actor, detail: { roomId } }));
      return { ok: true };
    });
  }

  async function saveRatePlan({ planId, input, actor }) {
    const check = validateRatePlan(input);
    if (!check.ok) throw new SetupError("invalid", check.reason);
    const id = String(planId || "").trim() || `rate_${Date.now().toString(36)}`;
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(planRef(id));
      transaction.set(planRef(id), {
        restaurantId, ...check.plan,
        ...(existing.exists() ? {} : { createdAt: serverTimestamp() }),
        updatedAt: serverTimestamp()
      }, { merge: true });
      transaction.set(auditRef(), auditPayload({
        action: existing.exists() ? "rate_plan_updated" : "rate_plan_created",
        actor, detail: { planId: id, name: check.plan.name, amount: check.plan.amount, priority: check.plan.priority }
      }));
      return { ok: true, planId: id, created: !existing.exists() };
    });
  }

  /** A rate rule IS safely deletable: it prices the future, not the past. */
  async function deleteRatePlan({ planId, actor }) {
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(planRef(planId));
      if (!existing.exists()) return { ok: true, unchanged: true };
      transaction.delete(planRef(planId));
      transaction.set(auditRef(), auditPayload({
        action: "rate_plan_deleted", actor,
        detail: { planId, name: existing.data().name || "", amount: existing.data().amount || 0 }
      }));
      return { ok: true };
    });
  }

  return { saveRoomType, createRooms, saveRoom, retireRoom, restoreRoom, saveRatePlan, deleteRatePlan };
}

function slug(text) {
  return String(text || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

export class SetupError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SetupError";
    this.code = code;
    Object.assign(this, details);
  }
}

export { slug, dayKeyOf };
