"use strict";

// The desktop app never bundles a copy of the web frontend — it loads the
// same live site everyone else uses, inside a hardened native window. This
// is deliberate: one codebase, one Firebase project, zero drift between web
// and desktop. Override with SCAN2PLATE_DESKTOP_URL for local dev against a
// non-production backend (e.g. firebase emulators or localhost:5000).
const DEFAULT_APP_URL = "https://scan2plate.com/admin-login.html";
const APP_URL = process.env.SCAN2PLATE_DESKTOP_URL || DEFAULT_APP_URL;

// Top-level navigation is restricted to these hosts. Anything else (support
// links, WhatsApp links, third-party payment redirects, etc.) opens in the
// system's default browser instead of inside the app window.
const ALLOWED_HOSTS = ["scan2plate.com", "www.scan2plate.com"];

const APP_NAME = "Scan2Plate Restaurant POS";
const APP_ID = "com.scan2plate.restaurantpos";

module.exports = { APP_URL, ALLOWED_HOSTS, APP_NAME, APP_ID, DEFAULT_APP_URL };
