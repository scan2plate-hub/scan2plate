/* =========================================================
   PROPERTY SETUP

   The gap that made every other hotel screen a demonstration: a
   hotel could not create a room.

   Two rules decide most of this file:

     18 — deleting a room must preserve historical reservations
     51 — plan limits come from one central place, and fail open

   plus one that is not numbered but matters as much: a room
   number must identify exactly one room, because the night-lock
   ids that prevent double booking are derived from it.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// plan-limits.js reaches Firestore, so it cannot be imported directly under
// Node. The repo already solved this for plan-limits.test.mjs with a loader
// hook that stubs the Firebase modules — reused here rather than reinvented,
// because the point of this test is that setup calls the SAME central limit
// check the rest of the product does (section 51), not a second opinion.
globalThis.location = { hostname: "scan2plate.com" };
register("./stubs/loader.mjs", pathToFileURL(`${import.meta.dirname}/`));

const { checkLimitFor } = await import("../public/js/plan-limits.js");

import {
  createSetupService, SetupError, roomIdFor, validateRoom, validateRoomType,
  validateRatePlan, normalizeRoomType, normalizeRatePlan, expandRoomNumbers,
  splitExistingRooms, ratePlanWarnings, describeRatePlan, defaultPriorityFor,
  setupReadiness, STARTER_ROOM_TYPES
} from "../public/js/hotel-setup.js";
import { roomNightKey } from "../public/js/hotel-inventory.js";
import { ROOM_STATUS, isSellableRoom } from "../public/js/hotel-core.js";

function makeFirestore() {
  const store = new Map();
  let autoId = 0;
  const firestore = {
    doc: (dbOrRef, ...segments) => (segments.length
      ? { path: segments.filter(Boolean).join("/") }
      : { path: `${dbOrRef.path}/auto${autoId += 1}` }),
    collection: (db, ...segments) => ({ path: segments.join("/") }),
    serverTimestamp: () => "TS",
    writeBatch() {
      const writes = [];
      return {
        set(ref, data) { writes.push({ path: ref.path, data }); },
        async commit() { writes.forEach(write => store.set(write.path, write.data)); }
      };
    },
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
const owner = { uid: "o1", name: "O Wner", role: "owner" };

const P = {
  room: id => `restaurants/${RID}/hotel_rooms/${id}`,
  type: id => `restaurants/${RID}/hotel_room_types/${id}`,
  plan: id => `restaurants/${RID}/hotel_rate_plans/${id}`
};
const audits = store => [...store.entries()].filter(([path]) => path.startsWith("hotelAuditLogs/")).map(([, data]) => data);
const fresh = () => {
  const { firestore, store } = makeFirestore();
  return { service: createSetupService({ db, restaurantId: RID, firestore }), store };
};

/* =========================================================
   ROOM IDS — the bit that must never go wrong
========================================================= */

test("a room id can never forge another room's night lock", () => {
  // hotel-inventory.js refuses a room id containing the lock separator,
  // because "1__2026-10-01" as an id would collide with room 1's night and
  // hand away someone else's room. This is the other half: such an id is
  // never created in the first place.
  assert.equal(roomIdFor("1__2026-10-01"), "R1-2026-10-01");
  assert.ok(!roomIdFor("1__2026-10-01").includes("__"));
  assert.ok(roomNightKey(roomIdFor("1__2026-10-01"), "2026-10-02"), "and the sanitised id still keys");
});

test("room ids are deterministic, so a retry does not duplicate a room", () => {
  assert.equal(roomIdFor("101"), roomIdFor("101"));
  assert.equal(roomIdFor(" 101 "), "R101");
  assert.equal(roomIdFor("A-12"), "RA-12");
  assert.equal(roomIdFor(""), "");
  assert.equal(roomIdFor("!!!"), "", "an id that would be empty is refused, not guessed");
});

