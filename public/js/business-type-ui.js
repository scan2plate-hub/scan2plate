/* =========================================================
   BUSINESS-TYPE DRIVEN UI

   The dashboard was built restaurant-first, so Settings shows
   table and kitchen configuration to every business and the
   sidebar offers KOT to a salon. This tags the existing settings
   cards with the group they belong to and hides the ones the
   business type does not use, then does the same for sidebar
   modules.

   Two rules keep this safe:

   1. It only ever ADDS `hidden`, never removes it. applyStaffPermissions()
      already hides nav items by role, and this must not undo that —
      a section stays hidden if EITHER the role or the business type
      says so.
   2. Nothing is deleted and no setting is cleared. A hidden field
      keeps its stored value, so switching a business's type back
      restores its configuration untouched.

   Type-specific settings (rooms, hostel, salon) are added as new
   cards writing into settings/general, which is schemaless — so
   this is additive and backward compatible.
========================================================= */
import { businessTypeConfig, businessTypeLabel, normalizeBusinessType, showsSettingsGroup, supportsModule } from "./business-types.js";

// Which settings group each existing card belongs to, keyed by a stable
// element inside it. Cards are matched by the id of a field they contain, so
// no markup has to be restructured.
const CARD_GROUPS = [
  { group: "business", anchor: "restaurantField" },
  { group: "payments", anchor: "upiField" },
  { group: "tables", anchor: "allowedOrderRadiusField" },   // Order Location Protection
  { group: "billing", anchor: "printModeField" },           // Print Settings
  { group: "onlineOrders", anchor: "preorderEnabledField" },
  { group: "onlineOrders", anchor: "deliveryEnabledField" }
];

// Individual fields that belong to a narrower group than their card.
const FIELD_GROUPS = [
  { group: "tables", anchor: "tableCountField" },
  { group: "kitchen", anchor: "kitchenWhatsAppField" }
];

// Sidebar sections and the module each one needs.
const SECTION_MODULES = {
  orders: "liveOrders",
  billing: "quickBilling",
  "online-orders": "onlineOrders",
  kot: "kot",
  tables: "tables",
  menu: "menu",
  inventory: "inventory",
  reports: "reports",
  staff: "staff"
};

function cardFor(anchorId) {
  return document.getElementById(anchorId)?.closest(".card") || null;
}

function fieldFor(anchorId) {
  return document.getElementById(anchorId)?.closest(".form-group") || null;
}

/**
 * Applies a business type to the dashboard. Safe to call again after the
 * type changes; it re-evaluates every group from scratch.
 */
export function applyBusinessTypeUi(businessType) {
  const type = normalizeBusinessType(businessType);
  const config = businessTypeConfig(type);

  CARD_GROUPS.forEach(({ group, anchor }) => {
    const card = cardFor(anchor);
    if (card && !showsSettingsGroup(type, group)) card.classList.add("hidden");
  });

  FIELD_GROUPS.forEach(({ group, anchor }) => {
    const field = fieldFor(anchor);
    if (field && !showsSettingsGroup(type, group)) field.classList.add("hidden");
  });

  // Sidebar: hide a section this business type has no use for. Never unhide —
  // applyStaffPermissions() may already have hidden it by role.
  Object.entries(SECTION_MODULES).forEach(([section, moduleName]) => {
    if (supportsModule(type, moduleName)) return;
    document.querySelector(`.nav-item[data-section="${section}"]`)?.classList.add("hidden");
    document.getElementById(`section-${section}`)?.classList.add("hidden");
  });

  // Quick actions that assume a restaurant.
  if (!supportsModule(type, "kot")) document.querySelectorAll('.quick-action[data-action="print-kot"]').forEach(el => el.classList.add("hidden"));
  if (!supportsModule(type, "tables")) document.querySelectorAll('[data-action="tables"]').forEach(el => el.classList.add("hidden"));

  relabelForBusinessType(type, config.label);
  ensureTypeSpecificSettings(type);
  return type;
}

/**
 * The dashboard says "Restaurant" in a few fixed places. A hostel owner
 * should not be asked for their "Restaurant Name".
 */
