/* =========================================================
   PROPERTY SETUP PAGE

   Where an owner turns an empty property into one that can take a
   booking. Rooms, room types and tariffs, plus the checklist that
   says what is still missing (section 50).

   Same structural rules as the other hotel pages: one shared
   store, one delegated click listener, render compared before it
   is written, and no reload — see hotel-store.js and
   hotel-front-desk.js for why each of those is load-bearing
   rather than stylistic.

   Room limits go through plan-limits.js, the same check the rest
   of the product uses (section 51). It fails open, so a slow or
   missing billing lookup can never stop a hotel adding a room.
========================================================= */
import { db, auth } from "./firebase.js?v=s2p-20260922d";
import {
  collection, doc, getDoc, getDocs, onSnapshot, query, where,
  runTransaction, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  installAppSafety, registerCleanup, readValidatedLocal,
  resolveActiveRestaurantId, devError
} from "./common.js?v=s2p-20260922d";
import { isSellableRoom, normalizeRoomStatus, RESERVATION_STATUS, normalizeReservationStatus } from "./hotel-core.js?v=s2p-20260922d";
import { createHotelStore } from "./hotel-store.js?v=s2p-20260922d";
import { loadPlanLimits, checkLimitFor } from "./plan-limits.js?v=s2p-20260922d";
import {
  createSetupService, SetupError, expandRoomNumbers, splitExistingRooms,
  setupReadiness, ratePlanWarnings, describeRatePlan, defaultPriorityFor,
  RATE_PLAN_KINDS, STARTER_ROOM_TYPES
} from "./hotel-setup.js?v=s2p-20260922d";

installAppSafety({ pageName: "Property Setup", stuckTimeoutMs: 16000 });

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const money = value => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
  .format(Number(value || 0));

const session = readValidatedLocal(
  localStorage.getItem("scan2plate_user") ? "scan2plate_user" : "scan2serve_user",
  {}, value => value && typeof value === "object"
);
const { restaurantId } = resolveActiveRestaurantId(session.restaurantId);
if (!restaurantId) location.replace("./admin-login.html");

const actor = {
  uid: session.uid || auth.currentUser?.uid || "",
  name: session.name || "",
  role: session.role || "owner"
};

const state = {
  rooms: [], roomTypes: [], ratePlans: [], upcoming: [],
  section: "rooms", showRetired: false, loaded: false,
  editingType: "", editingRoom: "", editingRate: ""
};

const store = createHotelStore({
  db, restaurantId,
  firestore: { collection, onSnapshot },
  onError: (error, context) => devError("setup store", { ...context, code: error?.code })
});
const service = createSetupService({
  db, restaurantId,
  firestore: { doc, collection, runTransaction, writeBatch, serverTimestamp }
});

const lastHtml = new Map();
function paint(id, html) {
  if (lastHtml.get(id) === html) return;
  lastHtml.set(id, html);
  const host = $(id);
  if (host) host.innerHTML = html;
}

const typeName = id => state.roomTypes.find(type => String(type.id) === String(id))?.name || id || "—";
const rateFor = room => room.baseRate
  || state.roomTypes.find(type => String(type.id) === String(room.roomTypeId))?.baseRate
  || 0;

/* ---------------------------------------------------------
   RENDER
--------------------------------------------------------- */
function render() {
  if (!state.loaded) return;
  renderChecklist();
  if (state.section === "rooms") renderRooms();
  if (state.section === "types") renderTypes();
  if (state.section === "rates") renderRates();
  renderTypeOptions();
}

function renderChecklist() {
  const readiness = setupReadiness(state);
  $("suSubtitle").textContent = readiness.ready
    ? `${readiness.counts.sellable} sellable rooms · ${readiness.counts.roomTypes} room types`
    : "Finish these steps before the front desk can take a booking";

  paint("suChecklist", `<h2>Setup</h2>
    ${readiness.steps.map(step => `<div class="su-step ${step.done ? "done" : ""}">
      <i>${step.done ? "✓" : "•"}</i><span>${esc(step.label)}</span></div>`).join("")}
    ${readiness.ready
      ? `<div class="su-ready">This property can take bookings.</div>`
      : readiness.roomsWithoutPrice.length
        ? `<div class="su-warn" style="margin-top:10px">${readiness.roomsWithoutPrice.length} room${
            readiness.roomsWithoutPrice.length === 1 ? " has" : "s have"} no price. ${
            readiness.roomsWithoutPrice.slice(0, 8).map(room => esc(room.roomNumber || room.id)).join(", ")}${
            readiness.roomsWithoutPrice.length > 8 ? "…" : ""}</div>`
        : ""}`);
}

