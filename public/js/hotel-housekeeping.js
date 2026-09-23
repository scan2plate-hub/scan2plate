/* =========================================================
   HOUSEKEEPING AND MAINTENANCE

   The cycle that decides whether a room may be sold again:

       DIRTY → ASSIGNED → CLEANING → CLEANED → INSPECTED → AVAILABLE

   Checkout puts a room into DIRTY and stops. Nothing else in the
   product may return it to AVAILABLE, because a room is sellable
   when someone has physically cleaned and checked it, not when a
   receptionist needs it to be.

   THE ROLE GATES ARE THE POINT (rules 5 and 6). Housekeeping
   cleans; a supervisor inspects. Letting one person do both
   removes the only check on the process, which is why
   canChangeRoomStatus in hotel-core refuses it and why this
   service asks that function rather than deciding for itself.
   The room status and the task move in ONE transaction, so a
   room can never be clean with an open cleaning task against it,
   or dirty with nobody told.

   MAINTENANCE IS THE OTHER WAY A ROOM LEAVES INVENTORY
   (section 15). A critical ticket takes the room OUT_OF_ORDER
   automatically. Resolving it deliberately does NOT hand the room
   straight back as sellable — a room that has had its plumbing
   opened needs cleaning before a guest sees it, so it returns to
   DIRTY and goes round the cycle like any other.
========================================================= */
import {
  ROOM_STATUS, canChangeRoomStatus, normalizeRoomStatus, normalizeHotelRole, asStayDate
} from "./hotel-core.js?v=s2p-20260922d";

export const HOUSEKEEPING = "hotel_housekeeping";
export const MAINTENANCE = "hotel_maintenance";
export const ROOMS = "hotel_rooms";
export const AUDIT_LOGS = "hotelAuditLogs";

/* ---------------------------------------------------------
   HOUSEKEEPING TASKS
--------------------------------------------------------- */

export const TASK_STATUS = {
  DIRTY: "DIRTY",
  ASSIGNED: "ASSIGNED",
  CLEANING: "CLEANING",
  CLEANED: "CLEANED",
  INSPECTED: "INSPECTED",
  DONE: "DONE"
};

export const TASK_TYPES = [
  { id: "departure_clean", label: "Departure clean" },
  { id: "stayover_clean", label: "Stayover clean" },
  { id: "deep_clean", label: "Deep cleaning" },
  { id: "bathroom_clean", label: "Bathroom cleaning" },
  { id: "linen_change", label: "Linen change" },
  { id: "towel_change", label: "Towel replacement" },
  { id: "amenities", label: "Amenities refill" },
  { id: "minibar_check", label: "Minibar check" },
  { id: "inspection", label: "Inspection" }
];

/**
 * Each step, the room status it drives, and who may take it.
 *
 * The room status is derived from the task rather than set alongside it, so
 * the two cannot disagree. A task that says CLEANING with a room that says
 * AVAILABLE is not a state this service can produce.
 */
const TASK_FLOW = {
  DIRTY:     { next: "ASSIGNED",  roomStatus: ROOM_STATUS.DIRTY,     roles: ["housekeeping", "supervisor", "manager"] },
  ASSIGNED:  { next: "CLEANING",  roomStatus: ROOM_STATUS.DIRTY,     roles: ["housekeeping", "supervisor", "manager"] },
  CLEANING:  { next: "CLEANED",   roomStatus: ROOM_STATUS.CLEANING,  roles: ["housekeeping", "supervisor", "manager"] },
  CLEANED:   { next: "INSPECTED", roomStatus: ROOM_STATUS.CLEANING,  roles: ["supervisor", "manager"] },
  INSPECTED: { next: "DONE",      roomStatus: ROOM_STATUS.INSPECTED, roles: ["supervisor", "manager"] },
  DONE:      { next: null,        roomStatus: ROOM_STATUS.AVAILABLE, roles: [] }
};

export const TASK_STATUSES = Object.keys(TASK_FLOW);

export function normalizeTaskStatus(value) {
  const status = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return TASK_STATUSES.includes(status) ? status : TASK_STATUS.DIRTY;
}

/** The room status a task in this state implies. */
export function roomStatusForTask(taskStatus) {
  return TASK_FLOW[normalizeTaskStatus(taskStatus)].roomStatus;
}

/**
 * May this person advance this task, and to what?
 *
 * Rule 6 lives here: moving CLEANED to INSPECTED is a supervisor's act, so a
 * housekeeper reaching that step is told who can, not merely refused.
 */
