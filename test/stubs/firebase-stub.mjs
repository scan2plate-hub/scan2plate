// Minimal in-memory stand-in for the Firestore SDK surface that
// orders-store.js uses, so the store's fan-out/teardown behaviour can be
// tested without a network or real Firebase project.
export const activeListeners = [];

export function collection(_db, name) { return { type: "collection", name }; }
export function query(ref, ...clauses) { return { type: "query", ref, clauses }; }
export function where(field, op, value) { return { field, op, value }; }

export function onSnapshot(ref, onNext, onError) {
  const listener = { ref, onNext, onError, active: true };
  activeListeners.push(listener);
  return () => { listener.active = false; };
}

export function emitSnapshot(docs) {
  activeListeners.filter(l => l.active).forEach(l => l.onNext({ docs: docs.map(d => ({ id: d.id, data: () => d })) }));
}

export function emitError(error) {
  activeListeners.filter(l => l.active).forEach(l => l.onError?.(error));
}

export function liveListenerCount() {
  return activeListeners.filter(l => l.active).length;
}

export function resetListeners() { activeListeners.length = 0; }

export const db = { stub: true };
export const auth = { currentUser: null };
export const app = { stub: true };
