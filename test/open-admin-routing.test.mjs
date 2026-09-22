/* =========================================================
   REGRESSION: "Open Admin" opened the wrong business

   Clicking Open Admin on RST_RAJ — a Hotel — opened a panel
   showing another business entirely, with that other business's
   plans. Every row in the table opened the same one.

   The route was picked correctly from the business type. The
   BUSINESS was not attached to it at all:

     window.open(panelRouteFor(restaurant), "_blank", "noopener")

   carried no id, and every panel resolves its id from
   localStorage. A super admin's session deliberately clears the
   staff session (saveSuperAdminSession removes scan2plate_user),
   so `currentUser.restaurantId` is undefined and the panel fell
   through to `scan2plate_last_restaurant_id` — whichever business
   this BROWSER last signed into. If that was a street vendor, you
   got a street vendor's panel and a street vendor's plans.

   The id now rides in the link. Who may honour it is the other
   half: an owner or staff member stays pinned to their own
   business, so a link cannot move them; a super admin has no
   business of their own, so for them the link is the only answer
   there is.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = `${import.meta.dirname}/..`;
const JS = file => readFileSync(`${ROOT}/public/js/${file}`, "utf8");

/* ---------------------------------------------------------
   The resolver, against a faked browser
--------------------------------------------------------- */

async function withBrowser({ search = "", storage = {} }, run) {
  const store = { ...storage };
  globalThis.window = { location: { search } };
  globalThis.localStorage = {
    getItem: key => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: key => { delete store[key]; }
  };
  try {
    // Fresh import each time: the helpers read the globals when called, but a
    // cached module would hide it if that ever stopped being true.
    const mod = await import(`${ROOT}/public/js/common.js?case=${Math.random()}`);
    return await run(mod, store);
  } finally {
    delete globalThis.window;
    delete globalThis.localStorage;
  }
}

const SUPER = JSON.stringify({ uid: "u1", role: "super_admin" });
const STAFF_LAST = { scan2plate_last_restaurant_id: "RST_VENDOR" };

test("a super admin following the link gets the business in the link", async () => {
  // The reported bug, exactly: a stale vendor id in localStorage, a Hotel in
  // the link. The link must win.
  await withBrowser({
    search: "?restaurantId=RST_RAJ",
    storage: { ...STAFF_LAST, scan2serve_super_admin: SUPER }
  }, ({ resolveActiveRestaurantId }) => {
    const result = resolveActiveRestaurantId("");
    assert.equal(result.restaurantId, "RST_RAJ");
    assert.equal(result.fromSuperAdminLink, true);
  });
});

test("two different rows open two different businesses", async () => {
  // Before the fix both resolved to whatever localStorage held, which is why
  // every row appeared to open the same business.
  const ids = [];
  for (const id of ["RST_RAJ", "RST005"]) {
    await withBrowser({
      search: `?restaurantId=${id}`,
      storage: { ...STAFF_LAST, scan2serve_super_admin: SUPER }
    }, ({ resolveActiveRestaurantId }) => ids.push(resolveActiveRestaurantId("").restaurantId));
  }
  assert.deepEqual(ids, ["RST_RAJ", "RST005"]);
});

test("an owner stays on their own business even if the URL says otherwise", async () => {
  // A link must never be able to move a signed-in owner or staff member.
  await withBrowser({
    search: "?restaurantId=RST005",
    storage: { scan2plate_last_restaurant_id: "RST_MINE" }
  }, ({ resolveActiveRestaurantId }) => {
    const result = resolveActiveRestaurantId("RST_MINE");
    assert.equal(result.restaurantId, "RST_MINE");
    assert.equal(result.fromSuperAdminLink, false);
  });
});

test("a super admin who is ALSO signed in as staff keeps their own business", async () => {
  // Both sessions present. The staff pin is the stricter answer, so it wins.
  await withBrowser({
    search: "?restaurantId=RST005",
    storage: { scan2serve_super_admin: SUPER }
  }, ({ resolveActiveRestaurantId }) => {
    assert.equal(resolveActiveRestaurantId("RST_MINE").restaurantId, "RST_MINE");
  });
});

test("no link and no session still falls back to the last business, as before", async () => {
  await withBrowser({ search: "", storage: STAFF_LAST }, ({ resolveActiveRestaurantId }) => {
    assert.equal(resolveActiveRestaurantId("").restaurantId, "RST_VENDOR");
  });
});

