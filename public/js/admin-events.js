// Event Food Pre-Booking - admin management module. Entirely isolated from
// admin.js/admin-modules.js: its own Firestore collections (events,
// events/{id}/menu, eventBookings - never touches "orders" or existing
// restaurant billing schema), its own nav item, its own section. Gated
// behind restaurants/{id}.eventPrebookingEnabled, default-off, so this
// never appears for a restaurant that hasn't opted in (Part 35).
import { app, auth, db } from "./firebase.js";
import { collection, doc, addDoc, setDoc, deleteDoc, getDocs, getDoc, onSnapshot, query, where, orderBy, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { installAppSafety, registerCleanup, devError, showStuckFallback, createCoalescedRunner, getBackendBaseUrl } from "./common.js?v=freeze-fix-20260816";

installAppSafety({ pageName: "Admin Events", stuckTimeoutMs: 18000 });

const user = (() => {
  try { return JSON.parse(localStorage.getItem("scan2plate_user") || localStorage.getItem("scan2serve_user") || "{}"); }
  catch { return {}; }
})();
const restaurantId = user.restaurantId || localStorage.getItem("scan2plate_last_restaurant_id");
if (!restaurantId) throw new Error("Missing restaurant context");

const esc = v => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const money = v => `₹${Number(v || 0).toFixed(2)}`;
const slugify = v => String(v || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

let restaurantSettings = {};
let events = [];
let bookingsByEvent = new Map(); // eventId -> eventBookings[]
let activeEventId = null;
let activeEventMenu = [];

async function authHeaders() {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Please sign in again.");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// Same auth-retry-once pattern already proven for admin-modules.js's
// listeners (a cold page load can race Firebase Auth's own session
// restoration - see that file's subscribeWithAuthRetry for the full
// reasoning); every listener in this file uses it too rather than
// reintroducing the silent-failure class that pattern was built to fix.
function subscribeWithAuthRetry(label, ref, onNext) {
  let retried = false, unsub = () => {};
  const start = () => {
    unsub = onSnapshot(ref, onNext, async error => {
      if (error?.code === "permission-denied" && auth.currentUser && !retried) {
        retried = true;
        try { await auth.currentUser.getIdToken(true); start(); return; }
        catch (refreshError) { devError(`${label} token refresh retry failed`, refreshError); }
      }
      devError(`${label} listener failed`, error);
      showStuckFallback("Unable to load event data. Refresh if needed.");
    });
  };
  start();
  registerCleanup(() => unsub());
}

function nav(name, icon, title) {
  document.querySelectorAll(".nav-group")[1]?.insertAdjacentHTML("beforeend", `<a class="nav-item module-nav" data-module="${name}"><span class="nav-icon"><i class="fas ${icon}"></i></span>${title}</a>`);
}
function section(name, html) {
  document.querySelector(".dashboard-content")?.insertAdjacentHTML("beforeend", `<section class="content-section module-section" id="module-${name}">${html}</section>`);
}
function openSection(name, title, sub) {
  document.querySelectorAll(".content-section").forEach(x => x.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(x => x.classList.remove("active"));
  document.getElementById(`module-${name}`)?.classList.add("active");
  document.querySelector(`.module-nav[data-module="${name}"]`)?.classList.add("active");
  const pt = document.getElementById("pageTitle"), ps = document.getElementById("pageSubtitle");
  if (pt) pt.textContent = title;
  if (ps) ps.textContent = sub || "";
  window.closeSidebarOnMobile?.();
}

function loadQrLibrary() {
  if (window.QRCode) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not load QR code library."));
    document.head.appendChild(script);
  });
}

/* =========================================================
   ENABLE GATE — nothing below renders until eventPrebookingEnabled
   is true for this restaurant. Section content is built once we know.
========================================================= */
nav("events", "fa-calendar-star", "Events");
section("events", `
  <div id="eventsGate" class="card" style="display:none">
    <div class="card-body" style="text-align:center;padding:40px 24px">
      <i class="fas fa-calendar-star" style="font-size:32px;color:#d88a1d;margin-bottom:12px;display:block"></i>
      <h3 style="margin:0 0 8px">Event Food Pre-Booking</h3>
      <p class="muted" style="max-width:480px;margin:0 auto 18px">Sell limited food items in advance for an event, collect online payment, and issue a one-time pickup QR that staff scan at the counter. This is a separate, isolated flow — it does not change your existing menu, billing, or table QR ordering.</p>
      <button id="enableEventPrebookingBtn" class="btn btn-primary">Enable Event Pre-Booking</button>
    </div>
  </div>
  <div id="eventsRoot" style="display:none">
    <div id="eventsListView">
      <div class="card">
        <div class="card-header"><h3 class="card-title">Events</h3><button id="createEventBtn" class="btn btn-primary btn-sm"><i class="fas fa-plus"></i> Create Event</button></div>
        <div class="card-body" id="eventsListBody"></div>
      </div>
    </div>
    <div id="eventDetailView" style="display:none">
      <button id="backToEventsBtn" class="btn btn-outline btn-sm" style="margin-bottom:14px"><i class="fas fa-arrow-left"></i> All Events</button>
      <div id="eventDetailBody"></div>
    </div>
  </div>
`);

const eventsGateEl = document.getElementById("eventsGate");
const eventsRootEl = document.getElementById("eventsRoot");

document.getElementById("enableEventPrebookingBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("enableEventPrebookingBtn");
  btn.disabled = true; btn.textContent = "Enabling...";
  try {
    await setDoc(doc(db, "restaurants", restaurantId), { eventPrebookingEnabled: true, updatedAt: serverTimestamp() }, { merge: true });
  } catch (error) {
    alert("Could not enable Event Pre-Booking: " + (error?.message || error));
    btn.disabled = false; btn.textContent = "Enable Event Pre-Booking";
  }
});

subscribeWithAuthRetry("restaurant (events gate)", doc(db, "restaurants", restaurantId), snap => {
  restaurantSettings = snap.exists() ? snap.data() : {};
  const enabled = restaurantSettings.eventPrebookingEnabled === true;
  if (eventsGateEl) eventsGateEl.style.display = enabled ? "none" : "block";
  if (eventsRootEl) eventsRootEl.style.display = enabled ? "block" : "none";
});

document.querySelectorAll(".module-nav").forEach(a => { if (!a.onclick) a.onclick = e => { e.preventDefault(); openSection(a.dataset.module, a.textContent.trim(), ""); }; });

/* =========================================================
   EVENTS LIST
========================================================= */
function eventStatusBadge(status) {
  const map = { draft: "muted", active: "success", booking_closed: "warning", completed: "muted", cancelled: "danger" };
  return `<span class="status-badge ${map[status] || "muted"}">${esc(status || "draft")}</span>`;
}

function renderEventsList() {
  const body = document.getElementById("eventsListBody");
  if (!body) return;
  if (!events.length) {
    body.innerHTML = `<div class="empty-state"><i class="fas fa-calendar-star"></i><h4>No events yet</h4><p>Create an event to start selling pre-booked food with pickup QR.</p></div>`;
    return;
  }
  body.innerHTML = events.map(e => `
    <div class="card" style="padding:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div>
        <strong>${esc(e.eventName)}</strong> ${eventStatusBadge(e.status)}
        <div class="small muted">${esc(e.eventDate || "")} · ${esc(e.venueName || "")}</div>
      </div>
      <div class="btn-group">
        <button class="btn btn-outline btn-sm open-event" data-id="${e.id}">Manage</button>
      </div>
    </div>
  `).join("");
  body.querySelectorAll(".open-event").forEach(btn => btn.addEventListener("click", () => openEventDetail(btn.dataset.id)));
}

subscribeWithAuthRetry("events", query(collection(db, "events"), where("restaurantId", "==", restaurantId)), snap => {
  events = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  renderEventsList();
  if (activeEventId && !events.find(e => e.id === activeEventId)) closeEventDetail();
});

function eventFormHtml(existing = {}) {
  return `
    <div class="form-row">
      <div class="form-group"><label class="form-label">Event Name</label><input class="form-input" id="evName" value="${esc(existing.eventName || "")}" /></div>
      <div class="form-group"><label class="form-label">Organizer Name</label><input class="form-input" id="evOrganizer" value="${esc(existing.organizerName || "")}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Event Date</label><input class="form-input" type="date" id="evDate" value="${esc(existing.eventDate || "")}" /></div>
      <div class="form-group"><label class="form-label">Start Time</label><input class="form-input" type="time" id="evStart" value="${esc(existing.eventStartTime || "")}" /></div>
      <div class="form-group"><label class="form-label">End Time</label><input class="form-input" type="time" id="evEnd" value="${esc(existing.eventEndTime || "")}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Booking Opens</label><input class="form-input" type="datetime-local" id="evBookStart" value="${esc(existing.bookingStartLocal || "")}" /></div>
      <div class="form-group"><label class="form-label">Booking Closes</label><input class="form-input" type="datetime-local" id="evBookEnd" value="${esc(existing.bookingEndLocal || "")}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Venue Name</label><input class="form-input" id="evVenue" value="${esc(existing.venueName || "")}" /></div>
      <div class="form-group"><label class="form-label">City</label><input class="form-input" id="evCity" value="${esc(existing.city || "")}" /></div>
    </div>
    <div class="form-group"><label class="form-label">Venue Address</label><input class="form-input" id="evAddress" value="${esc(existing.venueAddress || "")}" /></div>
    <div class="form-group"><label class="form-label">Description</label><textarea class="form-input" id="evDescription" rows="2">${esc(existing.description || "")}</textarea></div>
    <div class="form-group"><label class="form-label">Pickup Instructions</label><textarea class="form-input" id="evPickupInstructions" rows="2">${esc(existing.pickupInstructions || "Show this QR at the food pickup counter.")}</textarea></div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Status</label><select class="form-select" id="evStatus">
        ${["draft", "active", "booking_closed", "completed", "cancelled"].map(s => `<option value="${s}" ${existing.status === s ? "selected" : ""}>${s}</option>`).join("")}
      </select></div>
      <div class="form-group"><label class="form-label">Max Bookings (optional)</label><input class="form-input" type="number" min="0" id="evMaxBookings" value="${existing.maxBookings ?? ""}" /></div>
    </div>
  `;
}

function readEventForm() {
  const bookStartVal = document.getElementById("evBookStart")?.value || "";
  const bookEndVal = document.getElementById("evBookEnd")?.value || "";
  const eventName = document.getElementById("evName")?.value.trim() || "";
  return {
    eventName,
    organizerName: document.getElementById("evOrganizer")?.value.trim() || "",
    eventDate: document.getElementById("evDate")?.value || "",
    eventStartTime: document.getElementById("evStart")?.value || "",
    eventEndTime: document.getElementById("evEnd")?.value || "",
    bookingStartLocal: bookStartVal,
    bookingEndLocal: bookEndVal,
    bookingStartAt: bookStartVal ? new Date(bookStartVal) : null,
    bookingEndAt: bookEndVal ? new Date(bookEndVal) : null,
    venueName: document.getElementById("evVenue")?.value.trim() || "",
    city: document.getElementById("evCity")?.value.trim() || "",
    venueAddress: document.getElementById("evAddress")?.value.trim() || "",
    description: document.getElementById("evDescription")?.value.trim() || "",
    pickupInstructions: document.getElementById("evPickupInstructions")?.value.trim() || "Show this QR at the food pickup counter.",
    status: document.getElementById("evStatus")?.value || "draft",
    maxBookings: document.getElementById("evMaxBookings")?.value ? Number(document.getElementById("evMaxBookings").value) : null
  };
}

function openModal(title, bodyHtml, onSave) {
  let modal = document.getElementById("eventFormModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "eventFormModal";
    modal.className = "modal-overlay";
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="modal" style="max-width:640px"><div class="modal-header"><h3>${esc(title)}</h3><button class="modal-close" type="button">&times;</button></div><div class="modal-body">${bodyHtml}</div><div class="modal-footer"><button class="btn btn-outline" id="eventFormCancel" type="button">Cancel</button><button class="btn btn-primary" id="eventFormSave" type="button">Save</button></div></div>`;
  modal.classList.add("active");
  document.body.classList.add("modal-open");
  const close = () => { modal.classList.remove("active"); document.body.classList.remove("modal-open"); };
  modal.querySelector(".modal-close")?.addEventListener("click", close);
  document.getElementById("eventFormCancel")?.addEventListener("click", close);
  document.getElementById("eventFormSave")?.addEventListener("click", async () => {
    const saveBtn = document.getElementById("eventFormSave");
    saveBtn.disabled = true; saveBtn.textContent = "Saving...";
    try { await onSave(); close(); }
    catch (error) { alert(error?.message || "Could not save."); }
    finally { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
  });
}

document.getElementById("createEventBtn")?.addEventListener("click", () => {
  openModal("Create Event", eventFormHtml(), async () => {
    const form = readEventForm();
    if (!form.eventName) throw new Error("Event name is required.");
    const eventSlugBase = slugify(form.eventName) || `event-${Date.now()}`;
    let eventSlug = eventSlugBase, suffix = 1;
    while ((await getDocs(query(collection(db, "events"), where("eventSlug", "==", eventSlug)))).size > 0) {
      eventSlug = `${eventSlugBase}-${++suffix}`;
    }
    const { bookingStartLocal, bookingEndLocal, ...rest } = form;
    await addDoc(collection(db, "events"), {
      ...rest,
      eventSlug,
      restaurantId,
      createdAt: serverTimestamp(),
      createdBy: user.email || user.uid || "admin"
    });
  });
});

/* =========================================================
   EVENT DETAIL — menu + dashboard + QR
========================================================= */
let menuUnsub = null, bookingsUnsub = null;

function closeEventDetail() {
  activeEventId = null;
  document.getElementById("eventDetailView").style.display = "none";
  document.getElementById("eventsListView").style.display = "block";
}
document.getElementById("backToEventsBtn")?.addEventListener("click", closeEventDetail);

function openEventDetail(eventId) {
  activeEventId = eventId;
  document.getElementById("eventsListView").style.display = "none";
  document.getElementById("eventDetailView").style.display = "block";
  renderEventDetail();

  if (menuUnsub) menuUnsub();
  const menuRunner = createCoalescedRunner(snap => {
    activeEventMenu = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    renderEventDetail();
  }, 150);
  menuUnsub = onSnapshot(collection(db, "events", eventId, "menu"), menuRunner, error => devError("event menu listener failed", error));
  registerCleanup(() => menuUnsub && menuUnsub());

  if (bookingsUnsub) bookingsUnsub();
  const bookingsRunner = createCoalescedRunner(snap => {
    bookingsByEvent.set(eventId, snap.docs.map(d => ({ id: d.id, ...d.data() })));
    renderEventDetail();
  }, 200);
  bookingsUnsub = onSnapshot(query(collection(db, "eventBookings"), where("eventId", "==", eventId)), bookingsRunner, error => devError("event bookings listener failed", error));
  registerCleanup(() => bookingsUnsub && bookingsUnsub());
}

function computeEventStats(eventId) {
  const bookings = bookingsByEvent.get(eventId) || [];
  const confirmed = bookings.filter(b => b.bookingStatus === "confirmed" || b.bookingStatus === "redeemed");
  const paid = bookings.filter(b => b.paymentStatus === "paid");
  const pending = bookings.filter(b => b.bookingStatus === "pending_payment");
  const redeemed = bookings.filter(b => b.redeemed === true);
  const notRedeemed = confirmed.filter(b => b.redeemed !== true);
  const cancelled = bookings.filter(b => b.bookingStatus === "cancelled");
  const revenue = paid.reduce((sum, b) => sum + Number(b.priceSnapshot || 0), 0);
  const perItem = new Map();
  activeEventMenu.forEach(item => perItem.set(item.id, {
    itemName: item.itemName,
    capacity: Number(item.availableQuantity || 0),
    sold: Number(item.soldQuantity || 0),
    redeemed: 0,
    pending: 0
  }));
  confirmed.forEach(b => {
    const row = perItem.get(b.itemId);
    if (!row) return;
    if (b.redeemed === true) row.redeemed += 1; else row.pending += 1;
  });
  return { total: bookings.length, confirmed: confirmed.length, paid: paid.length, pending: pending.length, redeemed: redeemed.length, notRedeemed: notRedeemed.length, cancelled: cancelled.length, revenue, perItem: [...perItem.values()] };
}

function menuItemFormHtml(existing = {}) {
  return `
    <div class="form-row">
      <div class="form-group"><label class="form-label">Item Name</label><input class="form-input" id="miName" value="${esc(existing.itemName || "")}" /></div>
      <div class="form-group"><label class="form-label">Price (₹)</label><input class="form-input" type="number" min="0" step="0.01" id="miPrice" value="${existing.price ?? ""}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Food Type</label><select class="form-select" id="miFoodType"><option value="veg" ${existing.foodType !== "non-veg" ? "selected" : ""}>Veg</option><option value="non-veg" ${existing.foodType === "non-veg" ? "selected" : ""}>Non-Veg</option></select></div>
      <div class="form-group"><label class="form-label">Available Quantity</label><input class="form-input" type="number" min="0" id="miQty" value="${existing.availableQuantity ?? 0}" /></div>
    </div>
    <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="miDescription" value="${esc(existing.description || "")}" /></div>
    <div class="form-group"><label class="form-label">Image URL (optional)</label><input class="form-input" id="miImage" value="${esc(existing.imageUrl || "")}" /></div>
  `;
}

function renderEventDetail() {
  const ev = events.find(e => e.id === activeEventId);
  const body = document.getElementById("eventDetailBody");
  if (!ev || !body) return;
  const stats = computeEventStats(activeEventId);
  const pickupUrl = `https://scan2plate.com/event.html?slug=${encodeURIComponent(ev.eventSlug || "")}`;

  body.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="card-header"><h3 class="card-title">${esc(ev.eventName)} ${eventStatusBadge(ev.status)}</h3><div class="btn-group"><button class="btn btn-outline btn-sm" id="editEventBtn">Edit Event</button><button class="btn btn-outline btn-sm" id="downloadEventQrBtn"><i class="fas fa-qrcode"></i> Download Event QR</button></div></div>
      <div class="card-body">
        <p class="small muted">${esc(ev.eventDate || "")} · ${esc(ev.eventStartTime || "")}-${esc(ev.eventEndTime || "")} · ${esc(ev.venueName || "")}, ${esc(ev.city || "")}</p>
        <p class="small">Booking link: <a href="${pickupUrl}" target="_blank" rel="noopener">${esc(pickupUrl)}</a></p>
      </div>
    </div>

    <div class="stats-grid" style="margin-bottom:14px">
      <div class="stat-card"><div class="stat-label">Confirmed Bookings</div><div class="stat-value">${stats.confirmed}</div></div>
      <div class="stat-card"><div class="stat-label">Paid</div><div class="stat-value">${stats.paid}</div></div>
      <div class="stat-card"><div class="stat-label">Pending Payment</div><div class="stat-value">${stats.pending}</div></div>
      <div class="stat-card"><div class="stat-label">Redeemed Pickups</div><div class="stat-value">${stats.redeemed}</div></div>
      <div class="stat-card"><div class="stat-label">Not Yet Redeemed</div><div class="stat-value">${stats.notRedeemed}</div></div>
      <div class="stat-card"><div class="stat-label">Cancelled</div><div class="stat-value">${stats.cancelled}</div></div>
      <div class="stat-card"><div class="stat-label">Revenue</div><div class="stat-value">${money(stats.revenue)}</div></div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-header"><h3 class="card-title">Food Items</h3><button class="btn btn-primary btn-sm" id="addMenuItemBtn">Add Item</button></div>
      <div class="card-body">
        <table class="data-table"><tr><th>Item</th><th>Price</th><th>Capacity</th><th>Sold</th><th>Redeemed</th><th>Pending Pickup</th><th>Active</th><th></th></tr>
        ${activeEventMenu.map(item => {
          const row = stats.perItem.find(r => r.itemName === item.itemName) || { redeemed: 0, pending: 0 };
          return `<tr>
            <td>${esc(item.itemName)}${item.foodType === "non-veg" ? " 🍗" : " 🥦"}</td>
            <td>${money(item.price)}</td>
            <td>${Number(item.availableQuantity || 0)}</td>
            <td>${Number(item.soldQuantity || 0)}</td>
            <td>${row.redeemed}</td>
            <td>${row.pending}</td>
            <td>${item.active !== false ? "Yes" : "No"}</td>
            <td><button class="btn btn-outline btn-sm edit-menu-item" data-id="${item.id}">Edit</button></td>
          </tr>`;
        }).join("") || `<tr><td colspan="8">No food items yet. Add one to start selling bookings.</td></tr>`}
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><h3 class="card-title">Bookings</h3></div>
      <div class="card-body">
        <table class="data-table"><tr><th>Booking</th><th>Item</th><th>Customer</th><th>Status</th><th>Payment</th><th>Pickup</th><th></th></tr>
        ${(bookingsByEvent.get(ev.id) || []).slice().sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)).map(b => `
          <tr>
            <td>${esc(b.bookingCode)}</td>
            <td>${esc(b.itemNameSnapshot)}</td>
            <td>${esc(b.customerName)}<br><span class="small muted">${esc(b.customerPhone)}</span></td>
            <td>${esc(b.bookingStatus)}</td>
            <td>${esc(b.paymentStatus)}</td>
            <td>${b.redeemed ? "Redeemed" : "Not yet"}</td>
            <td>${(b.bookingStatus === "confirmed" && !b.redeemed) ? `<button class="btn btn-outline btn-sm cancel-booking" data-id="${b.id}">Cancel & Refund</button>` : ""}</td>
          </tr>
        `).join("") || `<tr><td colspan="7">No bookings yet.</td></tr>`}
        </table>
      </div>
    </div>
  `;

  body.querySelectorAll(".cancel-booking").forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm("Cancel this booking? If it was paid, a refund will be issued automatically.")) return;
    btn.disabled = true; btn.textContent = "Cancelling...";
    try {
      const response = await fetch(`${getBackendBaseUrl()}/api/event-bookings/cancel`, {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify({ bookingId: btn.dataset.id })
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Could not cancel booking.");
    } catch (error) {
      alert(error.message || "Could not cancel booking.");
      btn.disabled = false; btn.textContent = "Cancel & Refund";
    }
  }));

  document.getElementById("editEventBtn")?.addEventListener("click", () => {
    openModal("Edit Event", eventFormHtml(ev), async () => {
      const form = readEventForm();
      if (!form.eventName) throw new Error("Event name is required.");
      const { bookingStartLocal, bookingEndLocal, ...rest } = form;
      await setDoc(doc(db, "events", ev.id), rest, { merge: true });
    });
  });

  document.getElementById("downloadEventQrBtn")?.addEventListener("click", () => downloadEventQr(ev, pickupUrl));

  document.getElementById("addMenuItemBtn")?.addEventListener("click", () => {
    openModal("Add Food Item", menuItemFormHtml(), async () => {
      const itemName = document.getElementById("miName")?.value.trim() || "";
      if (!itemName) throw new Error("Item name is required.");
      const price = Number(document.getElementById("miPrice")?.value || 0);
      if (!(price > 0)) throw new Error("Enter a valid price.");
      await addDoc(collection(db, "events", ev.id, "menu"), {
        itemName,
        description: document.getElementById("miDescription")?.value.trim() || "",
        imageUrl: document.getElementById("miImage")?.value.trim() || "",
        foodType: document.getElementById("miFoodType")?.value || "veg",
        price,
        availableQuantity: Number(document.getElementById("miQty")?.value || 0),
        soldQuantity: 0,
        active: true,
        sortOrder: activeEventMenu.length
      });
    });
  });

  body.querySelectorAll(".edit-menu-item").forEach(btn => btn.addEventListener("click", () => {
    const item = activeEventMenu.find(m => m.id === btn.dataset.id);
    if (!item) return;
    openModal("Edit Food Item", menuItemFormHtml(item) + `<label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="miActive" ${item.active !== false ? "checked" : ""}/> Active (visible for booking)</label>`, async () => {
      const itemName = document.getElementById("miName")?.value.trim() || "";
      if (!itemName) throw new Error("Item name is required.");
      await setDoc(doc(db, "events", ev.id, "menu", item.id), {
        itemName,
        description: document.getElementById("miDescription")?.value.trim() || "",
        imageUrl: document.getElementById("miImage")?.value.trim() || "",
        foodType: document.getElementById("miFoodType")?.value || "veg",
        price: Number(document.getElementById("miPrice")?.value || 0),
        availableQuantity: Number(document.getElementById("miQty")?.value || 0),
        active: document.getElementById("miActive")?.checked !== false
      }, { merge: true });
    });
  }));
}

async function downloadEventQr(ev, url) {
  try {
    await loadQrLibrary();
    const holder = document.createElement("div");
    holder.style.cssText = "position:fixed;left:-9999px;top:-9999px";
    document.body.appendChild(holder);
    new window.QRCode(holder, { text: url, width: 480, height: 480, correctLevel: window.QRCode.CorrectLevel.M });
    await new Promise(r => setTimeout(r, 150)); // qrcodejs renders synchronously via canvas/table but a tick keeps this safe across its two render modes
    const canvas = holder.querySelector("canvas");
    const dataUrl = canvas ? canvas.toDataURL("image/png") : holder.querySelector("img")?.src;
    if (!dataUrl) throw new Error("QR render failed.");

    const composite = document.createElement("canvas");
    composite.width = 600; composite.height = 720;
    const ctx = composite.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, composite.width, composite.height);
    ctx.fillStyle = "#111"; ctx.textAlign = "center"; ctx.font = "bold 26px Arial";
    ctx.fillText("Scan to Pre-Book Food", composite.width / 2, 44);
    ctx.font = "20px Arial";
    ctx.fillText(String(ev.eventName || "").slice(0, 40), composite.width / 2, 76);
    ctx.font = "16px Arial"; ctx.fillStyle = "#555";
    ctx.fillText(String(ev.eventDate || ""), composite.width / 2, 102);

    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
    ctx.drawImage(img, 60, 130, 480, 480);
    document.body.removeChild(holder);

    const a = document.createElement("a");
    a.href = composite.toDataURL("image/png");
    a.download = `event-qr-${slugify(ev.eventName) || ev.id}.png`;
    a.click();
  } catch (error) {
    alert("Could not generate QR: " + (error?.message || error));
  }
}
