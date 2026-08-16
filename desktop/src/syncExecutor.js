"use strict";

const { buildSyncPlan } = require("./syncPlan");

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

// Runs inside the live, already-authenticated scan2plate.com page via
// executeJavaScript - deliberately dumb: it only checks which offlineIds
// already exist. All the "what do we do about it" decisions happen in
// buildSyncPlan() on the Node side, where they're unit-tested. This reuses
// the page's own already-initialized Firebase app (getApp()) and its
// existing auth session - the sync executor never handles credentials
// itself and never touches Firebase Admin.
function buildCheckExistingScript(offlineIds) {
  const idsJson = JSON.stringify(offlineIds);
  return `
    (async () => {
      try {
        const { getApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
        const { getFirestore, collection, query, where, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        const db = getFirestore(getApp());
        const ids = ${idsJson};
        const found = [];
        for (let i = 0; i < ids.length; i += 10) {
          const batch = ids.slice(i, i + 10);
          const snap = await getDocs(query(collection(db, "orders"), where("offlineId", "in", batch)));
          snap.docs.forEach(d => found.push(d.data().offlineId));
        }
        return { ok: true, existing: found };
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) };
      }
    })();
  `;
}

// Uploads exactly one order and reports back { ok, firebaseOrderId } or
// { ok:false, error }. One order per call (not batched) so a failure on
// order 2 of 3 can never be confused with orders 1 or 3 - each has its own
// clear, independently-recorded result, matching the Part 31 requirement
// that a mid-sync failure only affects the order actually in flight.
function buildUploadScript(order) {
  const payload = JSON.stringify({
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
    // see Part 10. Cash offline payments are trusted the same as any
    // in-person cash payment always has been.
    paymentStatus: order.paymentMethod === "cash" ? order.paymentStatus : "unpaid",
    paymentConfirmationPending: order.paymentMethod !== "cash",
    businessDate: order.businessDate,
    source: "desktop_offline",
    status: "completed"
  });
  return `
    (async () => {
      try {
        const { getApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
        const { getFirestore, collection, addDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        const db = getFirestore(getApp());
        const payload = ${payload};
        const ref = await addDoc(collection(db, "orders"), { ...payload, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        return { ok: true, firebaseOrderId: ref.id };
      } catch (error) {
        return { ok: false, error: String(error && error.message || error) };
      }
    })();
  `;
}

// Orchestrates one full sync pass. Returns a summary for the connectivity
// indicator UI (Part 9). Never throws - a failed batch just leaves those
// orders as "failed" locally, to be retried on the next pass.
async function runSyncPass(webContents, offlineDb, restaurantId) {
  const pending = offlineDb.listPendingOrders(restaurantId);
  if (!pending.length) return { total: 0, synced: 0, failed: 0 };

  let existingIds = [];
  try {
    const checkResult = await webContents.executeJavaScript(buildCheckExistingScript(pending.map(o => o.offlineId)));
    if (checkResult && checkResult.ok) existingIds = checkResult.existing;
  } catch {
    // Couldn't even check - treat everything as still needing upload; the
    // idempotency check on the next successful pass will catch any that
    // actually made it through.
  }

  const plan = buildSyncPlan(pending, new Set(existingIds));
  plan.alreadySynced.forEach(order => offlineDb.markSynced(order.offlineId, order.firebaseOrderId || null));

  let synced = plan.alreadySynced.length;
  let failed = 0;

  for (const order of plan.upload) {
    try {
      const result = await webContents.executeJavaScript(buildUploadScript(order));
      if (result && result.ok) {
        offlineDb.markSynced(order.offlineId, result.firebaseOrderId);
        synced++;
      } else {
        offlineDb.markSyncFailed(order.offlineId, result && result.error);
        failed++;
      }
    } catch (error) {
      offlineDb.markSyncFailed(order.offlineId, error && error.message);
      failed++;
    }
  }

  return { total: pending.length, synced, failed };
}

module.exports = { runSyncPass, buildCheckExistingScript, buildUploadScript, chunk };
