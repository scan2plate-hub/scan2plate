// Minimal in-memory stand-in for the Firestore SDK surface that
// orders-store.js uses, so the store's fan-out/teardown behaviour can be
// tested without a network or real Firebase project.
export const activeListeners = [];

// Joins the full path so a test can tell restaurants/<id>/staff apart from
// restaurants/<id>/attendance when inspecting which listener fired.
export function collection(_db, ...path) { return { type: "collection", name: path.join("/"), path: path.join("/") }; }
export function query(ref, ...clauses) { return { type: "query", ref, clauses }; }
export function where(field, op, value) { return { field, op, value }; }

export function onSnapshot(ref, onNext, onError) {
  const listener = { ref, onNext, onError, active: true };
  activeListeners.push(listener);
  return () => { listener.active = false; };
}

/** The collection a listener is on, seeing through a query() wrapper. */
export function listenerPath(listener) {
  const ref = listener?.ref?.type === "query" ? listener.ref.ref : listener?.ref;
  return ref?.path || ref?.name || "";
}

/**
 * Emits to the listeners on ONE collection, defaulting to top-level `orders`.
 *
 * The store now runs two listeners — online orders and the offline POS
 * subcollection — and they carry different document shapes. Emitting online
 * documents into the offline listener would map them a second time and
 * silently double every order, so a test has to say which stream it means.
 */
export function emitSnapshot(docs, { path = "orders" } = {}) {
  activeListeners
    .filter(l => l.active && listenerPath(l) === path)
    .forEach(l => l.onNext({ docs: docs.map(d => ({ id: d.id, data: () => d })) }));
}

export function emitError(error, { path = "orders" } = {}) {
  activeListeners
    .filter(l => l.active && listenerPath(l) === path)
    .forEach(l => l.onError?.(error));
}

export function liveListenerCount() {
  return activeListeners.filter(l => l.active).length;
}

export function resetListeners() { activeListeners.length = 0; }

// Firestore writes are recorded rather than performed, so a test can assert
// exactly which document a save targeted (e.g. that editing a staff member
// writes back to the SAME id instead of adding a new document).
export const writes = [];

export function doc(_db, ...path) { return { type: "doc", path: path.join("/") }; }
export function setDoc(ref, data, options) { writes.push({ op: "setDoc", path: ref.path, data, options }); return Promise.resolve(); }
export function addDoc(ref, data) { writes.push({ op: "addDoc", path: ref.name, data }); return Promise.resolve({ id: `generated-${writes.length}` }); }
export function deleteDoc(ref) { writes.push({ op: "deleteDoc", path: ref.path }); return Promise.resolve(); }
export function getDocs(ref) {
  const rows = seededRows(ref?.name || ref?.path || "");
  return Promise.resolve({ empty: rows.length === 0, size: rows.length, docs: rows.map(row => ({ id: row.id, data: () => row })) });
}
export function getDoc(ref) {
  const row = (globalThis.__STUB_DOCS || {})[ref?.path || ""];
  return Promise.resolve({ exists: () => Boolean(row), id: String(ref?.path || "").split("/").pop(), data: () => row });
}
// Tests seed collections/documents through these globals; an unseeded path
// simply comes back empty, which is what an absent record looks like.
function seededRows(name) {
  const rows = (globalThis.__STUB_COLLECTIONS || {})[name];
  return Array.isArray(rows) ? rows : [];
}
export function limit(n) { return { limit: n }; }
export function orderBy(field) { return { orderBy: field }; }
export function serverTimestamp() { return { __serverTimestamp: true }; }
export function runTransaction(_db, fn) { return fn({ get: () => Promise.resolve({ exists: () => false, data: () => ({}) }), set: () => {} }); }
export function getStorage() { return { stub: true }; }
export function ref() { return { stub: true }; }
export function uploadBytes() { return Promise.resolve(); }
export function getDownloadURL() { return Promise.resolve(""); }
export function resetWrites() { writes.length = 0; }

export const db = { stub: true };
export const auth = { currentUser: null };
export const app = { stub: true };
