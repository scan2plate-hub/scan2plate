"use strict";

// Pure planning logic, deliberately kept free of any Firebase/SQLite call so
// it can be unit-tested without live infrastructure. The actual sync
// executor (src/syncExecutor.js) is the only thing that touches Firestore,
// and it just follows this plan.
//
// Given the locally pending orders and the set of offlineIds that already
// exist server-side (a single `where("offlineId","in",[...])` query worth
// of results), decide, for each pending order, whether it still needs to be
// uploaded or was already synced (either by this run or a previous
// interrupted one) and just needs its local syncStatus flipped.
//
// This is what makes resuming after a mid-sync failure safe (Part 31): if
// Bill A already made it to Firestore before the network dropped, the next
// run's `existingOfflineIds` set will already contain Bill A's offlineId,
// so it's classified as "alreadySynced" (no re-upload) while B and C are
// still "needsUpload" - no special partial-failure handling required, it
// falls out of re-running the same planner with fresh data.
function buildSyncPlan(pendingOrders = [], existingOfflineIds = new Set()) {
  const plan = { upload: [], alreadySynced: [] };
  const seen = new Set();

  for (const order of pendingOrders) {
    const offlineId = order && order.offlineId;
    if (!offlineId) continue; // malformed record - never guess an ID, skip it
    if (seen.has(offlineId)) continue; // defend against a caller passing duplicates
    seen.add(offlineId);

    if (existingOfflineIds.has(offlineId)) {
      plan.alreadySynced.push(order);
    } else {
      plan.upload.push(order);
    }
  }

  return plan;
}

module.exports = { buildSyncPlan };
