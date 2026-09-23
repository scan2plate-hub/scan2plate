/* =========================================================
   GUEST CRM  (sections 9 and 24)

   Who has stayed, what they spent, what they asked for, and how
   to find them again when they call.

   THE PRIVACY SPLIT IS STRUCTURAL, NOT A PERMISSION FLAG.

   A guest's record lives in two collections:

     hotel_guests            — what reception needs to serve
                               someone: name, phone, email,
                               preferences, stay history.
     hotel_guest_documents   — passport and visa numbers, ID
                               scans. OWNER-ONLY in the rules.

   Section 9 says sensitive guest documents must not be exposed to
   unauthorised staff, and Firestore rules are per DOCUMENT. One
   record carrying both could not be half-readable, so no
   arrangement of fields or flags would enforce it. The split IS
   the enforcement: a housekeeper querying hotel_guests gets a
   name and a phone number, and a query for the passport is
   refused by the database, not by the interface.

   SECTION 24, PLAINLY. The foreign-guest fields exist and export.
   Nothing here files anything with any government, and nothing
   claims to. Where a property has a legal obligation, this
   produces the record it needs to meet it; meeting it remains
   theirs. Saying otherwise would be the kind of claim that gets a
   hotel fined for trusting us.

   RULE 17. Deleting a guest must not destroy financial records.
   A guest is archived, never deleted, and every folio and invoice
   already copied their name at the time it was raised — so the
   books survive even the archive.
========================================================= */
import {
  RESERVATION_STATUS, normalizeReservationStatus, asStayDate, nightsOf,
  round2, normalizeHotelRole
} from "./hotel-core.js?v=s2p-20260922d";

export const GUESTS = "hotel_guests";
export const GUEST_DOCUMENTS = "hotel_guest_documents";
export const AUDIT_LOGS = "hotelAuditLogs";

export const ID_TYPES = [
  "aadhaar", "passport", "driving_licence", "voter_id", "pan", "other"
];

/* ---------------------------------------------------------
   NORMALISING
--------------------------------------------------------- */

/**
 * A phone number reduced to what makes two entries the same person.
 *
 * Indian mobiles arrive as 9876543210, +919876543210, 09876543210 and
 * 91 98765 43210, all meaning one guest. Matching on the raw string creates
 * four profiles for one person and loses their history at the moment the
 * desk most wants it.
 */
export function phoneKey(value) {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (!digits) return "";
  // Keep the last ten. Country and trunk prefixes vary by how it was typed;
  // the subscriber number does not.
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function normalizeGuest(input = {}) {
  return {
    name: String(input.name || "").trim(),
    phone: String(input.phone || "").trim(),
    phoneKey: phoneKey(input.phone),
    email: String(input.email || "").trim().toLowerCase(),
    address: String(input.address || "").trim(),
    city: String(input.city || "").trim(),
    state: String(input.state || "").trim(),
    country: String(input.country || "").trim(),
    nationality: String(input.nationality || "").trim(),
    company: String(input.company || "").trim(),
    gstin: String(input.gstin || "").trim().toUpperCase(),
    preferences: String(input.preferences || "").trim(),
    notes: String(input.notes || "").trim(),
    emergencyName: String(input.emergencyName || "").trim(),
    emergencyPhone: String(input.emergencyPhone || "").trim(),
    archived: input.archived === true
  };
}

/**
 * The sensitive half. Stored separately, and deliberately NOT merged back
 * into the guest object anywhere in this module — a helper that returned
 * one combined record would be used by a screen that should not have it.
 */
export function normalizeGuestDocuments(input = {}) {
  return {
    idType: ID_TYPES.includes(input.idType) ? input.idType : "other",
    idNumber: String(input.idNumber || "").trim(),
    idScanUrl: String(input.idScanUrl || "").trim(),
    // Section 24. Captured when a property needs them; never transmitted
    // anywhere by this product.
    passportNumber: String(input.passportNumber || "").trim(),
    passportExpiry: asStayDate(input.passportExpiry),
    visaNumber: String(input.visaNumber || "").trim(),
    visaType: String(input.visaType || "").trim(),
    visaExpiry: asStayDate(input.visaExpiry),
    arrivedFrom: String(input.arrivedFrom || "").trim(),
    arrivalDate: asStayDate(input.arrivalDate),
    departingTo: String(input.departingTo || "").trim(),
    departureDate: asStayDate(input.departureDate)
  };
}

export function validateGuest(input = {}) {
  const guest = normalizeGuest(input);
  if (!guest.name) return { ok: false, reason: "Enter the guest's name." };
  if (!guest.phone && !guest.email) {
    return { ok: false, reason: "Enter a phone number or an email — without one the guest cannot be found again." };
  }
  if (guest.phone && guest.phoneKey.length < 6) {
    return { ok: false, reason: "That phone number looks too short to be reachable." };
  }
  if (guest.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email)) {
    return { ok: false, reason: "That email address does not look right." };
  }
  return { ok: true, reason: "", guest };
}

