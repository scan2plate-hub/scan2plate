/* =========================================================
   SELF-SERVICE RENEWAL

   The page an expired business lands on. It exists because
   without it the product had a dead end: login.js blocks an
   expired account and signs it out, the dashboard is locked,
   and renew.html used to say "contact Scan2Plate admin". A
   customer who wanted to pay had no way to.

   Deliberately narrow. This page can do exactly one thing —
   buy a subscription for the business the signed-in user
   already owns. It grants no dashboard access, reads no
   business data beyond what it must show, and leaves every
   existing gate (login.js, checkRestaurantSubscription) exactly
   as it was. Access returns only when Razorpay's webhook says
   the payment happened.
========================================================= */
import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { pricingFor, startSubscription, openRazorpayCheckout, watchSubscription, loadBusiness } from "./subscription-client.js?v=renew-20260918";
import { formatMoney, isEntitled } from "./subscription-core.js?v=renew-20260918";
import { businessTypeLabel } from "./business-types.js?v=renew-20260918";

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

let business = null;
let cycle = "monthly";
let quotes = [];
let unwatch = null;

/* The business is taken from the session login.js stored, never from the URL:
   a business id in a query string is something anyone can edit. The backend
   checks ownership again on every call regardless. */
function sessionBusinessId() {
  for (const key of ["scan2plate_user", "scan2serve_user"]) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "{}");
      if (raw.restaurantId) return String(raw.restaurantId);
    } catch { /* fall through to the next key */ }
  }
  return String(localStorage.getItem("scan2plate_last_restaurant_id") || "");
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    // Signed out, or the session expired while the tab sat open. There is
    // nothing to renew without knowing who is asking.
    $("renewBody").innerHTML = `<div class="renew-msg muted">Please <a href="./admin-login.html">log in</a> to renew your plan.</div>`;
    $("renewBusiness").textContent = "";
    return;
  }
  const businessId = sessionBusinessId();
  if (!businessId) {
    $("renewBody").innerHTML = `<div class="renew-msg muted">We could not identify your business. Please <a href="./admin-login.html">log in again</a>.</div>`;
    return;
  }
  try {
    business = await loadBusiness(businessId);
    if (!business) throw new Error("not found");
  } catch {
    $("renewBody").innerHTML = `<div class="renew-msg muted">We could not load your account. Please <a href="./admin-login.html">log in again</a>.</div>`;
    return;
  }

  $("renewBusiness").textContent = `${business.restaurantName || business.businessName || businessId} · ${businessTypeLabel(business.businessType)}`;
  showExpiryNotice();
  watchForActivation(businessId);
  await renderPlans();
});

function showExpiryNotice() {
  const host = $("renewStatus");
  if (!host) return;
  const raw = business.planExpiryDate || business.expiryDate;
  const date = raw ? new Date(raw.toDate ? raw.toDate() : raw.seconds ? raw.seconds * 1000 : raw) : null;
  const when = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "";
  host.innerHTML = `<strong>Your plan has expired${when ? ` (${esc(when)})` : ""}.</strong>
    Pick a plan below to restore access. Your menu, orders, staff and reports are all still here &mdash; nothing was deleted.`;
  host.classList.remove("hidden");
}

/* The webhook is what actually restores access, so the page watches for it
   rather than trusting the checkout callback. This is also what makes the
   success state appear without the customer refreshing. */
function watchForActivation(businessId) {
  unwatch?.();
  unwatch = watchSubscription(businessId, subscription => {
    if (subscription && isEntitled(subscription)) showActivated();
  }, error => console.warn("subscription watch failed", error?.message));
}

function showActivated() {
  unwatch?.();
  $("renewStatus")?.classList.add("hidden");
  $("renewBody").innerHTML = `
    <div class="renew-done">
      <i class="fa-solid fa-circle-check" style="font-size:38px"></i>
      <h2 style="margin:12px 0 6px">Payment received</h2>
      <p style="margin:0 0 16px">Your plan is active again. Log in to get back to your dashboard.</p>
      <a class="btn btn-primary" href="./admin-login.html">Go to login</a>
    </div>`;
}

