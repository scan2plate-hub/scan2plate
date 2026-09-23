/* =========================================================
   FRONT DESK

   The screen a receptionist lives in: room status, today's
   arrivals and departures, the booking calendar, and the walk-in
   flow. Every write goes through the reservation service, so the
   transaction that prevents double booking is the same one
   whether a booking arrives from this page, the booking engine or
   a future channel manager.

   PERFORMANCE IS A REQUIREMENT HERE, NOT A POLISH ITEM
   (section 47). Three things carry it:

     * Two listeners for the whole page, shared by every section,
       via hotel-store.js.
     * Section switching is a class toggle over markup that is
       already rendered from cached data. There is no reload, no
       refetch and no spinner when moving between tabs.
     * Rendering is compared against the last markup before it is
       written, so a snapshot that changes nothing visible does
       not touch the DOM — which is what stops an idle front desk
       repainting every few seconds and losing the receptionist's
       half-typed input.

   Nothing here calls location.reload().
========================================================= */
import { db, auth } from "./firebase.js?v=s2p-20260922d";
import {
  collection, doc, getDoc, getDocs, onSnapshot, query, where, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  installAppSafety, registerCleanup, readValidatedLocal, getBusinessDate,
  resolveActiveRestaurantId, devError
} from "./common.js?v=s2p-20260922d";
import {
  ROOM_STATUS, RESERVATION_STATUS, BOOKING_SOURCES, normalizeReservationStatus,
  propertyToday, nightsOf, addDays, asStayDate, validateStayDates, quoteStay,
  hotelKpis, frontDeskSnapshot, availableRooms, validateRoomAssignment
} from "./hotel-core.js?v=s2p-20260922d";
import { createHotelStore, roomGrid, todayLists, calendarGrid } from "./hotel-store.js?v=s2p-20260922d";
import { createReservationService, ReservationError } from "./hotel-reservations.js?v=s2p-20260922d";
import {
  createFolioService, checkoutSummary, PAYMENT_METHODS, FolioError
} from "./hotel-folio.js?v=s2p-20260922d";

installAppSafety({ pageName: "Hotel Front Desk", stuckTimeoutMs: 16000 });

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
  role: session.role || "receptionist"
};

/* ---------------------------------------------------------
   STATE

   One copy, fed by the shared store. Every section reads from
   here, so switching tabs is a render, never a fetch.
--------------------------------------------------------- */
const state = {
  settings: {},
  rooms: [],
  roomTypes: [],
  ratePlans: [],
  reservations: [],
  businessDate: "",
  calendarFrom: "",
  calendarDays: 14,
  section: "dashboard",
  resFilter: "upcoming",
  loaded: false
};

const store = createHotelStore({
  db, restaurantId,
  firestore: { collection, onSnapshot },
  onError: (error, context) => devError("hotel store", { ...context, code: error?.code, message: error?.message })
});

const firestoreApi = { doc, collection, runTransaction, serverTimestamp };
const reservations = createReservationService({ db, restaurantId, firestore: firestoreApi });
const folios = createFolioService({ db, restaurantId, firestore: firestoreApi });

/** The folio id for a stay. Derived, so it needs no lookup and no index. */
const folioIdFor = reservationId => `FOL_${reservationId}`;

/* ---------------------------------------------------------
   RENDER GUARD

   setHtmlIfChanged in common.js does this for the restaurant
   dashboard. The same idea, kept local so this page does not
   depend on that module's exact signature: comparing before
   writing is what stops a snapshot that changes nothing from
   blowing away focus or a half-typed field.
--------------------------------------------------------- */
const lastHtml = new Map();
function paint(elementId, html) {
  if (lastHtml.get(elementId) === html) return;
  lastHtml.set(elementId, html);
  const host = $(elementId);
  if (host) host.innerHTML = html;
}

/* ---------------------------------------------------------
   NAVIGATION — a class toggle, never a reload
--------------------------------------------------------- */
const SECTION_TITLES = {
  dashboard: ["Dashboard", "Today at a glance"],
  rooms: ["Room Status", "Tap a room for its details and actions"],
  arrivals: ["Arrivals & Departures", "Today's movements"],
  calendar: ["Booking Calendar", "Tap a free night to start a booking"],
  reservations: ["Reservations", "Every booking for this property"]
};

function showSection(name) {
  if (!SECTION_TITLES[name]) return;
  state.section = name;
  document.querySelectorAll(".hx-section").forEach(section => {
    section.classList.toggle("active", section.dataset.section === name);
  });
  document.querySelectorAll("#hxNav button").forEach(button => {
    button.classList.toggle("active", button.dataset.section === name);
  });
  const [title, subtitle] = SECTION_TITLES[name];
  $("hxTitle").textContent = title;
  $("hxSubtitle").textContent = state.businessDate ? `${subtitle} · ${formatDate(state.businessDate)}` : subtitle;
  render();
}