/**
 * Is a foreign guest's paperwork complete enough for the property's own
 * compliance workflow?
 *
 * Returns what is MISSING, and nothing more. Whether these fields are
 * legally required, and to whom they must be given, depends on the property
 * and its jurisdiction — that is the property's to know. This only reports
 * which of the fields they asked for are still blank.
 */
export function missingForeignGuestFields(documents = {}, { required = ["passportNumber", "visaNumber", "arrivalDate"] } = {}) {
  const normalized = normalizeGuestDocuments(documents);
  return required.filter(field => !String(normalized[field] || "").trim());
}

/* ---------------------------------------------------------
   FINDING A GUEST
--------------------------------------------------------- */

/**
 * Search by anything the desk actually has when the phone rings: a name, a
 * number, an email, a booking reference.
 *
 * Phone matching goes through phoneKey, so a guest who gave +91 last time
 * and ten digits this time is one guest.
 */
export function searchGuests(guests = [], term, { includeArchived = false } = {}) {
  const text = String(term ?? "").trim().toLowerCase();
  const digits = phoneKey(term);
  const pool = guests.filter(guest => includeArchived || !guest.archived);
  if (!text) return pool;
  return pool.filter(guest => {
    if (digits && guest.phoneKey && guest.phoneKey.includes(digits)) return true;
    return [guest.name, guest.email, guest.company, guest.city, guest.id]
      .some(field => String(field || "").toLowerCase().includes(text));
  });
}

/**
 * Guests who look like the same person.
 *
 * Offered at the desk as "is this them?", never merged automatically: two
 * people genuinely do share a phone, and merging two guests' histories is
 * not something that can be undone from a front desk.
 */
export function possibleDuplicates(guests = [], candidate = {}) {
  const key = phoneKey(candidate.phone);
  const email = String(candidate.email || "").trim().toLowerCase();
  const name = String(candidate.name || "").trim().toLowerCase();
  return guests.filter(guest => {
    if (guest.archived) return false;
    if (candidate.id && String(guest.id) === String(candidate.id)) return false;
    if (key && guest.phoneKey === key) return true;
    if (email && String(guest.email || "").toLowerCase() === email) return true;
    // A name alone is not a match — hotels are full of common names — but a
    // name AND a city is worth asking about.
    return Boolean(name) && String(guest.name || "").toLowerCase() === name
      && Boolean(candidate.city) && String(guest.city || "").toLowerCase() === String(candidate.city).toLowerCase();
  });
}

/* ---------------------------------------------------------
   HISTORY
--------------------------------------------------------- */

/**
 * What this guest is worth, from their actual stays.
 *
 * Only stays that happened count toward spend and nights — a cancellation
 * is part of their record but not of their value, and counting it would
 * make a serial canceller look like the property's best customer.
 */
export function guestHistory(guestId, { reservations = [], invoices = [] } = {}) {
  const theirs = reservations.filter(reservation => String(reservation.guestId || "") === String(guestId));
  const completed = theirs.filter(reservation =>
    [RESERVATION_STATUS.CHECKED_OUT, RESERVATION_STATUS.CHECKED_IN]
      .includes(normalizeReservationStatus(reservation.status)));

  const nights = completed.reduce((sum, reservation) =>
    sum + nightsOf(reservation.checkIn, reservation.checkOut).length, 0);

  const theirInvoices = invoices.filter(invoice =>
    completed.some(reservation => String(reservation.id) === String(invoice.reservationId)));
  const spend = round2(theirInvoices.reduce((sum, invoice) => sum + Number(invoice.totals?.total || 0), 0));
  const roomSpend = round2(theirInvoices.reduce((sum, invoice) => sum + Number(invoice.totals?.byKind?.room || 0), 0));

  const dates = completed.map(reservation => asStayDate(reservation.checkIn)).filter(Boolean).sort();
  const cancellations = theirs.filter(reservation =>
    normalizeReservationStatus(reservation.status) === RESERVATION_STATUS.CANCELLED).length;
  const noShows = theirs.filter(reservation =>
    normalizeReservationStatus(reservation.status) === RESERVATION_STATUS.NO_SHOW).length;

  return {
    stays: completed.length,
    nights,
    totalSpend: spend,
    roomSpend,
    otherSpend: round2(spend - roomSpend),
    averageSpendPerStay: completed.length ? round2(spend / completed.length) : 0,
    firstStay: dates[0] || "",
    lastStay: dates[dates.length - 1] || "",
    cancellations,
    noShows,
    roomsUsed: [...new Set(completed.map(reservation => reservation.roomId).filter(Boolean))],
    reservations: [...theirs].sort((a, b) => String(b.checkIn || "").localeCompare(String(a.checkIn || "")))
  };
}

