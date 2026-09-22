/* =========================================================
   BUSINESS TYPE REGISTRY

   Scan2Plate runs one codebase for every kind of business. A
   business record carries `businessType`, and this module is the
   single place that says what that means: the label to show, the
   modules that make sense, and which settings sections to render.

   BACKWARD COMPATIBILITY IS THE POINT OF normalizeBusinessType().
   Existing records store the display form ("Restaurant", "Street
   Vendor"), login.js canonicalises to lowercase-with-spaces, and
   newer code uses snake_case ids. All three resolve to the same id
   here, and a record with NO businessType resolves to "restaurant",
   because the product was restaurant-only before this existed.
   Nothing needs migrating and no existing business is re-onboarded.
========================================================= */

export const DEFAULT_BUSINESS_TYPE = "restaurant";

// Every capability the product can switch on for a business. Plan feature
// flags (see subscription-service.js) use these same keys, so "does this
// business type have tables?" and "does this plan include tables?" are asked
// in one vocabulary.
export const MODULES = {
  dashboard: "Dashboard",
  liveOrders: "Live Orders",
  quickBilling: "Quick Billing",
  onlineOrders: "Online Orders",
  preOrder: "Pre-Orders",
  kot: "KOT / Kitchen",
  kitchenDisplay: "Kitchen Display",
  tables: "Tables",
  rooms: "Rooms",
  beds: "Beds & Residents",
  mess: "Mess / Food Plans",
  appointments: "Appointments",
  services: "Services",
  products: "Products",
  menu: "Menu",
  inventory: "Inventory",
  staff: "Staff",
  payroll: "Payroll",
  reports: "Reports",
  qrOrdering: "QR Ordering",
  customOrders: "Custom Orders",
  roomService: "Room Service",
  whatsapp: "WhatsApp Alerts",
  advancedReports: "Advanced Reports"
};

// Settings groups a business type can show. The Settings screen renders only
// the groups listed for the business's type, so a street vendor never sees
// table or kitchen configuration.
export const SETTINGS_GROUPS = {
  business: "Business Details",
  billing: "Billing & Tax",
  payments: "Payments & UPI",
  tables: "Tables & QR",
  kitchen: "Kitchen & KOT",
  menu: "Menu",
  products: "Products & Categories",
  inventory: "Inventory",
  rooms: "Rooms",
  hostel: "Hostel & Residents",
  mess: "Mess & Food Plans",
  salon: "Services & Appointments",
  onlineOrders: "Online Orders & Delivery",
  notifications: "Notifications",
  subscription: "Subscription"
};

// Groups every business gets, whatever its type.
const COMMON_SETTINGS = ["business", "billing", "payments", "notifications", "subscription"];
const COMMON_MODULES = ["dashboard", "quickBilling", "reports", "staff"];

// Food businesses that seat customers at tables and run a kitchen.
const DINE_IN = {
  modules: [...COMMON_MODULES, "liveOrders", "onlineOrders", "preOrder", "kot", "kitchenDisplay", "tables", "menu", "inventory", "qrOrdering", "payroll"],
  settings: [...COMMON_SETTINGS, "tables", "kitchen", "menu", "inventory", "onlineOrders"]
};

// Counter-service food businesses: a menu and billing, no table service.
const COUNTER_SERVICE = {
  modules: [...COMMON_MODULES, "liveOrders", "onlineOrders", "menu", "inventory", "qrOrdering"],
  settings: [...COMMON_SETTINGS, "menu", "inventory", "onlineOrders"]
};

const TYPES = [
  { id: "restaurant", label: "Restaurant", ...DINE_IN },
  { id: "cafe", label: "Cafe", ...DINE_IN },
  { id: "dhaba", label: "Dhaba", ...DINE_IN },
  { id: "food_court", label: "Food Court", ...DINE_IN },
  { id: "fast_food", label: "Fast Food", ...COUNTER_SERVICE },
  { id: "juice_shop", label: "Juice Shop", ...COUNTER_SERVICE },
  { id: "tea_stall", label: "Tea Stall", ...COUNTER_SERVICE },
  { id: "sweet_shop", label: "Sweet Shop", ...COUNTER_SERVICE },
  {
    id: "bakery",
    label: "Bakery",
    modules: [...COMMON_MODULES, "liveOrders", "onlineOrders", "preOrder", "products", "menu", "inventory", "qrOrdering", "customOrders"],
    settings: [...COMMON_SETTINGS, "products", "menu", "inventory", "onlineOrders"]
  },
  {
    // Deliberately minimal: a street vendor should not be shown table,
    // kitchen or inventory configuration they will never use.
    id: "street_vendor",
    label: "Street Vendor",
    modules: ["dashboard", "quickBilling", "liveOrders", "menu", "qrOrdering", "reports"],
    settings: ["business", "billing", "payments", "menu", "subscription"]
  },
  {
    id: "cloud_kitchen",
    label: "Cloud Kitchen",
    modules: [...COMMON_MODULES, "liveOrders", "onlineOrders", "preOrder", "kot", "kitchenDisplay", "menu", "inventory", "payroll"],
    settings: [...COMMON_SETTINGS, "kitchen", "menu", "inventory", "onlineOrders"]
  },
  {
    id: "hotel",
    label: "Hotel",
    modules: [...COMMON_MODULES, "liveOrders", "rooms", "roomService", "kot", "menu", "inventory", "payroll"],
    settings: [...COMMON_SETTINGS, "rooms", "kitchen", "menu", "inventory"]
  },
  {
    id: "hostel",
    label: "Hostel",
    modules: [...COMMON_MODULES, "rooms", "beds", "mess", "inventory", "payroll"],
    settings: [...COMMON_SETTINGS, "rooms", "hostel", "mess", "inventory"]
  },
  {
    id: "salon",
    label: "Salon",
    modules: [...COMMON_MODULES, "appointments", "services", "inventory", "payroll"],
    settings: [...COMMON_SETTINGS, "salon", "inventory"]
  },
  {
    // The safe catch-all: billing, reports and staff, nothing assumed.
    id: "other",
    label: "Other",
    modules: ["dashboard", "quickBilling", "reports", "staff", "menu"],
    settings: [...COMMON_SETTINGS, "menu"]
  }
];