$("hxNav").addEventListener("click", event => {
  const button = event.target.closest("button[data-section]");
  if (button) return showSection(button.dataset.section);
  // The two other hotel screens. Separate pages rather than sections,
  // because housekeeping is a phone screen and setup is a sit-down job;
  // neither belongs in the front desk's live-listener graph.
  if (event.target.id === "hxSetupLink") location.assign("./hotel-setup.html");
  if (event.target.id === "hxHousekeepingLink") location.assign("./hotel-housekeeping.html");
});

/* An empty property looks broken. It is not — it is unconfigured, and
   saying so with a way out beats a grid with nothing in it. */
function noticeIfUnconfigured() {
  if (state.rooms.length || !state.loaded) return;
  paint("hxRoomGrid", `<div class="hx-empty">
    <p><strong>No rooms yet.</strong></p>
    <p>Add your rooms and tariffs before taking bookings.</p>
    <button class="hx-btn" id="hxSetupLink" type="button" style="margin-top:12px">Set up rooms &amp; tariffs</button>
  </div>`);
}

/* ---------------------------------------------------------
   RENDER
--------------------------------------------------------- */
const STATUS_LABEL = status => String(status || "").replace(/_/g, " ");

function formatDate(stayDate) {
  const date = asStayDate(stayDate);
  if (!date) return "—";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
  });
}

function render() {
  if (!state.loaded) return;
  const grid = roomGrid(state.rooms, state.reservations, state.businessDate);
  const lists = todayLists(state.reservations, state.businessDate);

  // Only the visible section is rendered. The others are rebuilt from the
  // same cached state the moment they are opened, which costs nothing and
  // keeps an idle tab off the render path entirely.
  if (state.section === "dashboard") renderDashboard(grid, lists);
  if (state.section === "rooms") { renderRooms(grid); noticeIfUnconfigured(); }
  if (state.section === "arrivals") renderArrivals(lists);
  if (state.section === "calendar") renderCalendar(grid);
  if (state.section === "reservations") renderReservations();
}

function renderDashboard(grid, lists) {
  const snap = frontDeskSnapshot(state.rooms, state.reservations, state.businessDate);
  const kpis = hotelKpis(state.rooms, state.reservations, state.businessDate, addDays(state.businessDate, 1));
  const counts = snap.roomStatusCounts;

  const cards = [
    ["Occupancy", `${kpis.occupancy}%`, `${snap.inHouse} in house`],
    ["Available", counts.AVAILABLE + counts.INSPECTED, `of ${snap.sellableRooms} sellable`],
    ["Arrivals", snap.arrivalsToday, `${snap.expectedCheckIns} still to arrive`],
    ["Departures", snap.departuresToday, `${snap.expectedCheckOuts} still to leave`],
    ["Dirty", counts.DIRTY + counts.CLEANING, "awaiting housekeeping"],
    ["Out of order", counts.OUT_OF_ORDER + counts.OUT_OF_SERVICE, "not sellable"],
    ["ADR", money(kpis.adr), "today"],
    ["Room revenue", money(kpis.roomRevenue), "today"]
  ];
  paint("hxStats", cards.map(([label, value, note]) => `
    <div class="hx-card"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(note)}</small></div>`).join(""));

  $("hxArrivalCount").textContent = `${lists.arrivals.length} booking${lists.arrivals.length === 1 ? "" : "s"}`;
  $("hxDepartureCount").textContent = `${lists.departures.length} booking${lists.departures.length === 1 ? "" : "s"}`;
  paint("hxArrivalsMini", movementTable(lists.arrivals, "arrival"));
  paint("hxDeparturesMini", movementTable(lists.departures, "departure"));
}

function roomNumberOf(roomId) {
  return state.rooms.find(room => String(room.id) === String(roomId))?.roomNumber || roomId || "—";
}

function movementTable(rows, kind) {
  if (!rows.length) {
    return `<div class="hx-empty">${kind === "arrival" ? "No arrivals today." : "No departures today."}</div>`;
  }
  return `<table class="hx-table"><thead><tr>
      <th>Guest</th><th>Room</th><th>Nights</th><th>Status</th><th></th>
    </tr></thead><tbody>${rows.map(row => {
      const status = normalizeReservationStatus(row.status);
      const action = kind === "arrival" && status !== RESERVATION_STATUS.CHECKED_IN
        ? `<button class="hx-btn sm" data-check-in="${esc(row.id)}" type="button">Check in</button>`
        : kind === "departure"
          ? `<button class="hx-btn sm" data-check-out="${esc(row.id)}" type="button">Check out</button>`
          : "";
      return `<tr>
        <td><strong>${esc(row.guestName || "Guest")}</strong><br><span class="hx-note">${esc(row.bookingId || row.id)}</span></td>
        <td>${esc(roomNumberOf(row.roomId))}</td>
        <td>${esc(row.nights ?? "—")}</td>
        <td><span class="hx-tag ${status === RESERVATION_STATUS.CHECKED_IN ? "ok" : "info"}">${esc(STATUS_LABEL(status))}</span></td>
        <td style="text-align:right">${action}</td>
      </tr>`;
    }).join("")}</tbody></table>`;
}

