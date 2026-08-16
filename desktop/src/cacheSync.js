"use strict";

// Runs inside the live, authenticated page to read the restaurant context
// already sitting in its own localStorage (the same keys common.js/admin.js
// already write - see getRestaurantContext()/loadSettings() in
// public/js/common.js) and re-query the same public restaurants/menu/tables
// collections the app itself uses, via the page's own already-initialized
// Firebase app. Nothing here is a new data source - it mirrors exactly what
// the live app already reads, so the offline cache can never drift from
// the schema the online app depends on.
const CAPTURE_SCRIPT = `
  (async () => {
    try {
      const restaurantId =
        localStorage.getItem("restaurantId") ||
        localStorage.getItem("scan2plate_last_restaurant_id") ||
        (() => { try { return JSON.parse(localStorage.getItem("scan2plate_user") || "{}").restaurantId || ""; } catch { return ""; } })();
      if (!restaurantId) return { ok: false, error: "no restaurantId in this session yet" };

      const { getApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
      const { getFirestore, doc, getDoc, collection, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      const db = getFirestore(getApp());

      const [restaurantSnap, settingsSnap, menuSnap, tablesSnap] = await Promise.all([
        getDoc(doc(db, "restaurants", restaurantId)),
        getDoc(doc(db, "restaurants", restaurantId, "settings", "general")),
        getDocs(collection(db, "restaurants", restaurantId, "menu")),
        getDocs(collection(db, "restaurants", restaurantId, "tables"))
      ]);

      const restaurantData = restaurantSnap.exists() ? restaurantSnap.data() : {};
      const settingsData = settingsSnap.exists() ? settingsSnap.data() : {};

      return {
        ok: true,
        restaurantId,
        restaurant: {
          restaurantId,
          name: restaurantData.restaurantName || settingsData.restaurantName || "",
          address: restaurantData.address || settingsData.address || "",
          gstNumber: restaurantData.gstNumber || settingsData.gstNumber || "",
          taxPercent: Number(restaurantData.taxPercent ?? settingsData.taxPercent ?? 0),
          dailyOrderResetTime: restaurantData.dailyOrderResetTime || settingsData.dailyOrderResetTime || "04:00"
        },
        menu: menuSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(item => item.available !== false),
        tables: tablesSnap.docs.map(d => ({ id: d.id, tableNo: d.data().tableNo || d.id, active: d.data().active !== false && d.data().disabled !== true }))
      };
    } catch (error) {
      return { ok: false, error: String(error && error.message || error) };
    }
  })();
`;

async function refreshCacheFromLivePage(webContents, offlineDb) {
  try {
    const result = await webContents.executeJavaScript(CAPTURE_SCRIPT);
    if (!result || !result.ok) return null;
    offlineDb.cacheRestaurant(result.restaurant);
    offlineDb.replaceMenuCache(result.restaurantId, result.menu);
    offlineDb.replaceTablesCache(result.restaurantId, result.tables);
    return result.restaurantId;
  } catch {
    return null;
  }
}

module.exports = { refreshCacheFromLivePage, CAPTURE_SCRIPT };
