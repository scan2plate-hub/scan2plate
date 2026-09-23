/* =========================================================
   SHARED HOTEL STORE

   Section 47 names duplicate Firestore listeners as a thing not
   to reintroduce. A front desk shows the same rooms and bookings
   on five screens at once, so the invariant worth asserting is
   not "does data arrive" but "how many listeners did that cost".
   That cannot be checked against a live database, which is why
   Firestore is injected.

   The derived views are tested alongside, because a room grid
   that shows an occupied room as sellable is the same class of
   bug as an oversold night — it just arrives through the eyes
   instead of the database.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import { createHotelStore, roomGrid, todayLists, calendarGrid } from "../public/js/hotel-store.js";
import { ROOM_STATUS, RESERVATION_STATUS, nightsOf } from "../public/js/hotel-core.js";

/* ---------------------------------------------------------
   A Firestore stub that counts listeners
--------------------------------------------------------- */
function makeFirestore() {
  const listeners = new Map();   // path -> { onNext, onError }
  let opened = 0;
  let closed = 0;

  const firestore = {
    collection: (db, ...segments) => ({ path: segments.join("/") }),
    onSnapshot(ref, onNext, onError) {
      opened += 1;
      const entry = { onNext, onError };
      const bucket = listeners.get(ref.path) || new Set();
      bucket.add(entry);
      listeners.set(ref.path, bucket);
      return () => { closed += 1; bucket.delete(entry); };
    }
  };

  const push = (path, rows) => {
    (listeners.get(path) || new Set()).forEach(entry => entry.onNext({
      docs: rows.map(row => ({ id: row.id, data: () => ({ ...row }) }))
    }));
  };
  const fail = (path, error) => {
    (listeners.get(path) || new Set()).forEach(entry => entry.onError?.(error));
  };
  const openFor = path => (listeners.get(path) || new Set()).size;

  return { firestore, push, fail, openFor, stats: () => ({ opened, closed }) };
}

const RID = "RST006";
const ROOMS_PATH = `restaurants/${RID}/hotel_rooms`;
const newStore = (extra = {}) => {
  const stub = makeFirestore();
  const store = createHotelStore({ db: {}, restaurantId: RID, firestore: stub.firestore, ...extra });
  return { store, ...stub };
};

const settle = () => new Promise(resolve => setTimeout(resolve, 200));

/* =========================================================
   THE INVARIANT
========================================================= */

test("five screens on the same collection cost ONE listener", async () => {
  // The whole reason this module exists. A dashboard, a grid, an arrivals
  // list, a departures list and a calendar all want the same rooms.
  const { store, openFor, stats } = newStore();
  const seen = [0, 0, 0, 0, 0];
  const offs = seen.map((unused, index) => store.subscribe("hotel_rooms", () => { seen[index] += 1; }));

  assert.equal(openFor(ROOMS_PATH), 1, "one Firestore listener");
  assert.equal(stats().opened, 1);
  assert.equal(store.subscriberCount("hotel_rooms"), 5, "for five subscribers");
  offs.forEach(off => off());
});

test("the listener closes when the last screen lets go, and not before", () => {
  const { store, openFor, stats } = newStore();
  const offA = store.subscribe("hotel_rooms", () => {});
  const offB = store.subscribe("hotel_rooms", () => {});
  assert.equal(store.listenerCount(), 1);

  offA();
  assert.equal(openFor(ROOMS_PATH), 1, "one screen closing must not blind the other");
  assert.equal(store.listenerCount(), 1);

  offB();
  assert.equal(openFor(ROOMS_PATH), 0, "the last one out turns off the light");
  assert.equal(stats().closed, 1);
  assert.equal(store.listenerCount(), 0);
});

test("re-opening a screen after leaving starts exactly one fresh listener", () => {
  const { store, stats } = newStore();
  store.subscribe("hotel_rooms", () => {})();
  const off = store.subscribe("hotel_rooms", () => {});
  assert.equal(stats().opened, 2, "one per genuine open, never an accumulating pile");
  assert.equal(store.listenerCount(), 1);
  off();
});