function renderRooms(grid) {
  paint("hxLegend", [
    ["AVAILABLE", "var(--s-available)"], ["OCCUPIED", "var(--s-occupied)"], ["RESERVED", "var(--s-reserved)"],
    ["DIRTY", "var(--s-dirty)"], ["CLEANING", "var(--s-cleaning)"], ["INSPECTED", "var(--s-inspected)"],
    ["OUT OF ORDER", "var(--s-ooo)"], ["BLOCKED", "var(--s-blocked)"]
  ].map(([label, colour]) => `<span><i style="background:${colour}"></i>${label}</span>`).join(""));

  if (!grid.length) {
    paint("hxRoomGrid", `<div class="hx-empty">No rooms yet. Add rooms in Settings to start taking bookings.</div>`);
    return;
  }
  paint("hxRoomGrid", grid.map(room => {
    const guest = room.occupant?.guestName || room.arriving?.guestName || "";
    const note = room.occupant ? `Until ${formatDate(room.occupant.checkOut)}`
      : room.arriving ? `Arriving today` : "";
    return `<button class="hx-room" data-status="${esc(room.status)}" data-room="${esc(room.id)}" type="button">
      <b>${esc(room.roomNumber || room.id)}</b>
      <em>${esc(STATUS_LABEL(room.status))}</em>
      ${guest ? `<small>${esc(guest)}</small>` : ""}
      ${note ? `<small>${esc(note)}</small>` : ""}
      ${room.statusMismatch ? `<small class="hx-warn">Status needs repair</small>` : ""}
    </button>`;
  }).join(""));
}

function renderArrivals(lists) {
  paint("hxArrivals", movementTable(lists.arrivals, "arrival"));
  paint("hxDepartures", movementTable(lists.departures, "departure"));
  paint("hxInHouse", movementTable(lists.inHouse, "inhouse"));
}