test("two rooms cannot share a number", () => {
  // "Which 101 is the guest in?" must have an answer at the desk.
  const existing = [{ id: "R101", roomNumber: "101" }];
  const clash = validateRoom({ roomNumber: "101", roomTypeId: "deluxe" }, { existingRooms: existing });
  assert.equal(clash.ok, false);
  assert.match(clash.reason, /already exists/);
  // Case and padding do not make it a different room.
  assert.equal(validateRoom({ roomNumber: " 101 ", roomTypeId: "deluxe" }, { existingRooms: existing }).ok, false);
  // Editing the room itself is fine.
  assert.equal(validateRoom({ roomNumber: "101", roomTypeId: "deluxe" }, { existingRooms: existing, editingId: "R101" }).ok, true);
});

test("a room needs a number and a type before it can exist", () => {
  assert.match(validateRoom({ roomTypeId: "deluxe" }).reason, /room number/i);
  assert.match(validateRoom({ roomNumber: "101" }).reason, /room type/i);
});

/* =========================================================
   BULK CREATION
========================================================= */

test("a range expands the way a front desk describes its property", () => {
  const rooms = expandRoomNumbers({ from: 101, to: 105, floor: "1" });
  assert.deepEqual(rooms.map(room => room.roomNumber), ["101", "102", "103", "104", "105"]);
  assert.equal(rooms[0].floor, "1");
});

test("leading zeros are kept, because 007 and 7 are different doors", () => {
  assert.deepEqual(expandRoomNumbers({ from: "007", to: "010" }).map(room => room.roomNumber),
    ["007", "008", "009", "010"]);
});

test("a prefix makes wing and block numbering work", () => {
  assert.deepEqual(expandRoomNumbers({ from: 1, to: 3, prefix: "A-" }).map(room => room.roomNumber),
    ["A-1", "A-2", "A-3"]);
});

test("an absurd or backwards range produces nothing rather than a disaster", () => {
  assert.deepEqual(expandRoomNumbers({ from: 1, to: 100000 }), [], "that is a typo, not a hotel");
  assert.deepEqual(expandRoomNumbers({ from: 110, to: 101 }), []);
  assert.deepEqual(expandRoomNumbers({ from: "abc", to: "def" }), []);
});

test("a retried bulk create adds only the rooms that are missing", () => {
  const planned = expandRoomNumbers({ from: 101, to: 105 });
  const existing = [{ roomNumber: "101" }, { roomNumber: "103" }];
  const { create, skip } = splitExistingRooms(planned, existing);
  assert.deepEqual(create.map(room => room.roomNumber), ["102", "104", "105"]);
  assert.equal(skip.length, 2);
});

test("a range containing its own duplicates only creates each once", () => {
  const { create } = splitExistingRooms(
    [{ roomNumber: "101" }, { roomNumber: "101" }, { roomNumber: "102" }], []);
  assert.deepEqual(create.map(room => room.roomNumber), ["101", "102"]);
});

test("creating a floor of rooms writes them all and logs the batch", async () => {
  const { service, store } = fresh();
  const result = await service.createRooms({
    planned: expandRoomNumbers({ from: 101, to: 110, floor: "1" }),
    defaults: { roomTypeId: "deluxe" },
    actor: owner
  });
  assert.equal(result.created, 10);
  assert.equal(store.get(P.room("R101")).roomNumber, "101");
  assert.equal(store.get(P.room("R110")).floor, "1");
  assert.equal(store.get(P.room("R101")).status, ROOM_STATUS.AVAILABLE);
  const entry = audits(store).find(row => row.action === "rooms_created");
  assert.equal(entry.detail.count, 10);
  assert.equal(entry.detail.from, "101");
});

test("re-running the same bulk create is harmless", async () => {
  const { service, store } = fresh();
  const planned = expandRoomNumbers({ from: 101, to: 103 });
  await service.createRooms({ planned, defaults: { roomTypeId: "deluxe" }, actor: owner });
  const existing = [101, 102, 103].map(number => ({ id: `R${number}`, roomNumber: String(number) }));
  const again = await service.createRooms({ planned, existingRooms: existing, defaults: { roomTypeId: "deluxe" }, actor: owner });
  assert.equal(again.created, 0);
  assert.equal(again.skipped, 3);
  assert.equal([...store.keys()].filter(path => path.includes("hotel_rooms")).length, 3);
});

