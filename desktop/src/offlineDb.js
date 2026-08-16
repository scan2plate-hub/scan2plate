"use strict";

const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");
const { generateOfflineId } = require("./offlineId");

let db = null;

function openDb(userDataDir) {
  if (db) return db;
  fs.mkdirSync(userDataDir, { recursive: true });
  db = new Database(path.join(userDataDir, "scan2plate-offline.db"));
  db.pragma("journal_mode = WAL"); // survives a hard app-quit mid-write without corrupting the file
  db.exec(`
    CREATE TABLE IF NOT EXISTS restaurant_cache (
      restaurantId TEXT PRIMARY KEY,
      name TEXT,
      address TEXT,
      gstNumber TEXT,
      taxPercent REAL DEFAULT 0,
      logoDataUrl TEXT,
      signatureUrl TEXT,
      dailyOrderResetTime TEXT DEFAULT '04:00',
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS menu_cache (
      id TEXT NOT NULL,
      restaurantId TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      price REAL NOT NULL DEFAULT 0,
      foodType TEXT DEFAULT 'veg',
      hasVariants INTEGER DEFAULT 0,
      variantsJson TEXT DEFAULT '[]',
      available INTEGER DEFAULT 1,
      updatedAt TEXT,
      PRIMARY KEY (restaurantId, id)
    );

    CREATE TABLE IF NOT EXISTS tables_cache (
      id TEXT NOT NULL,
      restaurantId TEXT NOT NULL,
      tableNo TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      updatedAt TEXT,
      PRIMARY KEY (restaurantId, id)
    );

    CREATE TABLE IF NOT EXISTS inventory_cache (
      id TEXT NOT NULL,
      restaurantId TEXT NOT NULL,
      itemName TEXT NOT NULL,
      currentStock REAL DEFAULT 0,
      unit TEXT DEFAULT 'pcs',
      updatedAt TEXT,
      PRIMARY KEY (restaurantId, id)
    );

    -- Fields match Part 6 of the spec exactly (offlineId, restaurantId,
    -- tableNo, items, subtotal, discount, tax, total, paymentMethod,
    -- paymentStatus, businessDate, createdAt, syncStatus, firebaseOrderId).
    -- localOrderNo/syncAttempts/lastSyncError are additive, non-breaking.
    CREATE TABLE IF NOT EXISTS offline_orders (
      offlineId TEXT PRIMARY KEY,
      restaurantId TEXT NOT NULL,
      tableNo TEXT,
      itemsJson TEXT NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      paymentMethod TEXT NOT NULL DEFAULT 'cash',
      paymentStatus TEXT NOT NULL DEFAULT 'unpaid',
      businessDate TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      syncStatus TEXT NOT NULL DEFAULT 'pending',
      firebaseOrderId TEXT,
      localOrderNo INTEGER,
      syncAttempts INTEGER NOT NULL DEFAULT 0,
      lastSyncError TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_offline_orders_status ON offline_orders (restaurantId, syncStatus);
  `);
  return db;
}

function nowIso() { return new Date().toISOString(); }

// ---- Cache writers (called whenever the live page successfully loads and
// reports its current localStorage-derived context - see connectivity.js /
// main.js for how this data is collected). ----

function cacheRestaurant(profile) {
  db.prepare(`
    INSERT INTO restaurant_cache (restaurantId, name, address, gstNumber, taxPercent, logoDataUrl, signatureUrl, dailyOrderResetTime, updatedAt)
    VALUES (@restaurantId, @name, @address, @gstNumber, @taxPercent, @logoDataUrl, @signatureUrl, @dailyOrderResetTime, @updatedAt)
    ON CONFLICT(restaurantId) DO UPDATE SET
      name=excluded.name, address=excluded.address, gstNumber=excluded.gstNumber,
      taxPercent=excluded.taxPercent, logoDataUrl=COALESCE(excluded.logoDataUrl, restaurant_cache.logoDataUrl),
      signatureUrl=COALESCE(excluded.signatureUrl, restaurant_cache.signatureUrl),
      dailyOrderResetTime=excluded.dailyOrderResetTime, updatedAt=excluded.updatedAt
  `).run({
    restaurantId: profile.restaurantId,
    name: profile.name || "",
    address: profile.address || "",
    gstNumber: profile.gstNumber || "",
    taxPercent: Number(profile.taxPercent || 0),
    logoDataUrl: profile.logoDataUrl || null,
    signatureUrl: profile.signatureUrl || null,
    dailyOrderResetTime: profile.dailyOrderResetTime || "04:00",
    updatedAt: nowIso()
  });
}

function replaceMenuCache(restaurantId, items = []) {
  const tx = db.transaction(rows => {
    db.prepare("DELETE FROM menu_cache WHERE restaurantId = ?").run(restaurantId);
    const insert = db.prepare(`
      INSERT INTO menu_cache (id, restaurantId, name, category, price, foodType, hasVariants, variantsJson, available, updatedAt)
      VALUES (@id, @restaurantId, @name, @category, @price, @foodType, @hasVariants, @variantsJson, @available, @updatedAt)
    `);
    rows.forEach(item => insert.run({
      id: String(item.id || ""),
      restaurantId,
      name: item.name || "",
      category: item.category || "Uncategorized",
      price: Number(item.price || 0),
      foodType: item.foodType || "veg",
      hasVariants: item.hasVariants ? 1 : 0,
      variantsJson: JSON.stringify(item.variants || []),
      available: item.available === false ? 0 : 1,
      updatedAt: nowIso()
    }));
  });
  tx(items);
}

