/* =========================================================
   OFFLINE POS — backup & restore API
   ---------------------------------------------------------
   Mounted at /api/v1. Serves the Scan2Plate Billing Flutter
   app, which runs fully offline on SQLite and syncs when it
   has a connection.

   restaurant_code is the existing Scan2Plate restaurant id
   (RST006 and the like), so this API backs up into the same
   business record the dashboard already shows rather than
   inventing a parallel one.

   Firestore layout:
     offlinePosKeys/{sha256(apiKey)}         one doc per device key
     restaurants/{code}/offlinePos/settings  full-replace documents
     restaurants/{code}/offlinePos/menu
     restaurants/{code}/offlinePos/tables
     restaurants/{code}/offlinePosOrders/{uuid}
     restaurants/{code}/offlinePosDevices/{deviceId}

   The key's document id IS the hash, so authenticating a
   request is one document read: no query, no index, and a
   leaked database yields no usable keys.
========================================================= */

import express from "express";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  ApiError, errorBody, badRequest, bearerToken, hashApiKey, generateApiKey, maskApiKey,
  normalizeSettings, normalizeMenuSnapshot, normalizeTablesSnapshot, normalizeOrder,
  legacyMenuView, validateBatch, computeCounters, pageOrders, ordersAvailable,
  businessDate, text, MAX_BATCH
} from "./offline-pos-core.js";

export const OFFLINE_POS_BASE = "/api/v1/restaurants/:restaurantCode";

const nowIso = () => new Date().toISOString();

/* ---------------- storage helpers ---------------- */

const backupDoc = (db, code, name) => db.doc(`restaurants/${code}/offlinePos/${name}`);
const ordersCollection = (db, code) => db.collection(`restaurants/${code}/offlinePosOrders`);
const deviceDoc = (db, code, deviceId) => db.doc(`restaurants/${code}/offlinePosDevices/${deviceId}`);

async function readBackup(db, code, name) {
  const snap = await backupDoc(db, code, name).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  delete data.received_at;
  delete data.device_id;
  return data;
}

/** Orders exactly as stored, server bookkeeping fields included. */
async function readStoredOrders(db, code) {
  // Sorting and paging happen in application code rather than in the query:
  // the range + order this needs would require a composite index the project
  // does not define, and one restaurant's order history is a bounded read.
  const snap = await ordersCollection(db, code).get();
  return snap.docs.map(doc => doc.data() || {});
}

/** Orders in the shape the app sent them, for download and restore. */
async function readAllOrders(db, code) {
  return (await readStoredOrders(db, code)).map(data => {
    const clean = { ...data };
    delete clean.received_at;
    delete clean.device_id;
    delete clean.app_version;
    delete clean.source;
    return clean;
  });
}

/* ---------------- auth ---------------- */

/**
 * Bearer key -> restaurant. 401 for a missing, unknown or revoked key;
 * 403 when a valid key is used against a restaurant that is not its own.
 */
export function createOfflinePosAuth(getDb = getFirestore) {
  return async function offlinePosAuth(req, res, next) {
    try {
      const db = getDb();
      const presented = bearerToken(req.headers.authorization);
      if (!presented) throw new ApiError(401, "unauthorized", "An API key is required.");

      const keySnap = await db.doc(`offlinePosKeys/${hashApiKey(presented)}`).get();
      if (!keySnap.exists) throw new ApiError(401, "unauthorized", "This API key is not recognised.");

      const key = keySnap.data() || {};
      if (key.revoked_at) throw new ApiError(401, "key_revoked", "This API key has been revoked.");

      const requested = text(req.params.restaurantCode, { max: 80 });
      if (!requested) throw new ApiError(400, "validation_error", "restaurant_code is required.");
      if (String(key.restaurant_code) !== requested) {
        throw new ApiError(403, "forbidden", "This API key cannot access that restaurant.");
      }

      req.offlinePos = {
        restaurantCode: requested,
        keyHash: keySnap.id,
        deviceId: text(req.headers["x-device-id"], { max: 100 }),
        appVersion: text(req.headers["x-app-version"], { max: 40 })
      };

      // Last-seen device info, for the dashboard's per-device panel. Recorded
      // on the way in so a request that later fails validation still shows the
      // device as having reached the server.
      if (req.offlinePos.deviceId) {
        await deviceDoc(db, requested, req.offlinePos.deviceId).set({
          device_id: req.offlinePos.deviceId,
          app_version: req.offlinePos.appVersion,
          restaurant_code: requested,
          key_hash: keySnap.id,
          last_seen_at: nowIso()
        }, { merge: true });
        await db.doc(`offlinePosKeys/${keySnap.id}`).set({
          last_seen_at: nowIso(),
          last_device_id: req.offlinePos.deviceId,
          last_app_version: req.offlinePos.appVersion
        }, { merge: true });
      }
      next();
    } catch (error) {
      sendError(res, error);
    }
  };
}

