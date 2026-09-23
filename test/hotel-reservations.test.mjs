/* =========================================================
   RESERVATION SERVICE — THE RACE, AND WHAT SURVIVES IT

   Rule 2 says a room cannot be double-booked. The test that
   matters is not "does it refuse an obvious clash" — a check
   before the write does that. It is what happens when two
   bookings for the same night are in flight at once, which is
   the case a pre-write check cannot cover and which is exactly
   what happens when two receptionists work the same arrival list.

   The Firestore stub below models the part of the real thing
   that decides the outcome: a transaction reads, another writer
   commits, and the first transaction's commit is rejected and
   retried. That is enough to make the race real in a test.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createReservationService, buildReservation, ReservationError
} from "../public/js/hotel-reservations.js";
import { RESERVATION_STATUS } from "../public/js/hotel-core.js";
import { roomNightKey, roomNightKeysFor, planRoomNightChange, lockConflicts, describeLockConflicts, validateLockRequest, parseRoomNightKey, MAX_LOCKABLE_NIGHTS } from "../public/js/hotel-inventory.js";

/* ---------------------------------------------------------
   A FIRESTORE STUB WITH OPTIMISTIC CONCURRENCY

   Documents carry a version. A transaction records the version of
   everything it read; at commit, if any of those changed, the
   commit is rejected and the whole block runs again — which is
   what the real client SDK does.
--------------------------------------------------------- */
function makeFirestore({ onAfterReads, onBeforeAttempt } = {}) {
  const store = new Map();           // path -> { data, version }
  const versionFloor = new Map();    // path -> version a deleted doc left behind
  let commits = 0;
  let attempts = 0;
  const versionAt = path => (store.get(path)?.version ?? versionFloor.get(path) ?? 0);

  const pathOf = segments => segments.join("/");
  const docRef = (...segments) => ({ path: pathOf(segments.filter(Boolean)) });

  const firestore = {
    doc: (dbOrRef, ...segments) => (segments.length ? docRef(...segments) : { path: `${dbOrRef.path}/${randomId()}` }),
    collection: (db, ...segments) => ({ path: pathOf(segments) }),
    serverTimestamp: () => "SERVER_TIMESTAMP",
    async runTransaction(db, body) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        attempts += 1;
        // Interference that landed BEFORE this attempt starts — the state a
        // retry actually re-reads.
        if (onBeforeAttempt) await onBeforeAttempt({ attempt, store, commit: rawCommit, release: rawRelease });
        const readVersions = new Map();
        const writes = [];
        const transaction = {
          async get(ref) {
            const held = store.get(ref.path);
            readVersions.set(ref.path, versionAt(ref.path));
            return {
              exists: () => Boolean(held),
              data: () => (held ? { ...held.data } : undefined)
            };
          },
          set(ref, data) { writes.push({ kind: "set", path: ref.path, data }); },
          delete(ref) { writes.push({ kind: "delete", path: ref.path }); }
        };

        const result = await body(transaction);

        // The interference point: another writer commits between this
        // transaction's reads and its commit.
        if (onAfterReads) await onAfterReads({ attempt, store, commit: rawCommit, release: rawRelease });

        const stale = [...readVersions.entries()].some(([path, version]) => versionAt(path) !== version);
        if (stale) continue;   // aborted — run the whole block again

        writes.forEach(write => {
          if (write.kind === "delete") store.delete(write.path);
          else {
            const held = store.get(write.path);
            store.set(write.path, { data: { ...(held?.data || {}), ...write.data }, version: (held?.version || 0) + 1 });
          }
        });
        commits += 1;
        return result;
      }
      throw new Error("transaction failed after repeated retries");
    }
  };

  function rawCommit(path, data) {
    const held = store.get(path);
    store.set(path, { data: { ...(held?.data || {}), ...data }, version: (held?.version || 0) + 1 });
  }

  // A delete still bumps the version, so a transaction that read the document
  // before it vanished is correctly treated as stale.
  function rawRelease(path) {
    const held = store.get(path);
    store.delete(path);
    store.set(`${path}#tombstone`, { data: {}, version: (held?.version || 0) + 1 });
    store.delete(`${path}#tombstone`);
    versionFloor.set(path, (held?.version || 0) + 1);
  }

  return { firestore, store, rawCommit, rawRelease, stats: () => ({ commits, attempts }) };
}