test("two different collections are two listeners, not one shared by accident", () => {
  const { store } = newStore();
  const offRooms = store.subscribe("hotel_rooms", () => {});
  const offBookings = store.subscribe("hotel_reservations", () => {});
  assert.equal(store.listenerCount(), 2);
  offRooms(); offBookings();
});

/* =========================================================
   WHAT SUBSCRIBERS RECEIVE
========================================================= */

test("the first snapshot renders immediately, without waiting to coalesce", () => {
  // Coalescing the first one would put a visible delay on every initial load
  // to save a repaint that is not happening yet.
  const { store, push } = newStore();
  let rows = null;
  const off = store.subscribe("hotel_rooms", next => { rows = next; });
  push(ROOMS_PATH, [{ id: "101" }]);
  assert.deepEqual(rows, [{ id: "101" }], "no timer between the data arriving and the screen showing it");
  off();
});

test("a screen opened later renders from memory with no second read", () => {
  // This is what makes moving between front-desk tabs feel instant, and it
  // is why the page never needs a reload to show current data.
  const { store, push, stats } = newStore();
  const offFirst = store.subscribe("hotel_rooms", () => {});
  push(ROOMS_PATH, [{ id: "101" }, { id: "102" }]);

  let late = null;
  const offLate = store.subscribe("hotel_rooms", next => { late = next; });
  assert.equal(late.length, 2, "served from cache, synchronously");
  assert.equal(stats().opened, 1, "and without opening a second listener");
  offFirst(); offLate();
});

test("a burst of writes repaints once, not once per write", async () => {
  // A check-in writes the reservation and the room together. The grid should
  // repaint once.
  const { store, push } = newStore();
  let renders = 0;
  const off = store.subscribe("hotel_rooms", () => { renders += 1; });
  push(ROOMS_PATH, [{ id: "101" }]);          // first: immediate
  assert.equal(renders, 1);
  push(ROOMS_PATH, [{ id: "101", status: "OCCUPIED" }]);
  push(ROOMS_PATH, [{ id: "101", status: "OCCUPIED" }, { id: "102" }]);
  push(ROOMS_PATH, [{ id: "101", status: "OCCUPIED" }, { id: "102" }]);
  assert.equal(renders, 1, "still coalescing");
  await settle();
  assert.equal(renders, 2, "three writes, one extra repaint");
  off();
});

test("the newest data wins a coalesced burst", async () => {
  const { store, push } = newStore();
  let rows = null;
  const off = store.subscribe("hotel_rooms", next => { rows = next; });
  push(ROOMS_PATH, [{ id: "101" }]);
  push(ROOMS_PATH, [{ id: "101" }, { id: "102" }]);
  push(ROOMS_PATH, [{ id: "101" }, { id: "102" }, { id: "103" }]);
  await settle();
  assert.equal(rows.length, 3, "a coalesced render must not show a stale intermediate state");
  off();
});

test("one screen throwing does not freeze the others", async () => {
  // A render bug in the calendar cannot be allowed to stop the grid the
  // receptionist is checking someone in from.
  const errors = [];
  const { store, push } = newStore({ onError: error => errors.push(error) });
  let healthy = 0;
  const offBad = store.subscribe("hotel_rooms", () => { throw new Error("render bug"); });
  const offGood = store.subscribe("hotel_rooms", () => { healthy += 1; });
  push(ROOMS_PATH, [{ id: "101" }]);
  assert.equal(healthy, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /render bug/);
  offBad(); offGood();
});

test("a listener error is reported and does not throw into Firestore", () => {
  const errors = [];
  const { store, fail } = newStore({ onError: (error, context) => errors.push(context.phase) });
  const off = store.subscribe("hotel_rooms", () => {});
  fail(ROOMS_PATH, new Error("permission-denied"));
  assert.deepEqual(errors, ["listener"]);
  off();
});