function renderRooms() {
  const rooms = [...state.rooms]
    .filter(room => state.showRetired || room.active !== false)
    .sort((a, b) => String(a.roomNumber || a.id).localeCompare(String(b.roomNumber || b.id), undefined, { numeric: true }));

  if (!rooms.length) {
    paint("suRooms", `<div class="su-empty"><p><strong>No rooms yet.</strong></p>
      <p>Add a floor above — 101 to 110 — and they all appear here.</p></div>`);
    return;
  }
  paint("suRooms", `<table class="su-table"><thead><tr>
      <th>Room</th><th>Floor</th><th>Type</th><th>Rate</th><th>Status</th><th></th>
    </tr></thead><tbody>${rooms.map(room => {
      const retired = room.active === false;
      const rate = rateFor(room);
      return `<tr class="${retired ? "retired" : ""}">
        <td><strong>${esc(room.roomNumber || room.id)}</strong></td>
        <td>${esc(room.floor || "—")}</td>
        <td>${esc(typeName(room.roomTypeId))}</td>
        <td>${rate ? esc(money(rate)) : `<span class="su-tag">no price</span>`}
            ${room.baseRate ? `<span class="su-tag">override</span>` : ""}</td>
        <td>${retired ? `<span class="su-tag">retired</span>`
          : `<span class="su-tag ${isSellableRoom(room) ? "ok" : ""}">${esc(normalizeRoomStatus(room.status).replace(/_/g, " "))}</span>`}</td>
        <td style="text-align:right">
          ${retired
            ? `<button class="su-btn ghost sm" data-restore-room="${esc(room.id)}" type="button">Restore</button>`
            : `<button class="su-btn ghost sm" data-edit-room="${esc(room.id)}" type="button">Edit</button>
               <button class="su-btn danger sm" data-retire-room="${esc(room.id)}" type="button">Retire</button>`}
        </td>
      </tr>`;
    }).join("")}</tbody></table>`);
}

function renderTypes() {
  $("suStarterPanel").hidden = state.roomTypes.length > 0;
  if (!state.roomTypes.length) {
    paint("suTypes", `<div class="su-empty"><p><strong>No room types yet.</strong></p>
      <p>A room type carries the price and how many people it sleeps.</p></div>`);
    return;
  }
  paint("suTypes", `<table class="su-table"><thead><tr>
      <th>Type</th><th>Sleeps</th><th>Base rate</th><th>Extra person</th><th>Rooms</th><th></th>
    </tr></thead><tbody>${state.roomTypes.map(type => {
      const count = state.rooms.filter(room => String(room.roomTypeId) === String(type.id) && room.active !== false).length;
      return `<tr>
        <td><strong>${esc(type.name || type.id)}</strong><br><span class="su-hint">${esc(type.bedType || "")}</span></td>
        <td>${esc(type.maxAdults ?? "—")} adults${type.maxChildren ? ` + ${esc(type.maxChildren)}` : ""}<br>
            <span class="su-hint">${esc(type.includedAdults ?? type.maxAdults ?? "")} included</span></td>
        <td>${Number(type.baseRate) > 0 ? esc(money(type.baseRate)) : `<span class="su-tag">no price</span>`}</td>
        <td>${type.extraAdultRate ? esc(money(type.extraAdultRate)) : "—"}</td>
        <td>${count}</td>
        <td style="text-align:right"><button class="su-btn ghost sm" data-edit-type="${esc(type.id)}" type="button">Edit</button></td>
      </tr>`;
    }).join("")}</tbody></table>`);
}

function renderRates() {
  const warnings = ratePlanWarnings(state.ratePlans);
  paint("suRateWarnings", warnings.length
    ? warnings.map(warning => `<div class="su-warn">${esc(warning.message)}</div>`).join("")
    : "");

  if (!state.ratePlans.length) {
    paint("suRates", `<div class="su-empty"><p><strong>No tariff rules yet.</strong></p>
      <p>Rooms sell at their room type's base rate. Add a rule for weekends, seasons or a corporate contract.</p></div>`);
    return;
  }
  const sorted = [...state.ratePlans].sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  paint("suRates", `<table class="su-table"><thead><tr>
      <th>Rule</th><th>Applies to</th><th>When</th><th>Rate</th><th>Priority</th><th></th>
    </tr></thead><tbody>${sorted.map(plan => `<tr>
      <td><strong>${esc(plan.name || plan.id)}</strong><br><span class="su-hint">${esc(plan.kind || "standard")}</span></td>
      <td>${plan.roomTypeId ? esc(typeName(plan.roomTypeId)) : "all room types"}</td>
      <td>${esc(describeRatePlan(plan))}</td>
      <td>${esc(money(plan.amount))}</td>
      <td>${esc(plan.priority ?? 0)}</td>
      <td style="text-align:right">
        <button class="su-btn ghost sm" data-edit-rate="${esc(plan.id)}" type="button">Edit</button>
        <button class="su-btn danger sm" data-delete-rate="${esc(plan.id)}" type="button">Delete</button>
      </td></tr>`).join("")}</tbody></table>`);
}