let counter = 0;
const randomId = () => `auto${counter += 1}`;

const db = { name: "stub" };
const RID = "RST006";
const actor = { uid: "u1", name: "Reception", role: "receptionist" };
const roomType = { id: "deluxe", baseRate: 2000, maxAdults: 2 };

const lockPath = key => `restaurants/${RID}/hotel_room_nights/${key}`;
const bookingPath = id => `restaurants/${RID}/hotel_reservations/${id}`;
const auditEntries = store => [...store.entries()].filter(([path]) => path.startsWith("hotelAuditLogs/"));

const newBooking = (over = {}) => ({
  id: "BK1", bookingId: "BK1", roomId: "101", roomTypeId: "deluxe", roomType,
  guestName: "A Guest", checkIn: "2026-10-01", checkOut: "2026-10-04",
  adults: 2, source: "walk_in", ...over
});

/* =========================================================
   LOCK KEYS
========================================================= */

test("a lock id names exactly one room on one night", () => {
  assert.equal(roomNightKey("101", "2026-10-01"), "101__2026-10-01");
  assert.deepEqual(parseRoomNightKey("101__2026-10-01"), { roomId: "101", stayDate: "2026-10-01" });
});

test("a room id that could forge another room's key is refused", () => {
  // "1__2026-10-01" as a room id would produce a key that collides with
  // room 1's night, silently handing away someone else's room.
  assert.equal(roomNightKey("1__2026-10-01", "2026-10-02"), "");
  const check = validateLockRequest({ roomId: "a__b", checkIn: "2026-10-01", checkOut: "2026-10-02" });
  assert.equal(check.ok, false);
});

test("an invalid date produces no lock at all, never a partial hold", () => {
  assert.equal(roomNightKey("101", "2026-02-31"), "");
  assert.deepEqual(roomNightKeysFor({ roomId: "101", checkIn: "2026-02-31", checkOut: "2026-03-02" }), [],
    "a stay that cannot be fully locked must be locked not at all");
});

test("a stay locks one night per night, checkout day excluded", () => {
  assert.deepEqual(roomNightKeysFor({ roomId: "101", checkIn: "2026-10-01", checkOut: "2026-10-04" }),
    ["101__2026-10-01", "101__2026-10-02", "101__2026-10-03"]);
});

test("an absurdly long stay is refused before it reaches the database", () => {
  const check = validateLockRequest({ roomId: "101", checkIn: "2026-01-01", checkOut: "2028-01-01" });
  assert.equal(check.ok, false);
  assert.match(check.reason, new RegExp(String(MAX_LOCKABLE_NIGHTS)));
});

test("moving a booking releases only the nights it gives up", () => {
  const before = { roomId: "101", checkIn: "2026-10-01", checkOut: "2026-10-04", status: RESERVATION_STATUS.CONFIRMED };
  const after = { roomId: "101", checkIn: "2026-10-02", checkOut: "2026-10-05", status: RESERVATION_STATUS.CONFIRMED };
  const plan = planRoomNightChange(before, after);
  assert.deepEqual(plan.release, ["101__2026-10-01"]);
  assert.deepEqual(plan.acquire, ["101__2026-10-04"]);
  assert.equal(plan.keep.length, 2, "the unchanged nights are never dropped and retaken");
});