test("destroy closes everything, so leaving the page leaks nothing", () => {
  const { store, stats } = newStore();
  store.subscribe("hotel_rooms", () => {});
  store.subscribe("hotel_reservations", () => {});
  store.destroy();
  assert.equal(stats().closed, 2);
  assert.equal(store.listenerCount(), 0);
});

test("current() reads the cache without subscribing to anything", () => {
  const { store, push } = newStore();
  assert.deepEqual(store.current("hotel_rooms"), [], "and never undefined");
  const off = store.subscribe("hotel_rooms", () => {});
  push(ROOMS_PATH, [{ id: "101" }]);
  assert.equal(store.current("hotel_rooms").length, 1);
  off();
});

/* =========================================================
   THE ROOM GRID
========================================================= */

const room = (id, patch = {}) => ({ id, roomNumber: id, status: ROOM_STATUS.AVAILABLE, ...patch });
const booking = (id, roomId, checkIn, checkOut, patch = {}) => ({
  id, bookingId: `BK${id}`, roomId, checkIn, checkOut, guestName: `Guest ${id}`,
  status: RESERVATION_STATUS.CONFIRMED, ...patch
});

test("a room with a guest in it shows OCCUPIED even if its own field disagrees", () => {
  // A stale status field must never present a room a guest is standing in as
  // sellable. The reservation is the stronger evidence, and the mismatch is
  // flagged rather than quietly papered over.
  const grid = roomGrid(
    [room("101", { status: ROOM_STATUS.AVAILABLE })],
    [booking("r1", "101", "2026-10-01", "2026-10-05", { status: RESERVATION_STATUS.CHECKED_IN })],
    "2026-10-02"
  );
  assert.equal(grid[0].status, ROOM_STATUS.OCCUPIED);
  assert.equal(grid[0].storedStatus, ROOM_STATUS.AVAILABLE, "the stored value stays visible for repair");
  assert.equal(grid[0].statusMismatch, true);
  assert.equal(grid[0].occupant.bookingId, "BKr1");
});

test("a room with someone arriving today reads RESERVED", () => {
  const grid = roomGrid(
    [room("101")],
    [booking("r1", "101", "2026-10-02", "2026-10-05")],
    "2026-10-02"
  );
  assert.equal(grid[0].status, ROOM_STATUS.RESERVED);
  assert.equal(grid[0].arriving.bookingId, "BKr1");
  assert.equal(grid[0].statusMismatch, false, "an expected arrival is not a fault");
});

test("an out-of-order room keeps its own status and is never sellable", () => {
  const grid = roomGrid([room("101", { status: ROOM_STATUS.OUT_OF_ORDER })], [], "2026-10-02");
  assert.equal(grid[0].status, ROOM_STATUS.OUT_OF_ORDER);
  assert.equal(grid[0].sellable, false);
});

test("a dirty room stays dirty on the grid even with an arrival due", () => {
  // The receptionist must see that housekeeping has not finished, precisely
  // because someone is arriving into it.
  const grid = roomGrid(
    [room("101", { status: ROOM_STATUS.DIRTY })],
    [booking("r1", "101", "2026-10-02", "2026-10-04")],
    "2026-10-02"
  );
  assert.equal(grid[0].status, ROOM_STATUS.DIRTY);
  assert.equal(grid[0].arriving.bookingId, "BKr1");
});

test("rooms sort the way a human reads room numbers", () => {
  const grid = roomGrid([room("205"), room("101"), room("1002"), room("21")], [], "2026-10-02");
  assert.deepEqual(grid.map(entry => entry.roomNumber), ["21", "101", "205", "1002"]);
});

test("a cancelled booking never colours a room", () => {
  const grid = roomGrid(
    [room("101")],
    [booking("r1", "101", "2026-10-02", "2026-10-05", { status: RESERVATION_STATUS.CANCELLED })],
    "2026-10-02"
  );
  assert.equal(grid[0].status, ROOM_STATUS.AVAILABLE);
  assert.equal(grid[0].arriving, null);
});

