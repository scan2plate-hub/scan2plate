/* =========================================================
   NIGHT AUDIT PAGE

   The screen a manager closes the day from. Deliberately the only
   way it happens: nothing on this page runs on a timer, and
   opening it does not close anything.

   Order matters here and is not decorative. What is BLOCKING
   comes first, then what needs acknowledging, then the numbers,
   then the one button. A manager running this at 2am should not
   have to hunt for the reason it will not close.
========================================================= */
import { db, auth } from "./firebase.js?v=s2p-20260922d";
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
  runTransaction, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  installAppSafety, readValidatedLocal, resolveActiveRestaurantId, devError, getBusinessDate
} from "./common.js?v=s2p-20260922d";
import { propertyToday, round2, normalizeHotelRole } from "./hotel-core.js?v=s2p-20260922d";
import {
  createNightAuditService, AuditError, auditReadiness, auditTotals, expectedAuditDate
} from "./hotel-night-audit.js?v=s2p-20260922d";

installAppSafety({ pageName: "Night Audit", stuckTimeoutMs: 20000 });

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
  role: session.role || "manager"
};

const state = { readiness: null, totals: null, acknowledged: new Set(), schedule: null, loaded: false };

const service = createNightAuditService({
  db, restaurantId,
  firestore: { doc, collection, runTransaction, writeBatch, serverTimestamp }
});

const folioIdFor = reservationId => `FOL_${reservationId}`;

/* ---------------------------------------------------------
   RENDER
--------------------------------------------------------- */
function render() {
  if (!state.loaded) return;
  const { readiness, totals, schedule } = state;

  $("naDate").textContent = readiness.businessDate || "—";
  $("naSubtitle").textContent = schedule?.behindBy
    ? `${schedule.behindBy} day${schedule.behindBy === 1 ? "" : "s"} behind — closing ${readiness.businessDate} first`
    : `Closing ${readiness.businessDate}`;

  const blocks = readiness.blocking.map(item =>
    `<div class="na-block">${esc(item.label)}</div>`).join("");
  const warnings = readiness.warnings.map(warning => `
    <div class="na-warn"><label>
      <input type="checkbox" data-ack="${esc(warning.id)}"${state.acknowledged.has(warning.id) ? " checked" : ""}>
      <span>${esc(warning.label)}</span>
    </label></div>`).join("");

  $("naChecks").innerHTML = blocks + warnings
    || `<div class="na-ok">Nothing outstanding. This day is ready to close.</div>`;

  $("naCharges").innerHTML = readiness.counts.roomChargesDue
    ? `<p style="margin-top:0">${readiness.counts.roomChargesDue} in-house guest${
        readiness.counts.roomChargesDue === 1 ? "" : "s"} to be charged for tonight —
        <strong>${esc(money(readiness.counts.roomChargeTotal))}</strong>.</p>
      <p class="na-hint" style="margin-bottom:0">Each night is charged at the rate agreed when the booking was made, and posts once however many times this runs.</p>`
    : `<p class="na-hint" style="margin:0">No room charges due tonight.</p>`;

  $("naStats").innerHTML = [
    ["Occupancy", `${totals.occupancy}%`],
    ["ADR", money(totals.adr)],
    ["RevPAR", money(totals.revpar)],
    ["Room nights", totals.roomNightsSold],
    ["In house", totals.inHouse],
    ["Arrivals", totals.arrivals],
    ["Departures", totals.departures],
    ["Collected", money(totals.collection.net)]
  ].map(([label, value]) => `<div class="na-stat"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("");

  const revenueRows = Object.entries(totals.revenue.byKind)
    .map(([kind, amount]) => `<tr><td>${esc(kind.replace(/_/g, " "))}</td><td>${esc(money(amount))}</td></tr>`).join("");
  const methodRows = Object.entries(totals.collection.byMethod)
    .map(([method, amount]) => `<tr><td>${esc(method.replace(/_/g, " "))}</td><td>${esc(money(amount))}</td></tr>`).join("");
  $("naBreakdown").innerHTML = `
    ${revenueRows ? `<tr><td colspan="2" class="na-hint">Revenue</td></tr>${revenueRows}
      <tr><td><strong>Total</strong></td><td>${esc(money(totals.revenue.total))}</td></tr>` : ""}
    ${methodRows ? `<tr><td colspan="2" class="na-hint" style="padding-top:14px">Collected by method</td></tr>${methodRows}
      ${totals.collection.refunded ? `<tr><td>Refunded</td><td>−${esc(money(totals.collection.refunded))}</td></tr>` : ""}` : ""}
    ${!revenueRows && !methodRows ? `<tr><td class="na-hint">Nothing posted on this day.</td></tr>` : ""}`;

  const unacknowledged = readiness.warnings.some(warning => !state.acknowledged.has(warning.id));
  const isManager = normalizeHotelRole(actor.role) === "manager";
  const button = $("naClose");
  button.disabled = !readiness.canRun || unacknowledged || !isManager;
  button.textContent = !isManager ? "Only a manager can close the day"
    : !readiness.canRun ? "Resolve the items above first"
    : unacknowledged ? "Acknowledge the items above"
    : `Close ${readiness.businessDate}`;
}

/* ---------------------------------------------------------
   ACTIONS
--------------------------------------------------------- */
let busy = false;
async function guarded(work) {
  if (busy) return;
  busy = true;
  document.body.classList.add("na-busy");
  try { await work(); }
  catch (error) {
    if (error instanceof AuditError) alert(error.message);
    else { devError("night audit", error); alert("Could not complete that. Check your connection and try again."); }
  } finally {
    busy = false;
    document.body.classList.remove("na-busy");
  }
}

document.body.addEventListener("click", event => {
  if (event.target.id === "naFrontDesk") { location.assign("./hotel-front-desk.html"); return; }

  const ack = event.target.closest("[data-ack]")?.dataset.ack;
  if (ack) {
    if (state.acknowledged.has(ack)) state.acknowledged.delete(ack);
    else state.acknowledged.add(ack);
    render();
    return;
  }

  if (event.target.id === "naClose") return guarded(async () => {
    const { readiness, totals } = state;
    if (!confirm(`Close ${readiness.businessDate}?\n\nRoom charges post first. Once closed, this day's record can never be edited.`)) return;

    // Charges first, and separately: they are safe to retry, so a failure
    // after this point does not lose them.
    await service.postRoomCharges({
      charges: readiness.charges, folioIdFor, actor,
      taxPercent: Number(state.settings?.roomTaxPercent || 0)
    });
    const result = await service.closeDay({
      readiness, totals, actor,
      acknowledgedWarnings: [...state.acknowledged],
      notes: $("naNotes").value.trim()
    });
    alert(result.duplicate
      ? `${readiness.businessDate} was already closed.`
      : `${readiness.businessDate} closed.`);
    await load();
  });
});

