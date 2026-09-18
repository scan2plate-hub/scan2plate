/* Redirects backend/server.js's firebase-admin and razorpay imports to the
   in-memory stubs, so the real Express routes run unchanged in a test. */
import { pathToFileURL } from "node:url";

const here = new URL("./", import.meta.url);
const admin = pathToFileURL(new URL("./firebase-admin-stub.mjs", here).pathname).href;
const razorpay = pathToFileURL(new URL("./razorpay-stub.mjs", here).pathname).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("firebase-admin/")) return { url: admin, shortCircuit: true };
  if (specifier === "razorpay") return { url: razorpay, shortCircuit: true };
  return nextResolve(specifier, context);
}