/* =========================================================
   RULE 51 — PLAN LIMITS
========================================================= */

test("RULE 51: the plan's room limit is enforced through the central check", async () => {
  const { service } = fresh();
  const plan = { name: "Hotel Starter", limits: { maxRooms: 10 } };
  const limitCheck = checkLimitFor("maxRooms", 8, 5, plan);
  assert.equal(limitCheck.allowed, false);
  assert.match(limitCheck.message, /Hotel Starter/);
  assert.match(limitCheck.message, /2 more/);

  await assert.rejects(
    () => service.createRooms({
      planned: expandRoomNumbers({ from: 201, to: 205 }),
      defaults: { roomTypeId: "deluxe" }, actor: owner, limitCheck
    }),
    error => {
      assert.equal(error.code, "plan_limit");
      assert.match(error.message, /Upgrade|more/);
      return true;
    }
  );
});

test("a business with no plan is never blocked from adding rooms", async () => {
  // The rule that matters most in plan-limits.js: a billing lookup must not
  // stop a hotel adding a room mid-shift.
  const { service, store } = fresh();
  const limitCheck = checkLimitFor("maxRooms", 500, 10, null);
  assert.equal(limitCheck.allowed, true);
  await service.createRooms({
    planned: expandRoomNumbers({ from: 301, to: 302 }),
    defaults: { roomTypeId: "deluxe" }, actor: owner, limitCheck
  });
  assert.ok(store.has(P.room("R301")));
});

/* =========================================================
   RULE 18 — A ROOM IS RETIRED, NEVER DELETED
========================================================= */

test("RULE 18: retiring a room keeps it resolvable for historical stays", async () => {
  const { service, store } = fresh();
  await service.createRooms({ planned: [{ roomNumber: "101" }], defaults: { roomTypeId: "deluxe" }, actor: owner });
  await service.retireRoom({ roomId: "R101", actor: owner, reason: "Converted to storage" });

  const room = store.get(P.room("R101"));
  assert.ok(room, "the document still exists, so last year's invoices still resolve");
  assert.equal(room.active, false);
  assert.equal(room.retiredReason, "Converted to storage");
  assert.equal(isSellableRoom(room), false, "and it has left sellable inventory");
});

test("a room with bookings still to come cannot be retired out from under them", async () => {
  const { service } = fresh();
  await service.createRooms({ planned: [{ roomNumber: "101" }], defaults: { roomTypeId: "deluxe" }, actor: owner });
  await assert.rejects(
    () => service.retireRoom({
      roomId: "R101", actor: owner,
      upcomingReservations: [{ id: "BK1", roomId: "R101" }, { id: "BK2", roomId: "R101" }]
    }),
    error => {
      assert.equal(error.code, "in_use");
      assert.match(error.message, /2 bookings/);
      return true;
    }
  );
});

test("retiring twice is harmless, and a retired room can come back", async () => {
  const { service, store } = fresh();
  await service.createRooms({ planned: [{ roomNumber: "101" }], defaults: { roomTypeId: "deluxe" }, actor: owner });
  await service.retireRoom({ roomId: "R101", actor: owner });
  const again = await service.retireRoom({ roomId: "R101", actor: owner });
  assert.equal(again.unchanged, true);
  await service.restoreRoom({ roomId: "R101", actor: owner });
  assert.equal(store.get(P.room("R101")).active, true);
});