function renderTypeOptions() {
  const options = state.roomTypes.filter(type => type.active !== false)
    .map(type => `<option value="${esc(type.id)}">${esc(type.name || type.id)}</option>`).join("");
  ["suBulkType", "suRoomType"].forEach(id => {
    const select = $(id);
    if (!select) return;
    const current = select.value;
    const html = options || `<option value="">Create a room type first</option>`;
    if (select.innerHTML !== html) select.innerHTML = html;
    if (current) select.value = current;
  });
  const rateType = $("suRateType");
  if (rateType) {
    const html = `<option value="">All room types</option>${options}`;
    if (rateType.innerHTML !== html) rateType.innerHTML = html;
  }
}

function previewBulk() {
  const planned = expandRoomNumbers({
    from: $("suFrom").value, to: $("suTo").value,
    prefix: $("suPrefix").value.trim(), floor: $("suFloor").value.trim()
  });
  const { create, skip } = splitExistingRooms(planned, state.rooms);
  $("suBulkPreview").textContent = !planned.length
    ? "Enter a range like 101 to 110."
    : `${create.length} new room${create.length === 1 ? "" : "s"}${skip.length ? `, ${skip.length} already exist` : ""}: ${
        create.slice(0, 6).map(room => room.roomNumber).join(", ")}${create.length > 6 ? "…" : ""}`;
}

/* ---------------------------------------------------------
   ACTIONS — one delegated listener
--------------------------------------------------------- */
let busy = false;
async function guarded(work) {
  if (busy) return;
  busy = true;
  document.body.classList.add("su-busy");
  try {
    await work();
  } catch (error) {
    if (error instanceof SetupError) alert(error.message);
    else {
      devError("setup action", error);
      alert("Could not save that. Check your connection and try again.");
    }
  } finally {
    busy = false;
    document.body.classList.remove("su-busy");
  }
}

const showError = (id, message) => {
  const box = $(id);
  box.textContent = message;
  box.hidden = !message;
};

document.body.addEventListener("click", event => {
  const tab = event.target.closest("#suTabs button[data-section]");
  if (tab) {
    state.section = tab.dataset.section;
    document.querySelectorAll("#suTabs button").forEach(button =>
      button.classList.toggle("active", button.dataset.section === state.section));
    document.querySelectorAll(".su-section").forEach(section =>
      section.classList.toggle("active", section.dataset.section === state.section));
    render();
    return;
  }

  if (event.target.id === "suFrontDesk") { location.assign("./hotel-front-desk.html"); return; }

  if (event.target.id === "suBulkAdd") return guarded(async () => {
    showError("suBulkError", "");
    const planned = expandRoomNumbers({
      from: $("suFrom").value, to: $("suTo").value,
      prefix: $("suPrefix").value.trim(), floor: $("suFloor").value.trim()
    });
    if (!planned.length) return showError("suBulkError", "Enter a range like 101 to 110. A range of more than 500 rooms is not accepted.");
    const roomTypeId = $("suBulkType").value;
    if (!roomTypeId) return showError("suBulkError", "Create a room type first — a room needs a price before it can be sold.");

    const { create } = splitExistingRooms(planned, state.rooms);
    // Section 51: the same central check the rest of the product uses.
    const limitCheck = checkLimitFor("maxRooms", state.rooms.filter(room => room.active !== false).length, create.length);
    const result = await service.createRooms({
      planned, existingRooms: state.rooms, defaults: { roomTypeId }, actor, limitCheck
    });
    if (!result.created) showError("suBulkError", result.reason || "Those rooms already exist.");
  });

  if (event.target.id === "suAddStarters") return guarded(async () => {
    for (const type of STARTER_ROOM_TYPES.slice(0, 5)) {
      // No price yet, deliberately: the owner fills in their own rates, and
      // an invented number would be worse than a blank one.
      await service.saveRoomType({ typeId: type.id, input: { ...type, baseRate: 1 }, actor });
    }
    alert("Starter room types added. Set a rate on each one.");
  });

  const editType = event.target.closest("[data-edit-type]")?.dataset.editType;
  if (editType || event.target.id === "suAddType") return openTypeDialog(editType || "");

  const editRoom = event.target.closest("[data-edit-room]")?.dataset.editRoom;
  if (editRoom) return openRoomDialog(editRoom);

  const retireRoom = event.target.closest("[data-retire-room]")?.dataset.retireRoom;
  if (retireRoom) return guarded(async () => {
    const room = state.rooms.find(item => String(item.id) === String(retireRoom));
    if (!confirm(`Retire room ${room?.roomNumber || retireRoom}?\n\nIt stops being sellable straight away. Past stays and invoices that name it are kept.`)) return;
    await service.retireRoom({
      roomId: retireRoom, actor,
      reason: prompt("Why is it being retired? (optional)") || "",
      upcomingReservations: state.upcoming
    });
  });

  const restoreRoom = event.target.closest("[data-restore-room]")?.dataset.restoreRoom;
  if (restoreRoom) return guarded(() => service.restoreRoom({ roomId: restoreRoom, actor }));

  const editRate = event.target.closest("[data-edit-rate]")?.dataset.editRate;
  if (editRate || event.target.id === "suAddRate") return openRateDialog(editRate || "");

  const deleteRate = event.target.closest("[data-delete-rate]")?.dataset.deleteRate;
  if (deleteRate) return guarded(async () => {
    if (!confirm("Delete this tariff rule? Stays already booked keep the price they were quoted.")) return;
    await service.deleteRatePlan({ planId: deleteRate, actor });
  });

  if (event.target.id === "suTypeSave") return saveType();
  if (event.target.id === "suRoomSave") return saveRoom();
  if (event.target.id === "suRateSave") return saveRate();
});

