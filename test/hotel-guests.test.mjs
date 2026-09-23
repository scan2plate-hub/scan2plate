/* =========================================================
   GUEST CRM

   Section 9 asks for a guest record, and adds one constraint
   that shapes the whole design:

     "Do not expose sensitive guest documents to unauthorized
      staff."

   Firestore rules are per DOCUMENT, so a single guest record
   carrying both a phone number and a passport could not be
   half-readable — no arrangement of fields would enforce it. The
   split into two collections IS the enforcement, and these tests
   pin that nothing in the module quietly puts them back together.

   Section 24 adds the other: capture what a property's compliance
   workflow needs, and claim nothing about filing it.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createGuestService, GuestError, phoneKey, normalizeGuest, normalizeGuestDocuments,
  validateGuest, searchGuests, possibleDuplicates, guestHistory, guestSummaryLine,
  missingForeignGuestFields, GUESTS, GUEST_DOCUMENTS, ID_TYPES
} from "../public/js/hotel-guests.js";
import { RESERVATION_STATUS } from "../public/js/hotel-core.js";

function makeFirestore() {
  const store = new Map();
  let autoId = 0;
  const firestore = {
    doc: (dbOrRef, ...segments) => (segments.length
      ? { path: segments.filter(Boolean).join("/") }
      : { path: `${dbOrRef.path}/auto${autoId += 1}` }),
    collection: (db, ...segments) => ({ path: segments.join("/") }),
    serverTimestamp: () => "TS",
    async runTransaction(db, body) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const held = store.get(ref.path);
          return { exists: () => Boolean(held), data: () => (held ? { ...held } : undefined) };
        },
        set(ref, data, options) { writes.push({ path: ref.path, data, merge: options?.merge }); },
        delete(ref) { writes.push({ path: ref.path, remove: true }); }
      };
      const result = await body(transaction);
      writes.forEach(write => {
        if (write.remove) store.delete(write.path);
        else store.set(write.path, write.merge ? { ...(store.get(write.path) || {}), ...write.data } : write.data);
      });
      return result;
    }
  };
  return { firestore, store };
}

const db = {};
const RID = "RST006";
const manager = { uid: "m1", name: "M Anager", role: "manager" };
const reception = { uid: "r1", name: "R Desk", role: "receptionist" };

const P = {
  guest: id => `restaurants/${RID}/${GUESTS}/${id}`,
  documents: id => `restaurants/${RID}/${GUEST_DOCUMENTS}/${id}`
};
const audits = store => [...store.entries()].filter(([path]) => path.startsWith("hotelAuditLogs/")).map(([, data]) => data);
const fresh = () => {
  const { firestore, store } = makeFirestore();
  return { service: createGuestService({ db, restaurantId: RID, firestore }), store };
};

/* =========================================================
   THE PRIVACY SPLIT
========================================================= */

test("SECTION 9: NO exported function returns a guest and their passport together", async () => {
  // Tested by behaviour, not by grepping for a spread: the module must
  // legitimately spread documents INTO the documents record, and a source
  // check strict enough to ban that would have to be switched off.
  //
  // What actually matters is that no caller can obtain one object holding
  // both. A helper that merged them would be used by a screen that should
  // not have it, and the rules could not intervene because the data would
  // already be in the caller's hands.
  const module = await import("../public/js/hotel-guests.js");
  const everything = {
    name: "A Guest", phone: "9876543210", email: "a@b.com", city: "Pune",
    passportNumber: "Z1234567", idNumber: "1234-5678", idScanUrl: "https://x/y.jpg", visaNumber: "V99"
  };
  const sensitive = ["passportNumber", "idNumber", "idScanUrl", "visaNumber"];

  Object.entries(module).forEach(([exportName, value]) => {
    if (typeof value !== "function" || /^create|Error$/.test(exportName)) return;
    let result;
    try { result = value(everything); } catch { return; }
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const flat = result.guest && typeof result.guest === "object" ? result.guest : result;
    const carriesIdentity = Boolean(flat.name) || Boolean(flat.phone);
    const carriesDocuments = sensitive.some(field => flat[field]);
    assert.ok(!(carriesIdentity && carriesDocuments),
      `${exportName}() returned a guest AND their documents in one object`);
  });

  // And the staff-readable shape carries no sensitive field at all.
  const guest = normalizeGuest(everything);
  sensitive.forEach(field => {
    assert.equal(guest[field], undefined, `${field} must never reach the staff-readable record`);
  });
});

