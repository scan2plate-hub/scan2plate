/* Mounts the subscription sections once the Super Admin console's own markup
   exists. Kept separate from super-admin-billing.js so that module stays
   purely functional and testable. */
import { mountSuperAdminBilling } from "./super-admin-billing.js";

function boot() {
  try {
    mountSuperAdminBilling();
  } catch (error) {
    // A failure here must never take down the rest of the console.
    console.error("Super Admin billing sections failed to mount", error);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
