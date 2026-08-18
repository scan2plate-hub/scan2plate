// Local SQLite cache/queue for Android, via the @capacitor-community/sqlite
// plugin. Same schema and same responsibilities as the desktop app's
// desktop/src/offlineDb.js (restaurant/menu/tables cache + an offline_orders
// queue) - the difference is entirely mechanical: better-sqlite3's API is
// synchronous (Electron's main process runs plain Node), the Capacitor
// SQLite plugin's is Promise-based (it crosses the native bridge), so every
// function here is async where offlineDb.js's equivalent was not.
//
// This file is a plain <script> with no bundler, so it deliberately calls
// the plugin's raw native bridge (Capacitor.Plugins.CapacitorSQLite -
// available on *any* registered Capacitor plugin automatically, no import
// needed) instead of the npm-distributed SQLiteConnection/SQLiteDBConnection
// JS wrapper classes, which are meant to be bundled and aren't reachable
// from a raw script tag. Android-only usage (this app has no web/PWA
// target), so the wrapper's cross-platform web-SQLite handling isn't needed.
//
// Capacitor plugins are available to *any* page running inside the app's
// WebView - the live remote site (scan2plate.com) and this bundled local
// offline-billing page both reach the exact same on-device database. That's
// what lets the live site cache data into it while online, and the bundled
// page read/write it while fully offline.
(function (root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.Scan2PlateOfflineDb = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DB_NAME = "scan2plate_offline";
  var opened = false;
  var openPromise = null;

  function plugin() {
    var Capacitor = (typeof window !== "undefined" && window.Capacitor) || null;
    var p = Capacitor && Capacitor.Plugins && Capacitor.Plugins.CapacitorSQLite;
    if (!p) throw new Error("CapacitorSQLite plugin is not available - this only runs inside the Android app.");
    return p;
  }

  async function run(statement, values) {
    return plugin().run({ database: DB_NAME, statement: statement, values: values || [], transaction: false });
  }

  async function query(statement, values) {
    var result = await plugin().query({ database: DB_NAME, statement: statement, values: values || [] });
    return (result && result.values) || [];
  }

  async function execute(statements) {
    return plugin().execute({ database: DB_NAME, statements: statements, transaction: false });
  }

  async function openDb() {
    if (opened) return;
    if (openPromise) return openPromise;
    openPromise = (async () => {
      var p = plugin();
      try {
        var exists = await p.isDBExists({ database: DB_NAME });
        if (!(exists && exists.result)) {
          await p.createConnection({ database: DB_NAME, encrypted: false, mode: "no-encryption", version: 1, readonly: false });
        }
      } catch (error) {
        // isDBExists/createConnection can legitimately throw "connection
        // already exists" if a previous session left one open - open()
        // below is what actually matters and is safe to call regardless.
      }
      await p.open({ database: DB_NAME, readonly: false });
      await execute(`
        CREATE TABLE IF NOT EXISTS restaurant_cache (
          restaurantId TEXT PRIMARY KEY,
          name TEXT, address TEXT, gstNumber TEXT,
          taxPercent REAL DEFAULT 0,
          dailyOrderResetTime TEXT DEFAULT '04:00',
          updatedAt TEXT
        );
        CREATE TABLE IF NOT EXISTS menu_cache (
          id TEXT NOT NULL, restaurantId TEXT NOT NULL, name TEXT NOT NULL,
          category TEXT, price REAL NOT NULL DEFAULT 0, foodType TEXT DEFAULT 'veg',
          available INTEGER DEFAULT 1, updatedAt TEXT,
          PRIMARY KEY (restaurantId, id)
        );
        CREATE TABLE IF NOT EXISTS tables_cache (
          id TEXT NOT NULL, restaurantId TEXT NOT NULL, tableNo TEXT NOT NULL,
          active INTEGER DEFAULT 1, updatedAt TEXT,
          PRIMARY KEY (restaurantId, id)
        );
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
      opened = true;
    })();
    return openPromise;
  }

  function nowIso() { return new Date().toISOString(); }

  async function cacheRestaurant(profile) {
    await openDb();
    await run(
      `INSERT INTO restaurant_cache (restaurantId, name, address, gstNumber, taxPercent, dailyOrderResetTime, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(restaurantId) DO UPDATE SET
         name=excluded.name, address=excluded.address, gstNumber=excluded.gstNumber,
         taxPercent=excluded.taxPercent, dailyOrderResetTime=excluded.dailyOrderResetTime,
         updatedAt=excluded.updatedAt`,
      [profile.restaurantId, profile.name || "", profile.address || "", profile.gstNumber || "",
        Number(profile.taxPercent || 0), profile.dailyOrderResetTime || "04:00", nowIso()]
    );
  }

  async function replaceMenuCache(restaurantId, items) {
    items = items || [];
    await openDb();
    await run("DELETE FROM menu_cache WHERE restaurantId = ?", [restaurantId]);
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      await run(
        `INSERT INTO menu_cache (id, restaurantId, name, category, price, foodType, available, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(item.id || ""), restaurantId, item.name || "", item.category || "Uncategorized",
          Number(item.price || 0), item.foodType || "veg", item.available === false ? 0 : 1, nowIso()]
      );
    }
  }

  async function replaceTablesCache(restaurantId, tables) {
    tables = tables || [];
    await openDb();
    await run("DELETE FROM tables_cache WHERE restaurantId = ?", [restaurantId]);
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      await run(
        "INSERT INTO tables_cache (id, restaurantId, tableNo, active, updatedAt) VALUES (?, ?, ?, ?, ?)",
        [String(t.id || t.tableNo || ""), restaurantId, String(t.tableNo || t.id || ""), t.active === false ? 0 : 1, nowIso()]
      );
    }
  }

  async function getCachedRestaurant(restaurantId) {
    await openDb();
    var rows = await query("SELECT * FROM restaurant_cache WHERE restaurantId = ?", [restaurantId]);
    return rows[0] || null;
  }

  // The bundled offline-billing page loads from a different WebView origin
  // than the live site, so it has no access to the live page's localStorage
  // (where restaurantId normally lives) - it isn't needed there anyway,
  // since this on-device SQLite database is itself the shared, origin-
  // independent source of truth reachable from either page. A device is
  // used by one restaurant's staff, so "most recently cached" is always
  // the right one.
  async function getMostRecentCachedRestaurant() {
    await openDb();
    var rows = await query("SELECT * FROM restaurant_cache ORDER BY updatedAt DESC LIMIT 1", []);
    return rows[0] || null;
  }

  async function getCachedMenu(restaurantId) {
    await openDb();
    return query("SELECT * FROM menu_cache WHERE restaurantId = ? AND available = 1 ORDER BY category, name", [restaurantId]);
  }

  async function getCachedTables(restaurantId) {
    await openDb();
    return query("SELECT * FROM tables_cache WHERE restaurantId = ? AND active = 1 ORDER BY tableNo", [restaurantId]);
  }

  async function nextLocalOrderNo(restaurantId, businessDate) {
    var rows = await query("SELECT COUNT(*) AS n FROM offline_orders WHERE restaurantId = ? AND businessDate = ?", [restaurantId, businessDate]);
    return ((rows[0] && rows[0].n) || 0) + 1;
  }

  async function createOfflineOrder(order, generateOfflineId) {
    await openDb();
    var offlineId = generateOfflineId(order.restaurantId);
    var localOrderNo = await nextLocalOrderNo(order.restaurantId, order.businessDate);
    var record = {
      offlineId: offlineId,
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
      localOrderNo: localOrderNo
    };
    await run(
      `INSERT INTO offline_orders (offlineId, restaurantId, tableNo, itemsJson, subtotal, discount, tax, total, paymentMethod, paymentStatus, businessDate, createdAt, syncStatus, localOrderNo, syncAttempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0)`,
      [record.offlineId, record.restaurantId, record.tableNo, record.itemsJson, record.subtotal, record.discount,
        record.tax, record.total, record.paymentMethod, record.paymentStatus, record.businessDate, record.createdAt, record.localOrderNo]
    );
    record.items = order.items || [];
    return record;
  }

  async function listPendingOrders(restaurantId) {
    await openDb();
    var rows = await query(
      "SELECT * FROM offline_orders WHERE restaurantId = ? AND syncStatus IN ('pending','failed') ORDER BY createdAt ASC",
      [restaurantId]
    );
    return rows.map(function (row) {
      return Object.assign({}, row, { items: JSON.parse(row.itemsJson || "[]") });
    });
  }

  async function countPendingOrders(restaurantId) {
    await openDb();
    var rows = await query("SELECT COUNT(*) AS n FROM offline_orders WHERE restaurantId = ? AND syncStatus IN ('pending','failed')", [restaurantId]);
    return (rows[0] && rows[0].n) || 0;
  }

  async function markSynced(offlineId, firebaseOrderId) {
    await run("UPDATE offline_orders SET syncStatus='synced', firebaseOrderId=?, lastSyncError=NULL WHERE offlineId=?", [firebaseOrderId || null, offlineId]);
  }

  async function markSyncFailed(offlineId, errorMessage) {
    await run("UPDATE offline_orders SET syncStatus='failed', syncAttempts=syncAttempts+1, lastSyncError=? WHERE offlineId=?", [String(errorMessage || "").slice(0, 500), offlineId]);
  }

  return {
    openDb: openDb,
    cacheRestaurant: cacheRestaurant,
    replaceMenuCache: replaceMenuCache,
    replaceTablesCache: replaceTablesCache,
    getCachedRestaurant: getCachedRestaurant,
    getMostRecentCachedRestaurant: getMostRecentCachedRestaurant,
    getCachedMenu: getCachedMenu,
    getCachedTables: getCachedTables,
    createOfflineOrder: createOfflineOrder,
    listPendingOrders: listPendingOrders,
    countPendingOrders: countPendingOrders,
    markSynced: markSynced,
    markSyncFailed: markSyncFailed
  };
});