export function canAdvanceTask(taskStatus, role) {
  const from = normalizeTaskStatus(taskStatus);
  const step = TASK_FLOW[from];
  if (!step.next) return { allowed: false, reason: "This room is already finished.", next: null };
  const actor = normalizeHotelRole(role);
  if (!step.roles.includes(actor)) {
    const who = from === TASK_STATUS.CLEANED ? "a supervisor" : step.roles.join(" or ");
    return { allowed: false, next: step.next, reason: `Only ${who} can mark this room ${step.next.toLowerCase()}.` };
  }
  return { allowed: true, reason: "", next: step.next };
}

/** The cleaner's own work queue: their assignments, dirtiest first. */
export function taskQueueFor(tasks = [], { staffId = "", role = "" } = {}) {
  const actor = normalizeHotelRole(role);
  const order = ["CLEANING", "ASSIGNED", "DIRTY", "CLEANED", "INSPECTED", "DONE"];
  return tasks
    .filter(task => {
      const status = normalizeTaskStatus(task.status);
      if (status === TASK_STATUS.DONE) return false;
      // A supervisor sees everything, because inspection is their job and
      // they cannot inspect what they cannot see. A cleaner sees their own
      // assignments plus anything still unassigned for them to pick up.
      if (["supervisor", "manager"].includes(actor)) return true;
      if (!task.assignedTo) return true;
      return String(task.assignedTo) === String(staffId);
    })
    .sort((a, b) => {
      const byStatus = order.indexOf(normalizeTaskStatus(a.status)) - order.indexOf(normalizeTaskStatus(b.status));
      if (byStatus) return byStatus;
      return String(a.roomNumber || a.roomId || "").localeCompare(String(b.roomNumber || b.roomId || ""), undefined, { numeric: true });
    });
}

/** What the board shows at the top: how much of today's cleaning is left. */
export function housekeepingSummary(tasks = []) {
  const counts = TASK_STATUSES.reduce((all, status) => ({ ...all, [status]: 0 }), {});
  tasks.forEach(task => { counts[normalizeTaskStatus(task.status)] += 1; });
  const outstanding = counts.DIRTY + counts.ASSIGNED + counts.CLEANING + counts.CLEANED;
  return { counts, outstanding, awaitingInspection: counts.CLEANED, finished: counts.DONE };
}

/* ---------------------------------------------------------
   MAINTENANCE
--------------------------------------------------------- */

export const TICKET_STATUS = {
  OPEN: "OPEN", ASSIGNED: "ASSIGNED", IN_PROGRESS: "IN_PROGRESS",
  RESOLVED: "RESOLVED", CLOSED: "CLOSED"
};

export const TICKET_PRIORITIES = ["low", "normal", "high", "critical"];

export const MAINTENANCE_CATEGORIES = [
  "ac", "tv", "plumbing", "electrical", "wifi", "furniture", "bathroom",
  "door_lock", "lift", "generator", "water_supply", "other"
];

export function normalizeTicketPriority(value) {
  const priority = String(value || "").trim().toLowerCase();
  return TICKET_PRIORITIES.includes(priority) ? priority : "normal";
}

export function normalizeTicketStatus(value) {
  const status = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return Object.values(TICKET_STATUS).includes(status) ? status : TICKET_STATUS.OPEN;
}

/**
 * Does this ticket take the room out of inventory?
 *
 * Only a critical one, and only while it is unresolved. A blown bulb is a
 * ticket; it is not a reason to stop selling the room. Making every ticket
 * close a room is how a property ends up with a maintenance log nobody
 * dares to use.
 */
export function ticketBlocksRoom(ticket = {}) {
  if (normalizeTicketPriority(ticket.priority) !== "critical") return false;
  return ![TICKET_STATUS.RESOLVED, TICKET_STATUS.CLOSED].includes(normalizeTicketStatus(ticket.status));
}

/** Any critical ticket still open against this room. */
export function blockingTickets(tickets = [], roomId) {
  return tickets.filter(ticket => String(ticket.roomId || "") === String(roomId) && ticketBlocksRoom(ticket));
}

/* ---------------------------------------------------------
   THE SERVICE
--------------------------------------------------------- */