const BY_ID = new Map(TYPES.map(type => [type.id, type]));

// Every spelling seen in existing data maps to a canonical id.
const ALIASES = new Map();
TYPES.forEach(type => {
  ALIASES.set(type.id, type.id);
  ALIASES.set(type.label.toLowerCase(), type.id);
  ALIASES.set(type.label.toLowerCase().replace(/\s+/g, ""), type.id);
  ALIASES.set(type.id.replace(/_/g, " "), type.id);
  ALIASES.set(type.id.replace(/_/g, ""), type.id);
});
// Panel names and older labels that appear in existing business records.
[
  ["restaurantadmin", "restaurant"], ["cafetoken", "cafe"], ["vendormobile", "street_vendor"],
  ["hotelroom", "hotel"], ["cloudkitchen", "cloud_kitchen"], ["foodcourttoken", "food_court"],
  ["vendor", "street_vendor"], ["streetvendor", "street_vendor"], ["restro", "restaurant"],
  ["hostelmess", "hostel"], ["beauty salon", "salon"], ["parlour", "salon"]
].forEach(([alias, id]) => ALIASES.set(alias, id));

/**
 * Resolves any stored spelling to a canonical business type id.
 * An empty/unknown value becomes "restaurant" — the product was
 * restaurant-only before business types existed, so that is what an
 * existing record without the field actually is.
 */
export function normalizeBusinessType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return DEFAULT_BUSINESS_TYPE;
  return ALIASES.get(raw) || ALIASES.get(raw.replace(/[\s_-]+/g, " ")) || ALIASES.get(raw.replace(/[\s_-]+/g, "")) || DEFAULT_BUSINESS_TYPE;
}

export function businessTypeConfig(value) {
  return BY_ID.get(normalizeBusinessType(value)) || BY_ID.get(DEFAULT_BUSINESS_TYPE);
}

export function businessTypeLabel(value) {
  return businessTypeConfig(value).label;
}

export function listBusinessTypes() {
  return TYPES.map(({ id, label }) => ({ id, label }));
}

/** Modules this business type can use at all, before plan limits apply. */
export function modulesForBusinessType(value) {
  return [...businessTypeConfig(value).modules];
}

export function supportsModule(businessType, moduleName) {
  return businessTypeConfig(businessType).modules.includes(moduleName);
}

/** Settings groups to render, in display order. */
export function settingsGroupsForBusinessType(value) {
  return businessTypeConfig(value).settings.map(id => ({ id, label: SETTINGS_GROUPS[id] || id }));
}

export function showsSettingsGroup(businessType, groupId) {
  return businessTypeConfig(businessType).settings.includes(groupId);
}

/**
 * The business type of a stored record, checking every field older code has
 * used for it. Returns a canonical id.
 */
export function businessTypeOf(record = {}) {
  return normalizeBusinessType(
    record.businessType || record.restaurantType || record.type || record.panelType || ""
  );
}

/**
 * True when this record actually stores a business type, as opposed to
 * merely defaulting to one. businessTypeOf() cannot answer this: it returns
 * "restaurant" both for a record that says Restaurant and for a record that
 * says nothing, and telling those apart is the whole point here.
 */
export function hasBusinessType(record = {}) {
  return Boolean(String(
    record?.businessType || record?.restaurantType || record?.type || record?.panelType || ""
  ).trim());
}

/**
 * The business type of a business, from the documents that claim to hold it,
 * MOST AUTHORITATIVE FIRST.
 *
 * WHY THIS EXISTS. A business's type was being stored in three places — the
 * `restaurants/{id}` document, its `settings/general` sub-document, and the
 * top-level `restaurantSettings/{id}` document — and the screens disagreed
 * about which one won. Super Admin read the root document; the owner's
 * dashboard spread `settings/general` over the root, so the sub-document won.
 * Super Admin's "Save business type" writes the root document only, so
 * correcting a type there left the owner's dashboard on the old one: Super
 * Admin showed Restaurant while the owner was offered Street Vendor plans,
 * for the same business, on the same day.
 *
 * The root document is authoritative, and not arbitrarily: it is what Super
 * Admin edits, what login.js gates the panel choice on, and — decisively —
 * what the server reads when it decides whether a plan may be bought
 * (see businessTypeOfDoc in backend/server.js). A client that offered plans
 * for any other document's type would have its checkout rejected.
 *
 * Later arguments are consulted only when the earlier ones store nothing at
 * all, which keeps businesses that predate the root field working.
 */
export function resolveBusinessType(...records) {
  for (const record of records) {
    if (record && hasBusinessType(record)) return businessTypeOf(record);
  }
  return DEFAULT_BUSINESS_TYPE;
}