test("the guest record written to Firestore holds no document fields", async () => {
  // The other half: not just what the helpers return, but what is stored.
  const { service, store } = fresh();
  await service.saveGuest({
    guestId: "G1", actor: reception,
    input: { name: "A Guest", phone: "9876543210", passportNumber: "Z1234567", idScanUrl: "https://x/y.jpg" }
  });
  const stored = store.get(P.guest("G1"));
  assert.equal(stored.name, "A Guest");
  ["passportNumber", "idScanUrl", "idNumber", "visaNumber"].forEach(field => {
    assert.equal(stored[field], undefined, `${field} must not be written to the staff-readable document`);
  });
});

test("identity documents are a separate shape, recorded only by a manager", async () => {
  const { service, store } = fresh();
  await service.saveGuest({ guestId: "G1", input: { name: "A Guest", phone: "9876543210" }, actor: reception });

  await assert.rejects(
    () => service.saveDocuments({ guestId: "G1", input: { passportNumber: "Z1" }, actor: reception }),
    error => {
      assert.equal(error.code, "forbidden");
      assert.match(error.message, /manager/i);
      return true;
    }
  );

  await service.saveDocuments({
    guestId: "G1", actor: manager,
    input: { idType: "passport", passportNumber: "Z1234567", visaNumber: "V-88", arrivalDate: "2026-10-01" }
  });
  assert.equal(store.get(P.documents("G1")).passportNumber, "Z1234567");
  assert.equal(store.get(P.guest("G1")).passportNumber, undefined, "and never on the guest record");
});

test("the audit log records WHICH guest, never their details", async () => {
  // The log is readable by anyone who may read logs. A log carrying a
  // passport number would defeat the split it is logging.
  const { service, store } = fresh();
  await service.saveGuest({ guestId: "G1", input: { name: "A Guest", phone: "9876543210" }, actor: reception });
  await service.saveDocuments({ guestId: "G1", input: { passportNumber: "Z1234567" }, actor: manager });

  const entries = audits(store);
  const serialised = JSON.stringify(entries);
  assert.ok(!serialised.includes("Z1234567"), "no document number in the log");
  assert.ok(!serialised.includes("9876543210"), "no phone number either");
  assert.ok(!serialised.includes("A Guest"), "nor the name");
  const documentEntry = entries.find(entry => entry.action === "guest_documents_updated");
  assert.deepEqual(documentEntry.detail.fields, ["idType", "passportNumber"], "only which fields were filled");
});

test("an unknown id type is not passed through", () => {
  assert.equal(normalizeGuestDocuments({ idType: "something_invented" }).idType, "other");
  assert.ok(ID_TYPES.includes(normalizeGuestDocuments({ idType: "passport" }).idType));
});

/* =========================================================
   SECTION 24 — FOREIGN GUESTS, CLAIMING NOTHING
========================================================= */

test("SECTION 24: the module reports what is missing and files nothing", async () => {
  const missing = missingForeignGuestFields({ passportNumber: "Z1234567" });
  assert.deepEqual(missing, ["visaNumber", "arrivalDate"]);
  assert.deepEqual(missingForeignGuestFields({
    passportNumber: "Z1", visaNumber: "V1", arrivalDate: "2026-10-01"
  }), []);

  // What a property must capture varies by jurisdiction, so the required
  // list is the caller's to set.
  assert.deepEqual(missingForeignGuestFields({ passportNumber: "Z1" }, { required: ["passportNumber"] }), []);

  // And nothing in the module transmits anywhere or claims compliance.
  const source = await import("node:fs").then(fs =>
    fs.readFileSync(new URL("../public/js/hotel-guests.js", import.meta.url), "utf8"));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  ["fetch(", "XMLHttpRequest", "sendBeacon"].forEach(transport => {
    assert.ok(!code.includes(transport), `the module must not ${transport.replace("(", "")} anything anywhere`);
  });
});

test("visa and passport expiry dates are validated, not stored as typed", () => {
  const documents = normalizeGuestDocuments({ passportExpiry: "2030-05-31", visaExpiry: "not a date" });
  assert.equal(documents.passportExpiry, "2030-05-31");
  assert.equal(documents.visaExpiry, "", "an unparseable expiry is blank, not a guess");
});

/* =========================================================
   FINDING A GUEST
========================================================= */

test("one person's phone number in four formats is one guest", () => {
  // The desk types it differently every time. Matching the raw string
  // creates four profiles for one person and loses their history at the
  // moment it is most wanted.
  ["9876543210", "+919876543210", "09876543210", "91 98765 43210"].forEach(written => {
    assert.equal(phoneKey(written), "9876543210", `${written} must key the same`);
  });
  assert.equal(phoneKey(""), "");
  assert.equal(phoneKey("not a number"), "");
});

