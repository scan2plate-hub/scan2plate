/* =========================================================
   SUPER ADMIN — PLANS, OFFERS, SUBSCRIPTIONS

   Adds four sections to the existing Super Admin console without
   touching its current markup or scripts: Subscription Plans,
   Offers, Subscriptions and Subscription Revenue.

   It reuses the console's own classes (sa-card, sa-btn, sa-table…)
   so it looks like the rest of the page, and mounts itself by
   appending to the existing nav and content area.

   Every WRITE that touches money goes through the backend
   (savePlan -> /api/admin/plans), which re-checks Super Admin
   rights server-side and owns the Razorpay credentials. Offers
   hold no money secrets and are written straight to Firestore,
   where the Super Admin rules already apply.
========================================================= */
import { db } from "./firebase.js?v=s2p-20260918c";
import {
  collection, doc, addDoc, setDoc, deleteDoc, getDocs, onSnapshot, query, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { listBusinessTypes, businessTypeLabel, normalizeBusinessType } from "./business-types.js?v=s2p-20260918c";
import {
  formatMoney, statusLabel, statusTone, toDate, planPrice, offerIsLive,
  normalizeCouponCode, isCouponOffer
} from "./subscription-core.js?v=s2p-20260918c";
import { savePlan, clearSubscriptionCache } from "./subscription-client.js?v=s2p-20260918c";
import { getBackendBaseUrl } from "./common.js?v=s2p-20260918c";

const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

// Limits a Super Admin can cap per plan. -1 (or blank) means unlimited.
const LIMIT_FIELDS = [
  ["maxTables", "Max tables"], ["maxStaff", "Max staff"], ["maxMenuItems", "Max menu items"],
  ["maxOrders", "Max orders / month"], ["maxRooms", "Max rooms"], ["maxInventoryItems", "Max inventory items"],
  ["maxWhatsappNotifications", "Max WhatsApp notifications"]
];

// Feature flags offered per plan, drawn from the shared module vocabulary so
// the plan editor and the dashboard speak about the same things.
// [stored key, label shown to a Super Admin].
//
// The labels are explicit rather than looked up in MODULES, because three of
// these keys (tableManagement, kitchen, hotelRooms) have no MODULES entry and
// were falling through to the raw field name — a Super Admin was being shown
// "tableManagement" next to "QR Ordering". The keys are deliberately left
// alone: they are what gets written into a plan's `features` map, and
// renaming them would silently orphan the flags on every plan already saved.
const FEATURE_FIELDS = [
  ["qrOrdering", "QR Ordering"],
  ["tableManagement", "Table Management"],
  ["kitchen", "Kitchen Display"],
  ["kot", "KOT / Kitchen"],
  ["inventory", "Inventory"],
  ["reports", "Reports"],
  ["onlineOrders", "Online Orders"],
  ["preOrder", "Pre-Orders"],
  ["whatsapp", "WhatsApp Alerts"],
  ["advancedReports", "Advanced Reports"],
  ["hotelRooms", "Rooms"],
  ["appointments", "Appointments"]
];

let plans = [];
let offers = [];
let subscriptions = [];
let businesses = [];
let editingPlanId = "";
let editingOfferId = "";

const $ = selector => document.querySelector(selector);

/* ---------------------------------------------------------
   MOUNT
--------------------------------------------------------- */
export function mountSuperAdminBilling() {
  if (document.getElementById("section-plans-manage")) return;
  const nav = document.querySelector(".sa-nav") || document.querySelector("aside nav") || document.querySelector("nav");
  const content = document.querySelector(".sa-content") || document.querySelector("main");
  if (!content) return;

  // Add nav buttons next to the existing ones, using their markup so the
  // console's own section-switching picks them up unchanged.
  const navHost = nav?.querySelector("button")?.parentElement || nav;
  navHost?.insertAdjacentHTML("beforeend", `
    <button data-section-target="plans-manage"><i class="fa-solid fa-tags"></i>Subscription Plans</button>
    <button data-section-target="offers"><i class="fa-solid fa-gift"></i>Offers</button>
    <button data-section-target="subscriptions"><i class="fa-solid fa-receipt"></i>Subscriptions</button>
  `);

  content.insertAdjacentHTML("beforeend", `
    <section id="section-plans-manage" class="sa-section">
      <div class="sa-card">
        <div class="sa-card-head"><h2>Subscription Plans</h2><button class="sa-btn" id="newPlanBtn" type="button"><i class="fa-solid fa-plus"></i>New Plan</button></div>
        <div class="sa-card-body">
          <div id="razorpayStatus" class="sa-alert" style="margin-bottom:16px">Checking payment configuration…</div>
          <p class="sa-sub" style="margin-top:0">Pricing for every business type. Saving syncs the plan with Razorpay: renaming a plan reuses its existing Razorpay plan, and only a real price change creates a new one.</p>
          <div id="planEditor"></div>
          <div class="sa-table-wrap" style="margin-top:18px">
            <table class="sa-table"><thead><tr>
              <th>Plan</th><th>Business type</th><th>Monthly</th><th>Yearly</th><th>Trial</th><th>Razorpay</th><th>Status</th><th>Actions</th>
            </tr></thead><tbody id="planRows"></tbody></table>
          </div>
        </div>
      </div>
    </section>

    <section id="section-offers" class="sa-section">
      <div class="sa-card">
        <div class="sa-card-head"><h2>Offers</h2><button class="sa-btn" id="newOfferBtn" type="button"><i class="fa-solid fa-plus"></i>New Offer</button></div>
        <div class="sa-card-body">
          <p class="sa-sub" style="margin-top:0">When several offers match, the one with the highest priority is the only one shown.</p>
          <div id="offerEditor"></div>
          <div class="sa-table-wrap" style="margin-top:18px">
            <table class="sa-table"><thead><tr>
              <th>Offer</th><th>Business type</th><th>Plan</th><th>Cycle</th><th>Benefit</th><th>Valid</th><th>Priority</th><th>Status</th><th>Actions</th>
            </tr></thead><tbody id="offerRows"></tbody></table>
          </div>
        </div>
      </div>
    </section>

    <section id="section-subscriptions" class="sa-section">
      <div class="sa-summary" id="subscriptionMetrics"></div>
      <div class="sa-card" style="margin-top:18px">
        <div class="sa-card-head"><h2>Subscription Management</h2></div>
        <div class="sa-card-body">
          <div class="sa-toolbar">
            <input id="subSearch" class="sa-input sa-search" placeholder="Search business, phone, email or subscription ID" />
            <select id="subTypeFilter" class="sa-select"><option value="all">All business types</option>${listBusinessTypes().map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join("")}</select>
            <select id="subStatusFilter" class="sa-select"><option value="all">All statuses</option><option value="active">Active</option><option value="trial">Trial</option><option value="payment_failed">Payment failed</option><option value="cancelled">Cancelled</option><option value="expired">Expired</option><option value="halted">Halted</option></select>
            <select id="subCycleFilter" class="sa-select"><option value="all">All cycles</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
          </div>
          <div class="sa-table-wrap">
            <table class="sa-table"><thead><tr>
              <th>Business</th><th>Type</th><th>Plan</th><th>Cycle</th><th>Amount</th><th>Status</th><th>Next payment</th>
            </tr></thead><tbody id="subscriptionRows"></tbody></table>
          </div>
        </div>
      </div>
    </section>
  `);

  const TITLES = {
    "plans-manage": ["Subscription Plans", "Pricing for every business type."],
    offers: ["Offers", "Promotions shown to business owners."],
    subscriptions: ["Subscriptions", "Scan2Plate subscription accounts and revenue."]
  };
  // super-admin-dashboard.js binds its nav handlers once at module load, so
  // buttons added afterwards get none. These sections therefore do their own
  // switching, mirroring exactly what the console's switchSection does, and
  // the console's own file stays untouched.
  document.querySelectorAll("[data-section-target]").forEach(button => {
    const target = button.dataset.sectionTarget;
    if (!TITLES[target]) return;
    button.addEventListener("click", () => showBillingSection(target, TITLES[target]));
  });

  $("#newPlanBtn")?.addEventListener("click", () => openPlanEditor(""));
  $("#newOfferBtn")?.addEventListener("click", () => openOfferEditor(""));
  ["subSearch", "subTypeFilter", "subStatusFilter", "subCycleFilter"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", renderSubscriptions);
  });

  // Delegated once per table, so re-rendering never stacks handlers.
  $("#planRows")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-plan-action]");
    if (!button) return;
    const { planAction, planId } = button.dataset;
    if (planAction === "edit") openPlanEditor(planId);
    if (planAction === "toggle") togglePlanActive(planId);
  });
  $("#offerRows")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-offer-action]");
    if (!button) return;
    const { offerAction, offerId } = button.dataset;
    if (offerAction === "edit") openOfferEditor(offerId);
    if (offerAction === "toggle") toggleOfferActive(offerId);
    if (offerAction === "delete") removeOffer(offerId);
  });

  watchCollections();
  renderRazorpayStatus();
}

