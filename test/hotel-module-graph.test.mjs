/* =========================================================
   THE HOTEL MODULE GRAPH LINKS

   A browser resolves ES module imports before running a single
   line. One import of a name that does not exist and the WHOLE
   graph fails to link — silently, with an empty page and nothing
   in the console that names the cause.

   This repo has been bitten by exactly that before: the Super
   Admin billing sections once vanished entirely because a stale
   cached module no longer had an export its importer wanted. The
   version-token tests in subscription-core.test.mjs came from
   that incident.

   Writing this file caught a live instance — hotel-front-desk.js
   imported `businessTypeLabelSafe`, a name that was never
   defined anywhere. Nothing else would have caught it: it parses,
   it lints, and it only fails when a browser tries to link it.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const JS_DIR = `${import.meta.dirname}/../public/js`;
const HOTEL_MODULES = readdirSync(JS_DIR).filter(file => file.startsWith("hotel-") && file.endsWith(".js"));

const sourceOf = file => readFileSync(`${JS_DIR}/${file}`, "utf8");

/** Source with comments removed, so a check never matches prose about itself. */
const codeOf = file => sourceOf(file)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * A module that imports from a URL cannot be loaded by Node's ESM loader, so
 * its exports cannot be read here. firebase.js is the only one, and it is
 * skipped explicitly rather than silently: pretending to have verified it
 * would be worse than saying which file was not covered.
 */
