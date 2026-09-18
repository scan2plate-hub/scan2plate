// Redirects the browser-only imports in public/js (the gstatic Firebase CDN
// URLs and ./firebase.js, which calls initializeApp) to the in-memory stub, so
// the modules under test can be loaded in Node exactly as written.
//
// Specifiers carry a ?v= cache-busting token in the browser, so the query
// string is stripped before matching. Without that, "./firebase.js?v=x" misses
// the rule, the real module loads, and the failure surfaces somewhere else
// entirely as a missing export from the Firebase CDN.
import { pathToFileURL } from "node:url";

const stubUrl = pathToFileURL(new URL("./firebase-stub.mjs", import.meta.url).pathname).href;
const bare = specifier => String(specifier).split("?")[0];

export function resolve(specifier, context, nextResolve) {
  const path = bare(specifier);
  if (path.startsWith("https://www.gstatic.com/firebasejs/")) {
    return { url: stubUrl, shortCircuit: true };
  }
  if (path === "./firebase.js" || path.endsWith("/firebase.js")) {
    return { url: stubUrl, shortCircuit: true };
  }
  // A versioned local module still has to resolve to the real file on disk.
  if (path !== specifier && path.startsWith(".")) return nextResolve(path, context);
  return nextResolve(specifier, context);
}