test("editing a room does not reach into the housekeeping cycle", async () => {
  // A room's status belongs to housekeeping and maintenance. Setup edits its
  // description; it must not quietly mark a dirty room available.
  const { service, store } = fresh();
  await service.createRooms({ planned: [{ roomNumber: "101" }], defaults: { roomTypeId: "deluxe" }, actor: owner });
  store.set(P.room("R101"), { ...store.get(P.room("R101")), status: ROOM_STATUS.DIRTY });

  await service.saveRoom({
    roomId: "R101",
    input: { roomNumber: "101", roomTypeId: "suite", description: "Corner room", status: ROOM_STATUS.AVAILABLE },
    actor: owner
  });
  assert.equal(store.get(P.room("R101")).status, ROOM_STATUS.DIRTY, "still dirty");
  assert.equal(store.get(P.room("R101")).roomTypeId, "suite", "but the edit applied");
});

/* =========================================================
   ROOM TYPES
========================================================= */

test("a room type must be named and priced before it can be sold", () => {
  assert.match(validateRoomType({ baseRate: 2000 }).reason, /name/i);
  assert.match(validateRoomType({ name: "Deluxe" }).reason, /base rate/i);
  assert.equal(validateRoomType({ name: "Deluxe", baseRate: 2000 }).ok, true);
});

test("the rate cannot include more adults than the room holds", () => {
  const check = validateRoomType({ name: "Twin", baseRate: 2000, maxAdults: 2, includedAdults: 4 });
  assert.equal(check.ok, false);
  assert.match(check.reason, /more adults than the room holds/);
});

test("included occupancy defaults to the room's capacity, not to one", () => {
  // A room quoted for two must not secretly charge extra for the second guest.
  const type = normalizeRoomType({ name: "Double", baseRate: 2000, maxAdults: 2 });
  assert.equal(type.includedAdults, 2);
  assert.equal(type.includedChildren, 0);
});

test("the starter room types are all usable as they stand", () => {
  STARTER_ROOM_TYPES.forEach(type => {
    const normalized = normalizeRoomType(type);
    assert.ok(normalized.name, `${type.id} needs a name`);
    assert.ok(normalized.maxAdults >= 1);
    assert.ok(normalized.includedAdults <= normalized.maxAdults, `${type.id} includes more than it holds`);
  });
});

test("a room type is saved under a readable id derived from its name", async () => {
  const { service, store } = fresh();
  const result = await service.saveRoomType({ input: { name: "Super Deluxe", baseRate: 3500 }, actor: owner });
  assert.equal(result.typeId, "super_deluxe");
  assert.equal(store.get(P.type("super_deluxe")).baseRate, 3500);
  assert.equal(result.created, true);
});

/* =========================================================
   RATE PLANS  (section 13)
========================================================= */

test("a rate rule's default priority matches how a hotel already thinks", () => {
  // Festival beats season beats weekend beats standard; a negotiated
  // corporate price sits above all of them.
  assert.ok(defaultPriorityFor("festival") > defaultPriorityFor("seasonal"));
  assert.ok(defaultPriorityFor("seasonal") > defaultPriorityFor("weekend"));
  assert.ok(defaultPriorityFor("weekend") > defaultPriorityFor("standard"));
  assert.ok(defaultPriorityFor("corporate") > defaultPriorityFor("festival"));
});

test("a rate needs a name, so the desk can explain the price", () => {
  assert.match(validateRatePlan({ amount: 3000 }).reason, /name/i);
  assert.match(validateRatePlan({ name: "Diwali", amount: 0 }).reason, /above zero/i);
});

test("a backwards or unparseable date window is refused", () => {
  assert.match(validateRatePlan({
    name: "Season", amount: 2800, validFrom: "2026-10-31", validTo: "2026-10-01"
  }).reason, /before the start/);
  assert.match(validateRatePlan({ name: "Season", amount: 2800, validFrom: "31-10-2026" }).reason, /valid start date/);
});

