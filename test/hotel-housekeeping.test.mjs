/* =========================================================
   HOUSEKEEPING AND MAINTENANCE

   Checkout leaves a room DIRTY and stops. This is the only path
   back to sellable, so the tests here are about who may move a
   room along it and what must be impossible:

     rule 5 — housekeeping cleans
     rule 6 — a supervisor inspects, and never the person who
              cleaned it
     rule 8 — an out-of-order room does not re-enter inventory by
              a side effect

   Section 15 adds the other way a room leaves inventory: a
   critical maintenance ticket, which must close the room at once
   and must not quietly reopen it as sellable when resolved.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createHousekeepingService, HousekeepingError,
  TASK_STATUS, TICKET_STATUS, canAdvanceTask, roomStatusForTask,
  taskQueueFor, housekeepingSummary, ticketBlocksRoom, blockingTickets,
  normalizeTicketPriority, normalizeTaskStatus
} from "../public/js/hotel-housekeeping.js";
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
const cleaner = { uid: "c1", name: "H Keeper", role: "housekeeping" };
const supervisor = { uid: "s1", name: "S Visor", role: "supervisor" };
const manager = { uid: "m1", name: "M Anager", role: "manager" };
const engineer = { uid: "e1", name: "E Ngineer", role: "maintenance" };
const receptionist = { uid: "r1", name: "R Desk", role: "receptionist" };

const P = {
  task: id => `restaurants/${RID}/hotel_housekeeping/${id}`,
  ticket: id => `restaurants/${RID}/hotel_maintenance/${id}`,
  room: id => `restaurants/${RID}/hotel_rooms/${id}`
};
const audits = store => [...store.entries()].filter(([path]) => path.startsWith("hotelAuditLogs/")).map(([, data]) => data);

function fresh() {
  const { firestore, store } = makeFirestore();
  return { service: createHousekeepingService({ db, restaurantId: RID, firestore }), store };
}

async function dirtyRoom(service, taskId = "T1", roomId = "101") {
  await service.createTask({ taskId, roomId, roomNumber: roomId, actor: receptionist, businessDate: "2026-10-02" });
  return taskId;
}

/* =========================================================
   THE CYCLE
========================================================= */

test("checkout's task puts the room in DIRTY and tells housekeeping", async () => {
  const { service, store } = fresh();
  await dirtyRoom(service);
  assert.equal(store.get(P.room("101")).status, ROOM_STATUS.DIRTY);
  assert.equal(store.get(P.task("T1")).status, TASK_STATUS.DIRTY);
});

test("the same task is never raised twice by a retry", async () => {
  const { service, store } = fresh();
  await dirtyRoom(service);
  const again = await service.createTask({ taskId: "T1", roomId: "101", actor: receptionist });
  assert.equal(again.duplicate, true);
  assert.equal(audits(store).filter(entry => entry.action === "housekeeping_task_created").length, 1);
});

test("the full cycle reaches AVAILABLE, and only through every step", async () => {
  const { service, store } = fresh();
  await dirtyRoom(service);

  await service.assignTask({ taskId: "T1", staffId: "c1", staffName: "H Keeper", actor: supervisor });
  assert.equal(store.get(P.task("T1")).assignedTo, "c1");

  await service.advance({ taskId: "T1", actor: cleaner });                    // ASSIGNED -> CLEANING
  assert.equal(store.get(P.task("T1")).status, TASK_STATUS.CLEANING);
  assert.equal(store.get(P.room("101")).status, ROOM_STATUS.CLEANING);

  await service.advance({ taskId: "T1", actor: cleaner });                    // CLEANING -> CLEANED
  assert.equal(store.get(P.task("T1")).cleanedBy, "H Keeper");

  await service.advance({ taskId: "T1", actor: supervisor });                 // CLEANED -> INSPECTED
  assert.equal(store.get(P.room("101")).status, ROOM_STATUS.INSPECTED);
  assert.equal(store.get(P.task("T1")).inspectedBy, "S Visor");

  await service.advance({ taskId: "T1", actor: supervisor });                 // INSPECTED -> DONE
  assert.equal(store.get(P.task("T1")).status, TASK_STATUS.DONE);
  assert.equal(store.get(P.room("101")).status, ROOM_STATUS.AVAILABLE);
  assert.equal(isSellableRoom(store.get(P.room("101"))), true);
});

