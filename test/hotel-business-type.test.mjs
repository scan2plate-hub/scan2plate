/* =========================================================
   HOTEL AS A BUSINESS TYPE — AND THE PROMISE NOT TO BREAK
   ANYTHING ELSE

   The specification opens with a constraint, not a feature:
   do not break, remove, redesign or negatively affect the
   Restaurant, Cafe, Dhaba, Bakery, Street Vendor, Food Court,
   Cloud Kitchen or other business modes.

   The hotel modules are therefore additive. These tests pin the
   exact module and settings lists of every OTHER type, so any
   future change that reaches them fails here rather than in a
   customer's dashboard.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import {
  listBusinessTypes, modulesForBusinessType, settingsGroupsForBusinessType,
  supportsModule, showsSettingsGroup, normalizeBusinessType, businessTypeLabel,
  MODULES, SETTINGS_GROUPS
} from "../public/js/business-types.js";
import { HOTEL_BUSINESS_TYPE } from "../public/js/hotel-core.js";

// Every PMS module and settings group the hotel type introduces.
const PMS_MODULES = [
  "frontDesk", "reservations", "bookingCalendar", "housekeeping", "maintenance",
  "guestCrm", "folios", "ratePlans", "nightAudit", "cashierShifts",
  "bookingEngine", "channelManager", "banquet", "corporate", "lostFound",
  "linen", "minibar"
];
const PMS_SETTINGS = [
  "hotelProfile", "hotelRooms", "hotelRates", "hotelPolicies",
  "hotelHousekeeping", "hotelNightAudit", "hotelBookingEngine", "hotelChannelManager"
];

const OTHER_TYPES = listBusinessTypes()
  .map(type => type.id)
  .filter(id => id !== HOTEL_BUSINESS_TYPE);

/* ---------------------------------------------------------
   THE PROMISE
--------------------------------------------------------- */

test("NO other business type gains a single hotel module", () => {
  OTHER_TYPES.forEach(type => {
    PMS_MODULES.forEach(moduleName => {
      assert.equal(supportsModule(type, moduleName), false,
        `${type} must not have ${moduleName}`);
    });
  });
});

test("NO other business type gains a hotel settings group", () => {
  OTHER_TYPES.forEach(type => {
    PMS_SETTINGS.forEach(group => {
      assert.equal(showsSettingsGroup(type, group), false,
        `${type} must not show ${group}`);
    });
  });
});

test("the restaurant's own modules and settings are byte-for-byte what they were", () => {
  // Pinned literally. A diff here means a restaurant owner's dashboard
  // changed, which this work is not allowed to do.
  assert.deepEqual(modulesForBusinessType("restaurant"), [
    "dashboard", "quickBilling", "reports", "staff",
    "liveOrders", "onlineOrders", "preOrder", "kot", "kitchenDisplay",
    "tables", "menu", "inventory", "qrOrdering", "payroll"
  ]);
  assert.deepEqual(settingsGroupsForBusinessType("restaurant").map(group => group.id), [
    "business", "billing", "payments", "notifications", "subscription",
    "tables", "kitchen", "menu", "inventory", "onlineOrders"
  ]);
});

test("the street vendor stays deliberately minimal", () => {
  assert.deepEqual(modulesForBusinessType("street_vendor"), [
    "dashboard", "quickBilling", "liveOrders", "menu", "qrOrdering", "reports"
  ]);
  assert.deepEqual(settingsGroupsForBusinessType("street_vendor").map(group => group.id), [
    "business", "billing", "payments", "menu", "subscription"
  ]);
});

test("every named business mode still exists and still resolves", () => {
  // The spec names these explicitly. None may disappear.
  ["restaurant", "cafe", "dhaba", "bakery", "street_vendor", "food_court", "cloud_kitchen"]
    .forEach(id => {
      assert.ok(listBusinessTypes().some(type => type.id === id), `${id} must still exist`);
      assert.equal(normalizeBusinessType(businessTypeLabel(id)), id, `${id} must round-trip`);
    });
});

test("an existing business with no businessType is still a restaurant", () => {
  // Migration safety, section 57: nothing is re-onboarded and no stored
  // record needs changing for the hotel type to exist.
  assert.equal(normalizeBusinessType(""), "restaurant");
  assert.equal(normalizeBusinessType(undefined), "restaurant");
  assert.equal(normalizeBusinessType(null), "restaurant");
});

/* ---------------------------------------------------------
   WHAT THE HOTEL GETS
--------------------------------------------------------- */

test("the hotel type carries the full PMS", () => {
  PMS_MODULES.forEach(moduleName => {
    assert.equal(supportsModule(HOTEL_BUSINESS_TYPE, moduleName), true, `hotel needs ${moduleName}`);
  });
  PMS_SETTINGS.forEach(group => {
    assert.equal(showsSettingsGroup(HOTEL_BUSINESS_TYPE, group), true, `hotel needs ${group}`);
  });
});

test("a hotel also runs restaurants, so it keeps the F&B modules unchanged", () => {
  // Section 17: reuse the existing POS rather than building a second one.
  // The hotel declares the same module ids the restaurant does, so the same
  // code renders them.
  ["liveOrders", "kot", "kitchenDisplay", "tables", "menu", "inventory", "qrOrdering", "roomService"]
    .forEach(moduleName => {
      assert.equal(supportsModule(HOTEL_BUSINESS_TYPE, moduleName), true, `hotel needs ${moduleName}`);
    });
});

test("every module and settings id a type names has a human label", () => {
  // A missing label renders the raw id in the sidebar.
  listBusinessTypes().forEach(({ id }) => {
    modulesForBusinessType(id).forEach(moduleName => {
      assert.ok(MODULES[moduleName], `${id} names module "${moduleName}" with no label`);
    });
    settingsGroupsForBusinessType(id).forEach(group => {
      assert.ok(SETTINGS_GROUPS[group.id], `${id} names settings group "${group.id}" with no label`);
      assert.notEqual(group.label, group.id, `${group.id} is rendering its own id`);
    });
  });
});

test("a hotel declares no module twice", () => {
  const modules = modulesForBusinessType(HOTEL_BUSINESS_TYPE);
  assert.equal(new Set(modules).size, modules.length, "a duplicate would render two sidebar entries");
  const groups = settingsGroupsForBusinessType(HOTEL_BUSINESS_TYPE).map(group => group.id);
  assert.equal(new Set(groups).size, groups.length);
});

test("hotel spellings that already exist in stored records still resolve", () => {
  // add-restaurant.js and the Super Admin console have both written "Hotel",
  // and the panel alias "HotelRoom" is in login.js's panelByType map.
  ["hotel", "Hotel", "HOTEL", "hotelroom"].forEach(spelling => {
    assert.equal(normalizeBusinessType(spelling), HOTEL_BUSINESS_TYPE, `${spelling} must resolve to hotel`);
  });
});