/* =========================================================
   TODAY'S LISTS
========================================================= */

test("arrivals, departures and in-house are each what the desk expects", () => {
  const reservations = [
    booking("a", "101", "2026-10-02", "2026-10-05"),                                              // arriving
    booking("b", "102", "2026-10-01", "2026-10-02", { status: RESERVATION_STATUS.CHECKED_IN }),   // departing
    booking("c", "103", "2026-09-30", "2026-10-06", { status: RESERVATION_STATUS.CHECKED_IN }),   // staying on
    booking("d", "104", "2026-10-02", "2026-10-03", { status: RESERVATION_STATUS.CANCELLED }),    // not an arrival
    booking("e", "105", "2026-10-02", "2026-10-04", { status: RESERVATION_STATUS.NO_SHOW })       // nor this
  ];
  const lists = todayLists(reservations, "2026-10-02");
  assert.deepEqual(lists.arrivals.map(r => r.id), ["a"]);
  assert.deepEqual(lists.departures.map(r => r.id), ["b"]);
  assert.deepEqual(lists.inHouse.map(r => r.id), ["b", "c"], "a guest leaving today is still in house until they go");
});

test("a guest who overstayed their checkout date is still in house", () => {
  // They have not left. Dropping them from the list is how a hotel loses
  // track of someone who is physically in a room.
  const lists = todayLists(
    [booking("a", "101", "2026-09-28", "2026-10-01", { status: RESERVATION_STATUS.CHECKED_IN })],
    "2026-10-03"
  );
  assert.equal(lists.inHouse.length, 1);
  assert.equal(lists.departures.length, 0, "and not counted as today's departure");
});

/* =========================================================
   THE CALENDAR
========================================================= */

test("a booking fills every night it holds and stops at checkout", () => {
  const dates = nightsOf("2026-10-01", "2026-10-06");
  const grid = calendarGrid([room("101")], [booking("r1", "101", "2026-10-02", "2026-10-04")], dates);
  assert.deepEqual(grid[0].cells.map(cell => Boolean(cell.reservation)), [false, true, true, false, false]);
  assert.deepEqual(grid[0].cells.map(cell => cell.isStart), [false, true, false, false, false],
    "only the first night starts the block, so it draws as one bar");
});

test("back-to-back bookings sit side by side with no gap and no overlap", () => {
  const dates = nightsOf("2026-10-01", "2026-10-05");
  const grid = calendarGrid([room("101")], [
    booking("r1", "101", "2026-10-01", "2026-10-03"),
    booking("r2", "101", "2026-10-03", "2026-10-05")
  ], dates);
  assert.deepEqual(grid[0].cells.map(cell => cell.reservation?.id), ["r1", "r1", "r2", "r2"]);
  assert.deepEqual(grid[0].cells.map(cell => cell.isStart), [true, false, true, false]);
});

test("cancelled and no-show bookings leave the calendar empty", () => {
  const dates = nightsOf("2026-10-01", "2026-10-04");
  const grid = calendarGrid([room("101")], [
    booking("r1", "101", "2026-10-01", "2026-10-04", { status: RESERVATION_STATUS.CANCELLED }),
    booking("r2", "101", "2026-10-01", "2026-10-04", { status: RESERVATION_STATUS.NO_SHOW })
  ], dates);
  assert.deepEqual(grid[0].cells.map(cell => cell.reservation), [null, null, null]);
});

test("the calendar marks which rooms cannot be sold at all", () => {
  const dates = nightsOf("2026-10-01", "2026-10-03");
  const grid = calendarGrid([room("101"), room("102", { status: ROOM_STATUS.OUT_OF_ORDER })], [], dates);
  assert.equal(grid[0].cells[0].sellable, true);
  assert.equal(grid[1].cells[0].sellable, false);
});
