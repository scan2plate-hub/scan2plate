/* In-memory stand-in for the firebase-admin surface backend/server.js uses,
   so the real routes can be exercised without a Firebase project. */

export const store = new Map();          // "collection/doc" -> data
export const authUsers = new Map();      // idToken -> decoded claims

export function resetStore() {
  store.clear();
  authUsers.clear();
}

export function seed(path, data) {
  store.set(path, { ...data });
}

export function readAll(prefix) {
  return [...store.entries()]
    .filter(([path]) => path.startsWith(`${prefix}/`) && path.slice(prefix.length + 1).split("/").length === 1)
    .map(([path, data]) => ({ id: path.split("/").pop(), path, data }));
}

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Date ? { __date: v.toISOString() } : v)), (_k, v) => (v && v.__date ? new Date(v.__date) : v)));

function snapshotFor(path) {
  const data = store.get(path);
  return {
    id: path.split("/").pop(),
    ref: refFor(path),
    exists: data !== undefined,
    data: () => (data === undefined ? undefined : clone(data))
  };
}

function refFor(path) {
  return {
    id: path.split("/").pop(),
    path,
    get: async () => snapshotFor(path),
    set: async (value, options = {}) => {
      const next = options.merge ? { ...(store.get(path) || {}), ...value } : { ...value };
      Object.keys(next).forEach(key => { if (next[key] && next[key].__delete) delete next[key]; });
      store.set(path, next);
    },
    update: async value => store.set(path, { ...(store.get(path) || {}), ...value }),
    delete: async () => store.delete(path),
    collection: name => collectionRef(`${path}/${name}`)
  };
}

function collectionRef(prefix, filters = [], max = Infinity) {
  const runQuery = () => {
    let rows = readAll(prefix);
    filters.forEach(({ field, op, value }) => {
      rows = rows.filter(row => {
        const actual = row.data?.[field];
        if (op === "==") return actual === value;
        if (op === "in") return Array.isArray(value) && value.includes(actual);
        return true;
      });
    });
    return rows.slice(0, max);
  };
  return {
    doc: (id = `auto-${Math.random().toString(36).slice(2, 10)}`) => refFor(`${prefix}/${id}`),
    add: async value => {
      const id = `auto-${store.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
      store.set(`${prefix}/${id}`, { ...value });
      return refFor(`${prefix}/${id}`);
    },
    where: (field, op, value) => collectionRef(prefix, [...filters, { field, op, value }], max),
    limit: n => collectionRef(prefix, filters, n),
    orderBy: () => collectionRef(prefix, filters, max),
    get: async () => {
      const rows = runQuery();
      return { empty: rows.length === 0, size: rows.length, docs: rows.map(row => snapshotFor(row.path)) };
    }
  };
}

const firestore = {
  collection: name => collectionRef(name),
  doc: path => refFor(path),
  runTransaction: async fn => fn({
    get: async ref => ref.get(),
    set: async (ref, value, options) => ref.set(value, options),
    update: async (ref, value) => ref.update(value)
  })
};

export function getFirestore() { return firestore; }

export const FieldValue = {
  serverTimestamp: () => new Date("2026-09-18T10:00:00.000Z"),
  delete: () => ({ __delete: true })
};

export function getAuth() {
  return {
    verifyIdToken: async token => {
      const claims = authUsers.get(token);
      if (!claims) throw new Error("invalid token");
      return claims;
    },
    getUserByEmail: async () => { const e = new Error("not found"); e.code = "auth/user-not-found"; throw e; },
    createUser: async attrs => ({ uid: `uid-${attrs.email}`, ...attrs }),
    updateUser: async () => ({}),
    deleteUser: async () => ({})
  };
}

// server.js decides adminReady from getApps().length, so the stub has to
// behave like the real module: empty until initializeApp() is called.
const apps = [];
export function initializeApp() {
  const app = { name: `stub-${apps.length}` };
  apps.push(app);
  return app;
}
export function cert(value) { return value; }
export function getApps() { return apps; }
export function getStorage() {
  return { bucket: () => ({ file: () => ({ save: async () => {} }) }) };
}