function renderCalendar(grid) {
  const from = state.calendarFrom || state.businessDate;
  const dates = nightsOf(from, addDays(from, state.calendarDays));
  $("hxCalRange").textContent = `${formatDate(dates[0])} — ${formatDate(dates[dates.length - 1])}`;

  const rows = calendarGrid(grid, state.reservations, dates);
  if (!rows.length) {
    paint("hxCalendar", `<div class="hx-empty">No rooms to show.</div>`);
    return;
  }

  const head = `<thead><tr><th class="hx-cal-room">Room</th>${dates.map(date => {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = day === 0 || day === 6;
    return `<th class="${weekend ? "wk" : ""}">${date.slice(8)}<br>${new Date(`${date}T00:00:00Z`)
      .toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" })}</th>`;
  }).join("")}</tr></thead>`;

  const body = rows.map(({ room, cells }) => `<tr>
    <th class="hx-cal-room">${esc(room.roomNumber || room.id)}<br>
      <span class="hx-note">${esc(STATUS_LABEL(room.status))}</span></th>
    ${cells.map(cell => {
      if (!cell.sellable) return `<td class="hx-cal-cell unsellable" title="Not sellable"></td>`;
      if (!cell.reservation) {
        return `<td class="hx-cal-cell free" data-new-room="${esc(room.id)}" data-new-date="${esc(cell.date)}" title="Book ${esc(room.roomNumber || room.id)} on ${esc(cell.date)}"></td>`;
      }
      const status = normalizeReservationStatus(cell.reservation.status);
      return `<td class="hx-cal-cell">
        <div class="hx-cal-block ${cell.isStart ? "start" : "cont"}" data-status="${esc(status)}"
             data-booking="${esc(cell.reservation.id)}"
             title="${esc(cell.reservation.guestName || "Guest")} · ${esc(cell.reservation.bookingId || "")}">
          ${cell.isStart ? esc(cell.reservation.guestName || "Guest") : ""}
        </div></td>`;
    }).join("")}
  </tr>`).join("");

  paint("hxCalendar", `<table class="hx-cal">${head}<tbody>${body}</tbody></table>`);
}

function renderReservations() {
  const filter = state.resFilter;
  const today = state.businessDate;
  const rows = state.reservations.filter(reservation => {
    const status = normalizeReservationStatus(reservation.status);
    if (filter === "all") return true;
    if (filter === "upcoming") {
      return ![RESERVATION_STATUS.CANCELLED, RESERVATION_STATUS.NO_SHOW].includes(status)
        && asStayDate(reservation.checkOut) >= today;
    }
    return status === filter;
  }).sort((a, b) => String(a.checkIn).localeCompare(String(b.checkIn)));

  if (!rows.length) {
    paint("hxReservations", `<div class="hx-empty">No bookings match this filter.</div>`);
    return;
  }
  paint("hxReservations", `<table class="hx-table"><thead><tr>
      <th>Booking</th><th>Guest</th><th>Room</th><th>Stay</th><th>Total</th><th>Status</th><th></th>
    </tr></thead><tbody>${rows.map(row => {
      const status = normalizeReservationStatus(row.status);
      const actions = [];
      if ([RESERVATION_STATUS.CONFIRMED, RESERVATION_STATUS.TENTATIVE, RESERVATION_STATUS.PENDING].includes(status)) {
        actions.push(`<button class="hx-btn sm" data-check-in="${esc(row.id)}" type="button">Check in</button>`);
        actions.push(`<button class="hx-btn ghost sm" data-cancel="${esc(row.id)}" type="button">Cancel</button>`);
        actions.push(`<button class="hx-btn ghost sm" data-no-show="${esc(row.id)}" type="button">No-show</button>`);
      }
      if (status === RESERVATION_STATUS.CHECKED_IN) {
        actions.push(`<button class="hx-btn sm" data-check-out="${esc(row.id)}" type="button">Check out</button>`);
      }
      const tone = status === RESERVATION_STATUS.CHECKED_IN ? "ok"
        : [RESERVATION_STATUS.CANCELLED, RESERVATION_STATUS.NO_SHOW].includes(status) ? "warn" : "info";
      return `<tr>
        <td><strong>${esc(row.bookingId || row.id)}</strong><br><span class="hx-note">${esc(row.source || "")}</span></td>
        <td>${esc(row.guestName || "Guest")}<br><span class="hx-note">${esc(row.guestPhone || "")}</span></td>
        <td>${esc(roomNumberOf(row.roomId))}</td>
        <td>${esc(formatDate(row.checkIn))} → ${esc(formatDate(row.checkOut))}<br>
            <span class="hx-note">${esc(row.nights ?? "")} night${row.nights === 1 ? "" : "s"}</span></td>
        <td>${esc(money(row.total))}</td>
        <td><span class="hx-tag ${tone}">${esc(STATUS_LABEL(status))}</span></td>
        <td style="text-align:right"><div class="hx-actions" style="justify-content:flex-end">${actions.join("")}</div></td>
      </tr>`;
    }).join("")}</tbody></table>`);
}

/* ---------------------------------------------------------
   ACTIONS

   One delegated listener on the body. Re-rendering replaces
   markup constantly, so per-button listeners would either be
   lost or, worse, accumulate — which section 47 names directly.
--------------------------------------------------------- */
let busy = false;

async function guarded(label, work) {
  if (busy) return;
  busy = true;
  document.body.classList.add("hx-busy");
  try {
    await work();
  } catch (error) {
    if (error instanceof ReservationError) alert(error.message);
    else {
      devError(`${label} failed`, error);
      alert("Could not complete that just now. Check your connection and try again.");
    }
  } finally {
    busy = false;
    document.body.classList.remove("hx-busy");
  }
}

document.body.addEventListener("click", event => {
  if (event.target.id === "hxSetupLink") { location.assign("./hotel-setup.html"); return; }
  // One delegated listener for the whole page. Re-rendering replaces markup
  // constantly, so a second listener here would be the accumulating-handler
  // fault section 47 names — and the checkout controls are rendered markup.
  if (handleCheckoutClick(event)) return;

  const checkInId = event.target.closest("[data-check-in]")?.dataset.checkIn;
  if (checkInId) return guarded("check-in", async () => {
    const booking = state.reservations.find(row => String(row.id) === String(checkInId));
    await reservations.checkIn(checkInId, { actor });
    // The folio opens WITH the check-in, not at the first charge, so the
    // restaurant has somewhere to post to from the moment the guest has a
    // room. Opening is idempotent, so a retry cannot create a second one.
    await folios.openFolio({
      folioId: folioIdFor(checkInId),
      reservationId: checkInId,
      guestId: booking?.guestId || "",
      guestName: booking?.guestName || "",
      roomId: booking?.roomId || "",
      businessDate: state.businessDate,
      actor
    });
    // The room nights themselves are the first charge. Posted per night, at
    // the rate agreed when the booking was made, so a stay spanning a rate
    // change bills what was quoted rather than today's price.
    for (const night of booking?.nightlyRates || []) {
      await folios.postCharge({
        folioId: folioIdFor(checkInId),
        chargeId: `room_${checkInId}_${night.stayDate}`,
        kind: "room",
        description: `Room ${roomNumberOf(booking.roomId)} · ${night.stayDate}`,
        quantity: 1, rate: night.amount,
        taxPercent: Number(state.settings.roomTaxPercent || 0),
        businessDate: night.stayDate,
        actor
      });
    }
  });

  const checkOutId = event.target.closest("[data-check-out]")?.dataset.checkOut;
  if (checkOutId) return openCheckoutDialog(checkOutId);

  const cancelId = event.target.closest("[data-cancel]")?.dataset.cancel;
  if (cancelId) return guarded("cancel", async () => {
    const reason = prompt("Cancel this booking. Reason (optional):");
    if (reason === null) return;
    await reservations.cancel(cancelId, { actor, reason, businessDate: state.businessDate });
  });

  const noShowId = event.target.closest("[data-no-show]")?.dataset.noShow;
  if (noShowId) return guarded("no-show", async () => {
    if (!confirm("Mark this booking a no-show? The room is released immediately.")) return;
    await reservations.markNoShow(noShowId, { actor, businessDate: state.businessDate });
  });

  const roomId = event.target.closest("[data-room]")?.dataset.room;
  if (roomId) return openRoomDialog(roomId);

  const cell = event.target.closest("[data-new-room]");
  if (cell) return openBookingDialog({ roomId: cell.dataset.newRoom, checkIn: cell.dataset.newDate });
});

$("hxResFilter").addEventListener("change", event => {
  state.resFilter = event.target.value;
  renderReservations();
});

$("hxCalPrev").addEventListener("click", () => {
  state.calendarFrom = addDays(state.calendarFrom || state.businessDate, -state.calendarDays);
  renderCalendar(roomGrid(state.rooms, state.reservations, state.businessDate));
});
$("hxCalNext").addEventListener("click", () => {
  state.calendarFrom = addDays(state.calendarFrom || state.businessDate, state.calendarDays);
  renderCalendar(roomGrid(state.rooms, state.reservations, state.businessDate));
});
$("hxCalToday").addEventListener("click", () => {
  state.calendarFrom = state.businessDate;
  renderCalendar(roomGrid(state.rooms, state.reservations, state.businessDate));
});

/* ---------------------------------------------------------
   ROOM DETAIL
--------------------------------------------------------- */
function openRoomDialog(roomId) {
  const grid = roomGrid(state.rooms, state.reservations, state.businessDate);
  const room = grid.find(entry => String(entry.id) === String(roomId));
  if (!room) return;
  $("hxRoomTitle").textContent = `Room ${room.roomNumber || room.id}`;
  const type = state.roomTypes.find(entry => String(entry.id) === String(room.roomTypeId));
  const rows = [
    ["Status", STATUS_LABEL(room.status)],
    ["Room type", type?.name || room.roomTypeId || "—"],
    ["Floor", room.floor || "—"],
    ["Base rate", room.baseRate || type?.baseRate ? money(room.baseRate || type?.baseRate) : "—"],
    ["Max occupancy", type?.maxAdults ? `${type.maxAdults} adults` : "—"],
    ["Sellable", room.sellable ? "Yes" : "No"]
  ];
  if (room.occupant) {
    rows.push(["Guest", room.occupant.guestName || "Guest"]);
    rows.push(["Booking", room.occupant.bookingId || room.occupant.id]);
    rows.push(["Departing", formatDate(room.occupant.checkOut)]);
  }
  $("hxRoomBody").innerHTML = `
    ${room.statusMismatch ? `<div class="hx-error">This room's stored status says ${esc(STATUS_LABEL(room.storedStatus))} while a guest is checked in. The booking is trusted here; repair the room record from Settings.</div>` : ""}
    <table class="hx-table"><tbody>${rows.map(([label, value]) =>
      `<tr><td class="hx-note">${esc(label)}</td><td><strong>${esc(value)}</strong></td></tr>`).join("")}</tbody></table>
    <p class="hx-note" style="margin-top:14px">Housekeeping actions and maintenance tickets arrive with the housekeeping board.</p>`;
  $("hxRoomDialog").showModal();
}

/* ---------------------------------------------------------
   BOOKING AND WALK-IN
--------------------------------------------------------- */
let bookingDraft = null;

function openBookingDialog({ roomId = "", checkIn = "", walkIn = false } = {}) {
  const today = state.businessDate;
  bookingDraft = { walkIn };
  $("hxBookingTitle").textContent = walkIn ? "Walk-in guest" : "New reservation";
  $("hxBookingSave").textContent = walkIn ? "Book and check in" : "Save booking";
  $("hxBookingError").hidden = true;
  $("hxBookingForm").reset();
  $("hxCheckIn").value = asStayDate(checkIn) || today;
  $("hxCheckOut").value = addDays(asStayDate(checkIn) || today, 1);
  $("hxAdults").value = 1;
  $("hxChildren").value = 0;
  $("hxSource").innerHTML = BOOKING_SOURCES
    .map(source => `<option value="${esc(source.id)}"${source.id === (walkIn ? "walk_in" : "direct") ? " selected" : ""}>${esc(source.label)}</option>`)
    .join("");
  refreshRoomOptions(roomId);
  $("hxBookingDialog").showModal();
}

/**
 * The room list offered is computed from reservation data, never from the
 * room's own status field — section 7. A room already held for these dates
 * is not offered at all, which is the difference between a receptionist
 * choosing from what is free and choosing something that will be refused.
 */
function refreshRoomOptions(preferredRoomId = "") {
  const checkIn = $("hxCheckIn").value;
  const checkOut = $("hxCheckOut").value;
  const dates = validateStayDates(checkIn, checkOut);
  const select = $("hxRoom");
  if (!dates.ok) {
    select.innerHTML = `<option value="">${esc(dates.reason)}</option>`;
    updateQuote();
    return;
  }
  const free = availableRooms(state.rooms, state.reservations, { checkIn, checkOut });
  if (!free.length) {
    select.innerHTML = `<option value="">No rooms free for these dates</option>`;
    updateQuote();
    return;
  }
  select.innerHTML = free
    .sort((a, b) => String(a.roomNumber || a.id).localeCompare(String(b.roomNumber || b.id), undefined, { numeric: true }))
    .map(room => {
      const type = state.roomTypes.find(entry => String(entry.id) === String(room.roomTypeId));
      const label = `${room.roomNumber || room.id}${type ? ` · ${type.name}` : ""}`;
      return `<option value="${esc(room.id)}"${String(room.id) === String(preferredRoomId) ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
  updateQuote();
}

