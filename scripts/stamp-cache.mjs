/* =========================================================
   STAMP THE CACHE TOKEN
   ---------------------------------------------------------
   This app has no build step. Every browser fetches the same
   ./js/admin.js it fetched last week, and firebase.json tells
   it to keep JS for seven days. The only thing that makes a
   browser look again is the ?v= token in the URL.

   Those tokens were written by hand, so they drifted: six
   different values across 223 references, and the admin
   dashboard's own entry point was still on a token minted in
   August. Fixes to admin.js shipped correctly and then sat
   behind a cache nobody had invalidated.

   So the token is no longer a name anybody types. It is a
   fingerprint of the files it busts. Change any shipped
   .js, .css or .html and the token changes with it; change
   nothing and it stays put, so re-running this is a no-op
   and the diff stays empty.

     npm run stamp:cache          rewrite the tokens
     npm run stamp:cache -- --check   fail if they are stale

   The --check form is what the test runs, which is what turns
   "I forgot to bump the token" from a silent production
   non-event into a failing test.
========================================================= */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PUBLIC_DIR = join(ROOT, "public");
const STAMPED = /\.(?:html|js|css)$/;

/** Every shipped file that can carry or reference a token. */
export function stampableFiles(dir = PUBLIC_DIR, found = []) {
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) stampableFiles(full, found);
    else if (STAMPED.test(entry)) found.push(full);
  }
  return found;
}

/**
 * A quoted relative reference to a shipped .js file, with or without a token.
 *
 * Both halves matter. Rewriting an existing token is the obvious job; ADDING
 * one to a reference that never had it is the job that was missed. firebase.js
 * was imported sixteen times with no token anywhere, which under a seven-day
 * cache header means no change to it could reach a returning browser at all.
 *
 * Absolute CDN imports are deliberately not matched: their versions live in
 * the URL the vendor publishes, and rewriting those would break them.
 */
const JS_REF = /(["'])(\.{1,2}\/[A-Za-z0-9._/-]+\.js)(?:\?v=[A-Za-z0-9._-]*)?\1/g;

/** Any token, wherever it appears — including on css and image references. */
const ANY_TOKEN = /(\?v=)([A-Za-z0-9._-]+)/g;

/**
 * The same file with tokens removed entirely, so the hash tracks content only.
 *
 * Removed, not blanked. A reference that has never carried a token and the
 * same reference once stamped must normalize identically, or adding a token
 * would change the fingerprint that decides the token — and stamping would
 * never settle.
 */
export function withoutTokens(source) {
  return source.replace(ANY_TOKEN, "");
}

/** The same file with every reference carrying `token`. */
export function stamped(source, token) {
  return source
    .replace(JS_REF, (whole, quote, path) => `${quote}${path}?v=${token}${quote}`)
    .replace(ANY_TOKEN, `$1${token}`);
}

/**
 * The token for a set of {path, source} entries.
 *
 * Derived from the content it is meant to invalidate, so it cannot disagree
 * with it. Paths are included: moving a file is a change a cache must see.
 * Taking entries rather than filenames is what lets this be tested against
 * content that is not on disk.
 */
export function fingerprint(entries) {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(withoutTokens(entry.source));
    hash.update("\0");
  }
  return `s2p-${hash.digest("hex").slice(0, 12)}`;
}

export function entriesFor(files) {
  return files.map(file => ({ path: relative(ROOT, file), source: readFileSync(file, "utf8"), file }));
}

export function tokenFor(files) {
  return fingerprint(entriesFor(files));
}

/** Files that are not carrying the expected token on every reference. */
export function staleFiles(files, token) {
  return entriesFor(files)
    .filter(entry => stamped(entry.source, token) !== entry.source)
    .map(entry => entry.file);
}

export function currentToken() {
  return tokenFor(stampableFiles());
}

function main() {
  const files = stampableFiles();
  const token = tokenFor(files);
  const stale = staleFiles(files, token);

  if (process.argv.includes("--check")) {
    if (!stale.length) {
      console.log(`Cache tokens are current (${token}).`);
      return;
    }
    console.error(`Cache tokens are stale. Expected ${token} in:`);
    for (const file of stale) console.error(`  ${relative(ROOT, file)}`);
    console.error(`\nRun: npm run stamp:cache`);
    process.exit(1);
  }

  for (const file of stale) {
    writeFileSync(file, stamped(readFileSync(file, "utf8"), token));
  }
  console.log(stale.length
    ? `Stamped ${token} into ${stale.length} file${stale.length === 1 ? "" : "s"}.`
    : `Nothing to do; already ${token}.`);
}

if (process.argv[1] && process.argv[1].endsWith("stamp-cache.mjs")) main();