test("a link with no session at all is still tried — Firestore decides, not this", async () => {
  // The param is not a permission. It only says which document to ASK for;
  // the rules check the real uid. A dashboard that cannot read anything is
  // the correct outcome, and is better than a blank page with no id.
  await withBrowser({ search: "?restaurantId=RST005", storage: {} }, ({ resolveActiveRestaurantId }) => {
    const result = resolveActiveRestaurantId("");
    assert.equal(result.restaurantId, "RST005");
    assert.equal(result.fromSuperAdminLink, false, "not a super admin, so nothing special is granted");
  });
});

test("a forged or broken super admin entry grants nothing", async () => {
  for (const raw of ["not json", JSON.stringify({ role: "staff" }), JSON.stringify(null), ""]) {
    await withBrowser({
      search: "?restaurantId=RST005",
      storage: { scan2serve_super_admin: raw, scan2plate_last_restaurant_id: "RST_MINE" }
    }, ({ isSuperAdminSession, resolveActiveRestaurantId }) => {
      assert.equal(isSuperAdminSession(), false, `"${raw}" must not read as a super admin`);
      assert.equal(resolveActiveRestaurantId("").restaurantId, "RST_MINE");
    });
  }
});

test("a browser with no localStorage at all does not throw", async () => {
  globalThis.window = { location: { search: "?restaurantId=RST005" } };
  globalThis.localStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); }
  };
  try {
    const { isSuperAdminSession } = await import(`${ROOT}/public/js/common.js?case=${Math.random()}`);
    assert.equal(isSuperAdminSession(), false);
  } finally {
    delete globalThis.window;
    delete globalThis.localStorage;
  }
});

/* ---------------------------------------------------------
   The wiring
--------------------------------------------------------- */

test("both Open Admin buttons put the business id in the link", () => {
  assert.match(
    JS("super-admin-dashboard.js"),
    /\?restaurantId=\$\{encodeURIComponent\(business\.id\)\}/,
    "the console's Open Admin must name the business it opens"
  );
  assert.match(
    JS("restaurant-list.js"),
    /admin-dashboard\.html\?restaurantId=\$\{encodeURIComponent\(btn\.dataset\.admin\)\}/,
    "the business list's Open Admin dropped the id its own QR button already passed"
  );
});

test("the panels resolve their business through the shared helper", () => {
  for (const file of ["admin.js", "business-panel.js"]) {
    assert.match(JS(file), /resolveActiveRestaurantId/, `${file} must not read localStorage directly`);
  }
  assert.doesNotMatch(
    JS("business-panel.js"),
    /const restaurantId = session\.restaurantId \|\| localStorage/,
    "the old localStorage-only resolution must be gone"
  );
});

test("a business a super admin merely inspected is not remembered as this browser's own", () => {
  // Writing it would leave the OWNER of this browser pointed at whichever
  // business the super admin last looked at — the same class of fault.
  assert.match(
    JS("admin.js"),
    /if \(!fromSuperAdminLink\) \{\s*\n\s*localStorage\.setItem\("restaurantId", restaurantId\);\s*\n\s*localStorage\.setItem\("scan2plate_last_restaurant_id", restaurantId\);/,
    "the last-business pin must be skipped for a super admin link"
  );
});

/* ---------------------------------------------------------
   Terminology
--------------------------------------------------------- */

test("the businesses table header matches the cells beneath it", () => {
  const html = readFileSync(`${ROOT}/public/super-admin-dashboard.html`, "utf8");
  const thead = html.match(/<thead><tr>((?:<th>[^<]*<\/th>)+)<\/tr><\/thead><tbody id="restaurantRows">/);
  assert.ok(thead, "the businesses table must have a header row");
  const headers = [...thead[1].matchAll(/<th>([^<]*)<\/th>/g)].map(m => m[1]);
  // renderRestaurants emits: id, name, owner email, plan, status, expiry,
  // business type, actions. The header used to read "Orders" and "Revenue"
  // over the last two, which describe neither.
  assert.deepEqual(headers, [
    "Business ID", "Business Name", "Owner Email", "Plan",
    "Status", "Expiry Date", "Business Type", "Actions"
  ]);
});

test("terminology never rewrites Restaurant where it is a business TYPE", () => {
  const source = JS("super-admin-dashboard.js");
  const list = source.match(/const replacements = \[(.*?)\];/s);
  assert.ok(list, "the replacement list must be findable");
  // A bare /Restaurant/ or /restaurant/ rule would relabel the Business Type
  // column and the type picker, making the type it is naming meaningless.
  assert.doesNotMatch(list[1], /\[\/Restaurant\/g/, "a bare Restaurant rule would rewrite the type itself");
  assert.doesNotMatch(list[1], /\[\/restaurant\/g/, "same for the lowercase form");
  assert.match(list[1], /Restaurant ID/, "the phrases the console actually shows are still covered");
});