test("a room move releases every old night and takes every new one", () => {
  const plan = planRoomNightChange(
    { roomId: "101", checkIn: "2026-10-01", checkOut: "2026-10-03", status: RESERVATION_STATUS.CONFIRMED },
    { roomId: "202", checkIn: "2026-10-01", checkOut: "2026-10-03", status: RESERVATION_STATUS.CONFIRMED }
  );
  assert.deepEqual(plan.release, ["101__2026-10-01", "101__2026-10-02"]);
  assert.deepEqual(plan.acquire, ["202__2026-10-01", "202__2026-10-02"]);
});

test("a booking's own lock is not a conflict with itself", () => {
  // Without this, saving an unchanged booking — or retrying after a dropped
  // connection — would report the room as taken by the booking being saved.
  const held = { "101__2026-10-01": { reservationId: "BK1" } };
  assert.deepEqual(lockConflicts(held, { reservationId: "BK1" }), []);
  assert.equal(lockConflicts(held, { reservationId: "BK2" }).length, 1);
});

test("a clash is described with the date and the booking that won", () => {
  const message = describeLockConflicts([{ key: "101__2026-10-02", roomId: "101", stayDate: "2026-10-02", bookingId: "BK9" }]);
  assert.match(message, /2026-10-02/);
  assert.match(message, /BK9/);
});

/* =========================================================
   THE TRANSACTION
========================================================= */

test("a new booking takes one lock per night and writes an audit entry", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });

  const result = await service.create(newBooking(), actor);
  assert.equal(result.ok, true);
  ["101__2026-10-01", "101__2026-10-02", "101__2026-10-03"].forEach(key => {
    assert.ok(store.has(lockPath(key)), `${key} must be held`);
    assert.equal(store.get(lockPath(key)).data.reservationId, "BK1");
  });
  assert.ok(store.has(bookingPath("BK1")));
  assert.equal(auditEntries(store).length, 1);
  assert.equal(auditEntries(store)[0][1].data.action, "reservation_created");
});

test("RULE 2, THE RACE: a booking that loses the night is refused", async () => {
  // The interference runs AFTER this transaction has read the locks and found
  // them free — the exact window a pre-write availability check cannot cover.
  const { firestore, store, rawCommit } = makeFirestore({
    onAfterReads: async ({ attempt, commit }) => {
      if (attempt !== 0) return;
      commit(lockPath("101__2026-10-02"), { reservationId: "BK-OTHER", bookingId: "BK-OTHER" });
    }
  });
  const service = createReservationService({ db, restaurantId: RID, firestore });

  await assert.rejects(
    () => service.create(newBooking(), actor),
    error => {
      assert.equal(error instanceof ReservationError, true);
      assert.equal(error.code, "room_taken");
      assert.match(error.message, /2026-10-02/);
      assert.match(error.message, /BK-OTHER/);
      return true;
    }
  );

  // And nothing partial is left behind: the losing booking holds no nights.
  assert.equal(store.has(bookingPath("BK1")), false, "no reservation document");
  assert.equal(store.has(lockPath("101__2026-10-01")), false, "no orphaned lock on the free nights");
  assert.equal(store.has(lockPath("101__2026-10-03")), false);
  assert.equal(auditEntries(store).length, 0, "and nothing in the log claiming it happened");
  assert.equal(store.get(lockPath("101__2026-10-02")).data.reservationId, "BK-OTHER", "the winner keeps the night");
  void rawCommit;
});

test("a transaction is not retried over a night it never read", async () => {
  // Optimistic concurrency at work: another booking taking a night this stay
  // does not want changes nothing this transaction read, so it commits first
  // time. A design that retried on any write at all would livelock a busy
  // property, where something is always being booked.
  const { firestore, store, stats } = makeFirestore({
    onAfterReads: async ({ attempt, commit }) => {
      if (attempt !== 0) return;
      commit(lockPath("101__2026-10-01"), { reservationId: "BK-OTHER" });
    }
  });
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking({ checkIn: "2026-10-05", checkOut: "2026-10-07" }), actor);
  assert.ok(store.has(lockPath("101__2026-10-05")));
  assert.equal(stats().attempts, 1, "an unrelated booking must not cost a retry");
});