export function createHousekeepingService({ db, restaurantId, firestore, now = () => new Date() }) {
  const { doc, collection, runTransaction, serverTimestamp } = firestore;

  const taskRef = id => doc(db, "restaurants", restaurantId, HOUSEKEEPING, id);
  const ticketRef = id => doc(db, "restaurants", restaurantId, MAINTENANCE, id);
  const roomRef = id => doc(db, "restaurants", restaurantId, ROOMS, String(id));
  const auditRef = () => doc(collection(db, AUDIT_LOGS));

  function audit(transaction, { action, actor = {}, detail }) {
    transaction.set(auditRef(), {
      restaurantId, action,
      userId: String(actor.uid || ""), userName: String(actor.name || ""), role: String(actor.role || ""),
      detail, createdAt: serverTimestamp(), at: now().toISOString()
    });
  }

  /** Raise a cleaning task. Idempotent on taskId, so a retry raises one. */
  async function createTask({ taskId, roomId, roomNumber = "", type = "departure_clean", reservationId = "", actor, businessDate = "", notes = "" }) {
    if (!taskId || !roomId) throw new HousekeepingError("invalid", "A task needs a room and an id.");
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(taskRef(taskId));
      if (existing.exists()) return { ok: true, duplicate: true, taskId };
      transaction.set(taskRef(taskId), {
        restaurantId, roomId: String(roomId), roomNumber: String(roomNumber),
        type: String(type), reservationId: String(reservationId),
        status: TASK_STATUS.DIRTY, assignedTo: "", assignedToName: "",
        notes: String(notes),
        businessDate: asStayDate(businessDate) || "",
        createdAt: serverTimestamp()
      });
      transaction.set(roomRef(roomId), { status: ROOM_STATUS.DIRTY, updatedAt: serverTimestamp() }, { merge: true });
      audit(transaction, { action: "housekeeping_task_created", actor, detail: { taskId, roomId, type } });
      return { ok: true, taskId };
    });
  }

  async function assignTask({ taskId, staffId, staffName, actor }) {
    return advance({ taskId, actor, to: TASK_STATUS.ASSIGNED, patch: { assignedTo: String(staffId || ""), assignedToName: String(staffName || "") } });
  }

  /**
   * Move a task one step, and the room with it, in one transaction.
   *
   * `to` is checked against the flow rather than trusted: a stale board could
   * otherwise send a room from DIRTY straight to INSPECTED because that was
   * the button showing when the page last rendered.
   */
  async function advance({ taskId, actor, to = null, patch = {} }) {
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(taskRef(taskId));
      if (!snapshot.exists()) throw new HousekeepingError("not_found", "That task no longer exists.");
      const task = snapshot.data();
      const from = normalizeTaskStatus(task.status);

      const step = canAdvanceTask(from, actor?.role);
      if (!step.allowed) throw new HousekeepingError("forbidden", step.reason);
      if (to && to !== step.next) {
        throw new HousekeepingError("stale", `This room is ${from.toLowerCase()}. Refresh the board and try again.`);
      }
      const next = step.next;

      // The room follows the task, and the room's own machine is consulted
      // too — so a room someone took OUT_OF_ORDER mid-clean is not quietly
      // dragged back into service by a cleaner finishing their round.
      const roomSnapshot = await transaction.get(roomRef(task.roomId));
      const currentRoomStatus = normalizeRoomStatus(roomSnapshot.exists() ? roomSnapshot.data().status : ROOM_STATUS.DIRTY);
      const wantedRoomStatus = roomStatusForTask(next);
      const roomMove = canChangeRoomStatus(currentRoomStatus, wantedRoomStatus, actor?.role);

      if (roomMove.allowed) {
        transaction.set(roomRef(task.roomId), { status: wantedRoomStatus, updatedAt: serverTimestamp() }, { merge: true });
      }

      transaction.set(taskRef(taskId), {
        status: next,
        ...patch,
        ...(next === TASK_STATUS.CLEANING ? { startedAt: serverTimestamp() } : {}),
        ...(next === TASK_STATUS.CLEANED ? { cleanedAt: serverTimestamp(), cleanedBy: String(actor?.name || "") } : {}),
        ...(next === TASK_STATUS.INSPECTED ? { inspectedAt: serverTimestamp(), inspectedBy: String(actor?.name || "") } : {}),
        ...(next === TASK_STATUS.DONE ? { completedAt: serverTimestamp() } : {}),
        updatedAt: serverTimestamp()
      }, { merge: true });

      audit(transaction, {
        action: "housekeeping_task_advanced", actor,
        detail: { taskId, roomId: task.roomId, from, to: next, roomStatusApplied: roomMove.allowed ? wantedRoomStatus : currentRoomStatus }
      });
      return { ok: true, from, to: next, roomStatus: roomMove.allowed ? wantedRoomStatus : currentRoomStatus, roomHeld: !roomMove.allowed };
    });
  }

  /* ---------------- maintenance ---------------- */

  async function reportIssue({ ticketId, roomId, category = "other", priority = "normal", description = "", actor, businessDate = "" }) {
    if (!ticketId) throw new HousekeepingError("invalid", "A ticket needs an id.");
    const level = normalizeTicketPriority(priority);
    return runTransaction(db, async transaction => {
      const existing = await transaction.get(ticketRef(ticketId));
      if (existing.exists()) return { ok: true, duplicate: true, ticketId };

      let roomClosed = false;
      if (roomId && level === "critical") {
        // Section 15: a critical fault takes the room out of inventory at
        // once. Waiting for someone to notice is how a guest is walked into
        // a room with no water.
        const roomSnapshot = await transaction.get(roomRef(roomId));
        const current = normalizeRoomStatus(roomSnapshot.exists() ? roomSnapshot.data().status : ROOM_STATUS.AVAILABLE);
        if (current !== ROOM_STATUS.OCCUPIED) {
          transaction.set(roomRef(roomId), { status: ROOM_STATUS.OUT_OF_ORDER, updatedAt: serverTimestamp() }, { merge: true });
          roomClosed = true;
        }
        // A room with a guest in it is NOT emptied by a ticket. Moving them
        // is a front-desk decision with a folio attached, not a side effect.
      }

      transaction.set(ticketRef(ticketId), {
        restaurantId, roomId: String(roomId || ""),
        category: MAINTENANCE_CATEGORIES.includes(category) ? category : "other",
        priority: level,
        description: String(description),
        status: TICKET_STATUS.OPEN,
        assignedTo: "", cost: 0, vendor: "",
        reportedBy: String(actor?.name || ""), reportedByUid: String(actor?.uid || ""),
        businessDate: asStayDate(businessDate) || "",
        createdAt: serverTimestamp()
      });
      audit(transaction, { action: "maintenance_reported", actor, detail: { ticketId, roomId, category, priority: level, roomClosed } });
      return { ok: true, ticketId, roomClosed };
    });
  }

  /**
   * Resolve a ticket.
   *
   * The room does NOT go back to AVAILABLE. A room whose plumbing has been
   * opened needs cleaning before a guest sees it, so it returns to DIRTY and
   * goes round the housekeeping cycle like any other — and only if no OTHER
   * critical ticket is still open against it.
   */
  async function resolveIssue({ ticketId, actor, resolution = "", cost = 0, vendor = "", openTickets = [] }) {
    const role = normalizeHotelRole(actor?.role);
    if (!["maintenance", "manager", "supervisor"].includes(role)) {
      throw new HousekeepingError("forbidden", "Only maintenance or a manager can resolve a ticket.");
    }
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(ticketRef(ticketId));
      if (!snapshot.exists()) throw new HousekeepingError("not_found", "That ticket no longer exists.");
      const ticket = snapshot.data();
      if ([TICKET_STATUS.RESOLVED, TICKET_STATUS.CLOSED].includes(normalizeTicketStatus(ticket.status))) {
        return { ok: true, unchanged: true };
      }

      transaction.set(ticketRef(ticketId), {
        status: TICKET_STATUS.RESOLVED,
        resolution: String(resolution), cost: Number(cost) || 0, vendor: String(vendor),
        resolvedBy: String(actor?.name || ""), resolvedAt: serverTimestamp()
      }, { merge: true });

      let roomReleased = false;
      const stillBlocked = blockingTickets(
        openTickets.filter(other => String(other.id) !== String(ticketId)),
        ticket.roomId
      );
      if (ticket.roomId && ticketBlocksRoom(ticket) && !stillBlocked.length) {
        const roomSnapshot = await transaction.get(roomRef(ticket.roomId));
        const current = normalizeRoomStatus(roomSnapshot.exists() ? roomSnapshot.data().status : ROOM_STATUS.OUT_OF_ORDER);
        if (current === ROOM_STATUS.OUT_OF_ORDER) {
          transaction.set(roomRef(ticket.roomId), { status: ROOM_STATUS.DIRTY, updatedAt: serverTimestamp() }, { merge: true });
          roomReleased = true;
        }
      }
      audit(transaction, {
        action: "maintenance_resolved", actor,
        detail: { ticketId, roomId: ticket.roomId, cost: Number(cost) || 0, roomReleased, stillBlocked: stillBlocked.length }
      });
      return { ok: true, roomReleased, stillBlocked: stillBlocked.length };
    });
  }

  return { createTask, assignTask, advance, reportIssue, resolveIssue };
}

export class HousekeepingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "HousekeepingError";
    this.code = code;
    Object.assign(this, details);
  }
}
