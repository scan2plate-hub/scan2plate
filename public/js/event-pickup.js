// Event Pickup Scanner - staff-facing, protected page (Part 11). Validates
// a scanned pickup QR (read-only preview) then requires an explicit
// "Redeem & Hand Over" tap before ever mutating anything - the backend
// /api/event-bookings/redeem call is the only thing that can actually mark
// a booking redeemed, inside a Firestore transaction (see backend/server.js
// and backend/lib/eventBookingLogic.js). This page never redeems locally,
// including when offline (Part 21) - it has no fallback "assume success"
// path by design, since one-time redemption requires centralized atomic
// validation across every staff device at the event, not just this one.
import { auth, db } from "./firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { installAppSafety, getBackendBaseUrl, canAccessModule, readValidatedLocal } from "./common.js";

installAppSafety({ pageName: "Event Pickup Scanner", stuckTimeoutMs: 15000 });

const rawUser = localStorage.getItem("scan2plate_user") || localStorage.getItem("scan2serve_user");
if (!rawUser) {
  alert("Please login first.");
  location.href = "./admin-login.html";
  throw new Error("No login data");
}
const currentUser = readValidatedLocal(localStorage.getItem("scan2plate_user") ? "scan2plate_user" : "scan2serve_user", null, v => v && typeof v === "object");
if (!currentUser) {
  alert("Login session invalid. Please login again.");
  location.href = "./admin-login.html";
  throw new Error("Invalid login data");
}
if (!canAccessModule(currentUser.role, "eventPickup")) {
  alert("Your account does not have access to the Event Pickup Scanner.");
  location.href = "./admin-dashboard.html";
  throw new Error("Not authorized for eventPickup");
}
const restaurantId = currentUser.restaurantId || localStorage.getItem("scan2plate_last_restaurant_id");

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  auth.signOut().finally(() => { location.href = "./admin-login.html"; });
});

function extractToken(scannedText) {
  const text = String(scannedText || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    const fromParam = url.searchParams.get("token");
    if (fromParam) return fromParam;
  } catch { /* not a URL - treat as a raw token/manual code */ }
  return text;
}

async function authHeaders() {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Session expired. Please login again.");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

const overlayEl = document.getElementById("scannerOverlay");
const resultScreenEl = document.getElementById("resultScreen");
const resultBodyEl = document.getElementById("resultBody");
let currentToken = "";

function setOverlay(text) { if (overlayEl) overlayEl.textContent = text; }

function renderResult(state, html) {
  resultScreenEl.className = `result-screen ${state}`;
  resultBodyEl.innerHTML = html;
  resultScreenEl.style.display = "block";
  document.getElementById("startScanBtn").style.display = "none";
  document.querySelector(".scanner-manual").style.display = "none";
  document.querySelector(".scanner-camera-wrap").style.display = "none";
}

function resetScanner() {
  resultScreenEl.style.display = "none";
  document.getElementById("startScanBtn").style.display = "block";
  document.querySelector(".scanner-manual").style.display = "block";
  document.querySelector(".scanner-camera-wrap").style.display = "block";
  setOverlay("READY TO SCAN");
  currentToken = "";
}
document.getElementById("scanAgainBtn")?.addEventListener("click", resetScanner);

async function checkToken(token) {
  currentToken = token;
  setOverlay("Checking...");
  let response, result;
  try {
    const backendUrl = getBackendBaseUrl();
    response = await fetch(`${backendUrl}/api/event-bookings/validate`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ token, restaurantId })
    });
    result = await response.json();
  } catch (error) {
    renderResult("amber", `
      <div class="result-icon">📶</div>
      <div class="result-title">NETWORK ERROR</div>
      <p>Network connection required to verify and redeem this pickup.</p>
      <div class="result-actions"><button class="scanner-btn scanner-btn-primary" id="retryBtn">Retry</button></div>
    `);
    document.getElementById("retryBtn")?.addEventListener("click", () => checkToken(currentToken));
    return;
  }

  if (result?.code === "valid") {
    const b = result.booking;
    renderResult("valid", `
      <div class="result-icon">✅</div>
      <div class="result-title">VALID BOOKING</div>
      <div class="result-row"><span>Item</span><strong>${escapeHtml(b.itemName)}</strong></div>
      <div class="result-row"><span>Payment</span><strong>PAID</strong></div>
      <div class="result-row"><span>Status</span><strong>NOT REDEEMED</strong></div>
      <div class="result-row"><span>Booking</span><strong>${escapeHtml(b.bookingCode)}</strong></div>
      <div class="result-row"><span>Customer</span><strong>${escapeHtml(b.customerNameMasked)} ${escapeHtml(b.customerPhoneMasked)}</strong></div>
      <div class="result-actions"><button class="scanner-btn scanner-btn-primary" id="redeemBtn">Redeem &amp; Hand Over</button></div>
    `);
    document.getElementById("redeemBtn")?.addEventListener("click", () => redeemToken(token));
    return;
  }

  if (result?.code === "already_redeemed") {
    const b = result.booking;
    return renderResult("error", `
      <div class="result-icon">❌</div>
      <div class="result-title">ALREADY REDEEMED</div>
      <div class="result-row"><span>Food</span><strong>${escapeHtml(b?.itemName || "")}</strong></div>
      <div class="result-row"><span>Redeemed at</span><strong>${formatFirestoreTimestamp(b?.redeemedAt)}</strong></div>
    `);
  }

  // invalid_token, wrong_event, cancelled, not_paid, or any other rejection
  // - never reveal backend details to the person holding the phone (Part 15).
  renderResult("error", `
    <div class="result-icon">❌</div>
    <div class="result-title">INVALID PICKUP QR</div>
    <p>This QR is not valid for pickup.</p>
  `);
}

