// Android offline-billing hook. Entirely inert unless running inside the
// Capacitor Android app (window.Capacitor?.isNativePlatform()) - on the
// regular website and inside the desktop app this file does nothing.
//
// While online, mirrors the restaurant/menu/tables this page already loads
// into the on-device SQLite cache (mobile-offline-db.js) and uploads any
// bills recorded while offline, using the exact same idempotent
// offlineId-based plan (mobile-offline-core.js's buildSyncPlan - a byte-for-
// byte port of desktop/src/syncPlan.js) the desktop app already relies on.
// When the network drops, shows a banner with a "Continue Billing Offline"
// button that hands off to the bundled offline-billing page via the native
// OfflineNav plugin (see mobile/android/.../OfflineNavPlugin.java) - the
// Android equivalent of the desktop app's "Continue Billing Offline" window
// switch.
import { db } from "./firebase.js";
import { collection, doc, getDoc, getDocs, addDoc, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { registerCleanup, devError } from "./common.js";
import { buildSyncPlan } from "./mobile-offline-core.js";
import { cacheRestaurant, replaceMenuCache, replaceTablesCache, listPendingOrders, markSynced, markSyncFailed } from "./mobile-offline-db.js";

function isCapacitorNative() {
  return Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
}

if (isCapacitorNative()) {
  (function initMobileOffline() {
    const CACHE_REFRESH_MS = 5 * 60 * 1000;
    const SYNC_BATCH_SIZE = 10;

    function currentRestaurantId() {
      try {
        const user = JSON.parse(localStorage.getItem("scan2plate_user") || localStorage.getItem("scan2serve_user") || "{}");
        return user.restaurantId || localStorage.getItem("scan2plate_last_restaurant_id") || "";
      } catch {
        return localStorage.getItem("scan2plate_last_restaurant_id") || "";
      }
    }

    async function refreshCache() {
      const restaurantId = currentRestaurantId();
      if (!restaurantId) return;
      try {
        const [restaurantSnap, settingsSnap, menuSnap, tablesSnap] = await Promise.all([
          getDoc(doc(db, "restaurants", restaurantId)),
          getDoc(doc(db, "restaurants", restaurantId, "settings", "general")),
          getDocs(collection(db, "restaurants", restaurantId, "menu")),
          getDocs(collection(db, "restaurants", restaurantId, "tables"))
        ]);
        const restaurantData = restaurantSnap.exists() ? restaurantSnap.data() : {};
        const settingsData = settingsSnap.exists() ? settingsSnap.data() : {};
        await cacheRestaurant({
          restaurantId,
          name: restaurantData.restaurantName || settingsData.restaurantName || "",
          address: restaurantData.address || settingsData.address || "",
          gstNumber: restaurantData.gstNumber || settingsData.gstNumber || "",
          taxPercent: Number(restaurantData.taxPercent ?? settingsData.taxPercent ?? 0),
          dailyOrderResetTime: restaurantData.dailyOrderResetTime || settingsData.dailyOrderResetTime || "04:00"
        });
        await replaceMenuCache(restaurantId, menuSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(item => item.available !== false));
        await replaceTablesCache(restaurantId, tablesSnap.docs.map(d => ({
          id: d.id,
          tableNo: d.data().tableNo || d.id,
          active: d.data().active !== false && d.data().disabled !== true
        })));
      } catch (error) {
        devError("mobile-offline: cache refresh failed", error);
      }
    }

    // Uploads exactly one order per call (not batched) so a failure on
    // order 2 of 3 never gets confused with orders 1 or 3 - matches
    // desktop/src/syncExecutor.js's buildUploadScript exactly, same reason.
    async function uploadOrder(order) {
      const payload = {
        offlineId: order.offlineId,
        restaurantId: order.restaurantId,
        tableNo: order.tableNo,
        items: order.items,
        itemsTotal: order.subtotal,
        subtotal: order.subtotal,
        discountAmount: order.discount,
        tax: order.tax,
        grandTotal: order.total,
        paymentMethod: order.paymentMethod,
        // Card/UPI recorded offline can't be verified without connectivity -
        // cash offline payments are trusted the same as any in-person cash
        // payment always has been. Matches desktop's exact policy.
        paymentStatus: order.paymentMethod === "cash" ? order.paymentStatus : "unpaid",
        paymentConfirmationPending: order.paymentMethod !== "cash",
        businessDate: order.businessDate,
        source: "android_offline",
        status: "completed",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      const ref = await addDoc(collection(db, "orders"), payload);
      return ref.id;
    }

    async function runSyncPass() {
      const restaurantId = currentRestaurantId();
      if (!restaurantId) return;
      let pending;
      try {
        pending = await listPendingOrders(restaurantId);
      } catch (error) {
        devError("mobile-offline: reading pending offline orders failed", error);
        return;
      }
      if (!pending.length) return;

      let existingIds = [];
      try {
        const offlineIds = pending.map(o => o.offlineId);
        for (let i = 0; i < offlineIds.length; i += SYNC_BATCH_SIZE) {
          const batch = offlineIds.slice(i, i + SYNC_BATCH_SIZE);
          const snap = await getDocs(query(collection(db, "orders"), where("offlineId", "in", batch)));
          snap.docs.forEach(d => existingIds.push(d.data().offlineId));
        }
      } catch (error) {
        devError("mobile-offline: existing-offlineId check failed, will retry full upload next pass", error);
      }

      const plan = buildSyncPlan(pending, new Set(existingIds));
      for (const order of plan.alreadySynced) {
        await markSynced(order.offlineId, order.firebaseOrderId || null);
      }
      for (const order of plan.upload) {
        try {
          const firebaseOrderId = await uploadOrder(order);
          await markSynced(order.offlineId, firebaseOrderId);
        } catch (error) {
          await markSyncFailed(order.offlineId, error?.message || String(error));
        }
      }
    }

    async function onlineTick() {
      await refreshCache();
      await runSyncPass();
    }

    function goOffline() {
      const nav = window.Capacitor?.Plugins?.OfflineNav;
      if (nav?.goOffline) nav.goOffline();
    }

    function installOfflineBanner() {
      const ID = "__scan2plateMobileOfflineBanner";
      if (document.getElementById(ID)) return;
      const el = document.createElement("div");
      el.id = ID;
      el.setAttribute("role", "status");
      el.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:2147483647;display:none;align-items:center;justify-content:center;gap:12px;text-align:center;padding:8px 14px;font:600 13px/1.4 -apple-system,Arial,sans-serif;background:#b91c1c;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.2);";
      el.innerHTML = '<span>Internet connection lost. Scan2Plate will reconnect automatically.</span>' +
        '<button type="button" id="__scan2plateMobileGoOfflineBtn" style="border:1px solid #fff;background:transparent;color:#fff;border-radius:6px;padding:3px 10px;font:inherit;cursor:pointer;">Continue Billing Offline</button>';
      document.documentElement.appendChild(el);
      document.getElementById("__scan2plateMobileGoOfflineBtn")?.addEventListener("click", goOffline);
      const setState = online => { el.style.display = online ? "none" : "flex"; };
      window.addEventListener("online", () => { setState(true); onlineTick(); });
      window.addEventListener("offline", () => setState(false));
      setState(navigator.onLine);
    }

    installOfflineBanner();
    if (navigator.onLine) onlineTick();
    const intervalId = setInterval(() => { if (navigator.onLine) onlineTick(); }, CACHE_REFRESH_MS);
    registerCleanup(() => clearInterval(intervalId));
  })();
}