function sendError(res, error) {
  if (error instanceof ApiError) return res.status(error.status).json(errorBody(error.code, error.message));
  console.error("offline-pos error", error);
  return res.status(500).json(errorBody("server_error", "Something went wrong on the server."));
}

const wrap = handler => (req, res) => handler(req, res).catch(error => sendError(res, error));

/* ---------------- router ---------------- */

export function createOfflinePosRouter({ getDb = getFirestore, clock = () => new Date() } = {}) {
  const router = express.Router({ mergeParams: true });
  const auth = createOfflinePosAuth(getDb);
  router.use(auth);

  const code = req => req.offlinePos.restaurantCode;

  /* 1. link check */
  router.get("/ping", wrap(async (req, res) => {
    const db = getDb();
    const snap = await db.doc(`restaurants/${code(req)}`).get();
    if (!snap.exists) throw new ApiError(404, "not_found", "That restaurant no longer exists.");
    const data = snap.data() || {};
    res.json({
      ok: true,
      restaurant_name: data.restaurantName || data.name || code(req),
      server_time: new Date(clock()).toISOString()
    });
  }));

  /* 2. settings */
  router.put("/backup/settings", wrap(async (req, res) => {
    const settings = normalizeSettings(req.body || {});
    await backupDoc(getDb(), code(req), "settings").set({
      ...settings,
      received_at: nowIso(),
      device_id: req.offlinePos.deviceId
    });
    res.json({ ok: true, saved: "settings", updated_at: settings.updated_at });
  }));

  router.get("/backup/settings", wrap(async (req, res) => {
    const settings = await readBackup(getDb(), code(req), "settings");
    if (!settings) throw new ApiError(404, "not_found", "No settings have been backed up yet.");
    res.json({ ok: true, ...settings });
  }));

  /* 3. menu */
  router.put("/backup/menu", wrap(async (req, res) => {
    const snapshot = normalizeMenuSnapshot(req.body || {});
    // A full-snapshot replace: one document holds the whole menu, so anything
    // absent from the snapshot is gone by construction. There is no partial
    // state to reconcile and nothing left behind to resurrect on restore.
    await backupDoc(getDb(), code(req), "menu").set({
      ...snapshot,
      received_at: nowIso(),
      device_id: req.offlinePos.deviceId
    });
    res.json({
      ok: true,
      saved: "menu",
      categories: snapshot.categories.length,
      menu_items: snapshot.menu_items.length,
      updated_at: snapshot.updated_at
    });
  }));

  router.get("/backup/menu", wrap(async (req, res) => {
    const menu = await readBackup(getDb(), code(req), "menu");
    if (!menu) throw new ApiError(404, "not_found", "No menu has been backed up yet.");
    res.json({ ok: true, ...menu });
  }));

  /* legacy shape, for app builds that predate the backup API */
  router.get("/menu", wrap(async (req, res) => {
    const menu = await readBackup(getDb(), code(req), "menu");
    res.json(legacyMenuView(menu));
  }));

  /* 4. tables */
  router.put("/backup/tables", wrap(async (req, res) => {
    const snapshot = normalizeTablesSnapshot(req.body || {});
    await backupDoc(getDb(), code(req), "tables").set({
      ...snapshot,
      received_at: nowIso(),
      device_id: req.offlinePos.deviceId
    });
    res.json({ ok: true, saved: "tables", tables: snapshot.tables.length, updated_at: snapshot.updated_at });
  }));

  router.get("/backup/tables", wrap(async (req, res) => {
    const tables = await readBackup(getDb(), code(req), "tables");
    if (!tables) throw new ApiError(404, "not_found", "No tables have been backed up yet.");
    res.json({ ok: true, ...tables });
  }));

  /* 5. orders upsert */
  router.post("/orders/batch", wrap(async (req, res) => {
    const db = getDb();
    const incoming = validateBatch(req.body?.orders, "orders");
    const results = [];

    for (const raw of incoming) {
      let uuid = typeof raw?.uuid === "string" ? raw.uuid : "";
      try {
        const order = normalizeOrder(raw);
        uuid = order.uuid;
        // set() without merge, so re-sending an order replaces it entirely
        // including its items. An edit that removed a line must not leave
        // that line behind, which a merge would do.
        await ordersCollection(db, code(req)).doc(order.uuid).set({
          ...order,
          source: "offline_pos",
          received_at: nowIso(),
          device_id: req.offlinePos.deviceId,
          app_version: req.offlinePos.appVersion
        });
        results.push({ uuid: order.uuid, status: "saved" });
      } catch (error) {
        // One bad record must not cost the device the whole batch: the rest
        // are still saved and only the failures need retrying.
        results.push({
          uuid: uuid || null,
          status: "error",
          error: error instanceof ApiError ? error.message : "Could not save this order."
        });
      }
    }

    const saved = results.filter(row => row.status === "saved").length;
    res.json({ ok: true, saved, failed: results.length - saved, results });
  }));

  /* 6. delete one order */
  router.delete("/orders/:uuid", wrap(async (req, res) => {
    const db = getDb();
    const uuid = text(req.params.uuid, { max: 64 }).toLowerCase();
    const ref = ordersCollection(db, code(req)).doc(uuid);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiError(404, "not_found", "No order with that uuid.");
    await ref.delete();
    res.json({ ok: true, deleted: uuid });
  }));

  /* 7. orders download */
  router.get("/orders", wrap(async (req, res) => {
    const all = await readAllOrders(getDb(), code(req));
    const page = pageOrders(all, {
      from: req.query.from ? businessDate(req.query.from, "from") : null,
      to: req.query.to ? businessDate(req.query.to, "to") : null,
      cursor: req.query.cursor || null,
      limit: req.query.limit || MAX_BATCH
    });
    res.json({ ok: true, orders: page.orders, next_cursor: page.next_cursor });
  }));

  /* 8. everything except orders, for a fresh install */
  router.get("/restore", wrap(async (req, res) => {
    const db = getDb();
    const restaurantCode = code(req);
    const [settings, menu, tables, orders] = await Promise.all([
      readBackup(db, restaurantCode, "settings"),
      readBackup(db, restaurantCode, "menu"),
      readBackup(db, restaurantCode, "tables"),
      readAllOrders(db, restaurantCode)
    ]);
    const today = businessDate(
      text(req.query.business_date) || new Date(clock()).toISOString().slice(0, 10),
      "business_date"
    );
    res.json({
      ok: true,
      settings,
      menu,
      tables,
      counters: computeCounters(orders, today),
      orders_available: ordersAvailable(orders)
    });
  }));

  return router;
}