const guest = (id, patch = {}) => normalizeGuest({ name: `Guest ${id}`, phone: "9000000000", ...patch }) && ({
  id, ...normalizeGuest({ name: `Guest ${id}`, phone: "9000000000", ...patch })
});

test("search finds a guest by anything the desk has when the phone rings", () => {
  const guests = [
    guest("G1", { name: "Anita Rao", phone: "+919876543210", email: "anita@example.com", city: "Pune" }),
    guest("G2", { name: "Vikram Shah", phone: "9123456789", company: "Acme Ltd" }),
    guest("G3", { name: "Anita Desai", phone: "9555000111" })
  ];
  assert.deepEqual(searchGuests(guests, "anita").map(row => row.id), ["G1", "G3"]);
  assert.deepEqual(searchGuests(guests, "9876543210").map(row => row.id), ["G1"], "typed without the country code");
  assert.deepEqual(searchGuests(guests, "+91 98765 43210").map(row => row.id), ["G1"], "or with it");
  assert.deepEqual(searchGuests(guests, "acme").map(row => row.id), ["G2"]);
  assert.deepEqual(searchGuests(guests, "anita@example.com").map(row => row.id), ["G1"]);
  assert.equal(searchGuests(guests, "").length, 3, "an empty search is everyone, not nobody");
});

test("an archived guest stays out of search unless asked for", () => {
  const guests = [guest("G1", { name: "Old Guest", archived: true })];
  assert.equal(searchGuests(guests, "old").length, 0);
  assert.equal(searchGuests(guests, "old", { includeArchived: true }).length, 1);
});

test("possible duplicates are offered, never merged", () => {
  // Two people genuinely do share a phone, and merging two histories is not
  // something a front desk can undo.
  const guests = [
    guest("G1", { name: "Anita Rao", phone: "+919876543210", city: "Pune" }),
    guest("G2", { name: "Vikram Shah", phone: "9123456789", email: "v@example.com" }),
    guest("G3", { name: "Anita Rao", phone: "9000000001", city: "Pune" })
  ];
  assert.deepEqual(possibleDuplicates(guests, { phone: "9876543210" }).map(row => row.id), ["G1"]);
  assert.deepEqual(possibleDuplicates(guests, { email: "v@example.com" }).map(row => row.id), ["G2"]);
  // A name alone is not a match — hotels are full of common names.
  assert.deepEqual(possibleDuplicates(guests, { name: "Anita Rao" }).map(row => row.id), []);
  // A name AND a city is worth asking about.
  assert.deepEqual(possibleDuplicates(guests, { name: "Anita Rao", city: "Pune" }).map(row => row.id), ["G1", "G3"]);
  // A guest never duplicates themselves.
  assert.deepEqual(possibleDuplicates(guests, { id: "G1", phone: "9876543210" }).map(row => row.id), []);
});

/* =========================================================
   HISTORY AND VALUE
========================================================= */

const stay = (id, patch = {}) => ({
  id, guestId: "G1", roomId: "101", checkIn: "2026-01-01", checkOut: "2026-01-04",
  status: RESERVATION_STATUS.CHECKED_OUT, ...patch
});
const invoice = (reservationId, total, room = total) => ({
  reservationId, totals: { total, byKind: { room } }
});

test("a cancellation is part of the record but not of the value", () => {
  // Counting it would make a serial canceller look like the property's best
  // customer.
  const history = guestHistory("G1", {
    reservations: [
      stay("s1"),
      stay("s2", { checkIn: "2026-03-01", checkOut: "2026-03-03" }),
      stay("s3", { status: RESERVATION_STATUS.CANCELLED }),
      stay("s4", { status: RESERVATION_STATUS.NO_SHOW })
    ],
    invoices: [invoice("s1", 9000, 7500), invoice("s2", 6000, 5000)]
  });
  assert.equal(history.stays, 2);
  assert.equal(history.nights, 5, "three nights plus two");
  assert.equal(history.totalSpend, 15000);
  assert.equal(history.roomSpend, 12500);
  assert.equal(history.otherSpend, 2500);
  assert.equal(history.cancellations, 1, "still recorded");
  assert.equal(history.noShows, 1);
});

test("another guest's stays never count toward this one", () => {
  const history = guestHistory("G1", {
    reservations: [stay("s1"), stay("s2", { guestId: "G2" })],
    invoices: [invoice("s1", 5000), invoice("s2", 90000)]
  });
  assert.equal(history.stays, 1);
  assert.equal(history.totalSpend, 5000);
});