function roomTypeFor(roomId) {
  const room = state.rooms.find(entry => String(entry.id) === String(roomId));
  return state.roomTypes.find(entry => String(entry.id) === String(room?.roomTypeId)) || { baseRate: room?.baseRate || 0 };
}

function updateQuote() {
  const checkIn = $("hxCheckIn").value;
  const checkOut = $("hxCheckOut").value;
  const roomId = $("hxRoom").value;
  const dates = validateStayDates(checkIn, checkOut);
  if (!dates.ok || !roomId) {
    $("hxQuote").textContent = dates.ok ? "Pick a room to see the tariff." : dates.reason;
    return;
  }
  const quote = quoteStay(state.ratePlans, {
    checkIn, checkOut, roomType: roomTypeFor(roomId), roomTypeId: roomTypeFor(roomId).id,
    adults: Number($("hxAdults").value || 1), children: Number($("hxChildren").value || 0)
  });
  const mixed = new Set(quote.nights.map(night => night.amount)).size > 1;
  $("hxQuote").innerHTML = `
    ${esc(quote.nightCount)} night${quote.nightCount === 1 ? "" : "s"}
    ${quote.extraTotal ? ` · extra occupancy ${esc(money(quote.extraTotal))}` : ""}
    <b>${esc(money(quote.total))}</b>
    ${mixed ? `<span class="hx-note">Rate varies by night: ${quote.nights.map(night => `${night.stayDate.slice(8)} ${money(night.amount)}`).join(", ")}</span>` : ""}`;
}

