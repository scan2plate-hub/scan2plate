"use strict";

const crypto = require("node:crypto");

// OFF-<restaurantId>-<YYYYMMDD>-<uuid>. The UUID alone is already globally
// unique; restaurantId+date are prefixed purely so a support agent can
// eyeball which restaurant/day an ID belongs to without a lookup. This is
// never used as the *only* uniqueness guarantee - the UUID is.
function generateOfflineId(restaurantId, date = new Date()) {
  const safeRestaurantId = String(restaurantId || "unknown").trim().replace(/[^a-zA-Z0-9_-]/g, "") || "unknown";
  const yyyymmdd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const uuid = crypto.randomUUID();
  return `OFF-${safeRestaurantId}-${yyyymmdd}-${uuid}`;
}

function isOfflineId(value) {
  return /^OFF-[a-zA-Z0-9_-]+-\d{8}-[0-9a-f-]{36}$/i.test(String(value || ""));
}

module.exports = { generateOfflineId, isOfflineId };
