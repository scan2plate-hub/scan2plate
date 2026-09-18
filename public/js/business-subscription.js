/* =========================================================
   BUSINESS OWNER — SUBSCRIPTION, PRICING AND OFFERS

   Adds a "Subscription" section to the admin dashboard showing
   the current plan and the plans available to THIS business type,
   plus the offer popup.

   A hostel never sees restaurant plans: the plan list is filtered
   by the business's own `businessType`, with global ("all") plans
   included. Pricing, discounts and bonus months all come from
   subscription-core, the same module the server and the Super
   Admin console use, so the three never disagree.

   Payment is confirmed by the signed Razorpay webhook, never by
   the checkout callback. The live subscription listener then
   updates this panel in place — no page reload.
========================================================= */
import {
  pricingFor, currentSubscription, watchSubscription, loadPlan, promotableOffer,
  isOfferDismissed, dismissOffer, startSubscription, cancelSubscription, openRazorpayCheckout
} from "./subscription-client.js?v=s2p-20260918c";
import { businessTypeLabel } from "./business-types.js?v=s2p-20260918c";
import {
  formatMoney, statusLabel, statusTone, toDate, isEntitled, graceEndsAt, limitLabel, planAllowsFeature
} from "./subscription-core.js?v=s2p-20260918c";

const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const dateLabel = value => {
  const date = toDate(value);
  return date ? date.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "—";
};

let context = { businessId: "", businessType: "restaurant", businessName: "", email: "", phone: "" };
let subscription = null;
let currentPlan = null;
let billingCycle = "monthly";
let unsubscribeWatch = null;

/* ---------------------------------------------------------
   MOUNT
--------------------------------------------------------- */
export async function mountBusinessSubscription(options = {}) {
  context = { ...context, ...options };
  if (!context.businessId) return;
  if (!document.getElementById("section-subscription")) buildSection();

  subscription = await currentSubscription(context.businessId).catch(() => null);
  currentPlan = subscription?.planId ? await loadPlan(subscription.planId).catch(() => null) : null;
  render();
  await renderPlans();

  // One live listener. After the webhook writes a new status this fires and
  // the panel re-renders itself.
  unsubscribeWatch?.();
  unsubscribeWatch = watchSubscription(context.businessId, async next => {
    subscription = next;
    if (next?.planId && next.planId !== currentPlan?.id) currentPlan = await loadPlan(next.planId).catch(() => null);
    render();
  }, error => console.warn("subscription listener failed", error?.message));

  mountOfferPopup().catch(error => console.warn("offer popup failed", error?.message));
  return () => unsubscribeWatch?.();
}

function buildSection() {
  const main = document.querySelector("main.main-content") || document.querySelector(".dashboard-content");
  if (!main) return;
  document.querySelector('.nav-item[data-section="settings"]')
    ?.insertAdjacentHTML("beforebegin", `<a class="nav-item" data-section="subscription"><span class="nav-icon"><i class="fas fa-crown"></i></span><span>Subscription</span></a>`);
  main.insertAdjacentHTML("beforeend", `
    <section class="content-section" id="section-subscription">
      <div class="card" id="subscriptionStatusCard"><div class="card-body"><p class="muted">Loading subscription…</p></div></div>
      <div class="card" style="margin-top:16px;">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
          <h3 class="card-title"><i class="fas fa-tags"></i> <span id="plansHeading">Plans</span></h3>
          <div class="btn-group">
            <button class="btn btn-sm btn-primary" id="cycleMonthlyBtn" type="button">Monthly</button>
            <button class="btn btn-sm btn-outline" id="cycleYearlyBtn" type="button">Yearly</button>
          </div>
        </div>
        <div class="card-body"><div id="planCards" class="stats-grid"></div></div>
      </div>
    </section>`);
  document.getElementById("cycleMonthlyBtn")?.addEventListener("click", () => setCycle("monthly"));
  document.getElementById("cycleYearlyBtn")?.addEventListener("click", () => setCycle("yearly"));
  document.getElementById("planCards")?.addEventListener("click", event => {
    const button = event.target.closest("button[data-subscribe-plan]");
    if (button) beginCheckout(button.dataset.subscribePlan, button.dataset.offerId || "");
  });
  document.getElementById("subscriptionStatusCard")?.addEventListener("click", event => {
    if (event.target.closest("#cancelSubscriptionBtn")) requestCancel();
    if (event.target.closest("#viewPlansBtn")) document.getElementById("planCards")?.scrollIntoView({ behavior: "smooth" });
  });
}

