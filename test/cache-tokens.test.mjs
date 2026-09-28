/* =========================================================
   THE CACHE TOKEN IS THE DELIVERY MECHANISM

   This app has no build step, and firebase.json tells browsers
   to keep JS for seven days. A fix to admin.js is therefore not
   shipped when it is merged and deployed — it is shipped when
   the ?v= token in the URL changes, because until then every
   browser replays the copy it already has.

   That went wrong exactly once and silently: the admin
   dashboard's entry point sat on a token minted in August while
   admin.js was changed repeatedly underneath it. The deploy was
   green, the code was correct, and no user ever received it.

   These tests make that failure loud.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { stampableFiles, tokenFor, staleFiles, withoutTokens, stamped, fingerprint, currentToken }
  from "../scripts/stamp-cache.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const files = stampableFiles();
const rel = file => relative(ROOT, file);

test("every shipped token matches the content it is meant to bust", () => {
  const token = tokenFor(files);
  const stale = staleFiles(files, token).map(rel);
  assert.deepEqual(stale, [],
    `Shipped files changed without restamping. Run: npm run stamp:cache`);
});

test("exactly one token exists across the whole site", () => {
  const seen = new Set();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(/\?v=([A-Za-z0-9._-]+)/g)) {
      seen.add(match[1]);
    }
  }
  assert.equal(seen.size, 1, `Tokens have drifted apart: ${[...seen].join(", ")}`);
});

test("the admin dashboard's entry point carries it", () => {
  // The specific file the bug hid behind. A browser that never re-fetches
  // this one never receives any POS fix at all.
  const html = readFileSync(`${ROOT}/public/admin-dashboard.html`, "utf8");
  const entry = html.match(/src="\.\/js\/admin\.js\?v=([A-Za-z0-9._-]+)"/);
  assert.ok(entry, "admin-dashboard.html loads a versioned admin.js");
  assert.equal(entry[1], currentToken());
});

test("every module admin.js imports is versioned too", () => {
  // An ES module import is its own request with its own cache entry. A
  // versioned entry point that pulls an unversioned module still serves a
  // stale module.
  const admin = readFileSync(`${ROOT}/public/js/admin.js`, "utf8");
  const local = [...admin.matchAll(/from\s+"(\.\/[^"]+\.js)(\?v=[^"]*)?"/g)];
  assert.ok(local.length > 5, "admin.js imports local modules");
  const bare = local.filter(match => !match[2]).map(match => match[1]);
  assert.deepEqual(bare, [], "these imports would be served from cache forever");
});

test("the token changes when a shipped file changes", () => {
  // The property the whole scheme rests on. Without it the stamp is
  // decoration and the seven-day cache wins. Tested on synthetic content so
  // it never touches the repository.
  const base = [{ path: "js/a.js", source: "export const a = 1;" }];
  const changed = [{ path: "js/a.js", source: "export const a = 2;" }];
  assert.notEqual(fingerprint(base), fingerprint(changed));
});

test("moving a file changes the token, because a cache keys on the path", () => {
  const here = [{ path: "js/a.js", source: "export const a = 1;" }];
  const there = [{ path: "js/sub/a.js", source: "export const a = 1;" }];
  assert.notEqual(fingerprint(here), fingerprint(there));
});

test("the token does not depend on the tokens already stamped", () => {
  // Otherwise stamping would change the fingerprint that decides the stamp,
  // and the stamper would never settle. This is the bug that showed up the
  // first time an unversioned import was given a token.
  const bare = [{ path: "js/a.js", source: 'import "./b.js";' }];
  const withToken = [{ path: "js/a.js", source: 'import "./b.js?v=s2p-old";' }];
  const withOther = [{ path: "js/a.js", source: 'import "./b.js?v=s2p-newer";' }];
  assert.equal(fingerprint(bare), fingerprint(withToken));
  assert.equal(fingerprint(withToken), fingerprint(withOther));
});

test("stamping adds a token to a reference that never had one", () => {
  // The half that was missing: firebase.js was imported sixteen times with
  // no token anywhere, so no change to it could reach a returning browser.
  assert.equal(stamped('import "./firebase.js";', "s2p-x"), 'import "./firebase.js?v=s2p-x";');
  assert.equal(stamped("import './common.js';", "s2p-x"), "import './common.js?v=s2p-x';");
  assert.equal(stamped('src="./js/track.js"', "s2p-x"), 'src="./js/track.js?v=s2p-x"');
});

test("stamping replaces a stale token rather than appending to it", () => {
  assert.equal(stamped('from "./a.js?v=old"', "s2p-x"), 'from "./a.js?v=s2p-x"');
  assert.equal(stamped('href="./style.css?v=old"', "s2p-x"), 'href="./style.css?v=s2p-x"');
});

test("stamping leaves CDN imports alone", () => {
  // Their version is part of the URL the vendor publishes; rewriting it
  // would fetch a module that does not exist.
  const cdn = 'import { x } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";';
  assert.equal(stamped(cdn, "s2p-x"), cdn);
});

test("stamping is idempotent", () => {
  const once = stamped('import "./a.js";', "s2p-x");
  assert.equal(stamped(once, "s2p-x"), once);
});

test("withoutTokens does not disturb the rest of a query string", () => {
  assert.equal(withoutTokens('"./a.js?v=s2p-x"'), '"./a.js"');
  assert.equal(withoutTokens("const url = `?restaurantId=${id}`;"), "const url = `?restaurantId=${id}`;");
});

test("restamping is a no-op, so it never churns a diff on its own", () => {
  assert.equal(tokenFor(files), tokenFor(files));
  assert.deepEqual(staleFiles(files, tokenFor(files)).map(rel), []);
});

/* ---------------------------------------------------------
   THE CACHE WINDOW ITSELF

   The token decides whether a browser looks again. These
   headers decide how long it waits before it would have
   looked anyway, which is the blast radius of a bad deploy:
   a mistake that ships is live for exactly this long for
   anyone whose browser does not re-fetch.

   They apply to Firebase Hosting only. GitHub Pages sets its
   own headers and does not read this file.
--------------------------------------------------------- */
const hostingHeaders = JSON.parse(readFileSync(`${ROOT}/firebase.json`, "utf8")).hosting.headers;

const cacheControlFor = source => hostingHeaders
  .find(rule => rule.source === source)?.headers
  .find(header => header.key === "Cache-Control")?.value;

test("JS is cached for one day", () => {
  assert.equal(cacheControlFor("**/*.js"), "public, max-age=86400");
});

test("no rule caches JS for longer than a day", () => {
  // A second rule matching .js with a larger window would quietly undo the
  // one above, and which rule wins is not obvious from reading the file.
  for (const rule of hostingHeaders) {
    if (rule.source === "**/*.js" || !/\bjs\b/.test(rule.source)) continue;
    const value = rule.headers.find(header => header.key === "Cache-Control")?.value || "";
    const maxAge = Number(value.match(/max-age=(\d+)/)?.[1] ?? 0);
    assert.ok(maxAge <= 86400, `${rule.source} caches JS for ${maxAge}s`);
  }
});

test("HTML is never cached, so a new token is always seen", () => {
  // The entry point carries the token. An HTML page served from cache points
  // at the old token, and the new JS is never requested at all — which is
  // the whole failure this suite exists to prevent.
  assert.match(cacheControlFor("**/*.html"), /max-age=0/);
  assert.match(cacheControlFor("**/*.html"), /must-revalidate/);
});