/* ---------------------------------------------------------
   LOAD

   One read per collection, on demand. This page is opened once a
   night and every figure on it must be a settled fact, so nothing
   here is a live listener: a number that moves while a manager is
   reading it is worse than one they refresh themselves.
--------------------------------------------------------- */
async function load() {
  const settingsSnapshot = await getDoc(doc(db, "restaurants", restaurantId, "settings", "general")).catch(() => null);
  state.settings = settingsSnapshot?.exists() ? settingsSnapshot.data() : {};

  // Which day is next to close — the one after the last closed, not
  // whatever today happens to be in the browser.
  let lastAuditDate = "";
  try {
    const lastAudit = await getDocs(query(
      collection(db, "hotelNightAudits"),
      where("restaurantId", "==", restaurantId),
      orderBy("businessDate", "desc"), limit(1)
    ));
    lastAuditDate = lastAudit.docs[0]?.data()?.businessDate || "";
  } catch (error) {
    // Missing index or no audits yet. Falling back to today is safe: the
    // close itself is idempotent per business date, so the worst case is a
    // duplicate attempt that returns the existing record.
    devError("last night audit unavailable", error);
  }
  state.schedule = expectedAuditDate(getBusinessDate, state.settings, lastAuditDate);
  const businessDate = state.schedule.next || propertyToday(getBusinessDate, state.settings);

  const [reservations, folios, shifts, rooms, items, payments] = await Promise.all([
    getDocs(collection(db, "restaurants", restaurantId, "hotel_reservations")),
    getDocs(collection(db, "restaurants", restaurantId, "hotel_folios")),
    getDocs(collection(db, "restaurants", restaurantId, "hotel_cashier_shifts")),
    getDocs(collection(db, "restaurants", restaurantId, "hotel_rooms")),
    getDocs(query(collection(db, "restaurants", restaurantId, "hotel_folio_items"),
      where("businessDate", "==", businessDate))).catch(() => ({ docs: [] })),
    getDocs(query(collection(db, "hotelPayments"),
      where("restaurantId", "==", restaurantId), where("businessDate", "==", businessDate))).catch(() => ({ docs: [] }))
  ]);
  const rows = snapshot => snapshot.docs.map(item => ({ id: item.id, ...item.data() }));

  state.readiness = auditReadiness({
    businessDate,
    reservations: rows(reservations),
    folios: rows(folios),
    shifts: rows(shifts),
    rooms: rows(rooms)
  });
  state.totals = auditTotals({
    businessDate,
    rooms: rows(rooms),
    reservations: rows(reservations),
    folioItems: rows(items),
    payments: rows(payments)
  });
  state.acknowledged = new Set();
  state.loaded = true;
  render();
}

load().catch(error => {
  devError("night audit load", error);
  $("naSubtitle").textContent = "Could not load the day. Check your connection and reload.";
});

export { state, render };