function setCycle(cycle) {
  billingCycle = cycle;
  document.getElementById("cycleMonthlyBtn")?.classList.toggle("btn-primary", cycle === "monthly");
  document.getElementById("cycleMonthlyBtn")?.classList.toggle("btn-outline", cycle !== "monthly");
  document.getElementById("cycleYearlyBtn")?.classList.toggle("btn-primary", cycle === "yearly");
  document.getElementById("cycleYearlyBtn")?.classList.toggle("btn-outline", cycle !== "yearly");
  renderPlans();
}

/* ---------------------------------------------------------
   CURRENT SUBSCRIPTION
--------------------------------------------------------- */
function render() {
  const host = document.getElementById("subscriptionStatusCard");
  if (!host) return;

  if (!subscription) {
    host.innerHTML = `<div class="card-body">
      <h3 style="margin:0 0 6px;">No active subscription</h3>
      <p class="muted" style="margin:0 0 12px;">Choose a ${esc(businessTypeLabel(context.businessType))} plan below to activate Scan2Plate.</p>
      <button class="btn btn-primary" id="viewPlansBtn" type="button">View Plans</button>
    </div>`;
    return;
  }

  const tone = statusTone(subscription.status);
  const entitled = isEntitled(subscription);
  const grace = graceEndsAt(subscription);
  const failed = subscription.status === "payment_failed" || subscription.status === "halted";

  host.innerHTML = `<div class="card-body">
    <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start;">
      <div>
        <div style="font-size:12px;font-weight:800;color:var(--text-3);letter-spacing:.06em;">SUBSCRIPTION</div>
        <h3 style="margin:6px 0 4px;">${esc(subscription.planName || currentPlan?.name || "Plan")}</h3>
        <div class="muted" style="font-size:13px;">${esc(businessTypeLabel(subscription.businessType || context.businessType))} · ${esc(subscription.billingCycle || "monthly")}</div>
      </div>
      <span class="status-badge ${tone === "success" ? "success" : tone === "danger" ? "danger" : "warning"}" style="font-size:12px;">● ${esc(statusLabel(subscription.status))}</span>
    </div>

    ${failed ? `<div class="notice-box danger" style="margin-top:14px;">
      <i class="fas fa-triangle-exclamation"></i>
      <span><strong>Payment failed.</strong> Please update your payment method to continue Scan2Plate.${grace && entitled ? ` Your access continues until <strong>${esc(dateLabel(grace))}</strong>.` : ""}</span>
    </div>` : ""}

    <div class="form-row" style="margin-top:16px;">
      <div><div class="muted" style="font-size:12px;">Price</div><strong>${formatMoney(subscription.amount || 0)}</strong></div>
      <div><div class="muted" style="font-size:12px;">Started</div><strong>${esc(dateLabel(subscription.startDate))}</strong></div>
      <div><div class="muted" style="font-size:12px;">Next billing</div><strong>${esc(dateLabel(subscription.nextBillingDate))}</strong></div>
      <div><div class="muted" style="font-size:12px;">Access until</div><strong>${esc(dateLabel(subscription.endDate))}</strong></div>
    </div>

    ${Number(subscription.bonusMonths) > 0 ? `<div class="notice-box success" style="margin-top:12px;">
      <i class="fas fa-gift"></i><span>Offer applied: <strong>${Number(subscription.paidMonths || 12)} months paid + ${Number(subscription.bonusMonths)} bonus months</strong> — access runs to ${esc(dateLabel(subscription.endDate))}.</span>
    </div>` : ""}

    ${currentPlan ? `<div style="margin-top:14px;font-size:12px;" class="muted">
      Included: ${esc(["maxTables", "maxStaff", "maxMenuItems"].map(key => `${key.replace("max", "")} ${limitLabel(currentPlan, key)}`).join(" · "))}
    </div>` : ""}

    <div class="btn-group" style="margin-top:16px;flex-wrap:wrap;">
      <button class="btn btn-outline" id="viewPlansBtn" type="button">Change Plan</button>
      ${["active", "trial", "payment_failed"].includes(subscription.status)
        ? `<button class="btn btn-outline" id="cancelSubscriptionBtn" type="button">Cancel Subscription</button>` : ""}
    </div>
  </div>`;
}