test("first and last stay are the dates the desk greets them with", () => {
  const history = guestHistory("G1", {
    reservations: [
      stay("s1", { checkIn: "2026-03-01", checkOut: "2026-03-02" }),
      stay("s2", { checkIn: "2025-11-01", checkOut: "2025-11-03" })
    ],
    invoices: []
  });
  assert.equal(history.firstStay, "2025-11-01");
  assert.equal(history.lastStay, "2026-03-01");
  assert.deepEqual(history.reservations.map(row => row.id), ["s1", "s2"], "newest first for display");
});

test("a guest in house right now counts as a stay", () => {
  const history = guestHistory("G1", {
    reservations: [stay("s1", { status: RESERVATION_STATUS.CHECKED_IN })],
    invoices: []
  });
  assert.equal(history.stays, 1);
});

test("a guest with no history reports zeroes, never NaN", () => {
  const history = guestHistory("G9", { reservations: [], invoices: [] });
  assert.equal(history.stays, 0);
  assert.equal(history.totalSpend, 0);
  assert.equal(history.averageSpendPerStay, 0);
  assert.equal(history.firstStay, "");
});

test("the desk gets a line it can greet a returning guest with", () => {
  assert.equal(guestSummaryLine({ stays: 0 }), "First stay");
  assert.match(guestSummaryLine({ stays: 3, lastStay: "2026-03-01", nights: 9 }), /4th stay/);
  assert.match(guestSummaryLine({ stays: 3, lastStay: "2026-03-01", nights: 9 }), /last here 2026-03-01/);
  assert.match(guestSummaryLine({ stays: 1, nights: 2 }), /2nd stay/);
  assert.match(guestSummaryLine({ stays: 2, nights: 4 }), /3rd stay/);
});

/* =========================================================
   VALIDATION AND RULE 17
========================================================= */

test("a guest with no way to reach them cannot be saved", () => {
  // Without a phone or an email the record cannot be found again, which is
  // the entire point of having one.
  assert.match(validateGuest({ name: "A Guest" }).reason, /phone number or an email/);
  assert.match(validateGuest({ phone: "9876543210" }).reason, /name/i);
  assert.equal(validateGuest({ name: "A Guest", phone: "9876543210" }).ok, true);
  assert.equal(validateGuest({ name: "A Guest", email: "a@b.com" }).ok, true);
});

test("an unreachable phone or a malformed email is refused", () => {
  assert.match(validateGuest({ name: "A", phone: "123" }).reason, /too short/);
  assert.match(validateGuest({ name: "A", email: "not-an-email" }).reason, /does not look right/);
});

test("RULE 17: a guest is archived, never deleted", async () => {
  const { service, store } = fresh();
  await service.saveGuest({ guestId: "G1", input: { name: "A Guest", phone: "9876543210" }, actor: reception });
  await service.archiveGuest({ guestId: "G1", actor: manager, reason: "Requested removal" });

  const record = store.get(P.guest("G1"));
  assert.ok(record, "the document survives, so reservations that reference it still resolve");
  assert.equal(record.archived, true);
  assert.equal(record.archivedReason, "Requested removal");
});

test("archiving twice is harmless", async () => {
  const { service } = fresh();
  await service.saveGuest({ guestId: "G1", input: { name: "A Guest", phone: "9876543210" }, actor: reception });
  await service.archiveGuest({ guestId: "G1", actor: manager });
  const again = await service.archiveGuest({ guestId: "G1", actor: manager });
  assert.equal(again.unchanged, true);
});

test("saving an existing guest updates rather than duplicating", async () => {
  const { service, store } = fresh();
  await service.saveGuest({ guestId: "G1", input: { name: "A Guest", phone: "9876543210" }, actor: reception });
  const again = await service.saveGuest({
    guestId: "G1", input: { name: "A Guest", phone: "9876543210", city: "Pune" }, actor: reception
  });
  assert.equal(again.created, false);
  assert.equal(store.get(P.guest("G1")).city, "Pune");
  assert.equal([...store.keys()].filter(path => path.includes(GUESTS)).length, 1);
});

test("a phone number is stored as typed AND as a match key", () => {
  // The desk should see what the guest gave them; the search should find it
  // however it was written.
  const normalized = normalizeGuest({ name: "A", phone: "+91 98765 43210" });
  assert.equal(normalized.phone, "+91 98765 43210");
  assert.equal(normalized.phoneKey, "9876543210");
});