test("RULE 6: the person who cleaned it cannot sign it off", async () => {
  const { service, store } = fresh();
  await dirtyRoom(service);
  await service.assignTask({ taskId: "T1", staffId: "c1", actor: supervisor });
  await service.advance({ taskId: "T1", actor: cleaner });
  await service.advance({ taskId: "T1", actor: cleaner });                    // now CLEANED

  await assert.rejects(
    () => service.advance({ taskId: "T1", actor: cleaner }),
    error => {
      assert.equal(error.code, "forbidden");
      assert.match(error.message, /supervisor/i);
      return true;
    }
  );
  assert.equal(store.get(P.room("101")).status, ROOM_STATUS.CLEANING, "and the room did not move");
});

test("a receptionist cannot clean a room into existence", async () => {
  // The whole point of rule 5. Reception wanting the room does not clean it.
  const { service } = fresh();
  await dirtyRoom(service);
  await assert.rejects(
    () => service.advance({ taskId: "T1", actor: receptionist }),
    error => error.code === "forbidden"
  );
});

test("a stale board cannot skip a step", async () => {
  // The button showing when the page last rendered is not authority for
  // where the room is now.
  const { service } = fresh();
  await dirtyRoom(service);
  await assert.rejects(
    () => service.advance({ taskId: "T1", actor: supervisor, to: TASK_STATUS.INSPECTED }),
    error => {
      assert.equal(error.code, "stale");
      assert.match(error.message, /refresh/i);
      return true;
    }
  );
});

test("a finished task cannot be advanced again", async () => {
  const { service } = fresh();
  await dirtyRoom(service);
  await service.assignTask({ taskId: "T1", staffId: "c1", actor: supervisor });
  await service.advance({ taskId: "T1", actor: cleaner });
  await service.advance({ taskId: "T1", actor: cleaner });
  await service.advance({ taskId: "T1", actor: supervisor });
  await service.advance({ taskId: "T1", actor: supervisor });
  await assert.rejects(() => service.advance({ taskId: "T1", actor: supervisor }), error => error.code === "forbidden");
});

test("RULE 8: a room taken out of order mid-clean is not dragged back into service", async () => {
  // A cleaner finishing their round must not override an engineer who closed
  // the room while they were in it. The task advances; the room does not.
  const { service, store } = fresh();
  await dirtyRoom(service);
  await service.assignTask({ taskId: "T1", staffId: "c1", actor: supervisor });
  await service.advance({ taskId: "T1", actor: cleaner });                    // CLEANING
  store.set(P.room("101"), { status: ROOM_STATUS.OUT_OF_ORDER });             // engineer closes it

  const result = await service.advance({ taskId: "T1", actor: cleaner });     // CLEANED
  assert.equal(result.roomHeld, true, "the service reports that the room did not follow");
  assert.equal(store.get(P.room("101")).status, ROOM_STATUS.OUT_OF_ORDER);
  assert.equal(store.get(P.task("T1")).status, TASK_STATUS.CLEANED, "the cleaning still happened and is recorded");
});

test("every step is logged with who did it and where the room went", async () => {
  const { service, store } = fresh();
  await dirtyRoom(service);
  await service.assignTask({ taskId: "T1", staffId: "c1", actor: supervisor });
  await service.advance({ taskId: "T1", actor: cleaner });
  const entry = audits(store).filter(row => row.action === "housekeeping_task_advanced").pop();
  assert.equal(entry.role, "housekeeping");
  assert.equal(entry.detail.from, TASK_STATUS.ASSIGNED);
  assert.equal(entry.detail.to, TASK_STATUS.CLEANING);
  assert.equal(entry.detail.roomStatusApplied, ROOM_STATUS.CLEANING);
});

/* =========================================================
   THE FLOW, IN THE ABSTRACT
========================================================= */

test("each task state implies exactly one room status", () => {
  assert.equal(roomStatusForTask("DIRTY"), ROOM_STATUS.DIRTY);
  assert.equal(roomStatusForTask("CLEANING"), ROOM_STATUS.CLEANING);
  assert.equal(roomStatusForTask("INSPECTED"), ROOM_STATUS.INSPECTED);
  assert.equal(roomStatusForTask("DONE"), ROOM_STATUS.AVAILABLE);
  assert.equal(roomStatusForTask("nonsense"), ROOM_STATUS.DIRTY, "an unknown state is treated as needing work");
});

