/* =========================================================
   THE CATEGORY LIST BESIDE THE MENU

   Forty categories wrapped into pills above the grid pushed
   the items halfway down the screen and moved every category
   whenever the list changed. Down the side they hold still.

   What is worth testing is the ordering, the counts, and the
   one case that used to empty the screen: a selected category
   that no longer exists.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ALL_CATEGORIES, normalizeCategoryName, categoryCounts,
  categoryListModel, resolveSelectedCategory, itemMatches
} from "../public/js/menu-categories.js";

const menu = [
  { name: "Veg Burger", category: "Burger Buffet" },
  { name: "Cheese Burger", category: "Burger Buffet" },
  { name: "Chilli Potato", category: "Chinese Snacks" },
  { name: "Masala Chai", category: "Kadak Chai" }
];

/* --------------------------------------------------------- */
test("a blank category is named, not dropped", () => {
  assert.equal(normalizeCategoryName(""), "Uncategorized");
  assert.equal(normalizeCategoryName("   "), "Uncategorized");
  assert.equal(normalizeCategoryName(undefined), "Uncategorized");
  assert.equal(normalizeCategoryName(null), "Uncategorized");
  assert.equal(normalizeCategoryName("  Soup "), "Soup");
});

test("counts are per category and add up to the menu", () => {
  const counts = categoryCounts(menu);
  assert.equal(counts.get("Burger Buffet"), 2);
  assert.equal(counts.get("Chinese Snacks"), 1);
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), menu.length);
});

test("All comes first and carries the whole count", () => {
  const [first] = categoryListModel(menu);
  assert.equal(first.key, ALL_CATEGORIES);
  assert.equal(first.label, "All");
  assert.equal(first.count, 4);
});

test("the rest are alphabetical, not by size", () => {
  // A list that reorders itself as the menu changes has to be read every
  // time instead of learned. The fixture is built so the two orderings
  // disagree: Water is the largest category and the last alphabetically,
  // so sorting by count would put it first.
  const skewed = [
    ...menu,
    { name: "Water 1L", category: "Water" },
    { name: "Sparkling", category: "Water" },
    { name: "Mineral", category: "Water" }
  ];
  const labels = categoryListModel(skewed).slice(1).map(entry => entry.label);
  assert.deepEqual(labels, ["Burger Buffet", "Chinese Snacks", "Kadak Chai", "Water"]);
  assert.equal(labels.at(-1), "Water", "the biggest category does not jump to the top");
});

test("exactly one entry is active, and it is the selected one", () => {
  const model = categoryListModel(menu, "Chinese Snacks");
  assert.deepEqual(model.filter(entry => entry.active).map(entry => entry.key), ["Chinese Snacks"]);
});

test("All is active when nothing is chosen", () => {
  assert.equal(categoryListModel(menu)[0].active, true);
  assert.equal(categoryListModel(menu, ALL_CATEGORIES)[0].active, true);
});

test("a category that no longer exists falls back to All", () => {
  // The last item in a category is deleted while it is selected. Falling
  // back shows a full grid rather than an empty one nobody can explain.
  assert.equal(resolveSelectedCategory(menu, "Deleted Category"), ALL_CATEGORIES);
  assert.equal(categoryListModel(menu, "Deleted Category")[0].active, true);
  assert.equal(resolveSelectedCategory(menu, "Burger Buffet"), "Burger Buffet");
});

test("an empty menu still yields a usable list", () => {
  const model = categoryListModel([]);
  assert.deepEqual(model.map(entry => entry.key), [ALL_CATEGORIES]);
  assert.equal(model[0].count, 0);
});

test("nulls in the menu are ignored rather than counted", () => {
  assert.equal(categoryListModel([null, undefined, ...menu])[0].count, 4);
});

/* ---------------------------------------------------------
   FILTERING
--------------------------------------------------------- */
test("picking Burger Buffet shows Burger Buffet and nothing else", () => {
  const shown = menu.filter(item => itemMatches(item, "Burger Buffet"));
  assert.deepEqual(shown.map(item => item.name), ["Veg Burger", "Cheese Burger"]);
});

test("All shows everything", () => {
  assert.equal(menu.filter(item => itemMatches(item, ALL_CATEGORIES)).length, 4);
});

test("search narrows within the chosen category, not across it", () => {
  // Searching "burger" while Chinese Snacks is selected must not pull burgers
  // back into view; the category is the frame, search works inside it.
  assert.equal(menu.filter(item => itemMatches(item, "Chinese Snacks", "burger")).length, 0);
  assert.equal(menu.filter(item => itemMatches(item, ALL_CATEGORIES, "burger")).length, 2);
});

test("search ignores case and surrounding spaces", () => {
  assert.equal(itemMatches(menu[0], ALL_CATEGORIES, "  VEG  "), true);
  assert.equal(itemMatches(menu[0], ALL_CATEGORIES, ""), true);
  assert.equal(itemMatches(menu[0], ALL_CATEGORIES, "   "), true);
});

test("search also looks at category and description", () => {
  assert.equal(itemMatches(menu[2], ALL_CATEGORIES, "chinese"), true);
  assert.equal(itemMatches({ name: "X", description: "peri peri" }, ALL_CATEGORIES, "peri"), true);
});

/* ---------------------------------------------------------
   THE WIRING
--------------------------------------------------------- */
const adminCode = readFileSync(`${import.meta.dirname}/../public/js/admin.js`, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const dashboardHtml = readFileSync(`${import.meta.dirname}/../public/admin-dashboard.html`, "utf8");

test("Quick Billing renders the vertical list", () => {
  const picker = adminCode.match(/function renderManualMenuPicker\(\)[\s\S]*?\n\}/)?.[0] || "";
  assert.match(picker, /renderCategoryList\(/);
  assert.doesNotMatch(picker, /renderCategoryChips\(/);
});

test("the Menu Items screen keeps its pills", () => {
  // Other screens were not asked to change, and a shared renderer would have
  // changed them both.
  assert.match(adminCode, /renderCategoryChips\(menuCategoryTabsEl/);
});

test("the category column binds one listener, not one per repaint", () => {
  // The list repaints on every category tap. Binding per paint is the fault
  // that made a table card fire Paid twice.
  const fn = adminCode.match(/function renderCategoryList\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(fn, /dataset\.s2pCatBound/, "it guards re-binding");
  assert.equal((fn.match(/addEventListener/g) || []).length, 1);
});

test("the markup gives the list its own column", () => {
  assert.match(dashboardHtml, /class="s2p-picker"/);
  assert.match(dashboardHtml, /class="s2p-cat-list" id="manualCategoryTabs"/);
  assert.match(dashboardHtml, /\.s2p-picker\{[^}]*grid-template-columns:\s*186px/);
});

test("it collapses to a scrolling row on a phone", () => {
  const media = dashboardHtml.match(/@media \(max-width:860px\)\{[\s\S]*?\n\s*\}\n/)?.[0] || "";
  assert.match(media, /\.s2p-cat-list\{[^}]*flex-direction:row/);
  assert.match(media, /overflow-x:auto/);
});
