// Redirects the browser-only imports in public/js (the gstatic Firebase CDN
// URLs and ./firebase.js, which calls initializeApp) to the in-memory stub, so
// the modules under test can be loaded in Node exactly as written.
import { pathToFileURL } from "node:url";

const stubUrl = pathToFileURL(new URL("./firebase-stub.mjs", import.meta.url).pathname).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("https://www.gstatic.com/firebasejs/")) {
    return { url: stubUrl, shortCircuit: true };
  }
  if (specifier === "./firebase.js" || specifier.endsWith("/firebase.js")) {
    return { url: stubUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