test("canAdvanceTask names who can, not merely that you cannot", () => {
  assert.equal(canAdvanceTask("CLEANED", "housekeeping").allowed, false);
  assert.match(canAdvanceTask("CLEANED", "housekeeping").reason, /supervisor/i);
  assert.equal(canAdvanceTask("CLEANED", "supervisor").allowed, true);
  assert.equal(canAdvanceTask("DIRTY", "housekeeping").next, "ASSIGNED");
  assert.equal(canAdvanceTask("DONE", "manager").allowed, false);
});

test("an unknown status never becomes a free pass", () => {
  assert.equal(normalizeTaskStatus("banana"), TASK_STATUS.DIRTY);
  assert.equal(canAdvanceTask("banana", "receptionist").allowed, false);
});

/* =========================================================
   THE CLEANER'S QUEUE  (section 54 — housekeeping is on a phone)
========================================================= */

const task = (id, patch = {}) => ({ id, roomId: id, roomNumber: id, status: TASK_STATUS.DIRTY, ...patch });

test("a cleaner sees their own work and anything unclaimed, not everyone else's", () => {
  const tasks = [
    task("101", { assignedTo: "c1" }),
    task("102", { assignedTo: "c2" }),
    task("103"),
    task("104", { assignedTo: "c1", status: TASK_STATUS.DONE })
  ];
  const queue = taskQueueFor(tasks, { staffId: "c1", role: "housekeeping" });
  assert.deepEqual(queue.map(entry => entry.id), ["101", "103"]);
});

test("a supervisor sees everything, because inspection is their job", () => {
  const tasks = [task("101", { assignedTo: "c1" }), task("102", { assignedTo: "c2" })];
  assert.equal(taskQueueFor(tasks, { staffId: "s1", role: "supervisor" }).length, 2);
});

test("work in progress sorts above work not started", () => {
  const tasks = [
    task("105", { status: TASK_STATUS.DIRTY }),
    task("102", { status: TASK_STATUS.CLEANING }),
    task("103", { status: TASK_STATUS.ASSIGNED })
  ];
  const queue = taskQueueFor(tasks, { role: "supervisor" });
  assert.deepEqual(queue.map(entry => entry.id), ["102", "103", "105"]);
});

test("rooms within a status sort the way a human reads room numbers", () => {
  const tasks = [task("205"), task("101"), task("1002"), task("21")];
  assert.deepEqual(taskQueueFor(tasks, { role: "supervisor" }).map(entry => entry.id), ["21", "101", "205", "1002"]);
});

test("the summary says how much cleaning is actually left", () => {
  const summary = housekeepingSummary([
    task("101", { status: TASK_STATUS.DIRTY }),
    task("102", { status: TASK_STATUS.CLEANING }),
    task("103", { status: TASK_STATUS.CLEANED }),
    task("104", { status: TASK_STATUS.DONE })
  ]);
  assert.equal(summary.outstanding, 3);
  assert.equal(summary.awaitingInspection, 1, "the supervisor's own queue is called out");
  assert.equal(summary.finished, 1);
});

/* =========================================================
   MAINTENANCE  (section 15)
========================================================= */

test("only a CRITICAL ticket takes a room out of inventory", async () => {
  // A blown bulb is a ticket, not a reason to stop selling the room. Closing
  // a room for every ticket is how a property stops raising them.
  const { service, store } = fresh();
  store.set(P.room("101"), { status: ROOM_STATUS.AVAILABLE });
  store.set(P.room("102"), { status: ROOM_STATUS.AVAILABLE });

  await service.reportIssue({ ticketId: "M1", roomId: "101", category: "tv", priority: "normal", actor: cleaner });
  assert.equal(store.get(P.room("101")).status, ROOM_STATUS.AVAILABLE);

  const critical = await service.reportIssue({ ticketId: "M2", roomId: "102", category: "water_supply", priority: "critical", actor: cleaner });
  assert.equal(critical.roomClosed, true);
  assert.equal(store.get(P.room("102")).status, ROOM_STATUS.OUT_OF_ORDER);
  assert.equal(isSellableRoom(store.get(P.room("102"))), false);
});

