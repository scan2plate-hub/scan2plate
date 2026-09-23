/* =========================================================
   HOUSEKEEPING BOARD

   The phone screen a cleaner and a supervisor actually use.

   Section 54 asks for housekeeping to work well on mobile, and
   section 27 asks that housekeeping not see financial reports.
   Both are structural here rather than cosmetic: this page reads
   two collections — tasks and rooms — and nothing else. There is
   no folio, no rate, no revenue on it to hide, because none of it
   is loaded.

   The buttons offered come from canAdvanceTask(), so what a
   person is shown matches what the service will allow. Showing a
   cleaner an "Inspect" button that then refuses them is how staff
   learn to distrust the software.
========================================================= */
import { db, auth } from "./firebase.js?v=s2p-20260922d";
import {
  collection, doc, getDoc, onSnapshot, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  installAppSafety, registerCleanup, readValidatedLocal, getBusinessDate,
  resolveActiveRestaurantId, devError
} from "./common.js?v=s2p-20260922d";
import { propertyToday, normalizeHotelRole } from "./hotel-core.js?v=s2p-20260922d";
import { createHotelStore } from "./hotel-store.js?v=s2p-20260922d";
import {
  createHousekeepingService, HousekeepingError, canAdvanceTask, taskQueueFor,
  housekeepingSummary, normalizeTaskStatus, blockingTickets,
  MAINTENANCE_CATEGORIES, TASK_STATUS
} from "./hotel-housekeeping.js?v=s2p-20260922d";

installAppSafety({ pageName: "Housekeeping", stuckTimeoutMs: 16000 });

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const session = readValidatedLocal(
  localStorage.getItem("scan2plate_user") ? "scan2plate_user" : "scan2serve_user",
  {}, value => value && typeof value === "object"
);
const { restaurantId } = resolveActiveRestaurantId(session.restaurantId);
if (!restaurantId) location.replace("./admin-login.html");

const actor = {
  uid: session.uid || auth.currentUser?.uid || "",
  name: session.name || "",
  role: session.role || "housekeeping"
};
const isSupervisor = ["supervisor", "manager"].includes(normalizeHotelRole(actor.role));

const state = { tasks: [], rooms: [], tickets: [], businessDate: "", loaded: false };

const store = createHotelStore({
  db, restaurantId,
  firestore: { collection, onSnapshot },
  onError: (error, context) => devError("housekeeping store", { ...context, code: error?.code })
});
const service = createHousekeepingService({
  db, restaurantId,
  firestore: { doc, collection, runTransaction, serverTimestamp }
});

const lastHtml = new Map();
function paint(id, html) {
  if (lastHtml.get(id) === html) return;
  lastHtml.set(id, html);
  const host = $(id);
  if (host) host.innerHTML = html;
}

const STATUS_LABEL = status => String(status || "").replace(/_/g, " ");
const ACTION_LABEL = {
  ASSIGNED: "Take this room",
  CLEANING: "Start cleaning",
  CLEANED: "Mark cleaned",
  INSPECTED: "Inspect and pass",
  DONE: "Release as available"
};

function roomNumberOf(roomId) {
  return state.rooms.find(room => String(room.id) === String(roomId))?.roomNumber || roomId || "—";
}

