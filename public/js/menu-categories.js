/* =========================================================
   THE CATEGORY LIST BESIDE THE MENU
   ---------------------------------------------------------
   Quick Billing used to wrap its categories into rows of
   pills above the grid. With forty categories that is four
   or five rows of wrapped text, the item grid starts halfway
   down the screen, and the category a counter wants is in a
   different place every time the list changes.

   A vertical list fixes the position of every category and
   costs one fixed column, which is the same trade the app's
   own left navigation already makes.

   Only the model lives here — labels, counts and which one
   is active. No DOM, so the ordering and the counts can be
   tested without a browser.
========================================================= */

export const ALL_CATEGORIES = "all";

/** Items with no category are not lost; they get a name. */
export function normalizeCategoryName(value) {
  return String(value ?? "").trim() || "Uncategorized";
}

/** How many items sit under each category, keyed by normalized name. */
export function categoryCounts(items) {
  const counts = new Map();
  for (const item of items || []) {
    if (!item) continue;
    const name = normalizeCategoryName(item.category);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

/**
 * The list to render, "All" first and the rest alphabetical.
 *
 * Counts are shown because an empty category is worth seeing before the tap,
 * not after. Alphabetical rather than by count: a list that reorders itself
 * as the menu changes forces the counter to read it every time instead of
 * learning where things are.
 */
export function categoryListModel(items, selected = ALL_CATEGORIES) {
  const counts = categoryCounts(items);
  const names = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const active = names.includes(selected) ? selected : ALL_CATEGORIES;

  return [
    { key: ALL_CATEGORIES, label: "All", count: (items || []).filter(Boolean).length, active: active === ALL_CATEGORIES },
    ...names.map(name => ({ key: name, label: name, count: counts.get(name), active: active === name }))
  ];
}

/**
 * The category actually in force.
 *
 * A category can disappear while it is selected — the last item in it is
 * deleted, or the menu reloads. Falling back to "All" shows a full grid
 * rather than an empty one the counter cannot explain.
 */
export function resolveSelectedCategory(items, selected) {
  return categoryCounts(items).has(selected) ? selected : ALL_CATEGORIES;
}

/** Does this item belong in the current view? */
export function itemMatches(item, selected, search = "") {
  const categoryOk = selected === ALL_CATEGORIES
    || normalizeCategoryName(item?.category) === selected;
  if (!categoryOk) return false;

  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return true;

  const haystack = `${item?.name || ""} ${item?.category || ""} ${item?.description || ""}`.toLowerCase();
  return haystack.includes(needle);
}