test("a night taken and then released mid-flight is retried and then booked", async () => {
  // The transaction reads the night free, another booking takes it before the
  // commit, so this one aborts. By the time it retries that booking has been
  // cancelled. It must re-read and succeed, rather than fail on what it saw
  // during its first attempt — which is the whole reason the check lives
  // inside the transaction instead of before it.
  const { firestore, store, stats } = makeFirestore({
    onAfterReads: async ({ attempt, commit }) => {
      if (attempt === 0) commit(lockPath("101__2026-10-02"), { reservationId: "BK-OTHER", bookingId: "BK-OTHER" });
    },
    onBeforeAttempt: async ({ attempt, release }) => {
      if (attempt === 1) release(lockPath("101__2026-10-02"));
    }
  });
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  assert.equal(stats().attempts, 2, "exactly one abort and one successful retry");
  assert.equal(store.get(lockPath("101__2026-10-02")).data.reservationId, "BK1");
});

test("an overlapping booking is refused even with no race at all", async () => {
  const { firestore } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  await assert.rejects(
    () => service.create(newBooking({ id: "BK2", bookingId: "BK2", checkIn: "2026-10-03", checkOut: "2026-10-06" })),
    error => error.code === "room_taken"
  );
});

test("a same-day turnover books successfully", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);                       // 01 -> 04
  await service.create(newBooking({ id: "BK2", bookingId: "BK2", checkIn: "2026-10-04", checkOut: "2026-10-06" }), actor);
  assert.equal(store.get(lockPath("101__2026-10-04")).data.reservationId, "BK2");
});

test("re-sending the same booking id is a retry, not a second booking", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  const again = await service.create(newBooking(), actor);
  assert.equal(again.duplicate, true);
  assert.equal(auditEntries(store).length, 1, "a retry must not log a second creation");
});

/* =========================================================
   LIFECYCLE — rules 9, 10 and the status machine
========================================================= */

test("RULE 9: cancelling releases every night immediately", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  await service.cancel("BK1", { actor, reason: "Guest called", businessDate: "2026-09-25" });

  ["101__2026-10-01", "101__2026-10-02", "101__2026-10-03"].forEach(key => {
    assert.equal(store.has(lockPath(key)), false, `${key} must be released`);
  });
  assert.equal(store.get(bookingPath("BK1")).data.status, RESERVATION_STATUS.CANCELLED);
  // And the nights are genuinely resellable, not merely unlocked.
  await service.create(newBooking({ id: "BK2", bookingId: "BK2" }), actor);
  assert.equal(store.get(lockPath("101__2026-10-01")).data.reservationId, "BK2");
});

test("RULE 10: a no-show releases the room too", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  await service.markNoShow("BK1", { actor, businessDate: "2026-10-01" });
  assert.equal(store.has(lockPath("101__2026-10-01")), false);
  assert.equal(store.get(bookingPath("BK1")).data.noShowOn, "2026-10-01");
});

test("check-out releases the remaining nights so an early departure resells", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  await service.checkIn("BK1", { actor });
  await service.checkOut("BK1", { actor });
  ["101__2026-10-01", "101__2026-10-02", "101__2026-10-03"].forEach(key => {
    assert.equal(store.has(lockPath(key)), false);
  });
  assert.equal(store.get(bookingPath("BK1")).data.status, RESERVATION_STATUS.CHECKED_OUT);
});

test("a guest cannot be checked out before being checked in", async () => {
  const { firestore } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  await assert.rejects(() => service.checkOut("BK1", { actor }), error => error.code === "bad_status");
});

test("an in-house guest is checked out, never cancelled", async () => {
  const { firestore } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  await service.checkIn("BK1", { actor });
  await assert.rejects(() => service.cancel("BK1", { actor }), error => {
    assert.match(error.message, /in house/i);
    return error.code === "bad_status";
  });
});