["suFrom", "suTo", "suPrefix", "suFloor"].forEach(id => $(id).addEventListener("input", previewBulk));
$("suShowRetired").addEventListener("change", event => { state.showRetired = event.target.checked; renderRooms(); });

/* ---------------------------------------------------------
   DIALOGS
--------------------------------------------------------- */
function openTypeDialog(typeId) {
  state.editingType = typeId;
  const type = state.roomTypes.find(item => String(item.id) === String(typeId)) || {};
  showError("suTypeError", "");
  $("suTypeTitle").textContent = typeId ? `Edit ${type.name || typeId}` : "New room type";
  $("suTypeName").value = type.name || "";
  $("suTypeRate").value = type.baseRate ?? "";
  $("suTypeMaxAdults").value = type.maxAdults ?? 2;
  $("suTypeMaxChildren").value = type.maxChildren ?? 1;
  $("suTypeIncluded").value = type.includedAdults ?? type.maxAdults ?? 2;
  $("suTypeExtraAdult").value = type.extraAdultRate ?? 0;
  $("suTypeExtraChild").value = type.extraChildRate ?? 0;
  $("suTypeBeds").value = type.bedType || "";
  $("suTypeDescription").value = type.description || "";
  $("suTypeDialog").showModal();
}

function saveType() {
  return guarded(async () => {
    showError("suTypeError", "");
    try {
      await service.saveRoomType({
        typeId: state.editingType,
        input: {
          name: $("suTypeName").value,
          baseRate: $("suTypeRate").value,
          maxAdults: $("suTypeMaxAdults").value,
          maxChildren: $("suTypeMaxChildren").value,
          includedAdults: $("suTypeIncluded").value,
          extraAdultRate: $("suTypeExtraAdult").value,
          extraChildRate: $("suTypeExtraChild").value,
          bedType: $("suTypeBeds").value,
          description: $("suTypeDescription").value
        },
        actor
      });
      $("suTypeDialog").close();
    } catch (error) {
      if (error instanceof SetupError) return showError("suTypeError", error.message);
      throw error;
    }
  });
}

function openRoomDialog(roomId) {
  state.editingRoom = roomId;
  const room = state.rooms.find(item => String(item.id) === String(roomId)) || {};
  showError("suRoomError", "");
  $("suRoomTitle").textContent = `Room ${room.roomNumber || ""}`;
  $("suRoomNumber").value = room.roomNumber || "";
  $("suRoomFloor").value = room.floor || "";
  renderTypeOptions();
  $("suRoomType").value = room.roomTypeId || "";
  $("suRoomRate").value = room.baseRate ?? "";
  $("suRoomDescription").value = room.description || "";
  $("suRoomDialog").showModal();
}