test("overlapping rules at equal priority are SHOWN, not silently resolved", () => {
  // Refusing them would block legitimate setups. Silently picking one is the
  // only unacceptable option, because the desk cannot then explain the price.
  const warnings = ratePlanWarnings([
    { id: "a", name: "October", roomTypeId: "deluxe", priority: 1, validFrom: "2026-10-01", validTo: "2026-10-31" },
    { id: "b", name: "Autumn", roomTypeId: "deluxe", priority: 1, validFrom: "2026-10-15", validTo: "2026-11-15" },
    { id: "c", name: "Diwali", roomTypeId: "deluxe", priority: 5, validFrom: "2026-10-20", validTo: "2026-10-25" }
  ]);
  assert.equal(warnings.length, 1, "only the equal-priority pair is a problem");
  assert.match(warnings[0].message, /October/);
  assert.match(warnings[0].message, /Autumn/);
  assert.match(warnings[0].message, /Raise one priority/);
});

test("a rate rule describes when it applies in words", () => {
  assert.equal(describeRatePlan({}), "always");
  assert.match(describeRatePlan({ validFrom: "2026-10-01", validTo: "2026-10-31" }), /2026-10-01 to 2026-10-31/);
  assert.match(describeRatePlan({ validFrom: "2026-10-01" }), /open-ended/);
  assert.match(describeRatePlan({ days: ["fri", "sat"] }), /fri, sat/);
});

test("a rate rule can be deleted, because it prices the future not the past", async () => {
  const { service, store } = fresh();
  const saved = await service.saveRatePlan({ input: { name: "Diwali", amount: 3500, kind: "festival" }, actor: owner });
  assert.equal(store.get(P.plan(saved.planId)).priority, defaultPriorityFor("festival"));
  await service.deleteRatePlan({ planId: saved.planId, actor: owner });
  assert.equal(store.has(P.plan(saved.planId)), false);
  const entry = audits(store).find(row => row.action === "rate_plan_deleted");
  assert.equal(entry.detail.name, "Diwali", "what was removed stays in the log");
});

/* =========================================================
   READINESS  (section 50)
========================================================= */

test("a brand new property is told exactly what is missing", () => {
  const readiness = setupReadiness({});
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.steps.map(step => step.done), [false, false, false, false]);
  assert.equal(readiness.steps[0].label, "Create at least one room type");
});

test("a room type with no price does not count as done", () => {
  const readiness = setupReadiness({
    roomTypes: [{ id: "deluxe", name: "Deluxe", baseRate: 0 }],
    rooms: [{ id: "R101", roomTypeId: "deluxe", status: ROOM_STATUS.AVAILABLE }]
  });
  assert.equal(readiness.steps.find(step => step.id === "rates").done, false);
  assert.equal(readiness.roomsWithoutPrice.length, 1);
  assert.equal(readiness.ready, false);
});

test("a room with its own rate is priced even if its type is not", () => {
  const readiness = setupReadiness({
    roomTypes: [{ id: "deluxe", name: "Deluxe", baseRate: 2500 }],
    rooms: [
      { id: "R101", roomTypeId: "deluxe", status: ROOM_STATUS.AVAILABLE },
      { id: "R102", roomTypeId: "other", baseRate: 4000, status: ROOM_STATUS.AVAILABLE }
    ]
  });
  assert.equal(readiness.roomsWithoutPrice.length, 0);
  assert.equal(readiness.ready, true);
});

test("a retired or out-of-order room does not hold setup back", () => {
  // It is not sellable, so it is not something that needs a price.
  const readiness = setupReadiness({
    roomTypes: [{ id: "deluxe", name: "Deluxe", baseRate: 2500 }],
    rooms: [
      { id: "R101", roomTypeId: "deluxe", status: ROOM_STATUS.AVAILABLE },
      { id: "R102", roomTypeId: "", active: false },
      { id: "R103", roomTypeId: "", status: ROOM_STATUS.OUT_OF_ORDER }
    ]
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.counts.rooms, 3);
  assert.equal(readiness.counts.sellable, 1);
});

test("a fully set up property reports ready", () => {
  const readiness = setupReadiness({
    roomTypes: [{ id: "deluxe", name: "Deluxe", baseRate: 2500 }],
    rooms: [{ id: "R101", roomTypeId: "deluxe", status: ROOM_STATUS.AVAILABLE }],
    ratePlans: [{ id: "r1", name: "Weekend" }]
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.counts.ratePlans, 1);
});
