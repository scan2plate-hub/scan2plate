// Public Event Food Pre-Booking page. Fully isolated from the restaurant
// QR table-ordering flow (customer-order.js) - own Firestore reads
// (events / events/{id}/menu, both public per Firestore rules - see this
// feature's security-rules note), own backend endpoints
// (/api/event-bookings/*), no shared state with the table-ordering cart.
//
// Frontend never decides payment success or price: create-payment returns
// a server-computed amount, and the pickup QR is only ever rendered from
// the verify-payment response after the backend has confirmed the
// Razorpay signature and atomically confirmed stock (Part 7/8).
import { db } from "./firebase.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { installAppSafety, getBackendBaseUrl, normalizeCustomerPhone } from "./common.js";

installAppSafety({ pageName: "Event Pre-Booking", stuckTimeoutMs: 18000 });

const params = new URLSearchParams(location.search);
const eventSlug = params.get("slug") || "";

const loadingEl = document.getElementById("eventLoading");
const errorEl = document.getElementById("eventError");
const bookingViewEl = document.getElementById("eventBookingView");
const confirmedViewEl = document.getElementById("eventConfirmedView");

function showError(message) {
  loadingEl.style.display = "none";
  bookingViewEl.style.display = "none";
  errorEl.style.display = "block";
  errorEl.textContent = message;
}

function money(v) { return `₹${Number(v || 0).toFixed(0)}`; }
function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

let event = null;
let menu = [];
let selectedItemId = null;

function formatBookingWindowNote(ev) {
  const now = Date.now();
  const start = ev.bookingStartAt?.toMillis ? ev.bookingStartAt.toMillis() : null;
  const end = ev.bookingEndAt?.toMillis ? ev.bookingEndAt.toMillis() : null;
  if (start && now < start) return `Bookings open on ${new Date(start).toLocaleString("en-IN")}`;
  if (end && now > end) return "Online pre-booking is closed.";
  if (end) return `Booking closes ${new Date(end).toLocaleString("en-IN")}`;
  return "";
}

function bookingIsOpen(ev) {
  if (ev.status !== "active") return false;
  const now = Date.now();
  const start = ev.bookingStartAt?.toMillis ? ev.bookingStartAt.toMillis() : null;
  const end = ev.bookingEndAt?.toMillis ? ev.bookingEndAt.toMillis() : null;
  if (start && now < start) return false;
  if (end && now > end) return false;
  return true;
}

function renderMenu() {
  const list = document.getElementById("menuList");
  const open = bookingIsOpen(event);
  list.innerHTML = menu.map(item => {
    const soldOut = item.active === false || Number(item.soldQuantity || 0) >= Number(item.availableQuantity || 0);
    const selected = selectedItemId === item.id;
    return `
      <div class="event-menu-card ${selected ? "selected" : ""} ${soldOut ? "sold-out" : ""}" data-id="${item.id}">
        ${item.imageUrl ? `<img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" />` : `<div style="width:64px;height:64px;border-radius:10px;background:#f2f2f2;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:22px">${item.foodType === "non-veg" ? "🍗" : "🥦"}</div>`}
        <div class="event-menu-card-body">
          <h3>${escapeHtml(item.itemName)}</h3>
          ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
          <div class="event-menu-price">${money(item.price)}</div>
        </div>
        <button type="button" class="event-menu-select-btn" data-id="${item.id}" ${soldOut || !open ? "disabled" : ""}>${soldOut ? "Sold Out" : selected ? "Selected" : "Select"}</button>
      </div>
    `;
  }).join("") || `<p class="event-error-text">No food items are available for this event yet.</p>`;

  list.querySelectorAll(".event-menu-select-btn:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => {
      // Only one item type per booking (Part 2's maxItemTypesPerBooking = 1)
      // - selecting another item replaces the previous selection, never adds to it.
      selectedItemId = btn.dataset.id;
      renderMenu();
      document.getElementById("detailsSection").style.display = "block";
      document.getElementById("detailsSection").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

async function loadEvent() {
  if (!eventSlug) return showError("No event specified. Please use the link or QR code provided for this event.");
  try {
    const snap = await getDocs(query(collection(db, "events"), where("eventSlug", "==", eventSlug)));
    if (snap.empty) return showError("Event not found.");
    event = { id: snap.docs[0].id, ...snap.docs[0].data() };

    const menuSnap = await getDocs(collection(db, "events", event.id, "menu"));
    menu = menuSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    document.getElementById("evName").textContent = event.eventName || "";
    document.getElementById("evDate").textContent = [event.eventDate, event.eventStartTime].filter(Boolean).join(" · ");
    document.getElementById("evVenue").textContent = [event.venueName, event.city].filter(Boolean).join(", ");
    document.getElementById("evBookingClose").textContent = formatBookingWindowNote(event);
    document.getElementById("evDescription").textContent = event.description || "";

    loadingEl.style.display = "none";
    if (!bookingIsOpen(event)) {
      document.getElementById("detailsSection").style.display = "none";
    }
    bookingViewEl.style.display = "block";
    renderMenu();
  } catch (error) {
    showError("Could not load this event. Please refresh and try again.");
  }
}

function loadRazorpayScript() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const check = () => window.Razorpay ? resolve() : setTimeout(check, 100);
    check();
    setTimeout(() => window.Razorpay ? resolve() : reject(new Error("Could not load payment gateway. Check your connection.")), 8000);
  });
}

async function startPayment() {
  const payBtn = document.getElementById("payBtn");
  const errorText = document.getElementById("payError");
  errorText.style.display = "none";
  if (!selectedItemId) { errorText.textContent = "Select a food item first."; errorText.style.display = "block"; return; }
  const name = document.getElementById("custName").value.trim();
  const phone = normalizeCustomerPhone(document.getElementById("custPhone").value);
  const email = document.getElementById("custEmail").value.trim();
  if (!name) { errorText.textContent = "Enter your name."; errorText.style.display = "block"; return; }
  if (phone.length !== 10) { errorText.textContent = "Enter a valid 10-digit phone number."; errorText.style.display = "block"; return; }

  payBtn.disabled = true;
  payBtn.textContent = "Please wait...";
  try {
    const backendUrl = getBackendBaseUrl();
    const createResponse = await fetch(`${backendUrl}/api/event-bookings/create-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: event.id, itemId: selectedItemId, customerName: name, customerPhone: phone, customerEmail: email })
    });
    const createResult = await createResponse.json();
    if (!createResponse.ok || !createResult.success) throw new Error(createResult.error || "Could not start checkout.");

    await loadRazorpayScript();
    const razorpay = new window.Razorpay({
      key: createResult.publicKeyId,
      amount: createResult.amount,
      currency: createResult.currency,
      name: "Scan2Plate Event Pre-Booking",
      description: `${createResult.eventName} — ${createResult.itemName}`,
      order_id: createResult.razorpayOrderId,
      prefill: { name, contact: phone, email },
      theme: { color: "#d88a1d" },
      handler: async response => {
        payBtn.textContent = "Verifying payment...";
        try {
          const verifyResponse = await fetch(`${backendUrl}/api/event-bookings/verify-payment`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature
            })
          });
          const verifyResult = await verifyResponse.json();
          if (!verifyResponse.ok || !verifyResult.success) throw new Error(verifyResult.error || "Payment verification failed.");
          await showConfirmed(verifyResult);
        } catch (error) {
          errorText.textContent = error.message || "Payment verification failed. If money was deducted, it will be refunded automatically if the booking could not be confirmed.";
          errorText.style.display = "block";
          payBtn.disabled = false;
          payBtn.textContent = "Pay & Book";
        }
      },
      modal: {
        ondismiss: () => {
          payBtn.disabled = false;
          payBtn.textContent = "Pay & Book";
        }
      }
    });
    razorpay.on("payment.failed", () => {
      errorText.textContent = "Payment was not completed. No booking was created.";
      errorText.style.display = "block";
      payBtn.disabled = false;
      payBtn.textContent = "Pay & Book";
    });
    razorpay.open();
  } catch (error) {
    errorText.textContent = error.message || "Could not start checkout.";
    errorText.style.display = "block";
    payBtn.disabled = false;
    payBtn.textContent = "Pay & Book";
  }
}