/* ---------------- dashboard-side key management ---------------- */

/**
 * Creates a key and returns it in full exactly once. Only the hash is
 * stored, so a key the owner loses cannot be recovered — it is regenerated.
 */
export async function issueApiKey(db, restaurantCode, { label = "", createdBy = "" } = {}) {
  const key = generateApiKey();
  const hash = hashApiKey(key);
  await db.doc(`offlinePosKeys/${hash}`).set({
    restaurant_code: restaurantCode,
    label: text(label, { max: 80 }) || "Offline POS device",
    masked: maskApiKey(key),
    created_at: nowIso(),
    created_by: text(createdBy, { max: 200 }),
    revoked_at: null,
    last_seen_at: null,
    last_device_id: "",
    last_app_version: ""
  });
  return { key, hash, masked: maskApiKey(key) };
}

export async function listApiKeys(db, restaurantCode) {
  const snap = await db.collection("offlinePosKeys").where("restaurant_code", "==", restaurantCode).get();
  return snap.docs.map(doc => {
    const data = doc.data() || {};
    return {
      hash: doc.id,
      label: data.label || "",
      masked: data.masked || "",
      created_at: data.created_at || null,
      revoked_at: data.revoked_at || null,
      last_seen_at: data.last_seen_at || null,
      last_device_id: data.last_device_id || "",
      last_app_version: data.last_app_version || ""
    };
  });
}

export async function revokeApiKey(db, restaurantCode, hash) {
  const ref = db.doc(`offlinePosKeys/${text(hash, { max: 80 })}`);
  const snap = await ref.get();
  if (!snap.exists || (snap.data() || {}).restaurant_code !== restaurantCode) {
    throw new ApiError(404, "not_found", "No such API key for this restaurant.");
  }
  await ref.set({ revoked_at: nowIso() }, { merge: true });
  return true;
}

/** Per-device sync status for the dashboard. */
export async function listDevices(db, restaurantCode) {
  const [deviceSnap, orders] = await Promise.all([
    db.collection(`restaurants/${restaurantCode}/offlinePosDevices`).get(),
    readStoredOrders(db, restaurantCode)
  ]);
  const counts = new Map();
  for (const order of orders) {
    const id = order.device_id || "";
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return deviceSnap.docs.map(doc => {
    const data = doc.data() || {};
    return {
      device_id: doc.id,
      app_version: data.app_version || "",
      last_seen_at: data.last_seen_at || null,
      orders_synced: counts.get(doc.id) || 0
    };
  });
}