/**
 * A short label for the desk: "4th stay, last here in March".
 * A returning guest being greeted as one is most of what a CRM is for.
 */
export function guestSummaryLine(history = {}) {
  if (!history.stays) return "First stay";
  const ordinal = count => {
    const suffix = ["th", "st", "nd", "rd"][(count % 100 - 20) % 10] || ["th", "st", "nd", "rd"][count % 100] || "th";
    return `${count}${suffix}`;
  };
  const parts = [`${ordinal(history.stays + 1)} stay`];
  if (history.lastStay) parts.push(`last here ${history.lastStay}`);
  if (history.nights) parts.push(`${history.nights} night${history.nights === 1 ? "" : "s"} total`);
  return parts.join(" · ");
}

/* ---------------------------------------------------------
   THE SERVICE
--------------------------------------------------------- */

export function createGuestService({ db, restaurantId, firestore, now = () => new Date() }) {
  const { doc, collection, runTransaction, serverTimestamp } = firestore;

  const guestRef = id => doc(db, "restaurants", restaurantId, GUESTS, String(id));
  const documentsRef = id => doc(db, "restaurants", restaurantId, GUEST_DOCUMENTS, String(id));
  const auditRef = () => doc(collection(db, AUDIT_LOGS));

  function audit(transaction, { action, actor = {}, detail }) {
    transaction.set(auditRef(), {
      restaurantId, action,
      userId: String(actor.uid || ""), userName: String(actor.name || ""), role: String(actor.role || ""),
      detail, createdAt: serverTimestamp(), at: now().toISOString()
    });
  }

  async function saveGuest({ guestId, input, actor }) {
    const check = validateGuest(input);
    if (!check.ok) throw new GuestError("invalid", check.reason);
    const id = String(guestId || "").trim() || `G${Date.now().toString(36).toUpperCase()}`;
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(guestRef(id));
      transaction.set(guestRef(id), {
        restaurantId, ...check.guest,
        ...(existing.exists() ? {} : { createdAt: serverTimestamp() }),
        updatedAt: serverTimestamp()
      }, { merge: true });
      audit(transaction, {
        action: existing.exists() ? "guest_updated" : "guest_created",
        actor,
        // The log records WHICH guest, never their details: it is readable
        // by anyone who may read logs.
        detail: { guestId: id }
      });
      return { ok: true, guestId: id, created: !existing.exists() };
    });
  }

  /**
   * Identity documents. Owner-level by the rules; checked here too so the
   * refusal is a clear message rather than a permission error.
   */
  async function saveDocuments({ guestId, input, actor }) {
    if (!["manager"].includes(normalizeHotelRole(actor?.role))) {
      throw new GuestError("forbidden", "Only a manager can record or change a guest's identity documents.");
    }
    if (!guestId) throw new GuestError("invalid", "Save the guest first.");
    const documents = normalizeGuestDocuments(input);
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(documentsRef(guestId));
      transaction.set(documentsRef(guestId), {
        restaurantId, guestId: String(guestId), ...documents,
        ...(existing.exists() ? {} : { createdAt: serverTimestamp() }),
        updatedAt: serverTimestamp()
      }, { merge: true });
      audit(transaction, {
        action: "guest_documents_updated", actor,
        // Which fields were filled, never their values. An audit log that
        // carried a passport number would defeat the split it is logging.
        detail: { guestId, fields: Object.keys(documents).filter(key => documents[key]) }
      });
      return { ok: true };
    });
  }

  /**
   * RULE 17. A guest is archived, never deleted.
   *
   * Their folios and invoices already copied their name when each was
   * raised, so the books survive regardless — but a deleted guest would
   * still orphan the reservations that reference them, and a stay with no
   * guest is not a record anybody can audit.
   */
  async function archiveGuest({ guestId, actor, reason = "" }) {
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(guestRef(guestId));
      if (!existing.exists()) return { ok: true, unchanged: true };
      if (existing.data().archived === true) return { ok: true, unchanged: true };
      transaction.set(guestRef(guestId), {
        archived: true,
        archivedReason: String(reason || ""),
        archivedBy: String(actor?.name || ""),
        archivedAt: serverTimestamp()
      }, { merge: true });
      audit(transaction, { action: "guest_archived", actor, detail: { guestId, reason: String(reason || "") } });
      return { ok: true, archived: true };
    });
  }

  return { saveGuest, saveDocuments, archiveGuest };
}

export class GuestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GuestError";
    this.code = code;
    Object.assign(this, details);
  }
}