function relabelForBusinessType(type, label) {
  if (type === "restaurant") return;
  const nameLabel = document.getElementById("restaurantField")?.closest(".form-group")?.querySelector(".form-label");
  if (nameLabel) nameLabel.textContent = `${label} Name`;
  const infoTitle = document.getElementById("restaurantField")?.closest(".card")?.querySelector(".card-title");
  if (infoTitle) infoTitle.innerHTML = `<i class="fas fa-store"></i> ${label} Info`;
  const nameInput = document.getElementById("restaurantField");
  if (nameInput) nameInput.placeholder = `Your ${label} Name`;
}

/* ---------------------------------------------------------
   TYPE-SPECIFIC SETTINGS

   Added only for the types that declare the group. Fields write
   into settings/general alongside everything else.
--------------------------------------------------------- */
const EXTRA_CARDS = {
  rooms: {
    title: "Rooms",
    icon: "fa-bed",
    fields: [
      ["roomCount", "Number of rooms", "number"],
      ["roomNumberPrefix", "Room number prefix", "text"],
      ["checkInTime", "Check-in time", "time"],
      ["checkOutTime", "Check-out time", "time"]
    ],
    toggles: [["roomServiceEnabled", "Enable room service"], ["roomBillingEnabled", "Enable room billing"]]
  },
  hostel: {
    title: "Hostel & Residents",
    icon: "fa-building-user",
    fields: [
      ["wardenName", "Warden / manager name", "text"],
      ["wardenPhone", "Warden phone", "tel"],
      ["bedsPerRoom", "Beds per room", "number"],
      ["monthlyRent", "Default monthly rent (₹)", "number"]
    ],
    toggles: [["roomAllocationEnabled", "Enable room allocation"], ["residentAttendanceEnabled", "Track resident attendance"]]
  },
  mess: {
    title: "Mess & Food Plans",
    icon: "fa-utensils",
    fields: [
      ["messPlanName", "Default food plan name", "text"],
      ["messMonthlyCharge", "Monthly mess charge (₹)", "number"]
    ],
    toggles: [["messEnabled", "Enable mess billing"]]
  },
  salon: {
    title: "Services & Appointments",
    icon: "fa-scissors",
    fields: [
      ["appointmentSlotMinutes", "Appointment slot length (minutes)", "number"],
      ["salonOpenTime", "Opening time", "time"],
      ["salonCloseTime", "Closing time", "time"]
    ],
    toggles: [["appointmentsEnabled", "Enable appointment booking"], ["walkInsEnabled", "Accept walk-ins"]]
  },
  products: {
    title: "Products & Custom Orders",
    icon: "fa-cake-candles",
    fields: [
      ["customOrderLeadHours", "Custom order lead time (hours)", "number"],
      ["customOrderAdvancePercent", "Advance payment (%)", "number"]
    ],
    toggles: [["customOrdersEnabled", "Accept custom orders"]]
  }
};

function ensureTypeSpecificSettings(type) {
  const host = document.querySelector("#section-settings .grid-2") || document.getElementById("section-settings");
  if (!host) return;
  Object.entries(EXTRA_CARDS).forEach(([group, spec]) => {
    const id = `settingsCard-${group}`;
    const existing = document.getElementById(id);
    if (!showsSettingsGroup(type, group)) {
      existing?.classList.add("hidden");
      return;
    }
    if (existing) { existing.classList.remove("hidden"); return; }
    host.insertAdjacentHTML("beforeend", `
      <div class="card" id="${id}" data-settings-group="${group}">
        <div class="card-header"><h3 class="card-title"><i class="fas ${spec.icon}"></i> ${spec.title}</h3></div>
        <div class="card-body">
          ${spec.fields.map(([field, label, inputType]) =>
            `<div class="form-group"><label class="form-label">${label}</label><input class="form-input" id="${field}Field" type="${inputType}" /></div>`).join("")}
          ${spec.toggles.map(([field, label]) =>
            `<label class="check-row" style="font-weight:700;display:flex;gap:8px;align-items:center;margin-bottom:8px;"><input id="${field}Field" type="checkbox" /> ${label}</label>`).join("")}
        </div>
      </div>`);
  });
}

/** Every extra field id, so settings load/save can round-trip them. */
export function typeSpecificSettingFields() {
  return Object.values(EXTRA_CARDS).flatMap(spec => [
    ...spec.fields.map(([field, , inputType]) => ({ field, kind: inputType === "number" ? "number" : "text" })),
    ...spec.toggles.map(([field]) => ({ field, kind: "boolean" }))
  ]);
}

export { businessTypeLabel };