/* ---------------------------------------------------------
   PAYMENT CONFIGURATION STATUS

   Read-only. Razorpay credentials live in backend environment
   variables and are never entered, stored or displayed here —
   this only reports WHETHER the backend has them, so a
   misconfigured deployment is obvious before anyone tries to
   sell a plan.
--------------------------------------------------------- */
async function renderRazorpayStatus() {
  const host = $("#razorpayStatus");
  if (!host) return;
  let health = null;
  try {
    const response = await fetch(`${getBackendBaseUrl()}/api/health`, { cache: "no-store" });
    health = await response.json();
  } catch {
    host.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span><strong>Backend unreachable.</strong> Payment configuration could not be checked.</span>`;
    return;
  }
  const line = (ok, label, detail) =>
    `<div style="display:flex;gap:8px;align-items:center;margin-top:4px">
       <i class="fa-solid ${ok ? "fa-circle-check" : "fa-circle-xmark"}" style="color:${ok ? "#167541" : "#b3342f"}"></i>
       <span>${esc(label)}${detail ? ` — <span class="sa-sub" style="display:inline">${esc(detail)}</span>` : ""}</span>
     </div>`;

  const ready = health.razorpayConfigured === true;
  const webhook = health.razorpayWebhookConfigured === true;
  const mode = String(health.razorpayMode || "unset");
  host.style.background = ready && webhook ? "#eaf8ef" : "#fff8ef";
  host.style.color = ready && webhook ? "#167541" : "#80520c";
  host.innerHTML = `
    <div style="width:100%">
      <strong>Payment configuration${mode === "live" ? " · LIVE mode" : mode === "test" ? " · TEST mode" : ""}</strong>
      ${line(ready, "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET", health.razorpayKeyIdPreview || "not set")}
      ${line(webhook, "RAZORPAY_WEBHOOK_SECRET", webhook ? "set" : "not set — webhooks will be rejected")}
      ${ready && webhook ? "" : `<div class="sa-sub" style="margin-top:8px">Set these as environment variables on the backend and redeploy. See <code>docs/SUBSCRIPTIONS.md</code>. They are never entered here: a secret typed into a browser would be exposed.</div>`}
    </div>`;
}

function showBillingSection(name, [title, subtitle]) {
  document.querySelectorAll(".sa-section").forEach(section => section.classList.toggle("active", section.id === `section-${name}`));
  document.querySelectorAll("[data-section-target]").forEach(button => button.classList.toggle("active", button.dataset.sectionTarget === name));
  const titleEl = document.getElementById("pageTitle");
  const subtitleEl = document.getElementById("pageSubtitle");
  if (titleEl) titleEl.textContent = title;
  if (subtitleEl) subtitleEl.textContent = subtitle;
}

function watchCollections() {
  onSnapshot(query(collection(db, "subscriptionPlans")), snap => {
    plans = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => Number(a.displayOrder || 0) - Number(b.displayOrder || 0));
    clearSubscriptionCache();
    renderPlans();
    renderOffers();
  }, error => console.warn("plans listener failed", error?.message));

  onSnapshot(query(collection(db, "offers")), snap => {
    offers = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
    clearSubscriptionCache();
    renderOffers();
  }, error => console.warn("offers listener failed", error?.message));

  onSnapshot(query(collection(db, "subscriptions")), snap => {
    subscriptions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSubscriptions();
    renderMetrics();
  }, error => console.warn("subscriptions listener failed", error?.message));

  getDocs(collection(db, "restaurants"))
    .then(snap => { businesses = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderSubscriptions(); })
    .catch(error => console.warn("businesses read failed", error?.message));
}

/* ---------------------------------------------------------
   PLANS
--------------------------------------------------------- */
function renderPlans() {
  const body = $("#planRows");
  if (!body) return;
  body.innerHTML = plans.length ? plans.map(plan => {
    // The ids themselves are not printed in the list: knowing WHETHER each
    // cycle is configured is what this column is for, and a screenshot of the
    // plan list should not carry identifiers out of the console.
    const configured = [plan.razorpayMonthlyPlanId ? "M" : "", plan.razorpayYearlyPlanId ? "Y" : ""].filter(Boolean).join(" + ");
    const planMode = String(plan.razorpayMonthlyPlanMode || plan.razorpayYearlyPlanMode || "").toUpperCase();
    const rzp = configured ? `${configured}${planMode ? ` · ${planMode}` : ""}` : "not configured";
    return `<tr>
      <td><strong>${esc(plan.name || plan.id)}</strong>${plan.featured ? ' <span class="sa-badge active">Featured</span>' : ""}${plan.badgeText ? ` <span class="sa-badge">${esc(plan.badgeText)}</span>` : ""}<span class="sa-sub">${esc(plan.description || "")}</span></td>
      <td>${esc(plan.businessType === "all" ? "All business types" : businessTypeLabel(plan.businessType))}</td>
      <td>${planPrice(plan, "monthly") ? formatMoney(planPrice(plan, "monthly")) : "—"}</td>
      <td>${planPrice(plan, "yearly") ? formatMoney(planPrice(plan, "yearly")) : "—"}</td>
      <td>${Number(plan.trialDays || 0) || "—"}</td>
      <td><span class="sa-sub">${esc(rzp)}</span></td>
      <td><span class="sa-badge ${plan.active === false ? "expired" : "active"}">${plan.active === false ? "Inactive" : "Active"}</span></td>
      <td><div class="sa-actions">
        <button class="sa-btn ghost" data-plan-action="edit" data-plan-id="${esc(plan.id)}">Edit</button>
        <button class="sa-btn ghost" data-plan-action="toggle" data-plan-id="${esc(plan.id)}">${plan.active === false ? "Activate" : "Deactivate"}</button>
      </div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="8"><div class="sa-empty">No plans yet. Create one to start selling.</div></td></tr>`;
}

/**
 * Whether a cycle's Razorpay plan id is configured, and which mode it was
 * configured for. Shown so a deployment that was switched from test to live
 * keys is visible here rather than discovered at a customer's checkout.
 */
function planIdStatus(plan, cycle) {
  const id = cycle === "yearly" ? plan.razorpayYearlyPlanId : plan.razorpayMonthlyPlanId;
  if (!id) return "Not configured — this cycle cannot be sold yet.";
  const mode = String((cycle === "yearly" ? plan.razorpayYearlyPlanMode : plan.razorpayMonthlyPlanMode) || "").toUpperCase();
  const source = String((cycle === "yearly" ? plan.razorpayYearlyPlanSource : plan.razorpayMonthlyPlanSource) || "") === "manual"
    ? "entered manually" : "created by Scan2Plate";
  const paise = Number(cycle === "yearly" ? plan.razorpayYearlyAmountPaise : plan.razorpayMonthlyAmountPaise) || 0;
  return `Configured${mode ? ` · ${mode} mode` : ""} · ${source}${paise ? ` · charges ${formatMoney(paise / 100)}` : ""}`;
}

function openPlanEditor(planId) {
  editingPlanId = planId || "";
  const plan = plans.find(item => item.id === planId) || {};
  const features = plan.features || {};
  const limits = plan.limits || {};
  const host = $("#planEditor");
  if (!host) return;
  host.innerHTML = `
    <div class="sa-card" style="border:1px solid var(--sa-border,#e5e7eb)">
      <div class="sa-card-head"><h2>${planId ? `Edit: ${esc(plan.name || planId)}` : "New Plan"}</h2></div>
      <div class="sa-card-body">
        <div class="sa-form-grid">
          <div class="sa-field"><label>Plan name</label><input id="planName" class="sa-input" value="${esc(plan.name || "")}" placeholder="Restaurant Professional" /></div>
          <div class="sa-field"><label>Business type</label><select id="planBusinessType" class="sa-select">
            <option value="all">All business types (global plan)</option>
            ${listBusinessTypes().map(t => `<option value="${t.id}" ${normalizeBusinessType(plan.businessType) === t.id && plan.businessType !== "all" ? "selected" : ""}>${esc(t.label)}</option>`).join("")}
          </select></div>
          <div class="sa-field"><label>Monthly price (₹)</label><input id="planMonthly" class="sa-input" type="number" min="0" value="${esc(plan.monthlyPrice ?? "")}" /></div>
          <div class="sa-field"><label>Yearly price (₹)</label><input id="planYearly" class="sa-input" type="number" min="0" value="${esc(plan.yearlyPrice ?? "")}" /></div>
          <div class="sa-field"><label>Trial days</label><input id="planTrial" class="sa-input" type="number" min="0" value="${esc(plan.trialDays ?? 0)}" /></div>
          <div class="sa-field"><label>Grace period (days)</label><input id="planGrace" class="sa-input" type="number" min="0" value="${esc(plan.gracePeriodDays ?? 7)}" /></div>
          <div class="sa-field"><label>Display order</label><input id="planOrder" class="sa-input" type="number" value="${esc(plan.displayOrder ?? 0)}" /></div>
          <div class="sa-field"><label>Badge text</label><input id="planBadge" class="sa-input" value="${esc(plan.badgeText || "")}" placeholder="Most Popular" /></div>
        </div>
        <div class="sa-field" style="margin-top:12px"><label>Description</label><input id="planDescription" class="sa-input" value="${esc(plan.description || "")}" /></div>
        <div class="sa-field" style="margin-top:12px"><label>Featured</label><select id="planFeatured" class="sa-select"><option value="no">No</option><option value="yes" ${plan.featured ? "selected" : ""}>Yes</option></select></div>

        <h3 style="margin:18px 0 8px">Razorpay plan IDs</h3>
        <p class="sa-sub" style="margin:0 0 10px">
          Create the plan in Razorpay Dashboard &rarr; Subscriptions &rarr; Plans, then paste its ID here.
          The backend verifies each ID against Razorpay before saving: a wrong period, a price that does not
          match, or an ID from the other mode is rejected with the reason. Leave a field blank to keep what is
          already stored. Plan IDs are identifiers, not secrets &mdash; no Razorpay key or secret is ever sent
          to this page.
        </p>
        <div class="sa-form-grid">
          <div class="sa-field">
            <label>Monthly Razorpay Plan ID</label>
            <input id="planRzpMonthly" class="sa-input" value="${esc(plan.razorpayMonthlyPlanId || "")}" placeholder="plan_XXXXXXXXXXXX" spellcheck="false" autocomplete="off" />
            <span class="sa-sub">${planIdStatus(plan, "monthly")}</span>
          </div>
          <div class="sa-field">
            <label>Yearly Razorpay Plan ID</label>
            <input id="planRzpYearly" class="sa-input" value="${esc(plan.razorpayYearlyPlanId || "")}" placeholder="plan_XXXXXXXXXXXX" spellcheck="false" autocomplete="off" />
            <span class="sa-sub">${planIdStatus(plan, "yearly")}</span>
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px">
          <input type="checkbox" id="planAutoCreate" checked />
          Let Scan2Plate create a Razorpay plan automatically for any cycle with a price but no ID
        </label>

        <h3 style="margin:18px 0 8px">Features</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">
          ${FEATURE_FIELDS.map(([key, label]) => `<label style="display:flex;align-items:center;gap:7px;font-size:13px">
            <input type="checkbox" class="plan-feature" value="${key}" ${features[key] !== false ? "checked" : ""} /> ${esc(label)}
          </label>`).join("")}
        </div>

        <h3 style="margin:18px 0 8px">Limits <span class="sa-sub">(blank or -1 = unlimited)</span></h3>
        <div class="sa-form-grid">
          ${LIMIT_FIELDS.map(([key, label]) => `<div class="sa-field"><label>${esc(label)}</label><input class="sa-input plan-limit" data-limit="${key}" type="number" value="${limits[key] === undefined ? "" : esc(limits[key])}" placeholder="-1" /></div>`).join("")}
        </div>

        <div id="planEditorMessage" class="sa-sub" style="margin-top:12px"></div>
        <div class="sa-actions" style="margin-top:14px">
          <button class="sa-btn" id="savePlanBtn" type="button">Save Plan</button>
          <button class="sa-btn ghost" id="cancelPlanBtn" type="button">Cancel</button>
        </div>
      </div>
    </div>`;
  $("#savePlanBtn")?.addEventListener("click", submitPlan);
  $("#cancelPlanBtn")?.addEventListener("click", () => { editingPlanId = ""; host.innerHTML = ""; });
  host.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function submitPlan() {
  const button = $("#savePlanBtn");
  const message = $("#planEditorMessage");
  const setMessage = (text, ok = false) => { if (message) { message.textContent = text; message.style.color = ok ? "#18794e" : "#b43731"; } };

  const features = {};
  document.querySelectorAll(".plan-feature").forEach(box => { features[box.value] = box.checked; });
  const limits = {};
  document.querySelectorAll(".plan-limit").forEach(input => {
    const raw = String(input.value).trim();
    limits[input.dataset.limit] = raw === "" ? -1 : Number(raw);
  });

  const payload = {
    planId: editingPlanId,
    name: $("#planName")?.value.trim() || "",
    businessType: $("#planBusinessType")?.value || "restaurant",
    description: $("#planDescription")?.value.trim() || "",
    monthlyPrice: Number($("#planMonthly")?.value || 0),
    yearlyPrice: Number($("#planYearly")?.value || 0),
    trialDays: Number($("#planTrial")?.value || 0),
    gracePeriodDays: Number($("#planGrace")?.value || 7),
    displayOrder: Number($("#planOrder")?.value || 0),
    badgeText: $("#planBadge")?.value.trim() || "",
    featured: $("#planFeatured")?.value === "yes",
    // Blank means "leave the stored id alone", so an ordinary rename never
    // disturbs a plan id that is already billing customers.
    razorpayMonthlyPlanId: $("#planRzpMonthly")?.value.trim() || "",
    razorpayYearlyPlanId: $("#planRzpYearly")?.value.trim() || "",
    autoCreateRazorpayPlans: $("#planAutoCreate")?.checked !== false,
    features,
    limits,
    active: true
  };
  if (!payload.name) return setMessage("Enter a plan name.");
  if (!payload.monthlyPrice && !payload.yearlyPrice && !payload.razorpayMonthlyPlanId && !payload.razorpayYearlyPlanId) {
    return setMessage("Set a monthly or yearly price, or paste a Razorpay plan ID.");
  }

  try {
    if (button) { button.disabled = true; button.textContent = "Saving…"; }
    setMessage("Saving and syncing with Razorpay…", true);
    const result = await savePlan(payload);
    const mode = result.razorpayMode && result.razorpayMode !== "unset" ? ` (${String(result.razorpayMode).toUpperCase()} mode)` : "";
    setMessage(result.createdRazorpayPlans
      ? `Saved. New Razorpay plan created for the new price${mode}.`
      : `Saved and verified against Razorpay${mode}.`, true);
    editingPlanId = result.planId || "";
    // The plans listener re-renders the table on its own.
  } catch (error) {
    setMessage(error.message || "Could not save the plan.");
  } finally {
    if (button) { button.disabled = false; button.textContent = "Save Plan"; }
  }
}

async function togglePlanActive(planId) {
  const plan = plans.find(item => item.id === planId);
  if (!plan) return;
  const next = plan.active === false;
  if (!confirm(`${next ? "Activate" : "Deactivate"} "${plan.name || planId}"?\n\nDeactivating hides it from pricing pages. Businesses already subscribed keep their subscription.`)) return;
  try {
    await setDoc(doc(db, "subscriptionPlans", planId), { active: next, updatedAt: serverTimestamp() }, { merge: true });
  } catch (error) {
    alert(error.message || "Could not update the plan.");
  }
}

/* ---------------------------------------------------------
   OFFERS
--------------------------------------------------------- */
function offerBenefit(offer) {
  const parts = [];
  const type = String(offer.discountType || "").toLowerCase();
  if (type === "percent" && Number(offer.discountValue)) parts.push(`${Number(offer.discountValue)}% off`);
  if (type === "flat" && Number(offer.discountValue)) parts.push(`${formatMoney(offer.discountValue)} off`);
  if (Number(offer.bonusMonths)) parts.push(`+${Number(offer.bonusMonths)} bonus month${Number(offer.bonusMonths) === 1 ? "" : "s"}`);
  return parts.join(" · ") || "—";
}

function renderOffers() {
  const body = $("#offerRows");
  if (!body) return;
  body.innerHTML = offers.length ? offers.map(offer => {
    const live = offerIsLive(offer);
    const plan = plans.find(item => item.id === offer.planId);
    const window = [offer.startDate || "—", offer.endDate || "—"].join(" → ");
    return `<tr>
      <td><strong>${esc(offer.name || offer.id)}</strong><span class="sa-sub">${esc(offer.offerText || "")}</span></td>
      <td>${esc(offer.businessType === "all" || !offer.businessType ? "All business types" : businessTypeLabel(offer.businessType))}</td>
      <td>${esc(plan ? plan.name : offer.planId ? "(plan removed)" : "Any plan")}</td>
      <td>${esc(offer.billingCycle || "any")}</td>
      <td>${esc(offerBenefit(offer))}</td>
      <td><span class="sa-sub">${esc(window)}</span></td>
      <td>${Number(offer.priority || 0)}</td>
      <td><span class="sa-badge ${offer.active === false ? "expired" : live ? "active" : "suspended"}">${offer.active === false ? "Inactive" : live ? "Live" : "Scheduled/Ended"}</span></td>
      <td><div class="sa-actions">
        <button class="sa-btn ghost" data-offer-action="edit" data-offer-id="${esc(offer.id)}">Edit</button>
        <button class="sa-btn ghost" data-offer-action="toggle" data-offer-id="${esc(offer.id)}">${offer.active === false ? "Activate" : "Deactivate"}</button>
        <button class="sa-btn ghost" data-offer-action="delete" data-offer-id="${esc(offer.id)}">Delete</button>
      </div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="9"><div class="sa-empty">No offers yet.</div></td></tr>`;
}

/** Explains, per offer, whether its discount can actually reach the customer. */
function couponBackingNote(offer = {}) {
  const type = String(offer.discountType || "");
  const percent = type === "percent" ? Number(offer.discountValue || 0) : 0;
  if (percent >= 100) return "Not needed: 100% off is granted directly, with no Razorpay payment.";
  if (type && Number(offer.discountValue || 0) > 0) {
    return offer.razorpayOfferId
      ? "Razorpay will apply this discount to the charge."
      : "Required — without it Razorpay charges the full plan price.";
  }
  return "Not needed for bonus months.";
}

// Bumped whenever an editor is opened or closed, so a pending close can tell
// whether it is still the current one.
let offerEditorGeneration = 0;

function openOfferEditor(offerId) {
  offerEditorGeneration += 1;
  editingOfferId = offerId || "";
  const offer = offers.find(item => item.id === offerId) || {};
  const host = $("#offerEditor");
  if (!host) return;
  host.innerHTML = `
    <div class="sa-card" style="border:1px solid var(--sa-border,#e5e7eb)">
      <div class="sa-card-head"><h2>${offerId ? `Edit: ${esc(offer.name || offerId)}` : "New Offer"}</h2></div>
      <div class="sa-card-body">
        <div class="sa-form-grid">
          <div class="sa-field"><label>Offer name</label><input id="offerName" class="sa-input" value="${esc(offer.name || "")}" placeholder="2 Months FREE" /></div>
          <div class="sa-field"><label>Business type</label><select id="offerBusinessType" class="sa-select">
            <option value="all">All business types</option>
            ${listBusinessTypes().map(t => `<option value="${t.id}" ${offer.businessType && offer.businessType !== "all" && normalizeBusinessType(offer.businessType) === t.id ? "selected" : ""}>${esc(t.label)}</option>`).join("")}
          </select></div>
          <div class="sa-field"><label>Plan</label><select id="offerPlan" class="sa-select">
            <option value="">Any plan</option>
            ${plans.map(plan => `<option value="${esc(plan.id)}" ${offer.planId === plan.id ? "selected" : ""}>${esc(plan.name || plan.id)}</option>`).join("")}
          </select></div>
          <div class="sa-field"><label>Billing cycle</label><select id="offerCycle" class="sa-select">
            <option value="any" ${!offer.billingCycle || offer.billingCycle === "any" ? "selected" : ""}>Any</option>
            <option value="monthly" ${offer.billingCycle === "monthly" ? "selected" : ""}>Monthly</option>
            <option value="yearly" ${offer.billingCycle === "yearly" ? "selected" : ""}>Yearly</option>
          </select></div>
          <div class="sa-field"><label>Discount type</label><select id="offerDiscountType" class="sa-select">
            <option value="" ${!offer.discountType ? "selected" : ""}>None</option>
            <option value="percent" ${offer.discountType === "percent" ? "selected" : ""}>Percentage</option>
            <option value="flat" ${offer.discountType === "flat" ? "selected" : ""}>Fixed amount</option>
          </select></div>
          <div class="sa-field"><label>Discount value</label><input id="offerDiscountValue" class="sa-input" type="number" min="0" value="${esc(offer.discountValue ?? "")}" /></div>
          <div class="sa-field"><label>Bonus months</label><input id="offerBonusMonths" class="sa-input" type="number" min="0" value="${esc(offer.bonusMonths ?? 0)}" /></div>
          <div class="sa-field"><label>Priority <span class="sa-sub">(higher wins)</span></label><input id="offerPriority" class="sa-input" type="number" value="${esc(offer.priority ?? 1)}" /></div>
          <div class="sa-field"><label>Start date</label><input id="offerStart" class="sa-input" type="date" value="${esc(String(offer.startDate || "").slice(0, 10))}" /></div>
          <div class="sa-field"><label>End date</label><input id="offerEnd" class="sa-input" type="date" value="${esc(String(offer.endDate || "").slice(0, 10))}" /></div>
          <div class="sa-field"><label>Max redemptions <span class="sa-sub">(0 = unlimited)</span></label><input id="offerMaxRedemptions" class="sa-input" type="number" min="0" value="${esc(offer.maxRedemptions ?? 0)}" /></div>
          <div class="sa-field"><label>Badge</label><input id="offerBadge" class="sa-input" value="${esc(offer.badge || "")}" placeholder="LIMITED TIME" /></div>
        </div>
        <div class="sa-field" style="margin-top:12px"><label>Offer text shown to the business</label><input id="offerText" class="sa-input" value="${esc(offer.offerText || "")}" placeholder="Pay for 12 months, get 2 months FREE" /></div>

        <h3 style="margin:18px 0 8px">Coupon code <span class="sa-sub">(optional)</span></h3>
        <p class="sa-sub" style="margin:0 0 10px">
          Leave the code blank and this offer applies <strong>automatically</strong> to everyone who qualifies.
          Give it a code and it applies only to a business that types that code &mdash; so you can hand it to one
          customer. Codes ignore spaces and capitals: <code>save 50</code> and <code>SAVE50</code> are the same code.
        </p>
        <div class="sa-form-grid">
          <div class="sa-field">
            <label>Coupon code</label>
            <input id="offerCode" class="sa-input" value="${esc(offer.code || "")}" placeholder="WELCOME50" spellcheck="false" autocomplete="off" style="text-transform:uppercase" />
            <span class="sa-sub">Blank = automatic offer, no code needed.</span>
          </div>
          <div class="sa-field">
            <label>Razorpay Offer ID <span class="sa-sub">(for a partial discount)</span></label>
            <input id="offerRazorpayId" class="sa-input" value="${esc(offer.razorpayOfferId || "")}" placeholder="offer_XXXXXXXXXXXX" spellcheck="false" autocomplete="off" />
            <span class="sa-sub">${couponBackingNote(offer)}</span>
          </div>
        </div>
        <div id="offerEditorMessage" class="sa-sub" style="margin-top:12px"></div>
        <div class="sa-actions" style="margin-top:14px">
          <button class="sa-btn" id="saveOfferBtn" type="button">Save Offer</button>
          <button class="sa-btn ghost" id="cancelOfferBtn" type="button">Cancel</button>
        </div>
      </div>
    </div>`;
  $("#saveOfferBtn")?.addEventListener("click", submitOffer);
  $("#cancelOfferBtn")?.addEventListener("click", () => { offerEditorGeneration += 1; editingOfferId = ""; host.innerHTML = ""; });
  // A discount value with no discount type is a contradiction the form should
  // not let someone type in the first place.
  const discountType = $("#offerDiscountType");
  const discountValue = $("#offerDiscountValue");
  const syncDiscount = () => {
    const off = !discountType?.value;
    if (!discountValue) return;
    discountValue.disabled = off;
    discountValue.placeholder = off ? "Choose a discount type first" : "";
    if (off) discountValue.value = "";
  };
  discountType?.addEventListener("change", syncDiscount);
  syncDiscount();
  host.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function submitOffer() {
  const button = $("#saveOfferBtn");
  const message = $("#offerEditorMessage");
  const setMessage = (text, ok = false) => { if (message) { message.textContent = text; message.style.color = ok ? "#18794e" : "#b43731"; } };

  const payload = {
    name: $("#offerName")?.value.trim() || "",
    businessType: $("#offerBusinessType")?.value || "all",
    planId: $("#offerPlan")?.value || "",
    billingCycle: $("#offerCycle")?.value || "any",
    discountType: $("#offerDiscountType")?.value || "",
    // With no discount type there is no discount, whatever is left in the
    // value box. discountAmount() already ignores it; storing it anyway made
    // a pure bonus-months offer look like a discount to the checks below.
    discountValue: $("#offerDiscountType")?.value ? Number($("#offerDiscountValue")?.value || 0) : 0,
    bonusMonths: Number($("#offerBonusMonths")?.value || 0),
    priority: Number($("#offerPriority")?.value || 1),
    startDate: $("#offerStart")?.value || "",
    endDate: $("#offerEnd")?.value || "",
    maxRedemptions: Number($("#offerMaxRedemptions")?.value || 0),
    badge: $("#offerBadge")?.value.trim() || "",
    offerText: $("#offerText")?.value.trim() || "",
    // Stored normalised so a code typed with different spacing or case still
    // matches, and two codes cannot differ only by a space.
    code: normalizeCouponCode($("#offerCode")?.value || ""),
    razorpayOfferId: $("#offerRazorpayId")?.value.trim() || "",
    active: true,
    updatedAt: serverTimestamp()
  };
  if (!payload.name) return setMessage("Enter an offer name.");
  if (!payload.discountValue && !payload.bonusMonths) return setMessage("Set a discount or some bonus months.");

  // A Razorpay plan's amount cannot be edited and a subscription bills its
  // plan, so a partial discount can only reach the customer through a Razorpay
  // Offer. Saying so here is the difference between a coupon that works and
  // one that is refused at checkout in front of a customer.
  // Only a real discount needs backing. "None" plus a number left in the value
  // box is not a discount, and a bonus-months offer must not be blocked by it.
  const hasDiscount = Boolean(payload.discountType) && payload.discountValue > 0;
  const coversEverything = payload.discountType === "percent" && payload.discountValue >= 100;
  const partialDiscount = hasDiscount && !coversEverything;
  if (partialDiscount && !payload.razorpayOfferId) {
    return setMessage("A partial discount needs a Razorpay Offer ID, or Razorpay will still charge the full price. Create the offer in Razorpay Dashboard → Offers and paste its ID, or use bonus months instead.");
  }
  if (payload.discountType === "percent" && payload.discountValue > 100) return setMessage("A percentage discount cannot be more than 100%.");
  if (payload.startDate && payload.endDate && payload.startDate > payload.endDate) return setMessage("The end date is before the start date.");

  try {
    if (button) { button.disabled = true; button.textContent = "Saving…"; }
    if (editingOfferId) {
      await setDoc(doc(db, "offers", editingOfferId), payload, { merge: true });
    } else {
      await addDoc(collection(db, "offers"), { ...payload, redemptions: 0, createdAt: serverTimestamp() });
    }
    // The editor used to blank itself in the same tick as the message, so the
    // confirmation was destroyed before it could be read and a successful save
    // looked exactly like nothing happening. The offer appears in the table
    // below either way; this just lets the operator see that it worked.
    setMessage("Offer saved.", true);
    editingOfferId = "";
    // Only close the editor this save belongs to. A bare timeout would blank
    // whatever editor happened to be open 1.4s later, including a new one the
    // operator had already started filling in.
    const closing = ++offerEditorGeneration;
    setTimeout(() => {
      if (closing !== offerEditorGeneration) return;
      const host = $("#offerEditor");
      if (host) host.innerHTML = "";
    }, 1400);
  } catch (error) {
    setMessage(error.message || "Could not save the offer.");
  } finally {
    if (button) { button.disabled = false; button.textContent = "Save Offer"; }
  }
}

async function toggleOfferActive(offerId) {
  const offer = offers.find(item => item.id === offerId);
  if (!offer) return;
  try {
    await setDoc(doc(db, "offers", offerId), { active: offer.active === false, updatedAt: serverTimestamp() }, { merge: true });
  } catch (error) {
    alert(error.message || "Could not update the offer.");
  }
}

async function removeOffer(offerId) {
  const offer = offers.find(item => item.id === offerId);
  if (!offer) return;
  if (!confirm(`Delete "${offer.name || offerId}"?\n\nBusinesses that already claimed it keep what they were given. This only removes the offer from future checkouts.`)) return;
  try {
    await deleteDoc(doc(db, "offers", offerId));
  } catch (error) {
    alert(error.message || "Could not delete the offer.");
  }
}

/* ---------------------------------------------------------
   SUBSCRIPTIONS + REVENUE

   Subscription revenue is Scan2Plate's own income. It is never
   mixed with the restaurants' customer-order revenue, which the
   existing Reports section covers separately.
--------------------------------------------------------- */
function businessName(businessId) {
  const match = businesses.find(item => item.id === businessId);
  return match?.restaurantName || match?.name || businessId || "—";
}

function filteredSubscriptions() {
  const search = String($("#subSearch")?.value || "").trim().toLowerCase();
  const type = $("#subTypeFilter")?.value || "all";
  const status = $("#subStatusFilter")?.value || "all";
  const cycle = $("#subCycleFilter")?.value || "all";
  return subscriptions.filter(sub => {
    if (type !== "all" && normalizeBusinessType(sub.businessType) !== type) return false;
    if (status !== "all" && String(sub.status || "") !== status) return false;
    if (cycle !== "all" && String(sub.billingCycle || "") !== cycle) return false;
    if (!search) return true;
    const business = businesses.find(item => item.id === sub.businessId) || {};
    return [businessName(sub.businessId), business.phone, business.email, business.ownerEmail, sub.razorpaySubscriptionId, sub.id]
      .join(" ").toLowerCase().includes(search);
  });
}

function renderSubscriptions() {
  const body = $("#subscriptionRows");
  if (!body) return;
  const rows = filteredSubscriptions();
  body.innerHTML = rows.length ? rows.map(sub => {
    const next = toDate(sub.nextBillingDate);
    return `<tr>
      <td><strong>${esc(businessName(sub.businessId))}</strong><span class="sa-sub">${esc(sub.razorpaySubscriptionId || sub.id)}</span></td>
      <td>${esc(businessTypeLabel(sub.businessType))}</td>
      <td>${esc(sub.planName || sub.planId || "—")}</td>
      <td>${esc(sub.billingCycle || "—")}</td>
      <td>${formatMoney(sub.amount || 0)}</td>
      <td><span class="sa-badge ${statusTone(sub.status) === "success" ? "active" : statusTone(sub.status) === "danger" ? "expired" : "suspended"}">${esc(statusLabel(sub.status))}</span></td>
      <td>${next ? esc(next.toLocaleDateString("en-IN")) : "—"}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="7"><div class="sa-empty">No subscriptions match these filters.</div></td></tr>`;
}

function renderMetrics() {
  const host = $("#subscriptionMetrics");
  if (!host) return;
  const count = predicate => subscriptions.filter(predicate).length;
  const now = new Date();
  const paidIn = (from) => subscriptions
    .filter(sub => {
      const paidAt = toDate(sub.lastPaidAt);
      return paidAt && paidAt >= from && Number(sub.lastPaymentAmount || 0) > 0;
    })
    .reduce((sum, sub) => sum + Number(sub.lastPaymentAmount || 0), 0);

  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const tiles = [
    ["Total Subscribers", subscriptions.length],
    ["Active", count(s => s.status === "active")],
    ["Trial", count(s => s.status === "trial")],
    ["Monthly", count(s => s.billingCycle === "monthly")],
    ["Annual", count(s => s.billingCycle === "yearly")],
    ["Payment Failed", count(s => s.status === "payment_failed")],
    ["Cancelled", count(s => s.status === "cancelled")],
    ["Expired", count(s => s.status === "expired")],
    ["Revenue Today", formatMoney(paidIn(startOfDay))],
    ["Revenue This Month", formatMoney(paidIn(startOfMonth))],
    ["Revenue This Year", formatMoney(paidIn(startOfYear))]
  ];
  // .sa-stat is the console's own summary tile markup.
  host.innerHTML = tiles.map(([label, value]) =>
    `<div class="sa-stat"><div class="sa-stat-top">${esc(label)}</div><b>${esc(value)}</b></div>`).join("");
}
