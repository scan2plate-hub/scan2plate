/* =========================================================
   REGRESSION: "lastmod is in the future" blocked the deploy

   The hosting deploy failed its SEO gate with every page in the
   sitemap reported as modified in the future. Nothing deployed.

   Three things had to line up:

     1. actions/checkout defaults to a depth-1 clone, so the only
        commit in CI's history is the merge commit — and
        `git log -1 -- <file>` returns it for EVERY file.
     2. That merge was made by an account in IST, so its committer
        date is "2026-09-23T02:59:28+05:30".
     3. build-sitemap.mjs sliced the first 10 characters off that
        string, taking the COMMITTER'S calendar day. validate-
        sitemap.mjs compares against UTC, as a crawler does. 23rd
        versus 22nd: every page looked like it came from the future.

   The slice is the defect — a timestamp rendered in +05:30 and one
   rendered in UTC are not the same calendar day, and only one of
   them is the day a crawler will check. The shallow clone is a
   second, quieter defect: it collapses every page to one date, which
   is the fake lastmod build-sitemap.mjs exists to prevent.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = `${import.meta.dirname}/..`;

// What the script does now, and what it used to do.
const utcDay = iso => new Date(iso).toISOString().slice(0, 10);
const slicedDay = iso => iso.slice(0, 10);

test("a commit made after midnight IST is not tomorrow in UTC", () => {
  // The exact commit that failed the deploy.
  const iso = "2026-09-23T02:59:28+05:30";
  assert.equal(slicedDay(iso), "2026-09-23", "the old behaviour, for the record");
  assert.equal(utcDay(iso), "2026-09-22");
});

test("the correction holds for offsets on both sides of UTC", () => {
  // Behind UTC: an evening commit in Los Angeles is already the next day in
  // UTC, so slicing loses a day instead of gaining one. Same defect, opposite
  // direction — a tolerance of "+1 day" would have fixed only half of it.
  const iso = "2026-09-22T18:30:00-08:00";
  assert.equal(slicedDay(iso), "2026-09-22");
  assert.equal(utcDay(iso), "2026-09-23");
});

test("a commit already in UTC is untouched", () => {
  const iso = "2026-09-22T21:25:42+00:00";
  assert.equal(utcDay(iso), slicedDay(iso));
  assert.equal(utcDay(iso), "2026-09-22");
});

test("no lastmod can be in the future by the validator's own measure", () => {
  // The real invariant. A commit happens at an INSTANT at or before now; the
  // offset only changes how that instant is written down. So the UTC day of
  // any real commit is never after today — which is exactly what the failing
  // gate checks, and what slicing the raw string broke.
  const today = new Date().toISOString().slice(0, 10);
  const instant = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000); // whole seconds: %cI carries none
  for (const offset of [14 * 60, 5 * 60 + 30, 0, -11 * 60]) {
    const sign = offset < 0 ? "-" : "+";
    const abs = Math.abs(offset);
    const shifted = new Date(instant.getTime() + offset * 60000).toISOString().slice(0, 19);
    const iso = `${shifted}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
    // Same instant, four different ways of writing it.
    assert.equal(new Date(iso).getTime(), instant.getTime(), `${iso} must be the same instant`);
    assert.ok(utcDay(iso) <= today, `${iso} must not produce a future lastmod`);
  }
});

test("build-sitemap.mjs parses the committer date instead of slicing it", () => {
  const source = readFileSync(`${ROOT}/scripts/build-sitemap.mjs`, "utf8");
  assert.match(
    source,
    /new Date\(iso\)\.toISOString\(\)\.slice\(0, 10\)/,
    "the committer date must be re-rendered in UTC"
  );
  assert.doesNotMatch(
    source,
    /return iso\.slice\(0, 10\)/,
    "slicing the raw %cI string takes the committer's calendar day, not UTC's"
  );
});

test("the sitemap index date and the page dates are measured the same way", () => {
  const source = readFileSync(`${ROOT}/scripts/build-sitemap.mjs`, "utf8");
  // `today` was always UTC. The per-page date now is too. Two different
  // clocks in one file is how this came back the first time.
  assert.match(source, /const today = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
});

test("the deploy workflow clones full history, not the default depth-1", () => {
  const workflow = readFileSync(`${ROOT}/.github/workflows/deploy-firestore.yml`, "utf8");
  assert.match(
    workflow,
    /actions\/checkout@v4\s*\n\s*with:\s*\n\s*fetch-depth: 0/,
    "a shallow clone gives every page the merge commit's date"
  );
});

test("the committed sitemap has no future dates", () => {
  const today = new Date().toISOString().slice(0, 10);
  const offenders = [];
  for (const file of ["sitemap.xml", "sitemap-pages.xml", "sitemap-blog.xml", "sitemap-categories.xml"]) {
    let xml;
    try { xml = readFileSync(`${ROOT}/public/${file}`, "utf8"); } catch { continue; }
    for (const match of xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) {
      if (match[1] > today) offenders.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [], "a date a crawler can prove wrong discredits every other date in the file");
});