document.getElementById("payBtn")?.addEventListener("click", startPayment);

async function showConfirmed(result) {
  bookingViewEl.style.display = "none";
  confirmedViewEl.style.display = "block";
  const pickupUrl = `${location.origin}/event-pickup.html?token=${encodeURIComponent(result.pickupToken)}`;

  confirmedViewEl.innerHTML = `
    <div class="event-confirm-card">
      <div class="event-confirm-badge">✅ Booking Confirmed</div>
      <div class="event-confirm-row"><span>Event</span><strong>${escapeHtml(result.eventName || event.eventName)}</strong></div>
      <div class="event-confirm-row"><span>Food</span><strong>${escapeHtml(result.itemName)}</strong></div>
      <div class="event-confirm-row"><span>Payment</span><strong style="color:#16a34a">PAID</strong></div>
      <div class="event-confirm-row"><span>Booking ID</span><strong>${escapeHtml(result.bookingCode)}</strong></div>
      <h3 style="margin:18px 0 4px">Your Pickup QR</h3>
      <div class="event-qr-wrap" id="pickupQrWrap"></div>
      <p>Show this QR at the food pickup counter.</p>
      <p class="event-qr-share-note">You may share this QR with another person if they are collecting your food.</p>
      <div class="event-qr-warning"><strong>This QR works only once.</strong> Once redeemed, it cannot be used again.</div>
      <div class="event-confirm-actions">
        <button type="button" class="btn btn-outline" id="saveQrBtn">Save QR</button>
        <button type="button" class="btn btn-outline" id="shareQrBtn">Share</button>
      </div>
    </div>
  `;

  const qrHolder = document.getElementById("pickupQrWrap");
  new window.QRCode(qrHolder, { text: pickupUrl, width: 220, height: 220, correctLevel: window.QRCode.CorrectLevel.M });

  document.getElementById("saveQrBtn")?.addEventListener("click", () => {
    setTimeout(() => {
      const canvas = qrHolder.querySelector("canvas");
      const dataUrl = canvas ? canvas.toDataURL("image/png") : qrHolder.querySelector("img")?.src;
      if (!dataUrl) return;
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `scan2plate-pickup-${result.bookingCode}.png`;
      a.click();
    }, 50);
  });

  document.getElementById("shareQrBtn")?.addEventListener("click", async () => {
    const shareText = `My Scan2Plate event pickup QR for ${result.eventName || event.eventName}: ${pickupUrl}`;
    if (navigator.share) {
      try { await navigator.share({ title: "Scan2Plate Pickup QR", text: shareText, url: pickupUrl }); }
      catch { /* user cancelled share - not an error */ }
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(shareText);
      alert("Pickup link copied to clipboard.");
    }
  });
}

loadEvent();