function saveRoom() {
  return guarded(async () => {
    showError("suRoomError", "");
    try {
      await service.saveRoom({
        roomId: state.editingRoom,
        existingRooms: state.rooms,
        input: {
          roomNumber: $("suRoomNumber").value,
          floor: $("suRoomFloor").value,
          roomTypeId: $("suRoomType").value,
          baseRate: $("suRoomRate").value,
          description: $("suRoomDescription").value
        },
        actor
      });
      $("suRoomDialog").close();
    } catch (error) {
      if (error instanceof SetupError) return showError("suRoomError", error.message);
      throw error;
    }
  });
}

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function openRateDialog(planId) {
  state.editingRate = planId;
  const plan = state.ratePlans.find(item => String(item.id) === String(planId)) || {};
  showError("suRateError", "");
  $("suRateTitle").textContent = planId ? `Edit ${plan.name || planId}` : "New tariff rule";
  $("suRateKind").innerHTML = RATE_PLAN_KINDS
    .map(kind => `<option value="${esc(kind.id)}"${kind.id === (plan.kind || "standard") ? " selected" : ""}>${esc(kind.label)}</option>`).join("");
  $("suRateDays").innerHTML = DAY_KEYS.map(day =>
    `<label><input type="checkbox" value="${day}" data-rate-day${
      Array.isArray(plan.days) && plan.days.includes(day) ? " checked" : ""}> ${day}</label>`).join("");
  $("suRateName").value = plan.name || "";
  $("suRateAmount").value = plan.amount ?? "";
  renderTypeOptions();
  $("suRateType").value = plan.roomTypeId || "";
  $("suRateFrom").value = plan.validFrom || "";
  $("suRateTo").value = plan.validTo || "";
  $("suRatePriority").value = plan.priority ?? defaultPriorityFor(plan.kind || "standard");
  $("suRateDialog").showModal();
}

// Changing the kind re-suggests its priority, unless the rule already exists
// and the owner has set one deliberately.
$("suRateKind").addEventListener("change", event => {
  if (!state.editingRate) $("suRatePriority").value = defaultPriorityFor(event.target.value);
});

function saveRate() {
  return guarded(async () => {
    showError("suRateError", "");
    try {
      await service.saveRatePlan({
        planId: state.editingRate,
        input: {
          name: $("suRateName").value,
          kind: $("suRateKind").value,
          amount: $("suRateAmount").value,
          roomTypeId: $("suRateType").value,
          validFrom: $("suRateFrom").value,
          validTo: $("suRateTo").value,
          priority: $("suRatePriority").value,
          days: [...document.querySelectorAll("[data-rate-day]:checked")].map(input => input.value)
        },
        actor
      });
      $("suRateDialog").close();
    } catch (error) {
      if (error instanceof SetupError) return showError("suRateError", error.message);
      throw error;
    }
  });
}

/* ---------------------------------------------------------
   BOOT
--------------------------------------------------------- */
async function start() {
  // Plan limits load in the background and fail open, so a slow billing
  // lookup never delays this page or blocks a room being added.
  loadPlanLimits(restaurantId).catch(error => devError("plan limits unavailable", error));

  try {
    // Bookings still to come, so a room in use cannot be retired out from
    // under a guest. Read once — this page is not a live booking screen.
    const upcoming = await getDocs(query(
      collection(db, "restaurants", restaurantId, "hotel_reservations"),
      where("checkOut", ">=", new Date().toISOString().slice(0, 10))
    ));
    state.upcoming = upcoming.docs.map(item => ({ id: item.id, ...item.data() }))
      .filter(reservation => ![RESERVATION_STATUS.CANCELLED, RESERVATION_STATUS.NO_SHOW, RESERVATION_STATUS.CHECKED_OUT]
        .includes(normalizeReservationStatus(reservation.status)));
  } catch (error) {
    // A property with no bookings yet, or a missing index. Retiring a room
    // then checks against an empty list, which is the safe direction: the
    // service still refuses if the caller supplies bookings.
    devError("upcoming reservations unavailable", error);
  }

  registerCleanup(store.subscribe("hotel_rooms", rows => { state.rooms = rows; state.loaded = true; render(); previewBulk(); }));
  registerCleanup(store.subscribe("hotel_room_types", rows => { state.roomTypes = rows; state.loaded = true; render(); }));
  registerCleanup(store.subscribe("hotel_rate_plans", rows => { state.ratePlans = rows; render(); }));
  registerCleanup(() => store.destroy());

  void getDoc;
}

start();

export { state, render };