test("a critical ticket does NOT empty a room with a guest in it", async () => {
  // Moving a guest is a front-desk decision with a folio attached, not a
  // side effect of someone filing a ticket.
  const { service, store } = fresh();
  store.set(P.room("101"), { status: ROOM_STATUS.OCCUPIED });
  const result = await service.reportIssue({ ticketId: "M1", roomId: "101", priority: "critical", category: "ac", actor: cleaner });
  assert.equal(result.roomClosed, false);
  assert.equal(store.get(P.room("101")).status, ROOM_STATUS.OCCUPIED);
});

test("resolving a critical ticket returns the room to DIRTY, never straight to sellable", async () => {
  // A room whose plumbing has been opened needs cleaning before a guest
  // sees it. It goes round the cycle like any other.
  const { service, store } = fresh();
  store.set(P.room("101"), { status: ROOM_STATUS.AVAILABLE });
  await service.reportIssue({ ticketId: "M1", roomId: "101", priority: "critical", category: "plumbing", actor: cleaner });
  const result = await service.resolveIssue({ ticketId: "M1", actor: engineer, resolution: "Replaced valve", cost: 1200 });

  assert.equal(result.roomReleased, true);
  assert.equal(store.get(P.room("101")).status, ROOM_STATUS.DIRTY);
  assert.equal(isSellableRoom(store.get(P.room("101"))), true, "sellable for a future date, once cleaned");
  assert.equal(store.get(P.ticket("M1")).cost, 1200);
});

test("a room with a SECOND critical ticket open stays out of order", async () => {
  const { service, store } = fresh();
  store.set(P.room("101"), { status: ROOM_STATUS.AVAILABLE });
  await service.reportIssue({ ticketId: "M1", roomId: "101", priority: "critical", category: "plumbing", actor: cleaner });
  await service.reportIssue({ ticketId: "M2", roomId: "101", priority: "critical", category: "electrical", actor: cleaner });

  const result = await service.resolveIssue({
    ticketId: "M1", actor: engineer,
    openTickets: [
      { id: "M1", roomId: "101", priority: "critical", status: TICKET_STATUS.OPEN },
      { id: "M2", roomId: "101", priority: "critical", status: TICKET_STATUS.OPEN }
    ]
  });
  assert.equal(result.roomReleased, false);
  assert.equal(result.stillBlocked, 1);
  assert.equal(store.get(P.room("101")).status, ROOM_STATUS.OUT_OF_ORDER);
});

test("housekeeping can report a fault but cannot close the ticket", async () => {
  // A cleaner finds the fault; they do not certify the repair.
  const { service } = fresh();
  await service.reportIssue({ ticketId: "M1", roomId: "101", priority: "high", category: "ac", actor: cleaner });
  await assert.rejects(
    () => service.resolveIssue({ ticketId: "M1", actor: cleaner }),
    error => error.code === "forbidden"
  );
  await service.resolveIssue({ ticketId: "M1", actor: engineer });
});

test("resolving twice is harmless and does not re-open a room", async () => {
  const { service, store } = fresh();
  store.set(P.room("101"), { status: ROOM_STATUS.AVAILABLE });
  await service.reportIssue({ ticketId: "M1", roomId: "101", priority: "critical", category: "lift", actor: cleaner });
  await service.resolveIssue({ ticketId: "M1", actor: engineer });
  store.set(P.room("101"), { status: ROOM_STATUS.OCCUPIED });        // resold and occupied since
  const again = await service.resolveIssue({ ticketId: "M1", actor: engineer });
  assert.equal(again.unchanged, true);
  assert.equal(store.get(P.room("101")).status, ROOM_STATUS.OCCUPIED, "a repeated resolve must not disturb the room");
});

test("ticket priority and blocking are decided by the same rule everywhere", () => {
  assert.equal(normalizeTicketPriority("CRITICAL"), "critical");
  assert.equal(normalizeTicketPriority("urgent"), "normal", "an unrecognised priority is not treated as critical");
  assert.equal(ticketBlocksRoom({ priority: "critical", status: "OPEN" }), true);
  assert.equal(ticketBlocksRoom({ priority: "critical", status: "RESOLVED" }), false);
  assert.equal(ticketBlocksRoom({ priority: "high", status: "OPEN" }), false);
  assert.equal(blockingTickets([
    { roomId: "101", priority: "critical", status: "OPEN" },
    { roomId: "102", priority: "critical", status: "OPEN" }
  ], "101").length, 1);
});