async function renderPlans() {
  const host = $("renewBody");
  try {
    quotes = await pricingFor(business.businessType);
  } catch (error) {
    console.warn("pricing failed", error?.message);
    host.innerHTML = `<div class="renew-msg muted">We could not load plans right now. Please try again shortly.</div>`;
    return;
  }
  const sellable = quotes.filter(entry => entry[cycle]?.payable > 0);
  if (!quotes.length) {
    host.innerHTML = `<div class="renew-msg muted">No plans are available for your business type yet. Please contact Scan2Plate support.</div>`;
    return;
  }

  const bothCycles = quotes.some(entry => entry.monthly?.payable > 0) && quotes.some(entry => entry.yearly?.payable > 0);
  host.innerHTML = `
    ${bothCycles ? `<div class="renew-cycle">
      <button type="button" data-cycle="monthly" class="${cycle === "monthly" ? "active" : ""}">Monthly</button>
      <button type="button" data-cycle="yearly" class="${cycle === "yearly" ? "active" : ""}">Yearly</button>
    </div>` : ""}
    <div class="renew-plans">
      ${sellable.length ? sellable.map(card).join("") : `<div class="renew-msg muted">No ${esc(cycle)} plan is available. Try the other billing cycle.</div>`}
    </div>`;

  host.querySelectorAll("[data-cycle]").forEach(button => {
    button.addEventListener("click", () => { cycle = button.dataset.cycle; renderPlans(); });
  });
  host.querySelectorAll("[data-buy]").forEach(button => {
    button.addEventListener("click", () => checkout(button.dataset.buy, button.dataset.offer || "", button));
  });
}

function card(entry) {
  const quote = entry[cycle];
  const plan = entry.plan;
  const features = Object.entries(plan.features || {}).filter(([, on]) => on !== false).slice(0, 5);
  return `
    <div class="renew-plan ${plan.featured ? "featured" : ""}">
      <h3>${esc(plan.name || "Plan")}</h3>
      ${plan.description ? `<div class="muted" style="font-size:13px">${esc(plan.description)}</div>` : ""}
      <div class="renew-price">${esc(formatMoney(quote.payable))}
        ${quote.payable < quote.listPrice ? `<span class="renew-was">${esc(formatMoney(quote.listPrice))}</span>` : ""}
      </div>
      <div class="muted" style="font-size:13px">per ${cycle === "yearly" ? "year" : "month"}</div>
      ${quote.offer ? `<div class="renew-offer"><i class="fa-solid fa-gift"></i> ${esc(quote.offer.offerText || quote.offer.name || "Offer applied")}
        ${quote.bonusMonths ? ` · ${quote.totalMonths} months access` : ""}</div>` : ""}
      ${features.length ? `<ul class="renew-feats">${features.map(([key]) =>
        `<li><i class="fa-solid fa-check"></i>${esc(FEATURE_LABELS[key] || key)}</li>`).join("")}</ul>` : ""}
      <button class="renew-buy" type="button" data-buy="${esc(plan.id)}" data-offer="${esc(quote.offer?.id || "")}">
        Pay ${esc(formatMoney(quote.payable))} &amp; restore access
      </button>
    </div>`;
}

const FEATURE_LABELS = {
  qrOrdering: "QR Ordering", tableManagement: "Table Management", kitchen: "Kitchen Display",
  kot: "KOT / Kitchen", inventory: "Inventory", reports: "Reports", onlineOrders: "Online Orders",
  preOrder: "Pre-Orders", whatsapp: "WhatsApp Alerts", advancedReports: "Advanced Reports",
  hotelRooms: "Rooms", appointments: "Appointments"
};

async function checkout(planId, offerId, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Opening payment…";
  try {
    const order = await startSubscription({ businessId: business.id, planId, billingCycle: cycle, offerId });
    await openRazorpayCheckout({
      publicKeyId: order.publicKeyId,
      razorpaySubscriptionId: order.razorpaySubscriptionId,
      name: "Scan2Plate",
      description: `${business.restaurantName || "Your business"} · ${cycle === "yearly" ? "Yearly" : "Monthly"} plan`,
      prefill: {
        name: business.restaurantName || "",
        email: auth.currentUser?.email || business.ownerEmail || "",
        contact: business.phone || business.ownerPhone || ""
      },
      // Razorpay's callback says the customer finished, not that the money
      // arrived. The webhook is the authority, and the watcher above is what
      // flips this page — so this only tells them what is happening.
      onSuccess: () => {
        button.textContent = "Confirming payment…";
        $("renewStatus").innerHTML = `<strong>Payment submitted.</strong> Waiting for confirmation from Razorpay — this page will update on its own.`;
        $("renewStatus").classList.remove("hidden");
      },
      onDismiss: () => { button.disabled = false; button.textContent = original; }
    });
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    $("renewStatus").innerHTML = `<strong>Could not start the payment.</strong> ${esc(error?.message || "Please try again.")}`;
    $("renewStatus").classList.remove("hidden");
  }
}

$("renewBack")?.addEventListener("click", async event => {
  // Leaving the renewal page ends the session it was given, so an expired
  // account is never left signed in on a shared device.
  event.preventDefault();
  try { await signOut(auth); } catch { /* going back matters more than a clean sign-out */ }
  window.location.assign("./admin-login.html");
});
