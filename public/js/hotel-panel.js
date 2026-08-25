// Hotel PMS panel — Milestone 1: Rooms, Room Types, Reservations,
// Availability Calendar, Front Desk, Check-in/Check-out, Guest Folio.
// Reuses the same session/auth bootstrap, .token-* layout classes, and
// registerCleanup/withTimeout/guardedAction conventions as business-panel.js
// (the sibling Cafe/Vendor/Cloud-Kitchen/Food-Court panel) so this stays
// visually and behaviorally consistent with the rest of Scan2Plate.
import { auth, db } from "./firebase.js";
import {
  collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc,
  onSnapshot, serverTimestamp, runTransaction, query, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { installAppSafety, registerCleanup, withTimeout, readValidatedLocal, guardedAction, normalizeCustomerPhone } from "./common.js";
import { nightsBetween, evaluateRoomAvailability, computeRoomCharges, computeFolioTotals, folioItemFromRoomCharge, isActiveBookingStatus } from "./hotel-booking-logic.js";

installAppSafety({ pageName: "Hotel PMS", stuckTimeoutMs: 16000 });

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const money = value => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value || 0));
const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, n) => { const d = new Date(`${dateStr}T00:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const fmtDate = dateStr => dateStr ? new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "-";

const session = readValidatedLocal(localStorage.getItem("scan2plate_user") ? "scan2plate_user" : "scan2serve_user", {}, value => value && typeof value === "object");
const restaurantId = session.restaurantId || localStorage.getItem("scan2plate_last_restaurant_id");
if (!restaurantId) location.replace("./admin-login.html");

const DEFAULT_ROOM_TYPES = ["Single", "Double", "Twin", "Deluxe", "Super Deluxe", "Suite", "Family Room", "Dormitory"];
const ROOM_STATUSES = ["Available", "Reserved", "Occupied", "Dirty", "Cleaning", "Inspected", "Maintenance", "Out of Order", "Blocked"];

let settings = {}, rooms = [], roomTypes = [], bookings = [], guests = [];
let editingRoomId = "", editingRoomTypeId = "";
let calendarStart = todayStr();
let panelLoadDone = false, panelLoadTimer = null;

function showLoadNotice(message = "Taking longer than expected. Please check internet and retry.", error = null) {
  const host = document.querySelector(".token-main") || document.body;
  const debug = error ? `<details><summary>Debug</summary><pre style="white-space:pre-wrap;font-size:11px">${esc(error?.message || error)}</pre></details>` : "";
  let box = $("hotelLoadNotice");
  if (!box) {
    box = document.createElement("div");
    box.id = "hotelLoadNotice";
    box.className = "token-panel";
    box.style.cssText = "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;max-width:min(92vw,520px)";
    host.prepend(box);
  }
  box.innerHTML = `<b>${esc(message)}</b><div class="token-actions" style="margin-top:10px"><button class="token-btn" onclick="location.reload()">Retry</button><button class="token-btn alt" onclick="location.href='./admin-login.html'">Login Again</button></div>${debug}`;
}
function startLoadTimeout() { clearTimeout(panelLoadTimer); panelLoadTimer = setTimeout(() => { if (!panelLoadDone) showLoadNotice(); }, 8000); }
function finishLoad() { panelLoadDone = true; clearTimeout(panelLoadTimer); $("hotelLoadNotice")?.remove(); }

const taxPercent = () => Number(settings.taxPercent || 0);

function section(name) {
  document.querySelectorAll(".token-section").forEach(el => el.classList.toggle("active", el.id === `hotel-${name}`));
  document.querySelectorAll("[data-section]").forEach(el => el.classList.toggle("active", el.dataset.section === name));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function render() {
  renderDashboard();
  renderRooms();
  renderRoomTypeOptions();
  renderRoomTypes();
  renderReservations();
  renderFrontDesk();
  renderCalendar();
  renderGuests();
  renderSettings();
  refreshBookingRoomOptions();
}

/* =========================================================
   DASHBOARD
========================================================= */
function bookingsOverlappingDate(dateStr) {
  return bookings.filter(b => isActiveBookingStatus(b.status) && b.checkInDate <= dateStr && b.checkOutDate > dateStr);
}
function roomEffectiveStatus(room, dateStr = todayStr()) {
  if (["Maintenance", "Out of Order", "Blocked", "Dirty", "Cleaning", "Inspected"].includes(room.status)) return room.status;
  const covering = bookingsOverlappingDate(dateStr).find(b => b.roomId === room.id);
  if (!covering) return "Available";
  return covering.status === "checked_in" ? "Occupied" : "Reserved";
}
function renderDashboard() {
  const today = todayStr();
  const activeRooms = rooms.filter(r => r.active !== false);
  const statuses = activeRooms.map(r => roomEffectiveStatus(r, today));
  const occupied = statuses.filter(s => s === "Occupied").length;
  const reserved = statuses.filter(s => s === "Reserved").length;
  const dirty = statuses.filter(s => ["Dirty", "Cleaning"].includes(s)).length;
  const maintenance = statuses.filter(s => ["Maintenance", "Out of Order", "Blocked"].includes(s)).length;
  const available = activeRooms.length - occupied - reserved - dirty - maintenance;
  const checkins = bookings.filter(b => b.checkInDate === today && isActiveBookingStatus(b.status));
  const checkouts = bookings.filter(b => b.checkOutDate === today && b.status === "checked_in");
  const upcomingIn = bookings.filter(b => b.checkInDate > today && b.checkInDate <= addDays(today, 3) && isActiveBookingStatus(b.status));
  const upcomingOut = bookings.filter(b => b.checkOutDate > today && b.checkOutDate <= addDays(today, 3) && b.status === "checked_in");
  const cancelled = bookings.filter(b => ["cancelled", "no_show"].includes(b.status)).length;
  const todaysBookings = bookings.filter(b => (b.createdAt?.seconds ? new Date(b.createdAt.seconds * 1000).toISOString().slice(0, 10) : "") === today).length;
  const todaysRevenue = bookings.filter(b => b.checkedInAt?.seconds && new Date(b.checkedInAt.seconds * 1000).toISOString().slice(0, 10) === today).reduce((sum, b) => sum + Number(b.advancePaid || 0), 0);
  const pending = bookings.filter(b => isActiveBookingStatus(b.status)).reduce((sum, b) => sum + Math.max(0, folioTotalsFor(b).balance), 0);
  const occupancyPct = activeRooms.length ? Math.round((occupied / activeRooms.length) * 100) : 0;
  const soldNights = bookings.filter(b => ["checked_in", "checked_out"].includes(b.status)).reduce((sum, b) => sum + Number(b.nights || 0), 0);
  const roomRevenue = bookings.filter(b => ["checked_in", "checked_out"].includes(b.status)).reduce((sum, b) => sum + Number(b.roomCharges || 0), 0);
  const adr = soldNights ? roomRevenue / soldNights : 0;
  const revpar = activeRooms.length ? roomRevenue / activeRooms.length : 0;

  $("hotelStats").innerHTML = [
    ["Today's Check-ins", checkins.length], ["Today's Check-outs", checkouts.length],
    ["Occupied Rooms", occupied], ["Available Rooms", available],
    ["Reserved Rooms", reserved], ["Dirty / Cleaning", dirty],
    ["Maintenance / Blocked", maintenance], ["Today's Revenue", money(todaysRevenue)],
    ["Pending Payments", money(pending)], ["Today's Bookings", todaysBookings],
    ["Occupancy", `${occupancyPct}%`], ["ADR", money(adr)],
    ["RevPAR", money(revpar)], ["Cancelled / No-show", cancelled]
  ].map(([label, value]) => `<div class="token-card"><span>${label}</span><b>${value}</b></div>`).join("");

  $("hotelUpcoming").innerHTML = `
    <div><h3 style="margin:0 0 8px;font-size:13px">Upcoming Check-ins (3 days)</h3>${upcomingIn.map(bookingRow).join("") || '<div class="token-empty">None.</div>'}</div>
    <div style="margin-top:14px"><h3 style="margin:0 0 8px;font-size:13px">Upcoming Check-outs (3 days)</h3>${upcomingOut.map(bookingRow).join("") || '<div class="token-empty">None.</div>'}</div>
  `;
}
function bookingRow(b) {
  return `<div class="token-cart-row"><span>${esc(b.guestName)} · Room ${esc(b.roomNumber)} · ${fmtDate(b.checkInDate)}–${fmtDate(b.checkOutDate)}</span><b>${esc(b.status)}</b></div>`;
}

/* =========================================================
   ROOMS
========================================================= */
function statusBadgeClass(status) {
  const map = { Available: "ok", Occupied: "danger", Reserved: "warn", Dirty: "warn", Cleaning: "warn", Inspected: "ok", Maintenance: "danger", "Out of Order": "danger", Blocked: "danger" };
  return map[status] || "";
}
function renderRooms() {
  const root = $("hotelRoomList");
  if (!root) return;
  const search = String($("hotelRoomSearch")?.value || "").trim().toLowerCase();
  const list = rooms.filter(r => !search || `${r.roomNumber} ${r.roomTypeName} ${r.floor}`.toLowerCase().includes(search));
  root.innerHTML = list.map(room => `
    <div class="menu-choice" style="cursor:default">
      <div data-edit-room="${room.id}" style="cursor:pointer">
        <b>Room ${esc(room.roomNumber)} ${room.active === false ? "(Disabled)" : ""}</b>
        <small>${esc(room.roomTypeName || "-")} · Floor ${esc(room.floor || "-")} · ${esc(room.acType || "Non-AC")} · Max ${Number(room.maxGuests || 2)} guests</small>
        <small>${money(room.basePrice)} / night</small>
        <span class="token-pill ${statusBadgeClass(room.status)}">${esc(room.status || "Available")}</span>
      </div>
      <div class="token-actions" style="margin-top:8px">
        <select data-room-id="${room.id}" class="hotel-room-status-select" style="padding:6px;border-radius:8px;border:1px solid #cbd5e1">
          ${ROOM_STATUSES.map(s => `<option value="${s}" ${room.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
        <button class="token-btn alt" data-room-toggle="${room.active === false ? "enable" : "disable"}" data-room-id="${room.id}">${room.active === false ? "Enable" : "Disable"}</button>
      </div>
    </div>
  `).join("") || '<div class="token-empty">No rooms yet. Add your first room below.</div>';
  root.querySelectorAll(".hotel-room-status-select").forEach(select => {
    select.onchange = () => withTimeout(setRoomStatus(select.dataset.roomId, select.value), 15000, "Could not update status.").catch(error => alert(error.message));
  });
}
function renderRoomTypeOptions() {
  ["hotelRoomType", "hotelBookingRoomType"].forEach(id => {
    const el = $(id);
    if (!el) return;
    const current = el.value;
    el.innerHTML = roomTypes.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
    if (current) el.value = current;
  });
}
function clearRoomForm() {
  editingRoomId = "";
  ["hotelRoomNumber", "hotelRoomFloor", "hotelRoomBedType", "hotelRoomMaxGuests", "hotelRoomBasePrice", "hotelRoomExtraAdult", "hotelRoomExtraChild", "hotelRoomAmenities", "hotelRoomDescription", "hotelRoomGst"].forEach(id => { if ($(id)) $(id).value = ""; });
  if ($("hotelRoomAc")) $("hotelRoomAc").value = "AC";
  if ($("hotelRoomStatus")) $("hotelRoomStatus").value = "Available";
}
async function saveRoom() {
  const roomNumber = $("hotelRoomNumber").value.trim();
  const roomTypeId = $("hotelRoomType").value;
  const roomType = roomTypes.find(t => t.id === roomTypeId);
  if (!roomNumber) return alert("Room number is required.");
  if (!roomType) return alert("Add a room type first.");
  const duplicate = rooms.find(r => r.roomNumber === roomNumber && r.id !== editingRoomId);
  if (duplicate) return alert(`Room ${roomNumber} already exists.`);
  const payload = {
    roomNumber, roomTypeId, roomTypeName: roomType.name,
    floor: $("hotelRoomFloor").value.trim(),
    bedType: $("hotelRoomBedType").value.trim(),
    maxGuests: Number($("hotelRoomMaxGuests").value || roomType.maxGuests || 2),
    basePrice: Number($("hotelRoomBasePrice").value || roomType.basePrice || 0),
    extraAdultPrice: Number($("hotelRoomExtraAdult").value || roomType.extraAdultPrice || 0),
    extraChildPrice: Number($("hotelRoomExtraChild").value || roomType.extraChildPrice || 0),
    acType: $("hotelRoomAc").value,
    amenities: $("hotelRoomAmenities").value.split(",").map(a => a.trim()).filter(Boolean),
    description: $("hotelRoomDescription").value.trim(),
    gstRate: Number($("hotelRoomGst").value || 0),
    status: $("hotelRoomStatus").value || "Available",
    active: true,
    updatedAt: serverTimestamp()
  };
  if (editingRoomId) await setDoc(doc(db, "restaurants", restaurantId, "rooms", editingRoomId), payload, { merge: true });
  else await addDoc(collection(db, "restaurants", restaurantId, "rooms"), { ...payload, createdAt: serverTimestamp() });
  clearRoomForm();
}
async function setRoomStatus(roomId, status) {
  await withTimeout(updateDoc(doc(db, "restaurants", restaurantId, "rooms", roomId), { status, updatedAt: serverTimestamp() }), 15000, "Could not update room status.");
}
async function toggleRoomActive(roomId, active) {
  await withTimeout(updateDoc(doc(db, "restaurants", restaurantId, "rooms", roomId), { active, updatedAt: serverTimestamp() }), 15000, "Could not update room.");
}

/* =========================================================
   ROOM TYPES
========================================================= */
function renderRoomTypes() {
  const root = $("hotelRoomTypeList");
  if (!root) return;
  root.innerHTML = roomTypes.map(t => `
    <div class="menu-choice" data-edit-roomtype="${t.id}">
      <b>${esc(t.name)}</b>
      <small>${money(t.basePrice)} base · max ${Number(t.maxGuests || 2)} guests · extra adult ${money(t.extraAdultPrice)} · extra child ${money(t.extraChildPrice)}</small>
    </div>
  `).join("") || '<div class="token-empty">No room types yet.</div>';
}
function clearRoomTypeForm() {
  editingRoomTypeId = "";
  ["hotelRoomTypeName", "hotelRoomTypeBasePrice", "hotelRoomTypeMaxGuests", "hotelRoomTypeExtraAdult", "hotelRoomTypeExtraChild"].forEach(id => { if ($(id)) $(id).value = ""; });
}
async function saveRoomType() {
  const name = $("hotelRoomTypeName").value.trim();
  if (!name) return alert("Room type name is required.");
  const payload = {
    name,
    basePrice: Number($("hotelRoomTypeBasePrice").value || 0),
    maxGuests: Number($("hotelRoomTypeMaxGuests").value || 2),
    extraAdultPrice: Number($("hotelRoomTypeExtraAdult").value || 0),
    extraChildPrice: Number($("hotelRoomTypeExtraChild").value || 0),
    isCustom: !DEFAULT_ROOM_TYPES.includes(name),
    updatedAt: serverTimestamp()
  };
  if (editingRoomTypeId) await setDoc(doc(db, "restaurants", restaurantId, "roomTypes", editingRoomTypeId), payload, { merge: true });
  else await addDoc(collection(db, "restaurants", restaurantId, "roomTypes"), { ...payload, createdAt: serverTimestamp() });
  clearRoomTypeForm();
}
async function seedDefaultRoomTypesIfEmpty() {
  const snap = await getDocs(collection(db, "restaurants", restaurantId, "roomTypes"));
  if (!snap.empty) return;
  await Promise.all(DEFAULT_ROOM_TYPES.map(name =>
    addDoc(collection(db, "restaurants", restaurantId, "roomTypes"), { name, basePrice: 0, maxGuests: 2, extraAdultPrice: 0, extraChildPrice: 0, isCustom: false, createdAt: serverTimestamp() })
  ));
}

/* =========================================================
   FOLIO
========================================================= */
// Uses the hotel's general tax% (Settings) for every folio; a per-room GST
// override (the room form's GST Rate field, stored but not yet wired here)
// is left for the billing/invoice milestone where tax needs to be broken
// out per line item rather than applied once to the folio total.
function folioTotalsFor(booking) {
  const items = booking.folioItems || [];
  return computeFolioTotals(items, taxPercent(), booking.discount || {}, booking.advancePaid || 0);
}

/* =========================================================
   RESERVATIONS / BOOKINGS
========================================================= */
function availableRoomsFor(roomTypeId, checkIn, checkOut, excludeBookingId = null) {
  return rooms.filter(room => {
    if (room.active === false) return false;
    if (roomTypeId && room.roomTypeId !== roomTypeId) return false;
    if (["Maintenance", "Out of Order", "Blocked"].includes(room.status)) return false;
    const roomBookings = bookings.filter(b => b.roomId === room.id);
    return evaluateRoomAvailability(roomBookings, checkIn, checkOut, excludeBookingId).available;
  });
}
function refreshBookingRoomOptions() {
  const roomTypeId = $("hotelBookingRoomType")?.value;
  const checkIn = $("hotelBookingCheckIn")?.value;
  const checkOut = $("hotelBookingCheckOut")?.value;
  const select = $("hotelBookingRoom");
  if (!select) return;
  if (!checkIn || !checkOut || checkOut <= checkIn) { select.innerHTML = '<option value="">Pick valid dates first</option>'; return; }
  const options = availableRoomsFor(roomTypeId, checkIn, checkOut);
  select.innerHTML = options.map(r => `<option value="${r.id}">Room ${esc(r.roomNumber)} · ${money(r.basePrice)}/night</option>`).join("") || '<option value="">No rooms available for these dates</option>';
  const rate = $("hotelBookingRate");
  if (rate && !rate.dataset.touched) {
    const firstRoom = options[0];
    if (firstRoom) rate.value = firstRoom.basePrice;
  }
}
function clearBookingForm() {
  ["hotelGuestName", "hotelGuestMobile", "hotelGuestEmail", "hotelGuestAddress", "hotelIdProofType", "hotelIdProofNumber", "hotelAdults", "hotelChildren", "hotelBookingCheckIn", "hotelBookingCheckOut", "hotelBookingRate", "hotelAdvancePaid", "hotelSpecialRequests", "hotelBookingNotes"].forEach(id => { if ($(id)) $(id).value = ""; });
  if ($("hotelAdults")) $("hotelAdults").value = 1;
  if ($("hotelBookingSource")) $("hotelBookingSource").value = "Walk-in";
  if ($("hotelBookingRate")) delete $("hotelBookingRate").dataset.touched;
  if ($("hotelBookingCheckIn")) $("hotelBookingCheckIn").value = todayStr();
  if ($("hotelBookingCheckOut")) $("hotelBookingCheckOut").value = addDays(todayStr(), 1);
  refreshBookingRoomOptions();
}
function prefillBookingForm(roomId, dateStr) {
  section("reservations");
  $("hotelBookingCheckIn").value = dateStr || todayStr();
  $("hotelBookingCheckOut").value = addDays(dateStr || todayStr(), 1);
  const room = rooms.find(r => r.id === roomId);
  if (room) $("hotelBookingRoomType").value = room.roomTypeId;
  refreshBookingRoomOptions();
  if (room) $("hotelBookingRoom").value = room.id;
}

async function createOrUpdateBooking(asWalkInCheckin = false) {
  const guestName = $("hotelGuestName").value.trim();
  const mobile = normalizeCustomerPhone($("hotelGuestMobile").value);
  const checkInDate = $("hotelBookingCheckIn").value;
  const checkOutDate = $("hotelBookingCheckOut").value;
  const roomId = $("hotelBookingRoom").value;
  const room = rooms.find(r => r.id === roomId);
  if (!guestName) return alert("Guest name is required.");
  if (mobile.length !== 10) return alert("A valid 10-digit mobile number is required.");
  if (!room) return alert("Select an available room.");
  const nights = nightsBetween(checkInDate, checkOutDate);
  if (nights < 1) return alert("Check-out date must be after check-in date.");
  const adults = Number($("hotelAdults").value || 1);
  const children = Number($("hotelChildren").value || 0);
  const ratePerNight = Number($("hotelBookingRate").value || room.basePrice || 0);
  const extraAdults = Math.max(0, adults - 1);
  const charges = computeRoomCharges(ratePerNight, nights, extraAdults, room.extraAdultPrice, children, room.extraChildPrice);
  const advancePaid = Number($("hotelAdvancePaid").value || 0);
  const bookingId = doc(collection(db, "restaurants", restaurantId, "hotelBookings")).id;

  await runTransaction(db, async transaction => {
    // transaction.get(query) — not getDocs() — so this read is part of the
    // transaction's read-set. Firestore only detects a conflicting concurrent
    // booking (and retries this transaction) for reads made through the
    // transaction object; a plain getDocs() here would silently defeat the
    // whole double-booking guarantee under concurrent front-desk usage.
    const roomBookingsSnap = await transaction.get(query(collection(db, "restaurants", restaurantId, "hotelBookings"), where("roomId", "==", roomId)));
    const roomBookings = roomBookingsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const availability = evaluateRoomAvailability(roomBookings, checkInDate, checkOutDate);
    if (!availability.available) throw new Error(availability.reason);

    const status = asWalkInCheckin ? "checked_in" : "reserved";
    const folioItems = [folioItemFromRoomCharge(ratePerNight, nights, checkInDate)];
    const payload = {
      guestName, mobile, email: $("hotelGuestEmail").value.trim(), address: $("hotelGuestAddress").value.trim(),
      idProofType: $("hotelIdProofType").value.trim(), idProofNumber: $("hotelIdProofNumber").value.trim(),
      adults, children, roomTypeId: room.roomTypeId, roomTypeName: room.roomTypeName, roomId, roomNumber: room.roomNumber,
      checkInDate, checkOutDate, nights, ratePerNight,
      roomCharges: charges.roomCharges, extraGuestCharges: charges.extraGuestCharges,
      advancePaid, source: $("hotelBookingSource").value, status,
      specialRequests: $("hotelSpecialRequests").value.trim(), notes: $("hotelBookingNotes").value.trim(),
      folioItems, discount: {}, updatedAt: serverTimestamp(),
      createdBy: session.email || session.name || session.uid || "front-desk"
    };
    if (asWalkInCheckin) payload.checkedInAt = serverTimestamp();
    transaction.set(doc(db, "restaurants", restaurantId, "hotelBookings", bookingId), { ...payload, createdAt: serverTimestamp() });
    if (asWalkInCheckin) transaction.set(doc(db, "restaurants", restaurantId, "rooms", roomId), { status: "Occupied", updatedAt: serverTimestamp() }, { merge: true });
  });

  await upsertGuest(guestName, mobile, $("hotelGuestEmail").value.trim(), $("hotelGuestAddress").value.trim());
  clearBookingForm();
  if (asWalkInCheckin) alert(`Checked in. Room ${room.roomNumber} is now Occupied.`);
  else alert("Reservation created.");
}

async function checkInBooking(bookingId) {
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) return;
  await runTransaction(db, async transaction => {
    transaction.update(doc(db, "restaurants", restaurantId, "hotelBookings", bookingId), { status: "checked_in", checkedInAt: serverTimestamp(), updatedAt: serverTimestamp() });
    transaction.set(doc(db, "restaurants", restaurantId, "rooms", booking.roomId), { status: "Occupied", updatedAt: serverTimestamp() }, { merge: true });
  });
  printRegistrationCard(booking);
}
async function checkOutBooking(bookingId) {
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) return;
  const totals = folioTotalsFor(booking);
  const finalPayment = Number(prompt(`Balance due: ${money(totals.balance)}\nEnter amount received now (0 if already settled):`, totals.balance) || 0);
  await runTransaction(db, async transaction => {
    transaction.update(doc(db, "restaurants", restaurantId, "hotelBookings", bookingId), {
      status: "checked_out", checkedOutAt: serverTimestamp(), updatedAt: serverTimestamp(),
      advancePaid: Number(booking.advancePaid || 0) + finalPayment
    });
    transaction.set(doc(db, "restaurants", restaurantId, "rooms", booking.roomId), { status: "Dirty", updatedAt: serverTimestamp() }, { merge: true });
  });
  alert(`Checked out. Room ${booking.roomNumber} marked Dirty — housekeeping can mark it Available once cleaned.`);
}
async function cancelBooking(bookingId, noShow = false) {
  if (!confirm(noShow ? "Mark this booking as No-show?" : "Cancel this booking?")) return;
  await withTimeout(updateDoc(doc(db, "restaurants", restaurantId, "hotelBookings", bookingId), { status: noShow ? "no_show" : "cancelled", updatedAt: serverTimestamp() }), 15000, "Could not update booking.");
}
async function extendOrTransfer(bookingId, { newCheckOutDate, newRoomId } = {}) {
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) return;
  const targetRoomId = newRoomId || booking.roomId;
  const targetCheckOut = newCheckOutDate || booking.checkOutDate;
  await runTransaction(db, async transaction => {
    const roomBookingsSnap = await transaction.get(query(collection(db, "restaurants", restaurantId, "hotelBookings"), where("roomId", "==", targetRoomId)));
    const roomBookings = roomBookingsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const availability = evaluateRoomAvailability(roomBookings, booking.checkInDate, targetCheckOut, bookingId);
    if (!availability.available) throw new Error(availability.reason);
    const nights = nightsBetween(booking.checkInDate, targetCheckOut);
    const room = rooms.find(r => r.id === targetRoomId);
    const updates = { checkOutDate: targetCheckOut, nights, roomId: targetRoomId, roomNumber: room?.roomNumber || booking.roomNumber, roomTypeId: room?.roomTypeId || booking.roomTypeId, roomTypeName: room?.roomTypeName || booking.roomTypeName, updatedAt: serverTimestamp() };
    transaction.update(doc(db, "restaurants", restaurantId, "hotelBookings", bookingId), updates);
    if (newRoomId && newRoomId !== booking.roomId && booking.status === "checked_in") {
      transaction.set(doc(db, "restaurants", restaurantId, "rooms", booking.roomId), { status: "Dirty", updatedAt: serverTimestamp() }, { merge: true });
      transaction.set(doc(db, "restaurants", restaurantId, "rooms", newRoomId), { status: "Occupied", updatedAt: serverTimestamp() }, { merge: true });
    }
  });
}
async function addFolioCharge(bookingId, description, amount) {
  const booking = bookings.find(b => b.id === bookingId);
  if (!booking) return;
  const items = [...(booking.folioItems || []), { date: todayStr(), description, quantity: 1, rate: Number(amount || 0), category: "service" }];
  await withTimeout(updateDoc(doc(db, "restaurants", restaurantId, "hotelBookings", bookingId), { folioItems: items, updatedAt: serverTimestamp() }), 15000, "Could not add charge.");
}

