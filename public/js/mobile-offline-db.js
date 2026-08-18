// Local SQLite cache/queue for Android, via the @capacitor-community/sqlite
// plugin's raw native bridge (Capacitor.Plugins.CapacitorSQLite - available
// on any registered Capacitor plugin automatically, no import needed).
// Used by mobile-offline.js to write the restaurant/menu/tables cache while
// online and read/mark pending offline orders during sync.
//
// Deliberately duplicated rather than shared with mobile/www/offline-db.js
// - see mobile-offline-core.js's header comment for why (different WebView
// origins, no shared module graph). Same schema and responsibilities as
// the desktop app's desktop/src/offlineDb.js; async throughout because the
// Capacitor SQLite plugin's API crosses the native bridge as Promises,
// unlike better-sqlite3's synchronous one.
//
// Capacitor plugins are reachable from *any* page running inside the app's
// WebView - this file (running at the real scan2plate.com origin) and the
// bundled offline-billing page (a different origin) both reach the exact
// same on-device database. That's what lets this file cache data into it
// while online, and the bundled page read/write it while fully offline.

const DB_NAME = "scan2plate_offline";
let opened = false;
let openPromise = null;

function plugin() {
  const Capacitor = (typeof window !== "undefined" && window.Capacitor) || null;
  const p = Capacitor && Capacitor.Plugins && Capacitor.Plugins.CapacitorSQLite;
  if (!p) throw new Error("CapacitorSQLite plugin is not available - this only runs inside the Android app.");
  return p;
}

async function run(statement, values) {
  return plugin().run({ database: DB_NAME, statement, values: values || [], transaction: false });
}

async function query(statement, values) {
  const result = await plugin().query({ database: DB_NAME, statement, values: values || [] });
  return (result && result.values) || [];
}

async function execute(statements) {
  return plugin().execute({ database: DB_NAME, statements, transaction: false });
}

export async function openDb() {
  if (opened) return;
  if (openPromise) return openPromise;
  openPromise = (async () => {
    const p = plugin();
    try {
      const exists = await p.isDBExists({ database: DB_NAME });
      if (!(exists && exists.result)) {
        await p.createConnection({ database: DB_NAME, encrypted: false, mode: "no-encryption", version: 1, readonly: false });
      }
    } catch {
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

export async function cacheRestaurant(profile) {
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

export async function replaceMenuCache(restaurantId, items = []) {
  await openDb();
  await run("DELETE FROM menu_cache WHERE restaurantId = ?", [restaurantId]);
  for (const item of items) {
    await run(
      `INSERT INTO menu_cache (id, restaurantId, name, category, price, foodType, available, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(item.id || ""), restaurantId, item.name || "", item.category || "Uncategorized",
        Number(item.price || 0), item.foodType || "veg", item.available === false ? 0 : 1, nowIso()]
    );
  }
}

export async function replaceTablesCache(restaurantId, tables = []) {
  await openDb();
  await run("DELETE FROM tables_cache WHERE restaurantId = ?", [restaurantId]);
  for (const t of tables) {
    await run(
      "INSERT INTO tables_cache (id, restaurantId, tableNo, active, updatedAt) VALUES (?, ?, ?, ?, ?)",
      [String(t.id || t.tableNo || ""), restaurantId, String(t.tableNo || t.id || ""), t.active === false ? 0 : 1, nowIso()]
    );
  }
}

export async function listPendingOrders(restaurantId) {
  await openDb();
  const rows = await query(
    "SELECT * FROM offline_orders WHERE restaurantId = ? AND syncStatus IN ('pending','failed') ORDER BY createdAt ASC",
    [restaurantId]
  );
  return rows.map(row => ({ ...row, items: JSON.parse(row.itemsJson || "[]") }));
}

export async function markSynced(offlineId, firebaseOrderId) {
  await run("UPDATE offline_orders SET syncStatus='synced', firebaseOrderId=?, lastSyncError=NULL WHERE offlineId=?", [firebaseOrderId || null, offlineId]);
}

export async function markSyncFailed(offlineId, errorMessage) {
  await run("UPDATE offline_orders SET syncStatus='failed', syncAttempts=syncAttempts+1, lastSyncError=? WHERE offlineId=?", [String(errorMessage || "").slice(0, 500), offlineId]);
}