/* ---------------------------------------------------------
   PLANS FOR THIS BUSINESS TYPE
--------------------------------------------------------- */
async function renderPlans() {
  const host = document.getElementById("planCards");
  if (!host) return;
  const heading = document.getElementById("plansHeading");
  if (heading) heading.textContent = `${businessTypeLabel(context.businessType)} Plans`;

  let rows = [];
  try {
    rows = await pricingFor(context.businessType);
  } catch (error) {
    console.warn("plan load failed", error?.message);
    host.innerHTML = `<p class="muted">Could not load plans right now. Please try again.</p>`;
    return;
  }
  if (!rows.length) {
    host.innerHTML = `<p class="muted">No ${esc(businessTypeLabel(context.businessType))} plans are available yet. Please contact Scan2Plate support.</p>`;
    return;
  }

  host.innerHTML = rows.map(({ plan, monthly, yearly }) => {
    const quote = billingCycle === "yearly" ? yearly : monthly;
    if (!quote.listPrice) return "";
    const isCurrent = subscription?.planId === plan.id && ["active", "trial"].includes(subscription?.status);
    return `<div class="card" style="padding:18px;${plan.featured ? "border:2px solid var(--brand);" : ""}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <h4 style="margin:0;">${esc(plan.name)}</h4>
        ${plan.badgeText ? `<span class="status-badge info">${esc(plan.badgeText)}</span>` : ""}
      </div>
      ${plan.description ? `<p class="muted" style="font-size:12px;margin:6px 0 0;">${esc(plan.description)}</p>` : ""}
      <div style="margin:12px 0 4px;font-size:26px;font-weight:900;">
        ${formatMoney(quote.payable)}
        <span class="muted" style="font-size:12px;font-weight:600;">/ ${billingCycle === "yearly" ? "year" : "month"}</span>
      </div>
      ${quote.discount > 0 ? `<div class="muted" style="font-size:12px;"><s>${formatMoney(quote.listPrice)}</s> · you save ${formatMoney(quote.discount)}</div>` : ""}
      ${quote.bonusMonths > 0 ? `<div class="status-badge success" style="margin-top:8px;">Pay ${quote.paidMonths} months, get ${quote.bonusMonths} FREE — ${quote.totalMonths} months access</div>` : ""}
      ${quote.trialDays > 0 ? `<div class="muted" style="font-size:12px;margin-top:6px;">${quote.trialDays}-day free trial</div>` : ""}
      ${quote.offerText ? `<div class="muted" style="font-size:12px;margin-top:6px;">${esc(quote.offerText)}</div>` : ""}
      <ul style="margin:12px 0;padding-left:18px;font-size:12px;line-height:1.9;" class="muted">
        ${["qrOrdering", "kot", "inventory", "reports", "onlineOrders", "whatsapp"]
          .filter(key => planAllowsFeature(plan, key))
          .slice(0, 6)
          .map(key => `<li>${esc(key.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()))}</li>`).join("")}
      </ul>
      <button class="btn ${isCurrent ? "btn-outline" : "btn-primary"}" style="width:100%;"
        ${isCurrent ? "disabled" : ""}
        data-subscribe-plan="${esc(plan.id)}" data-offer-id="${esc(quote.offerId || "")}" type="button">
        ${isCurrent ? "Current Plan" : subscription ? "Change to this plan" : "Subscribe"}
      </button>
    </div>`;
  }).join("");
}

/* ---------------------------------------------------------
   CHECKOUT
--------------------------------------------------------- */
async function beginCheckout(planId, offerId) {
  const button = document.querySelector(`button[data-subscribe-plan="${CSS.escape(planId)}"]`);
  const original = button?.textContent;
  try {
    if (button) { button.disabled = true; button.textContent = "Starting…"; }
    // The server resolves the Razorpay plan, re-validates the offer and
    // creates the subscription. Nothing about price is decided here.
    const created = await startSubscription({ businessId: context.businessId, planId, billingCycle, offerId });
    await openRazorpayCheckout({
      publicKeyId: created.publicKeyId,
      razorpaySubscriptionId: created.razorpaySubscriptionId,
      name: context.businessName || "Scan2Plate",
      description: `${businessTypeLabel(context.businessType)} subscription`,
      prefill: { email: context.email || "", contact: context.phone || "" },
      onSuccess: () => {
        // The signed webhook is what actually activates this. The listener
        // above will re-render the panel when it lands.
        showToast("Payment received. Activating your subscription…");
      },
      onDismiss: () => showToast("Checkout closed. Your plan was not changed.", "warning")
    });
  } catch (error) {
    console.warn("checkout failed", error?.message);
    showToast(error?.message || "Could not start checkout. Please try again.", "danger");
  } finally {
    if (button) { button.disabled = false; button.textContent = original || "Subscribe"; }
  }
}