function renderReservations() {
  const root = $("hotelBookingList");
  if (!root) return;
  const filter = $("hotelBookingFilter")?.value || "all";
  const search = String($("hotelBookingSearch")?.value || "").trim().toLowerCase();
  const list = bookings
    .filter(b => filter === "all" || b.status === filter)
    .filter(b => !search || `${b.guestName} ${b.mobile} ${b.id} ${b.roomNumber}`.toLowerCase().includes(search))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  root.innerHTML = list.map(bookingCard).join("") || '<div class="token-empty">No matching reservations.</div>';
}
function bookingCard(b) {
  const totals = folioTotalsFor(b);
  const actions = [];
  if (["reserved", "confirmed"].includes(b.status)) actions.push(`<button class="token-btn" data-checkin="${b.id}">Check-in</button>`);
  if (b.status === "checked_in") actions.push(`<button class="token-btn" data-checkout="${b.id}">Check-out</button>`);
  if (isActiveBookingStatus(b.status)) {
    actions.push(`<button class="token-btn alt" data-extend="${b.id}">Extend Stay</button>`);
    actions.push(`<button class="token-btn alt" data-transfer="${b.id}">Transfer Room</button>`);
    actions.push(`<button class="token-btn alt" data-charge="${b.id}">Add Charge</button>`);
    actions.push(`<button class="token-btn danger" data-cancel="${b.id}">Cancel</button>`);
  }
  if (b.status === "checked_in") actions.push(`<button class="token-btn alt" data-print-reg="${b.id}">Print Reg. Card</button>`);
  return `
    <article class="token-order">
      <div class="token-order-head">
        <div><b>${esc(b.guestName)}</b><small>${esc(b.mobile)} · Room ${esc(b.roomNumber)} (${esc(b.roomTypeName)})</small><small>${fmtDate(b.checkInDate)} → ${fmtDate(b.checkOutDate)} · ${b.nights} night(s)</small></div>
        <span class="token-pill">${esc(b.status)}</span>
      </div>
      <div class="token-items">
        Room ₹${b.roomCharges || 0}${b.extraGuestCharges ? ` + Extra guest ₹${b.extraGuestCharges}` : ""} · Folio total ${money(totals.grandTotal)} · Paid ${money(totals.paid)} · Balance ${money(totals.balance)}<br>
        Source: ${esc(b.source || "-")} ${b.specialRequests ? `· Requests: ${esc(b.specialRequests)}` : ""}
      </div>
      <div class="token-actions">${actions.join("")}</div>
    </article>
  `;
}
function printRegistrationCard(booking) {
  const w = open("", "_blank");
  if (!w) return;
  w.document.write(`<style>body{font:13px Arial;padding:24px;color:#000}h2{margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:14px}td{padding:6px 0;border-bottom:1px solid #ddd}</style>
    <h2>${esc(settings.restaurantName || settings.name || "Hotel")}</h2><small>${esc(settings.address || "")}</small>
    <h3>Guest Registration Card</h3>
    <table>
      <tr><td>Booking ID</td><td>${esc(booking.id)}</td></tr>
      <tr><td>Guest Name</td><td>${esc(booking.guestName)}</td></tr>
      <tr><td>Mobile</td><td>${esc(booking.mobile)}</td></tr>
      <tr><td>ID Proof</td><td>${esc(booking.idProofType || "-")} ${esc(booking.idProofNumber || "")}</td></tr>
      <tr><td>Room</td><td>${esc(booking.roomNumber)} (${esc(booking.roomTypeName)})</td></tr>
      <tr><td>Check-in</td><td>${fmtDate(booking.checkInDate)}</td></tr>
      <tr><td>Check-out</td><td>${fmtDate(booking.checkOutDate)}</td></tr>
      <tr><td>Guests</td><td>${Number(booking.adults || 1)} Adult(s), ${Number(booking.children || 0)} Child(ren)</td></tr>
      <tr><td>Advance Paid</td><td>${money(booking.advancePaid || 0)}</td></tr>
    </table>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

/* =========================================================
   FRONT DESK
========================================================= */
function renderFrontDesk() {
  const root = $("hotelFrontDeskList");
  if (!root) return;
  const search = String($("hotelFrontDeskSearch")?.value || "").trim().toLowerCase();
  if (search) {
    const matches = bookings.filter(b => `${b.guestName} ${b.mobile} ${b.id} ${b.roomNumber}`.toLowerCase().includes(search));
    root.innerHTML = matches.map(bookingCard).join("") || '<div class="token-empty">No matches.</div>';
    return;
  }
  const today = todayStr();
  const arriving = bookings.filter(b => b.checkInDate === today && ["reserved", "confirmed"].includes(b.status));
  const departing = bookings.filter(b => b.checkOutDate === today && b.status === "checked_in");
  root.innerHTML = `
    <div><h3 style="margin:0 0 8px;font-size:13px">Arriving Today</h3>${arriving.map(bookingCard).join("") || '<div class="token-empty">No arrivals today.</div>'}</div>
    <div style="margin-top:16px"><h3 style="margin:0 0 8px;font-size:13px">Departing Today</h3>${departing.map(bookingCard).join("") || '<div class="token-empty">No departures today.</div>'}</div>
  `;
}

/* =========================================================
   AVAILABILITY CALENDAR
========================================================= */
function renderCalendar() {
  const root = $("hotelCalendarGrid");
  if (!root) return;
  const days = Array.from({ length: 14 }, (_, i) => addDays(calendarStart, i));
  const activeRooms = rooms.filter(r => r.active !== false).sort((a, b) => String(a.roomNumber).localeCompare(String(b.roomNumber), undefined, { numeric: true }));
  const head = `<div class="hotel-cal-row hotel-cal-head"><div class="hotel-cal-room">Room</div>${days.map(d => `<div class="hotel-cal-cell hotel-cal-date">${fmtDate(d)}</div>`).join("")}</div>`;
  const rowsHtml = activeRooms.map(room => {
    const cells = days.map(d => {
      const status = roomEffectiveStatus(room, d);
      const cls = { Available: "cal-available", Occupied: "cal-occupied", Reserved: "cal-reserved" }[status] || "cal-blocked";
      return `<div class="hotel-cal-cell ${cls}" data-cal-room="${room.id}" data-cal-date="${d}" title="${esc(status)}"></div>`;
    }).join("");
    return `<div class="hotel-cal-row"><div class="hotel-cal-room">${esc(room.roomNumber)}<br><small>${esc(room.roomTypeName)}</small></div>${cells}</div>`;
  }).join("");
  root.innerHTML = head + (rowsHtml || '<div class="token-empty">Add rooms to see the calendar.</div>');
}

/* =========================================================
   GUESTS
========================================================= */
async function upsertGuest(name, mobile, email, address) {
  if (!mobile) return;
  const existing = guests.find(g => g.mobile === mobile);
  const stays = bookings.filter(b => b.mobile === mobile);
  const payload = { name, mobile, email, address, totalStays: stays.length + 1, updatedAt: serverTimestamp() };
  if (existing) await setDoc(doc(db, "restaurants", restaurantId, "hotelGuests", existing.id), payload, { merge: true });
  else await addDoc(collection(db, "restaurants", restaurantId, "hotelGuests"), { ...payload, createdAt: serverTimestamp() });
}
function renderGuests() {
  const root = $("hotelGuestList");
  if (!root) return;
  const search = String($("hotelGuestSearch")?.value || "").trim().toLowerCase();
  const list = guests.filter(g => !search || `${g.name} ${g.mobile}`.toLowerCase().includes(search));
  root.innerHTML = list.map(g => {
    const stays = bookings.filter(b => b.mobile === g.mobile);
    const totalSpend = stays.reduce((sum, b) => sum + folioTotalsFor(b).grandTotal, 0);
    return `<div class="menu-choice"><b>${esc(g.name)}</b><small>${esc(g.mobile)} ${g.email ? `· ${esc(g.email)}` : ""}</small><small>${stays.length} stay(s) · ${money(totalSpend)} total spend</small></div>`;
  }).join("") || '<div class="token-empty">No guests yet.</div>';
}

/* =========================================================
   SETTINGS
========================================================= */
function renderSettings() {
  const set = (id, value) => { if ($(id)) $(id).value = value ?? ""; };
  set("hotelSettingName", settings.restaurantName || settings.name || "");
  set("hotelSettingPhone", settings.phone || "");
  set("hotelSettingAddress", settings.address || "");
  set("hotelSettingGst", String(settings.gstNumber || "").toUpperCase());
  set("hotelSettingTax", settings.taxPercent ?? 0);
  set("hotelSettingCheckinTime", settings.defaultCheckInTime || "12:00");
  set("hotelSettingCheckoutTime", settings.defaultCheckOutTime || "11:00");
  $("hotelSettingRoomCount") && ($("hotelSettingRoomCount").value = String(rooms.filter(r => r.active !== false).length));
}
async function saveHotelSettings() {
  const payload = {
    restaurantName: $("hotelSettingName").value.trim(),
    phone: $("hotelSettingPhone").value.trim(),
    address: $("hotelSettingAddress").value.trim(),
    gstNumber: $("hotelSettingGst").value.trim().toUpperCase(),
    taxPercent: Number($("hotelSettingTax").value || 0),
    defaultCheckInTime: $("hotelSettingCheckinTime").value,
    defaultCheckOutTime: $("hotelSettingCheckoutTime").value,
    businessType: settings.businessType || "Hotel",
    updatedAt: serverTimestamp()
  };
  await setDoc(doc(db, "restaurants", restaurantId, "settings", "general"), payload, { merge: true });
  await setDoc(doc(db, "restaurants", restaurantId), payload, { merge: true });
  settings = { ...settings, ...payload };
  renderSettings();
  alert("Settings saved.");
}

/* =========================================================
   BIND + INIT
========================================================= */
function bind() {
  document.querySelectorAll("[data-section]").forEach(btn => btn.onclick = () => section(btn.dataset.section));

  $("hotelRoomSearch")?.addEventListener("input", renderRooms);
  $("saveHotelRoom")?.addEventListener("click", () => guardedAction($("saveHotelRoom"), saveRoom, { loadingText: "Saving...", timeoutMs: 20000 }));
  $("clearHotelRoom")?.addEventListener("click", clearRoomForm);

  $("saveHotelRoomType")?.addEventListener("click", () => guardedAction($("saveHotelRoomType"), saveRoomType, { loadingText: "Saving...", timeoutMs: 20000 }));
  $("clearHotelRoomType")?.addEventListener("click", clearRoomTypeForm);

  $("hotelBookingRoomType")?.addEventListener("change", refreshBookingRoomOptions);
  $("hotelBookingCheckIn")?.addEventListener("change", () => { $("hotelBookingCheckOut").value = addDays($("hotelBookingCheckIn").value, 1); refreshBookingRoomOptions(); });
  $("hotelBookingCheckOut")?.addEventListener("change", refreshBookingRoomOptions);
  $("hotelBookingRate")?.addEventListener("input", () => { $("hotelBookingRate").dataset.touched = "true"; });
  $("hotelBookingFilter")?.addEventListener("change", renderReservations);
  $("hotelBookingSearch")?.addEventListener("input", renderReservations);
  $("hotelFrontDeskSearch")?.addEventListener("input", renderFrontDesk);
  $("hotelGuestSearch")?.addEventListener("input", renderGuests);
  $("createHotelBooking")?.addEventListener("click", () => guardedAction($("createHotelBooking"), () => createOrUpdateBooking(false), { loadingText: "Booking...", timeoutMs: 20000 }));
  $("createHotelWalkin")?.addEventListener("click", () => guardedAction($("createHotelWalkin"), () => createOrUpdateBooking(true), { loadingText: "Checking in...", timeoutMs: 20000 }));
  $("clearHotelBooking")?.addEventListener("click", clearBookingForm);

  $("hotelCalPrev")?.addEventListener("click", () => { calendarStart = addDays(calendarStart, -7); renderCalendar(); });
  $("hotelCalNext")?.addEventListener("click", () => { calendarStart = addDays(calendarStart, 7); renderCalendar(); });
  $("hotelCalToday")?.addEventListener("click", () => { calendarStart = todayStr(); renderCalendar(); });

  $("saveHotelSettings")?.addEventListener("click", () => guardedAction($("saveHotelSettings"), saveHotelSettings, { loadingText: "Saving...", timeoutMs: 20000 }));
  $("hotelLogout")?.addEventListener("click", async () => { await signOut(auth); localStorage.removeItem("scan2plate_user"); localStorage.removeItem("scan2serve_user"); location.replace("./admin-login.html"); });

  document.addEventListener("click", async event => {
    const el = event.target.closest("button,[data-cal-room]");
    if (!el) return;
    try {
      if (el.dataset.editRoom) {
        const room = rooms.find(r => r.id === el.dataset.editRoom);
        if (room) {
          editingRoomId = room.id;
          $("hotelRoomNumber").value = room.roomNumber || "";
          $("hotelRoomType").value = room.roomTypeId || "";
          $("hotelRoomFloor").value = room.floor || "";
          $("hotelRoomBedType").value = room.bedType || "";
          $("hotelRoomMaxGuests").value = room.maxGuests || "";
          $("hotelRoomBasePrice").value = room.basePrice || "";
          $("hotelRoomExtraAdult").value = room.extraAdultPrice || "";
          $("hotelRoomExtraChild").value = room.extraChildPrice || "";
          $("hotelRoomAc").value = room.acType || "AC";
          $("hotelRoomAmenities").value = (room.amenities || []).join(", ");
          $("hotelRoomDescription").value = room.description || "";
          $("hotelRoomGst").value = room.gstRate || "";
          $("hotelRoomStatus").value = room.status || "Available";
        }
      }
      if (el.dataset.roomToggle) await withTimeout(toggleRoomActive(el.dataset.roomId, el.dataset.roomToggle === "enable"), 15000, "Could not update room.");
      if (el.dataset.editRoomtype) {
        const t = roomTypes.find(x => x.id === el.dataset.editRoomtype);
        if (t) {
          editingRoomTypeId = t.id;
          $("hotelRoomTypeName").value = t.name || "";
          $("hotelRoomTypeBasePrice").value = t.basePrice || "";
          $("hotelRoomTypeMaxGuests").value = t.maxGuests || "";
          $("hotelRoomTypeExtraAdult").value = t.extraAdultPrice || "";
          $("hotelRoomTypeExtraChild").value = t.extraChildPrice || "";
        }
      }
      if (el.dataset.checkin) await withTimeout(checkInBooking(el.dataset.checkin), 15000, "Could not check in.");
      if (el.dataset.checkout) await withTimeout(checkOutBooking(el.dataset.checkout), 20000, "Could not check out.");
      if (el.dataset.cancel) await withTimeout(cancelBooking(el.dataset.cancel), 15000, "Could not cancel.");
      if (el.dataset.printReg) { const b = bookings.find(x => x.id === el.dataset.printReg); if (b) printRegistrationCard(b); }
      if (el.dataset.extend) {
        const b = bookings.find(x => x.id === el.dataset.extend);
        const newDate = prompt("New check-out date (YYYY-MM-DD):", b?.checkOutDate);
        if (newDate) await withTimeout(extendOrTransfer(el.dataset.extend, { newCheckOutDate: newDate }), 15000, "Could not extend stay.");
      }
      if (el.dataset.transfer) {
        const b = bookings.find(x => x.id === el.dataset.transfer);
        const options = availableRoomsFor(null, b.checkInDate, b.checkOutDate, b.id).filter(r => r.id !== b.roomId);
        if (!options.length) return alert("No other rooms available for these dates.");
        const target = prompt(`Transfer to which room?\n${options.map(r => `${r.roomNumber}`).join(", ")}`);
        const room = options.find(r => String(r.roomNumber) === String(target));
        if (room) await withTimeout(extendOrTransfer(el.dataset.transfer, { newRoomId: room.id }), 15000, "Could not transfer room.");
      }
      if (el.dataset.charge) {
        const description = prompt("Charge description (e.g. Laundry, Room Service, Minibar):");
        if (!description) return;
        const amount = Number(prompt("Amount (₹):", "0") || 0);
        if (amount > 0) await withTimeout(addFolioCharge(el.dataset.charge, description, amount), 15000, "Could not add charge.");
      }
      if (el.dataset.calRoom && el.dataset.calDate) prefillBookingForm(el.dataset.calRoom, el.dataset.calDate);
    } catch (error) {
      console.error(error);
      alert(error.message || "Action failed. Please retry.");
    }
  });

  // Room status quick-action buttons are rendered per-card with data-room-id/data-room-status;
  // wired via the delegated handler above.
}

async function start() {
  startLoadTimeout();
  const snap = await withTimeout(getDoc(doc(db, "restaurants", restaurantId)), 15000, "Hotel settings timed out.");
  settings = snap.exists() ? snap.data() : {};
  $("hotelBusinessName").textContent = settings.restaurantName || settings.name || "Hotel";
  bind();
  clearBookingForm();
  await withTimeout(seedDefaultRoomTypesIfEmpty(), 15000, "Could not prepare room types.");

  registerCleanup(onSnapshot(collection(db, "restaurants", restaurantId, "rooms"), snap => { rooms = snap.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, error => showLoadNotice("Unable to load rooms.", error)));
  registerCleanup(onSnapshot(collection(db, "restaurants", restaurantId, "roomTypes"), snap => { roomTypes = snap.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, error => showLoadNotice("Unable to load room types.", error)));
  registerCleanup(onSnapshot(query(collection(db, "restaurants", restaurantId, "hotelBookings"), where("checkOutDate", ">=", addDays(todayStr(), -60))), snap => { bookings = snap.docs.map(d => ({ id: d.id, ...d.data() })); render(); finishLoad(); }, error => showLoadNotice("Unable to load reservations.", error)));
  registerCleanup(onSnapshot(collection(db, "restaurants", restaurantId, "hotelGuests"), snap => { guests = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderGuests(); }, error => showLoadNotice("Unable to load guests.", error)));

  render();
}

start().catch(error => { console.error(error); showLoadNotice("Unable to load data. Please retry.", error); });