function replaceTablesCache(restaurantId, tables = []) {
  const tx = db.transaction(rows => {
    db.prepare("DELETE FROM tables_cache WHERE restaurantId = ?").run(restaurantId);
    const insert = db.prepare("INSERT INTO tables_cache (id, restaurantId, tableNo, active, updatedAt) VALUES (@id, @restaurantId, @tableNo, @active, @updatedAt)");
    rows.forEach(t => insert.run({
      id: String(t.id || t.tableNo || ""),
      restaurantId,
      tableNo: String(t.tableNo || t.id || ""),
      active: t.disabled === true || t.active === false ? 0 : 1,
      updatedAt: nowIso()
    }));
  });
  tx(tables);
}

function getCachedRestaurant(restaurantId) {
  return db.prepare("SELECT * FROM restaurant_cache WHERE restaurantId = ?").get(restaurantId) || null;
}
function getCachedMenu(restaurantId) {
  return db.prepare("SELECT * FROM menu_cache WHERE restaurantId = ? AND available = 1 ORDER BY category, name").all(restaurantId)
    .map(row => ({ ...row, variants: JSON.parse(row.variantsJson || "[]"), hasVariants: Boolean(row.hasVariants) }));
}
function getCachedTables(restaurantId) {
  return db.prepare("SELECT * FROM tables_cache WHERE restaurantId = ? AND active = 1 ORDER BY tableNo").all(restaurantId);
}

// ---- Offline order lifecycle ----

function nextLocalOrderNo(restaurantId, businessDate) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM offline_orders WHERE restaurantId = ? AND businessDate = ?").get(restaurantId, businessDate);
  return (row?.n || 0) + 1;
}

function createOfflineOrder(order) {
  const offlineId = generateOfflineId(order.restaurantId);
  const localOrderNo = nextLocalOrderNo(order.restaurantId, order.businessDate);
  const record = {
    offlineId,
    restaurantId: order.restaurantId,
    tableNo: order.tableNo || null,
    itemsJson: JSON.stringify(order.items || []),
    subtotal: Number(order.subtotal || 0),
    discount: Number(order.discount || 0),
    tax: Number(order.tax || 0),
    total: Number(order.total || 0),
    paymentMethod: order.paymentMethod || "cash",
    paymentStatus: order.paymentStatus || "unpaid",
    businessDate: order.businessDate,
    createdAt: nowIso(),
    syncStatus: "pending",
    firebaseOrderId: null,
    localOrderNo,
    syncAttempts: 0,
    lastSyncError: null
  };
  db.prepare(`
    INSERT INTO offline_orders (offlineId, restaurantId, tableNo, itemsJson, subtotal, discount, tax, total, paymentMethod, paymentStatus, businessDate, createdAt, syncStatus, firebaseOrderId, localOrderNo, syncAttempts, lastSyncError)
    VALUES (@offlineId, @restaurantId, @tableNo, @itemsJson, @subtotal, @discount, @tax, @total, @paymentMethod, @paymentStatus, @businessDate, @createdAt, @syncStatus, @firebaseOrderId, @localOrderNo, @syncAttempts, @lastSyncError)
  `).run(record);
  return { ...record, items: order.items || [] };
}

function listPendingOrders(restaurantId) {
  return db.prepare("SELECT * FROM offline_orders WHERE restaurantId = ? AND syncStatus IN ('pending','failed') ORDER BY createdAt ASC").all(restaurantId)
    .map(row => ({ ...row, items: JSON.parse(row.itemsJson || "[]") }));
}

function countPendingOrders(restaurantId) {
  return db.prepare("SELECT COUNT(*) AS n FROM offline_orders WHERE restaurantId = ? AND syncStatus IN ('pending','failed')").get(restaurantId)?.n || 0;
}

function markSynced(offlineId, firebaseOrderId) {
  db.prepare("UPDATE offline_orders SET syncStatus='synced', firebaseOrderId=?, lastSyncError=NULL WHERE offlineId=?").run(firebaseOrderId || null, offlineId);
}

function markSyncFailed(offlineId, errorMessage) {
  db.prepare("UPDATE offline_orders SET syncStatus='failed', syncAttempts=syncAttempts+1, lastSyncError=? WHERE offlineId=?").run(String(errorMessage || "").slice(0, 500), offlineId);
}

module.exports = {
  openDb,
  cacheRestaurant,
  replaceMenuCache,
  replaceTablesCache,
  getCachedRestaurant,
  getCachedMenu,
  getCachedTables,
  createOfflineOrder,
  listPendingOrders,
  countPendingOrders,
  markSynced,
  markSyncFailed
};