async function redeemToken(token) {
  const redeemBtn = document.getElementById("redeemBtn");
  if (redeemBtn) { redeemBtn.disabled = true; redeemBtn.textContent = "Redeeming..."; }
  try {
    const backendUrl = getBackendBaseUrl();
    const response = await fetch(`${backendUrl}/api/event-bookings/redeem`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ token, restaurantId })
    });
    const result = await response.json();
    if (result.success) {
      renderResult("valid", `
        <div class="result-icon">✅</div>
        <div class="result-title">REDEEMED</div>
        <div class="result-row"><span>Item</span><strong>${escapeHtml(result.itemName)}</strong></div>
        <div class="result-row"><span>Booking</span><strong>${escapeHtml(result.bookingCode)}</strong></div>
        <p>Hand over the food now.</p>
      `);
    } else if (result.code === "already_redeemed") {
      // Another device won the race between this scan and the tap -
      // Firestore's transaction serialization is what guarantees exactly
      // one of the two concurrent attempts ends up here.
      renderResult("error", `<div class="result-icon">❌</div><div class="result-title">ALREADY REDEEMED</div><p>This QR was just redeemed on another device.</p>`);
    } else {
      renderResult("error", `<div class="result-icon">❌</div><div class="result-title">COULD NOT REDEEM</div><p>${escapeHtml(result.error || "Please try again.")}</p>`);
    }
  } catch (error) {
    renderResult("amber", `
      <div class="result-icon">📶</div>
      <div class="result-title">NETWORK ERROR</div>
      <p>Network connection required to verify and redeem this pickup.</p>
      <div class="result-actions"><button class="scanner-btn scanner-btn-primary" id="retryRedeemBtn">Retry</button></div>
    `);
    document.getElementById("retryRedeemBtn")?.addEventListener("click", () => redeemToken(token));
  }
}

// Firestore Admin Timestamp objects serialize over JSON in slightly
// different shapes depending on SDK version ({_seconds}/{seconds}/ISO
// string) - handled defensively since this is a display detail, not a
// security-relevant one.
function formatFirestoreTimestamp(value) {
  if (!value) return "-";
  const seconds = value._seconds ?? value.seconds;
  const ms = seconds != null ? seconds * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) return "-";
  return new Date(ms).toLocaleTimeString("en-IN");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

/* ===== Camera scanning (jsQR + getUserMedia). Manual entry (below) is a
   full-featured fallback, not a degraded one, per Part 11. ===== */
let stream = null, scanRafId = null;
async function startCameraScan() {
  const video = document.getElementById("scannerVideo");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!window.jsQR) { alert("QR scanning library failed to load. Use manual entry below."); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch {
    alert("Camera access is unavailable. Use manual entry below.");
    return;
  }
  video.srcObject = stream;
  await video.play();
  setOverlay("Scanning...");

  const tick = () => {
    if (!stream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(imageData.data, imageData.width, imageData.height);
      if (code?.data) {
        stopCameraScan();
        checkToken(extractToken(code.data));
        return;
      }
    }
    scanRafId = requestAnimationFrame(tick);
  };
  scanRafId = requestAnimationFrame(tick);
}
function stopCameraScan() {
  if (scanRafId) cancelAnimationFrame(scanRafId);
  scanRafId = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
}

document.getElementById("startScanBtn")?.addEventListener("click", startCameraScan);
document.getElementById("manualSubmitBtn")?.addEventListener("click", () => {
  const value = document.getElementById("manualTokenInput").value.trim();
  if (!value) return;
  stopCameraScan();
  checkToken(extractToken(value));
});

// If this page is opened directly from a scanned QR (e.g. a generic camera
// app, not this in-app scanner), validate that token immediately.
const directToken = new URLSearchParams(location.search).get("token");
if (directToken) checkToken(directToken);