["hxCheckIn", "hxCheckOut"].forEach(id => $(id).addEventListener("change", () => refreshRoomOptions($("hxRoom").value)));
["hxRoom", "hxAdults", "hxChildren"].forEach(id => $(id).addEventListener("change", updateQuote));

$("hxWalkIn").addEventListener("click", () => openBookingDialog({ walkIn: true }));
$("hxNewBooking").addEventListener("click", () => openBookingDialog({}));

$("hxBookingForm").addEventListener("submit", event => {
  if (event.submitter?.value !== "save") return;      // Cancel closes the dialog
  event.preventDefault();
  saveBooking();
});

async function saveBooking() {
  const error = message => {
    const box = $("hxBookingError");
    box.textContent = message;
    box.hidden = false;
  };
  const roomId = $("hxRoom").value;
  const checkIn = $("hxCheckIn").value;
  const checkOut = $("hxCheckOut").value;
  const guestName = $("hxGuestName").value.trim();
  if (!guestName) return error("Enter the guest's name.");
  if (!roomId) return error("Choose a room.");

  const room = state.rooms.find(entry => String(entry.id) === String(roomId));
  const check = validateRoomAssignment(room, state.reservations, { checkIn, checkOut });
  if (!check.ok) return error(check.reason);

  // The booking id is generated HERE and reused on retry, so a dropped
  // connection cannot produce two bookings for one guest — section 46.
  const bookingId = bookingDraft?.bookingId || `BK${Date.now().toString(36).toUpperCase()}`;
  if (bookingDraft) bookingDraft.bookingId = bookingId;

  await guarded("booking", async () => {
    try {
      await reservations.create({
        id: bookingId, bookingId, roomId,
        roomTypeId: room?.roomTypeId || "",
        roomType: roomTypeFor(roomId),
        ratePlans: state.ratePlans,
        guestName,
        guestPhone: $("hxGuestPhone").value.trim(),
        checkIn, checkOut,
        adults: Number($("hxAdults").value || 1),
        children: Number($("hxChildren").value || 0),
        source: $("hxSource").value,
        notes: $("hxNotes").value.trim(),
        status: RESERVATION_STATUS.CONFIRMED
      }, actor);

      if (bookingDraft?.walkIn) await reservations.checkIn(bookingId, { actor });
      bookingDraft = null;
      $("hxBookingDialog").close();
    } catch (failure) {
      if (failure instanceof ReservationError) {
        error(failure.message);
        // The room list is now known to be stale — the night was taken while
        // this form was open. Refreshing it is more useful than the message.
        refreshRoomOptions();
        return;
      }
      throw failure;
    }
  });
}