async function requestCancel() {
  if (!subscription?.id) return;
  const ok = confirm("Cancel this subscription?\n\nIt stays active until the end of the period you have already paid for. Your data is not deleted.");
  if (!ok) return;
  try {
    await cancelSubscription(subscription.id);
    showToast("Subscription cancelled. Access continues until the paid period ends.");
  } catch (error) {
    showToast(error?.message || "Could not cancel the subscription.", "danger");
  }
}

function showToast(message, tone = "success") {
  if (typeof window.scan2plateToast === "function") return window.scan2plateToast(message, tone);
  const colors = { success: "#16a34a", warning: "#b45309", danger: "#b91c1c" };
  const toast = document.createElement("div");
  toast.style.cssText = `position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:99999;max-width:min(92vw,460px);padding:12px 16px;border-radius:12px;background:${colors[tone] || colors.success};color:#fff;font:13px/1.45 Arial,sans-serif;font-weight:700;box-shadow:0 16px 40px rgba(0,0,0,.2);`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

/* ---------------------------------------------------------
   OFFER POPUP

   Shows at most ONE offer — the highest priority one that
   applies to this business type — and only when it is live,
   matches, and has not been dismissed. Dismissal is remembered,
   so it cannot reappear on every page change.
--------------------------------------------------------- */
export async function mountOfferPopup() {
  // An entitled business is not shown a sales popup.
  if (subscription && isEntitled(subscription) && subscription.status !== "trial") return;

  const promo = await promotableOffer(context.businessType);
  if (!promo?.offer || !promo.plan) return;
  if (isOfferDismissed(promo.offer.id)) return;
  if (document.getElementById("scan2plateOfferPopup")) return;

  const { offer, plan, quote } = promo;
  const overlay = document.createElement("div");
  overlay.id = "scan2plateOfferPopup";
  overlay.style.cssText = "position:fixed;inset:0;z-index:2500;display:grid;place-items:center;padding:16px;background:rgba(17,24,39,.55);";
  overlay.innerHTML = `
    <div style="width:min(420px,100%);border-radius:20px;background:#fff;box-shadow:0 30px 70px rgba(0,0,0,.3);overflow:hidden;">
      <div style="padding:20px;background:linear-gradient(135deg,#F97316,#ea580c);color:#fff;text-align:center;">
        ${offer.badge ? `<div style="display:inline-block;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.22);font-size:11px;font-weight:800;letter-spacing:.06em;">${esc(offer.badge)}</div>` : ""}
        <h3 style="margin:10px 0 0;font-size:22px;">🎉 ${esc(offer.name || "Special Offer")}</h3>
      </div>
      <div style="padding:20px;text-align:center;">
        <div style="font-weight:800;font-size:15px;">${esc(plan.name)}</div>
        <div class="muted" style="font-size:12px;margin-top:2px;">${esc(businessTypeLabel(context.businessType))} · ${esc(quote.billingCycle === "yearly" ? "Annual Plan" : "Monthly Plan")}</div>
        <div style="margin:14px 0 4px;font-size:30px;font-weight:900;">${formatMoney(quote.payable)}</div>
        ${quote.discount > 0 ? `<div class="muted" style="font-size:12px;"><s>${formatMoney(quote.listPrice)}</s> · save ${formatMoney(quote.discount)}</div>` : ""}
        ${quote.bonusMonths > 0 ? `<div style="margin-top:10px;font-weight:800;color:#16a34a;">Pay for ${quote.paidMonths} months<br>Get ${quote.bonusMonths} Months FREE</div>` : ""}
        ${offer.offerText ? `<p class="muted" style="font-size:12px;margin:12px 0 0;">${esc(offer.offerText)}</p>` : ""}
        <button class="btn btn-primary" id="claimOfferBtn" style="width:100%;margin-top:16px;" type="button">Claim Offer</button>
        <button class="btn btn-outline" id="dismissOfferBtn" style="width:100%;margin-top:8px;" type="button">Maybe later</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector("#dismissOfferBtn")?.addEventListener("click", () => { dismissOffer(offer.id); close(); });
  overlay.addEventListener("click", event => { if (event.target === overlay) { dismissOffer(offer.id, 1); close(); } });
  overlay.querySelector("#claimOfferBtn")?.addEventListener("click", () => {
    dismissOffer(offer.id, 30);
    close();
    billingCycle = quote.billingCycle;
    setCycle(billingCycle);
    document.querySelector('.nav-item[data-section="subscription"]')?.click();
    beginCheckout(plan.id, offer.id);
  });
}