test("a completed stay cannot be edited or cancelled afterwards", async () => {
  // Rule 19: historical reports must stay accurate. Rewriting a departed
  // stay would silently change a night already counted in a closed day.
  const { firestore } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  await service.checkIn("BK1", { actor });
  await service.checkOut("BK1", { actor });
  await assert.rejects(() => service.cancel("BK1", { actor }), error => error.code === "closed");
  await assert.rejects(
    () => service.amend("BK1", { checkOut: "2026-10-09" }, actor),
    error => error.code === "closed"
  );
});

test("repeating check-in is idempotent and does not log twice", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  await service.checkIn("BK1", { actor });
  const again = await service.checkIn("BK1", { actor });
  assert.equal(again.unchanged, true);
  assert.equal(auditEntries(store).filter(([, entry]) => entry.data.action === "check_in").length, 1);
});

test("extending a stay keeps the nights already held and takes only the new one", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  await service.amend("BK1", { checkOut: "2026-10-06" }, actor);
  ["101__2026-10-01", "101__2026-10-04", "101__2026-10-05"].forEach(key => {
    assert.equal(store.get(lockPath(key)).data.reservationId, "BK1");
  });
});

test("a stay cannot be extended into a night another guest holds", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);                                                    // 01 -> 04
  await service.create(newBooking({ id: "BK2", bookingId: "BK2", checkIn: "2026-10-04", checkOut: "2026-10-06" }), actor);
  await assert.rejects(
    () => service.amend("BK1", { checkOut: "2026-10-05" }, actor),
    error => error.code === "room_taken"
  );
  // The original booking is untouched by the failed extension.
  assert.equal(store.get(bookingPath("BK1")).data.checkOut, "2026-10-04");
});

test("moving to another room frees the first one in the same transaction", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  await service.amend("BK1", { roomId: "202" }, actor);
  assert.equal(store.has(lockPath("101__2026-10-01")), false, "room 101 is free at once");
  assert.equal(store.get(lockPath("202__2026-10-01")).data.reservationId, "BK1");
  assert.equal(auditEntries(store).some(([, entry]) => entry.data.action === "reservation_room_changed"), true);
});

test("a booking that does not exist cannot be amended", async () => {
  const { firestore } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await assert.rejects(() => service.checkIn("NOPE", { actor }), error => error.code === "not_found");
});

/* =========================================================
   WHAT IS RECORDED
========================================================= */

test("the audit trail carries who did what, and not the guest's details", () => {
  const reservation = buildReservation(newBooking({ guestPhone: "+919000000000", ratePlans: [] }));
  assert.equal(reservation.nights, 3);
  assert.equal(reservation.roomTotal, 6000, "three nights at the base rate");
  assert.equal(reservation.nightlyRates.length, 3, "priced per night, so a month boundary needs no guessing");
});

test("an audit entry names the actor and summarises both sides of the change", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await service.create(newBooking(), actor);
  await service.amend("BK1", { roomId: "202" }, actor);
  const entry = auditEntries(store).map(([, held]) => held.data)
    .find(data => data.action === "reservation_room_changed");
  assert.equal(entry.userId, "u1");
  assert.equal(entry.role, "receptionist");
  assert.equal(entry.restaurantId, RID);
  assert.equal(entry.before.roomId, "101");
  assert.equal(entry.after.roomId, "202");
  assert.equal(entry.after.guestName, undefined, "a log readable by staff carries no guest identity");
  assert.equal(entry.after.guestPhone, undefined);
});

test("a booking with impossible dates never reaches the database", async () => {
  const { firestore, store } = makeFirestore();
  const service = createReservationService({ db, restaurantId: RID, firestore });
  await assert.rejects(
    () => service.create(newBooking({ checkIn: "2026-10-05", checkOut: "2026-10-01" }), actor),
    error => error.code === "invalid"
  );
  assert.equal(store.size, 0, "nothing written at all");
});