function render() {
  if (!state.loaded) return;
  const queue = taskQueueFor(state.tasks, { staffId: actor.uid, role: actor.role });
  const summary = housekeepingSummary(state.tasks);

  $("hkTitle").textContent = isSupervisor ? "Housekeeping · Supervisor" : "My rooms";
  $("hkSubtitle").textContent = `${summary.outstanding} to do${
    isSupervisor && summary.awaitingInspection ? ` · ${summary.awaitingInspection} awaiting inspection` : ""}`;

  paint("hkCounts", [
    ["To clean", summary.counts.DIRTY + summary.counts.ASSIGNED],
    ["Cleaning", summary.counts.CLEANING],
    ["To inspect", summary.counts.CLEANED],
    ["Done", summary.finished]
  ].map(([label, value]) => `<div class="hk-count"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join(""));

  if (!queue.length) {
    paint("hkList", `<div class="hk-empty"><p><strong>Nothing to clean right now.</strong></p>
      <p>Rooms appear here as guests check out.</p></div>`);
    return;
  }

  paint("hkList", queue.map(task => {
    const status = normalizeTaskStatus(task.status);
    const step = canAdvanceTask(status, actor.role);
    const blocked = blockingTickets(state.tickets, task.roomId);
    const mine = task.assignedTo && String(task.assignedTo) === String(actor.uid);

    // The button a person is shown is the one the service will accept.
    const action = step.allowed
      ? `<button class="hk-btn" data-advance="${esc(task.id)}" data-to="${esc(step.next)}" type="button">${esc(ACTION_LABEL[step.next] || step.next)}</button>`
      : `<button class="hk-btn" disabled type="button">${esc(step.reason)}</button>`;

    return `<div class="hk-card" data-status="${esc(status)}">
      <div class="hk-head">
        <div class="hk-room">${esc(roomNumberOf(task.roomId))}</div>
        <div class="hk-status">${esc(STATUS_LABEL(status))}</div>
      </div>
      <div class="hk-meta">${esc(task.type ? task.type.replace(/_/g, " ") : "clean")}${
        task.assignedToName ? ` · ${esc(mine ? "you" : task.assignedToName)}` : " · unassigned"}</div>
      ${task.notes ? `<div class="hk-meta">${esc(task.notes)}</div>` : ""}
      ${blocked.length ? `<div class="hk-blocked">Maintenance has this room out of service. Do not release it.</div>` : ""}
      <div class="hk-actions">
        ${action}
        <button class="hk-btn warn" data-issue="${esc(task.roomId)}" type="button">Report a problem</button>
      </div>
    </div>`;
  }).join(""));
}

/* ---------------------------------------------------------
   ACTIONS — one delegated listener, as on the front desk
--------------------------------------------------------- */
let busy = false;
async function guarded(work) {
  if (busy) return;
  busy = true;
  document.body.classList.add("hk-busy");
  try {
    await work();
  } catch (error) {
    if (error instanceof HousekeepingError) alert(error.message);
    else {
      devError("housekeeping action", error);
      alert("Could not save that. Check your signal and try again.");
    }
  } finally {
    busy = false;
    document.body.classList.remove("hk-busy");
  }
}

document.body.addEventListener("click", event => {
  const advance = event.target.closest("[data-advance]");
  if (advance) {
    const { advance: taskId, to } = advance.dataset;
    return guarded(async () => {
      const task = state.tasks.find(row => String(row.id) === String(taskId));
      // Taking an unassigned room assigns it on the way, so a cleaner never
      // has to do two things to start work.
      if (to === TASK_STATUS.ASSIGNED) {
        await service.assignTask({ taskId, staffId: actor.uid, staffName: actor.name, actor });
        return;
      }
      if (to === TASK_STATUS.DONE && blockingTickets(state.tickets, task?.roomId).length) {
        alert("Maintenance still has this room out of service. It cannot be released yet.");
        return;
      }
      await service.advance({ taskId, actor, to });
    });
  }

  const issueRoom = event.target.closest("[data-issue]")?.dataset.issue;
  if (issueRoom) {
    $("hkIssueRoom").textContent = `Room ${roomNumberOf(issueRoom)}`;
    $("hkIssueDialog").dataset.roomId = issueRoom;
    $("hkIssueCategory").innerHTML = MAINTENANCE_CATEGORIES
      .map(category => `<option value="${esc(category)}">${esc(category.replace(/_/g, " "))}</option>`).join("");
    $("hkIssueDialog").showModal();
    return;
  }

  if (event.target.id === "hkIssueSend") {
    const roomId = $("hkIssueDialog").dataset.roomId;
    const priority = $("hkIssuePriority").value;
    if (priority === "critical" && !confirm("Critical takes this room out of service immediately. Continue?")) return;
    return guarded(async () => {
      await service.reportIssue({
        ticketId: `MT_${Date.now().toString(36).toUpperCase()}`,
        roomId, category: $("hkIssueCategory").value, priority,
        description: $("hkIssueNotes").value.trim(),
        businessDate: state.businessDate, actor
      });
      $("hkIssueNotes").value = "";
      $("hkIssueDialog").close();
    });
  }

  if (event.target.id === "hkFrontDesk") location.assign("./hotel-front-desk.html");
});

// A manual refresh exists because a cleaner in a lift loses signal, and a
// button they can press beats telling them to close and reopen the app.
$("hkRefresh").addEventListener("click", () => render());

/* ---------------------------------------------------------
   BOOT
--------------------------------------------------------- */
async function start() {
  try {
    const settingsSnapshot = await getDoc(doc(db, "restaurants", restaurantId, "settings", "general"));
    const settings = settingsSnapshot.exists() ? settingsSnapshot.data() : {};
    state.businessDate = propertyToday(getBusinessDate, settings);
  } catch (error) {
    devError("housekeeping boot", error);
    state.businessDate = propertyToday(getBusinessDate, {});
  }

  registerCleanup(store.subscribe("hotel_housekeeping", rows => {
    state.tasks = rows;
    state.loaded = true;
    render();
  }));
  registerCleanup(store.subscribe("hotel_rooms", rows => { state.rooms = rows; render(); }));
  registerCleanup(store.subscribe("hotel_maintenance", rows => { state.tickets = rows; render(); }));
  registerCleanup(() => store.destroy());
}

start();

export { state, render };
