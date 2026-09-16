import test from "node:test";
import assert from "node:assert/strict";
import { takeWindow, growWindow, resetWindow, openWindowFully, showMoreMarkup, LIST_PAGE_SIZE } from "../public/js/common.js";

// Windowing is what stopped Online Orders, Reports, Print Bills and the KOT
// queue from building a card for every record in the restaurant's history on
// every render. The property that matters most is that NOTHING becomes
// unreachable: the window only ever limits what is drawn, never the data.
// (The DOM halves — bindShowMore and reconcileKeyedList — are covered by the
// browser checks, which also assert Show more reaches every record.)

const items = n => Array.from({ length: n }, (_, i) => i);
// The window is keyed by container identity, so a plain object stands in.
const container = () => ({});

test("renders at most one page by default", () => {
  const c = container();
  const w = takeWindow(c, items(500));
  assert.equal(w.visible.length, LIST_PAGE_SIZE);
  assert.equal(w.hidden, 500 - LIST_PAGE_SIZE);
  assert.equal(w.total, 500);
});

test("a list shorter than a page shows everything and offers no Show more", () => {
  const c = container();
  const w = takeWindow(c, items(12));
  assert.equal(w.visible.length, 12);
  assert.equal(w.hidden, 0);
  assert.equal(showMoreMarkup(w.hidden, w.total, "orders"), "");
});

test("Show more reveals the next page and eventually every record", () => {
  const c = container();
  const all = items(145);
  assert.equal(takeWindow(c, all).visible.length, 60);
  growWindow(c);
  assert.equal(takeWindow(c, all).visible.length, 120);
  growWindow(c);
  const final = takeWindow(c, all);
  assert.equal(final.visible.length, 145, "never truncates below the real total");
  assert.equal(final.hidden, 0);
  assert.equal(showMoreMarkup(final.hidden, final.total, "orders"), "", "control disappears once everything is shown");
});

test("windows are independent per list", () => {
  const a = container(), b = container();
  growWindow(a);
  assert.equal(takeWindow(a, items(500)).visible.length, 120);
  assert.equal(takeWindow(b, items(500)).visible.length, 60, "growing one list must not affect another");
});

test("openWindowFully exposes every record, for export and print", () => {
  const c = container();
  const all = items(300);
  openWindowFully(c, all.length);
  assert.equal(takeWindow(c, all).visible.length, 300);
  assert.equal(takeWindow(c, all).hidden, 0);
});

test("resetWindow returns a list to page one after a filter change", () => {
  const c = container();
  openWindowFully(c, 300);
  resetWindow(c);
  assert.equal(takeWindow(c, items(300)).visible.length, LIST_PAGE_SIZE);
});

test("the Show more control reports how much is left", () => {
  const markup = showMoreMarkup(85, 145, "orders");
  assert.match(markup, /s2p-show-more/);
  assert.match(markup, /85 of 145 orders hidden/);
});

test("inside a table the control is wrapped in a spanning row", () => {
  const markup = showMoreMarkup(10, 70, "orders", true, 10);
  assert.match(markup, /^<tr><td colspan="10">/);
  assert.match(markup, /<\/td><\/tr>$/);
});

test("an empty list is handled without throwing", () => {
  const w = takeWindow(container(), []);
  assert.deepEqual(w.visible, []);
  assert.equal(w.hidden, 0);
  assert.equal(w.total, 0);
});