const loadable = file => !/from\s*["']https:/.test(sourceOf(file));

/** Named imports from a sibling module, as { from, names }. */
function localImports(source) {
  const imports = [];
  const pattern = /import\s*\{([^}]+)\}\s*from\s*["'](\.\/[a-z0-9-]+\.js)(\?[^"']*)?["']/gi;
  for (const match of source.matchAll(pattern)) {
    const names = match[1].split(",")
      .map(part => part.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    imports.push({ from: match[2].replace("./", ""), names, versioned: Boolean(match[3]?.includes("v=")) });
  }
  return imports;
}

/** Exported names of a module, by reading it — the real answer, not a regex. */
const exportsOf = new Map();
async function namesExportedBy(file) {
  if (!exportsOf.has(file)) {
    exportsOf.set(file, Object.keys(await import(`${JS_DIR}/${file}`)));
  }
  return exportsOf.get(file);
}

test("every hotel module exists to be found", () => {
  assert.ok(HOTEL_MODULES.length >= 4, `expected the hotel modules, found ${HOTEL_MODULES.join(", ")}`);
});

test("EVERY name imported by a hotel module is actually exported", async () => {
  const broken = [];
  const skipped = [];
  for (const file of HOTEL_MODULES) {
    for (const entry of localImports(sourceOf(file))) {
      // Firebase and other CDN modules cannot be imported here; only the
      // repo's own files are checked, which is where the mistakes are made.
      if (!loadable(entry.from)) { skipped.push(`${file} -> ${entry.from}`); continue; }
      let available;
      try {
        available = await namesExportedBy(entry.from);
      } catch (error) {
        broken.push(`${file} -> ${entry.from} could not be loaded at all: ${error.message}`);
        continue;
      }
      entry.names.forEach(name => {
        if (!available.includes(name)) broken.push(`${file} imports "${name}" from ${entry.from}, which does not export it`);
      });
    }
  }
  assert.deepEqual(broken, [], "an unresolvable import kills the whole page, silently");
  // Page modules import firebase.js, which loads the SDK from a CDN that
  // Node's loader cannot fetch — so their import of `db`/`auth` is the one
  // thing here that cannot be verified. Listed exactly, so the list growing
  // is a visible loss of coverage rather than a silent one.
  assert.deepEqual(skipped.sort(), [
    "hotel-front-desk.js -> firebase.js",
    "hotel-housekeeping-board.js -> firebase.js",
    "hotel-setup-page.js -> firebase.js",
    // plan-limits.js itself imports firebase.js, so it is unloadable for the
    // same reason. Its own behaviour is covered by plan-limits.test.mjs,
    // which stubs the SDK through a loader hook.
    "hotel-setup-page.js -> plan-limits.js"
  ], "if this list grows, coverage shrank and this line should say why");
});

test("every hotel module's relative imports are version-stamped", () => {
  // Same reasoning as the subscription graph: an unversioned link can serve a
  // stale copy that no longer has the exports its importer needs.
  const offenders = [];
  HOTEL_MODULES.forEach(file => {
    const source = sourceOf(file);
    for (const match of source.matchAll(/(?:from\s+|import\()\s*["'](\.\/[a-z0-9-]+\.js)(\?[^"']*)?["']/gi)) {
      if (!match[2]?.includes("v=")) offenders.push(`${file} -> ${match[1]}`);
    }
  });
  assert.deepEqual(offenders, []);
});

test("the hotel graph shares the codebase's single version token", () => {
  const tokens = new Set();
  HOTEL_MODULES.forEach(file => {
    for (const match of sourceOf(file).matchAll(/\?v=([a-z0-9-]+)/gi)) tokens.add(match[1]);
  });
  assert.equal(tokens.size, 1, `expected one token, found: ${[...tokens].join(", ")}`);
});

test("every hotel page loads its controller with a version token", () => {
  [
    ["hotel-front-desk.html", "hotel-front-desk.js"],
    ["hotel-housekeeping.html", "hotel-housekeeping-board.js"],
    ["hotel-setup.html", "hotel-setup-page.js"]
  ].forEach(([page, controller]) => {
    const html = readFileSync(`${import.meta.dirname}/../public/${page}`, "utf8");
    assert.match(html, new RegExp(`src="\\./js/${controller.replace(".", "\\.")}\\?v=s2p-[a-z0-9-]+"`), page);
    assert.match(html, /type="module"/, page);
  });
});

test("SECTION 27: the housekeeping board loads no financial data at all", () => {
  // "Housekeeping should NOT see financial reports" is structural here, not
  // a hidden nav item: there is no folio, rate, payment or revenue on this
  // page to hide, because none of it is fetched.
  const source = sourceOf("hotel-housekeeping-board.js");
  ["hotel_folios", "hotelPayments", "hotelInvoices", "hotel_rate_plans", "hotel_reservations"]
    .forEach(collectionName => {
      assert.ok(!source.includes(collectionName), `the board must not read ${collectionName}`);
    });
  assert.ok(!source.includes("hotel-folio.js"), "and must not import the folio service");
});

test("the hotel panel routes by job rather than dumping everyone on one screen", () => {
  const html = readFileSync(`${import.meta.dirname}/../public/hotel-room-panel.html`, "utf8");
  assert.match(html, /hotel-housekeeping\.html/, "housekeeping has its own board");
  assert.match(html, /hotel-front-desk\.html/, "everyone else goes to the front desk");
  assert.ok(!html.includes("cafe-token-panel"), "a hotel is no longer sent to counter billing");
});

test("both hotel pages bind exactly one delegated click listener", () => {
  // Re-rendering replaces markup constantly. Per-button listeners would
  // either be lost or accumulate — the duplicate-listener fault in §47.
  ["hotel-front-desk.js", "hotel-housekeeping-board.js", "hotel-setup-page.js"].forEach(file => {
    const code = codeOf(file);
    const listeners = code.match(/document\.body\.addEventListener\(/g) || [];
    assert.equal(listeners.length, 1, `${file} must delegate from one listener`);
    assert.match(code, /event\.target\.closest\(/, `${file} must resolve actions by delegation`);
  });
});

test("the front desk never reloads the page to navigate or save", () => {
  // Section 47 names this directly. A reload loses every listener, every
  // cached snapshot and anything the receptionist had half-typed.
  // Comments are stripped first: a prose promise not to reload must not be
  // what satisfies the test that checks for reloads.
  const code = codeOf("hotel-front-desk.js");
  assert.doesNotMatch(code, /location\.reload/, "navigation and CRUD must never reload");
  assert.doesNotMatch(code, /window\.location\.href\s*=/, "nor navigate away mid-task");
  // The one navigation that IS correct: no business in the session at all.
  assert.match(code, /location\.replace\("\.\/admin-login\.html"\)/);
});

test("SECTION 51: setup checks room limits through the CENTRAL plan check", () => {
  // Not a second opinion about entitlements. plan-limits.js already caches
  // per page and fails open; a local copy of that logic would eventually
  // disagree with the rest of the product about what a plan includes.
  const page = codeOf("hotel-setup-page.js");
  assert.match(page, /from "\.\/plan-limits\.js/, "the page must use the shared limit module");
  assert.match(page, /checkLimitFor\("maxRooms"/, "and ask it about rooms");
  // The service must not reach for limits itself — it is handed the answer,
  // so the page owns the single lookup. Comments are stripped first: the
  // service's own prose EXPLAINS why it does not import plan-limits, and
  // that explanation must not be what satisfies the test.
  const service = codeOf("hotel-setup.js");
  assert.ok(!service.includes("plan-limits"), "the service must not acquire its own opinion");
  assert.ok(!service.includes("checkLimit"), "nor call the limit check itself");
});

test("RULE 18: nothing in setup deletes a room", () => {
  // A hard delete would leave last year's invoices pointing at nothing.
  // Rate plans CAN be deleted — they price the future, not the past.
  const service = codeOf("hotel-setup.js");
  assert.match(service, /transaction\.delete\(planRef/, "a rate rule is deletable");
  assert.ok(!/transaction\.delete\(roomRef/.test(service), "a room is never deleted, only retired");
  assert.match(service, /active: false/, "retiring is a flag, so the document survives");
});

test("every element the controller looks up exists in the page", () => {
  // A typo'd id is a silent no-op: the button simply never works.
  [["hotel-front-desk.html", "hotel-front-desk.js"],
   ["hotel-housekeeping.html", "hotel-housekeeping-board.js"],
   ["hotel-setup.html", "hotel-setup-page.js"]].forEach(([page, controller]) => {
    checkIds(readFileSync(`${import.meta.dirname}/../public/${page}`, "utf8"), sourceOf(controller), page);
  });
});

function checkIds(html, source, label) {
  const missing = [];
  // Two ways an id reaches the DOM here: $("id") directly, and paint("id", …)
  // which looks it up on the caller's behalf. Checking only the first leaves
  // every rendered panel unverified — which is most of the page.
  // Ids come from two places and BOTH count: the static page, and markup the
  // controller renders itself (a payment field inside the checkout dialog
  // exists only once that dialog is drawn). Checking against the page alone
  // would report every rendered control as missing and be switched off.
  const renderedIds = new Set([...source.matchAll(/id="([A-Za-z0-9_]+)"/g)].map(match => match[1]));
  const has = id => html.includes(`id="${id}"`) || renderedIds.has(id);

  const patterns = [/\$\("([A-Za-z0-9_]+)"\)/g, /paint\("([A-Za-z0-9_]+)"/g];
  patterns.forEach(pattern => {
    for (const match of source.matchAll(pattern)) {
      if (!has(match[1])) missing.push(match[1]);
    }
  });
  assert.deepEqual([...new Set(missing)], [], `${label}: the controller reaches for ids the page does not have`);
}
