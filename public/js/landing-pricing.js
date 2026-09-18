/* =========================================================
   LANDING PAGE PRICING

   The pricing section was hardcoded at a single ₹499 card in
   index.html, so a Super Admin creating a plan changed the
   checkout but never the page customers actually read. Worse,
   different business types are priced differently by design and
   the page could only ever show one number.

   This renders the section from the same `subscriptionPlans`
   documents the checkout charges against.

   The static card stays in the markup as the fallback. This is a
   marketing page: if Firestore is slow, blocked, or the
   catalogue is empty, showing the old card is far better than
   showing an empty pricing section to someone deciding whether
   to buy.
========================================================= */
import { db } from "./firebase.js?v=s2p-20260918c";
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { listBusinessTypes, normalizeBusinessType, businessTypeLabel } from "./business-types.js?v=s2p-20260918c";
import { plansForBusinessType, quotePlan, formatMoney } from "./subscription-core.js?v=s2p-20260918c";

const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const FEATURE_LABELS = {
  qrOrdering: "QR Ordering", tableManagement: "Table Management", kitchen: "Kitchen Display",
  kot: "KOT / Kitchen", inventory: "Inventory", reports: "Reports & Analytics",
  onlineOrders: "Online Orders", preOrder: "Pre-Orders", whatsapp: "WhatsApp Alerts",
  advancedReports: "Advanced Reports", hotelRooms: "Rooms", appointments: "Appointments"
};

let plans = [];
let offers = [];
let selectedType = "restaurant";
let cycle = "monthly";

async function readActive(name) {
  const snap = await getDocs(query(collection(db, name), where("active", "==", true)));
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function mountLandingPricing() {
  const section = document.getElementById("pricing");
  const host = section?.querySelector(".plans");
  if (!host) return;

  try {
    [plans, offers] = await Promise.all([readActive("subscriptionPlans"), readActive("offers")]);
  } catch (error) {
    // Leave the static card exactly where it is.
    console.warn("Live pricing unavailable; showing the built-in card.", error?.message);
    return;
  }
  if (!plans.length) return;

  // Only types that actually have a plan on sale. Offering a chooser full of
  // empty options would be worse than the single card it replaces.
  const sellable = listBusinessTypes().filter(type => plansForBusinessType(plans, type.id).length);
  if (!sellable.length) return;
  if (!sellable.some(type => type.id === selectedType)) selectedType = sellable[0].id;

  host.dataset.livePricing = "true";
  render(host, sellable);
}

function render(host, sellable) {
  const forType = plansForBusinessType(plans, selectedType);
  const anyYearly = forType.some(plan => Number(plan.yearlyPrice) > 0);
  const anyMonthly = forType.some(plan => Number(plan.monthlyPrice) > 0);
  if (cycle === "yearly" && !anyYearly) cycle = "monthly";

  host.className = `plans${forType.length === 1 ? " plans-single" : ""}`;
  host.innerHTML = `
    <div class="pricing-controls">
      ${sellable.length > 1 ? `<label class="pricing-type">
        <span>Business type</span>
        <select id="pricingBusinessType">
          ${sellable.map(type => `<option value="${esc(type.id)}" ${type.id === selectedType ? "selected" : ""}>${esc(type.label)}</option>`).join("")}
        </select>
      </label>` : ""}
      ${anyMonthly && anyYearly ? `<div class="pricing-cycle">
        <button type="button" data-cycle="monthly" class="${cycle === "monthly" ? "active" : ""}">Monthly</button>
        <button type="button" data-cycle="yearly" class="${cycle === "yearly" ? "active" : ""}">Yearly</button>
      </div>` : ""}
    </div>
    ${forType.map(card).join("")}`;

  host.querySelector("#pricingBusinessType")?.addEventListener("change", event => {
    selectedType = normalizeBusinessType(event.target.value);
    render(host, sellable);
  });
  host.querySelectorAll("[data-cycle]").forEach(button => {
    button.addEventListener("click", () => { cycle = button.dataset.cycle; render(host, sellable); });
  });
}

function card(plan) {
  const quote = quotePlan({ plan, billingCycle: cycle, offers });
  if (!quote.listPrice) return "";
  const features = Object.entries(plan.features || {}).filter(([, on]) => on !== false).map(([key]) => FEATURE_LABELS[key] || key);
  const per = cycle === "yearly" ? "/ year" : "/ month";
  return `
    <div class="plan-card ${plan.featured ? "featured complete" : ""}">
      ${plan.badgeText ? `<div class="plan-tag">${esc(plan.badgeText)}</div>` : plan.featured ? `<div class="plan-tag">Most popular</div>` : ""}
      <h3>${esc(plan.name || "Plan")}</h3>
      ${plan.description ? `<p class="plan-note" style="margin:4px 0 8px">${esc(plan.description)}</p>` : ""}
      <div class="price">${esc(formatMoney(quote.payable))} <span>${per}, per ${esc(businessTypeLabel(selectedType).toLowerCase())}</span></div>
      ${quote.payable < quote.listPrice ? `<div class="plan-note" style="margin-top:-6px">
        <s>${esc(formatMoney(quote.listPrice))}</s> &middot; ${esc(quote.offerText || "offer applied")}</div>` : ""}
      ${quote.bonusMonths ? `<div class="plan-everything-badge">${quote.totalMonths} months access</div>` : ""}
      ${features.length ? `<ul class="plan-checklist">${features.map(f => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      <div class="plan-cta-group">
        <button type="button" class="btn btn-dark" data-open-checkout>Get started — ${esc(formatMoney(quote.payable))}</button>
        <a href="/contact" class="btn btn-outline">Book Free Demo</a>
      </div>
      <p class="plan-note">Taxes, if applicable, are shown at checkout.</p>
    </div>`;
}

mountLandingPricing().catch(error => console.warn("pricing mount failed", error?.message));