/* ---------------------------------------------------------
   CHECKOUT

   Section 11: show every charge, take the money, raise the
   invoice, then mark the room DIRTY and raise a housekeeping
   task. Rule 4 says the room becomes dirty; the room is never
   made available here, because only housekeeping's own workflow
   may do that.
--------------------------------------------------------- */
let checkoutContext = null;

async function openCheckoutDialog(reservationId) {
  const booking = state.reservations.find(row => String(row.id) === String(reservationId));
  if (!booking) return;
  const folioId = folioIdFor(reservationId);

  await guarded("folio load", async () => {
    // Read once, on open. The folio is not listened to: a checkout takes
    // seconds and a live listener for it would be a third stream for data
    // one screen looks at once.
    const [items, paid] = await Promise.all([
      getDocs(query(collection(db, "restaurants", restaurantId, "hotel_folio_items"), where("folioId", "==", folioId))),
      getDocs(query(collection(db, "hotelPayments"), where("folioId", "==", folioId)))
    ]);
    const charges = items.docs.map(item => ({ id: item.id, ...item.data() }));
    const payments = paid.docs.map(item => ({ id: item.id, ...item.data() }));
    checkoutContext = { reservationId, folioId, booking, charges, payments };
    renderCheckout();
    $("hxCheckoutDialog").showModal();
  });
}

function renderCheckout() {
  const { booking, charges, payments } = checkoutContext;
  const summary = checkoutSummary(charges, payments);
  checkoutContext.summary = summary;

  $("hxCheckoutTitle").textContent = `Check out · Room ${roomNumberOf(booking.roomId)}`;
  const lines = summary.lines.map(line =>
    `<tr><td>${esc(line.label)}</td><td style="text-align:right">${esc(money(line.amount))}</td></tr>`).join("");
  const settled = summary.payments.map(payment =>
    `<tr><td class="hx-note">${esc(payment.method || "")} ${esc(payment.reference || "")}</td>
      <td style="text-align:right" class="hx-note">${esc(money(payment.amount))}</td></tr>`).join("");

  paint("hxCheckoutBody", `
    <p class="hx-note">${esc(booking.guestName || "Guest")} · ${esc(formatDate(booking.checkIn))} → ${esc(formatDate(booking.checkOut))}</p>
    <table class="hx-table"><tbody>
      ${lines || `<tr><td colspan="2" class="hx-note">No charges posted.</td></tr>`}
      ${summary.discount ? `<tr><td>Discount</td><td style="text-align:right">−${esc(money(summary.discount))}</td></tr>` : ""}
      ${summary.tax ? `<tr><td>Tax</td><td style="text-align:right">${esc(money(summary.tax))}</td></tr>` : ""}
      <tr><td><strong>Total</strong></td><td style="text-align:right"><strong>${esc(money(summary.total))}</strong></td></tr>
      ${settled}
      ${summary.refunded ? `<tr><td>Refunded</td><td style="text-align:right">${esc(money(summary.refunded))}</td></tr>` : ""}
      <tr><td><strong>Balance</strong></td><td style="text-align:right"><strong>${esc(money(summary.balance))}</strong></td></tr>
    </tbody></table>
    ${summary.unsettledAttempts ? `<div class="hx-error" style="margin-top:12px">${summary.unsettledAttempts} payment attempt${summary.unsettledAttempts === 1 ? "" : "s"} did not go through. The balance above excludes ${summary.unsettledAttempts === 1 ? "it" : "them"}.</div>` : ""}
    ${summary.balance > 0 ? `
      <div class="hx-row" style="margin-top:14px">
        <div class="hx-field"><label for="hxPayAmount">Amount to collect</label>
          <input id="hxPayAmount" type="number" min="0" step="0.01" value="${esc(summary.balance)}"></div>
        <div class="hx-field"><label for="hxPayMethod">Method</label>
          <select id="hxPayMethod">${PAYMENT_METHODS.map(method =>
            `<option value="${esc(method)}">${esc(method.replace(/_/g, " "))}</option>`).join("")}</select></div>
      </div>
      <button class="hx-btn" id="hxTakePayment" type="button">Record payment</button>
      <p class="hx-note" style="margin-top:10px">Recorded as pending first, then confirmed. A payment that does not go through never reduces the balance.</p>
    ` : `<p class="hx-note" style="margin-top:14px">Folio settled. Ready to check out.</p>`}`);

  $("hxCheckoutConfirm").textContent = summary.balance > 0 ? "Check out on credit" : "Check out";
  $("hxCheckoutConfirm").disabled = false;
}

