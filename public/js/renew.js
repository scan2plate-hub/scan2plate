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
import { auth, db } from "./firebase.js?v=s2p-20260918c";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { pricingFor, startSubscription, openRazorpayCheckout, watchSubscription, loadBusiness, validateCoupon, redeemCoupon } from "./subscription-client.js?v=s2p-20260918c";
import { formatMoney, isEntitled } from "./subscription-core.js?v=s2p-20260918c";
import { businessTypeLabel } from "./business-types.js?v=s2p-20260918c";

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

let business = null;
let cycle = "monthly";
let quotes = [];
let unwatch = null;
// The coupon the server accepted, if any. Held here rather than read from the
// input at checkout, so a code edited after validation cannot be submitted.
let coupon = null;

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
    </div>
    <div class="renew-coupon">
      <label for="couponInput"><strong>Have a coupon code?</strong></label>
      <div class="renew-coupon-row">
        <input id="couponInput" type="text" placeholder="Enter code" spellcheck="false" autocomplete="off"
               value="${esc(coupon?.code || "")}" ${coupon ? "disabled" : ""} />
        <button type="button" id="couponApply">${coupon ? "Remove" : "Apply"}</button>
      </div>
      <div id="couponMessage" class="renew-coupon-msg">${coupon ? esc(couponSummary(coupon)) : ""}</div>
    </div>`;

  host.querySelectorAll("[data-cycle]").forEach(button => {
    button.addEventListener("click", () => { cycle = button.dataset.cycle; renderPlans(); });
  });
  host.querySelectorAll("[data-buy]").forEach(button => {
    button.addEventListener("click", () => checkout(button.dataset.buy, button.dataset.offer || "", button));
  });
  $("couponApply")?.addEventListener("click", () => {
    if (coupon) { coupon = null; renderPlans(); return; }
    applyCoupon();
  });
  $("couponInput")?.addEventListener("keydown", event => { if (event.key === "Enter") applyCoupon(); });
}

function card(entry) {
  const plan = entry.plan;
  // A coupon the server priced for THIS plan overrides the automatic offer;
  // the two never stack, so the customer sees one price and pays it.
  const applied = coupon && coupon.planId === plan.id ? coupon : null;
  const quote = applied
    ? { ...entry[cycle], payable: applied.payable, offer: null, bonusMonths: applied.bonusMonths, couponText: couponSummary(applied) }
    : entry[cycle];
  const features = Object.entries(plan.features || {}).filter(([, on]) => on !== false).slice(0, 5);
  return `
    <div class="renew-plan ${plan.featured ? "featured" : ""}">
      <h3>${esc(plan.name || "Plan")}</h3>
      ${plan.description ? `<div class="muted" style="font-size:13px">${esc(plan.description)}</div>` : ""}
      <div class="renew-price">${esc(formatMoney(quote.payable))}
        ${quote.payable < quote.listPrice ? `<span class="renew-was">${esc(formatMoney(quote.listPrice))}</span>` : ""}
      </div>
      <div class="muted" style="font-size:13px">per ${cycle === "yearly" ? "year" : "month"}</div>
      ${quote.couponText ? `<div class="renew-offer"><i class="fa-solid fa-ticket"></i> ${esc(quote.couponText)}</div>`
        : quote.offer ? `<div class="renew-offer"><i class="fa-solid fa-gift"></i> ${esc(quote.offer.offerText || quote.offer.name || "Offer applied")}
        ${quote.bonusMonths ? ` · ${quote.totalMonths} months access` : ""}</div>` : ""}
      ${features.length ? `<ul class="renew-feats">${features.map(([key]) =>
        `<li><i class="fa-solid fa-check"></i>${esc(FEATURE_LABELS[key] || key)}</li>`).join("")}</ul>` : ""}
      <button class="renew-buy" type="button" data-buy="${esc(plan.id)}" data-offer="${esc(quote.offer?.id || "")}">
        ${applied?.free ? "Activate free &amp; restore access" : `Pay ${esc(formatMoney(quote.payable))} &amp; restore access`}
      </button>
    </div>`;
}

function couponSummary(applied) {
  if (!applied) return "";
  if (applied.free) return `${applied.code} applied — this plan is free.`;
  const parts = [];
  if (applied.discount > 0) parts.push(`${formatMoney(applied.discount)} off`);
  if (applied.bonusMonths > 0) parts.push(`${applied.bonusMonths} bonus month${applied.bonusMonths === 1 ? "" : "s"}`);
  return `${applied.code} applied — ${parts.join(" · ") || applied.offerText || "discount applied"}.`;
}

/**
 * Checks a code against the SERVER, which is also what prices it. The page
 * never works out the discount itself, so the figure shown is the figure
 * charged.
 */
async function applyCoupon() {
  const input = $("couponInput");
  const message = $("couponMessage");
  const button = $("couponApply");
  const code = String(input?.value || "").trim();
  if (!code) { if (message) { message.textContent = "Enter a coupon code."; message.className = "renew-coupon-msg bad"; } return; }

  // A coupon is checked against one plan, so with several on sale we check the
  // one the customer is most likely buying: the featured plan, else the first.
  const target = quotes.find(entry => entry.plan.featured && entry[cycle]?.payable > 0)
    || quotes.find(entry => entry[cycle]?.payable > 0);
  if (!target) return;

  if (button) { button.disabled = true; button.textContent = "Checking…"; }
  try {
    const result = await validateCoupon({ businessId: business.id, planId: target.plan.id, billingCycle: cycle, code });
    if (!result.ok) {
      coupon = null;
      if (message) { message.textContent = result.error || "That coupon cannot be used here."; message.className = "renew-coupon-msg bad"; }
      return;
    }
    coupon = { ...result, planId: target.plan.id };
    renderPlans();
  } catch (error) {
    if (message) { message.textContent = error?.message || "Could not check that coupon."; message.className = "renew-coupon-msg bad"; }
  } finally {
    if (button) { button.disabled = false; button.textContent = coupon ? "Remove" : "Apply"; }
  }
}

const FEATURE_LABELS = {
  qrOrdering: "QR Ordering", tableManagement: "Table Management", kitchen: "Kitchen Display",
  kot: "KOT / Kitchen", inventory: "Inventory", reports: "Reports", onlineOrders: "Online Orders",
  preOrder: "Pre-Orders", whatsapp: "WhatsApp Alerts", advancedReports: "Advanced Reports",
  hotelRooms: "Rooms", appointments: "Appointments"
};

async function checkout(planId, offerId, button) {
  const original = button.textContent;
  const applied = coupon && coupon.planId === planId ? coupon : null;
  button.disabled = true;
  try {
    // A coupon covering the whole price is not a payment. Razorpay cannot
    // create a zero-rupee subscription, so it is redeemed instead — and the
    // server checks the coupon really is 100% before granting anything.
    if (applied?.free) {
      button.textContent = "Activating…";
      await redeemCoupon({ businessId: business.id, planId, billingCycle: cycle, code: applied.code });
      showActivated();
      return;
    }
    button.textContent = "Opening payment…";
    const order = await startSubscription({ businessId: business.id, planId, billingCycle: cycle, offerId, couponCode: applied?.code || "" });
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
