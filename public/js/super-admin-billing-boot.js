/* Mounts the subscription sections once the Super Admin console's own markup
   exists. Kept separate from super-admin-billing.js so that module stays
   purely functional and testable.

   The import is DYNAMIC on purpose. A static import that fails to link — a
   renamed export, or a stale cached copy of a dependency that predates a new
   one — throws before any code in this file runs, so a try/catch around the
   call would never see it and the nav items would simply never appear with no
   clue why. A dynamic import inside the try catches that too, and says so. */
function boot() {
  import("./super-admin-billing.js?v=s2p-20260922d")
    .then(module => module.mountSuperAdminBilling())
    .catch(error => {
      // A failure here must never take down the rest of the console, but it
      // must not be silent either: without these sections a Super Admin has
      // no way to manage plans at all.
      console.error("Super Admin billing sections failed to load", error);
      const nav = document.querySelector(".sa-nav");
      if (!nav || document.getElementById("billingLoadError")) return;
      const notice = document.createElement("div");
      notice.id = "billingLoadError";
      notice.style.cssText = "margin:12px;padding:10px 12px;border-radius:9px;background:#fff4f4;color:#b3342f;font-size:12.5px;line-height:1.45";
      notice.textContent = "Subscription sections could not load. Refresh the page (Ctrl+Shift+R); if it persists, a deployment may be mid-update.";
      nav.appendChild(notice);
    });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