async function handleCheckoutClick(event) {
  if (event.target.id === "hxTakePayment") {
    const amount = Number($("hxPayAmount").value || 0);
    const method = $("hxPayMethod").value;
    const paymentId = `PAY_${Date.now().toString(36).toUpperCase()}`;
    await guarded("payment", async () => {
      const { folioId } = checkoutContext;
      await folios.beginPayment({ folioId, paymentId, amount, method, actor, businessDate: state.businessDate });
      // Cash and UPI at the desk are confirmed by the person taking them.
      // A gateway payment would confirm from its own webhook instead — the
      // two-step write is the same either way, which is the point of it.
      const received = confirm(`Confirm ${money(amount)} received by ${method.replace(/_/g, " ")}?\n\nChoose Cancel if it did not go through.`);
      await folios.settlePayment({
        folioId, paymentId, outcome: received, actor,
        failureReason: received ? "" : "Not received at the desk"
      });
      const paid = await getDocs(query(collection(db, "hotelPayments"), where("folioId", "==", folioId)));
      checkoutContext.payments = paid.docs.map(item => ({ id: item.id, ...item.data() }));
      renderCheckout();
    });
    return true;
  }

  if (event.target.id === "hxCheckoutConfirm") {
    const { reservationId, folioId, charges, payments, summary, booking } = checkoutContext;
    if (summary.balance > 0 && !confirm(
      `${money(summary.balance)} is still outstanding.\n\nCheck out on credit? This is recorded against the invoice.`)) return;

    await guarded("checkout", async () => {
      try {
        const invoice = await folios.closeFolio({
          folioId, charges, payments, actor,
          allowCredit: summary.balance > 0,
          businessDate: state.businessDate,
          invoiceFormat: {
            prefix: state.settings.invoicePrefix || "INV",
            width: Number(state.settings.invoiceWidth || 5)
          }
        });
        await reservations.checkOut(reservationId, { actor, onCredit: summary.balance > 0 });

        // RULE 4. The room becomes DIRTY and housekeeping is told. It is
        // never made AVAILABLE here — only housekeeping's own workflow may
        // do that, which is what stops a room being resold uncleaned.
        await markRoomDirty(booking.roomId, reservationId);

        $("hxCheckoutDialog").close();
        alert(`Checked out. Invoice ${invoice.invoiceNumber}.`);
      } catch (failure) {
        if (failure instanceof FolioError) { alert(failure.message); return; }
        throw failure;
      }
    });
    return true;
  }
  return false;
}

async function markRoomDirty(roomId, reservationId) {
  if (!roomId) return;
  const taskId = `HK_${reservationId}`;
  await runTransaction(db, async transaction => {
    const roomRef = doc(db, "restaurants", restaurantId, "hotel_rooms", String(roomId));
    const taskRef = doc(db, "restaurants", restaurantId, "hotel_housekeeping", taskId);
    const existing = await transaction.get(taskRef);
    transaction.set(roomRef, { status: ROOM_STATUS.DIRTY, updatedAt: serverTimestamp() }, { merge: true });
    if (!existing.exists()) {
      transaction.set(taskRef, {
        restaurantId, roomId: String(roomId), reservationId: String(reservationId),
        type: "departure_clean", status: "DIRTY",
        businessDate: state.businessDate,
        createdAt: serverTimestamp()
      });
    }
  });
}

/* ---------------------------------------------------------
   BOOT
--------------------------------------------------------- */
async function start() {
  try {
    const [settingsSnap, rootSnap] = await Promise.all([
      getDoc(doc(db, "restaurants", restaurantId, "settings", "general")),
      getDoc(doc(db, "restaurants", restaurantId))
    ]);
    const root = rootSnap.exists() ? rootSnap.data() : {};
    state.settings = { ...root, ...(settingsSnap.exists() ? settingsSnap.data() : {}) };
    state.businessDate = propertyToday(getBusinessDate, state.settings);
    state.calendarFrom = state.businessDate;
    $("hxPropertyName").textContent = (state.settings.restaurantName || "HOTEL FRONT DESK").toUpperCase();

    // Room types and rate plans change rarely and are needed for pricing, so
    // they are read once rather than listened to. Two live listeners for the
    // page, not four.
    const [types, plans] = await Promise.all([
      getDocs(collection(db, "restaurants", restaurantId, "hotel_room_types")),
      getDocs(collection(db, "restaurants", restaurantId, "hotel_rate_plans"))
    ]);
    state.roomTypes = types.docs.map(item => ({ id: item.id, ...item.data() }));
    state.ratePlans = plans.docs.map(item => ({ id: item.id, ...item.data() }));
  } catch (error) {
    devError("hotel front desk boot", error);
  }

  registerCleanup(store.subscribe("hotel_rooms", rows => {
    state.rooms = rows;
    state.loaded = true;
    render();
  }));
  registerCleanup(store.subscribe("hotel_reservations", rows => {
    state.reservations = rows;
    state.loaded = true;
    render();
  }));
  registerCleanup(() => store.destroy());

  showSection("dashboard");
}

start();

export { state, render };
