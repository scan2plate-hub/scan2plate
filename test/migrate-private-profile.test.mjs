import test from "node:test";
import assert from "node:assert/strict";
import { migratePrivateProfiles } from "../scripts/migrate-private-profile.mjs";

const DELETE = Symbol("delete");
const FieldValue = { delete: () => DELETE, serverTimestamp: () => "TS" };

function fakeDb(restaurants, { failOnUpdate = null, failOnSet = null } = {}) {
  const privates = {};
  const db = {
    collection: () => ({
      get: async () => ({
        docs: Object.entries(restaurants).map(([id, data]) => ({ id, data: () => data }))
      })
    }),
    doc: path => ({
      set: async payload => {
        if (failOnSet && path.includes(failOnSet)) throw new Error("set failed");
        privates[path] = { ...(privates[path] || {}), ...payload };
      },
      update: async payload => {
        const id = path.split("/")[1];
        if (failOnUpdate && id === failOnUpdate) throw new Error("update failed");
        for (const [key, value] of Object.entries(payload)) if (value === DELETE) delete restaurants[id][key];
      }
    })
  };
  return { db, privates, restaurants };
}

const legacyRestaurant = () => ({
  restaurantName: "Old Monk Cafe", adminUid: "uid-1", phone: "+919876543210",
  adminEmail: "owner@example.com", email: "owner@example.com", ownerName: "A Person", status: "active"
});

/* ---------------- dry run ---------------- */

test("a dry run changes nothing at all", async () => {
  const { db, privates, restaurants } = fakeDb({ RST006: legacyRestaurant() });
  const result = await migratePrivateProfiles({ db, FieldValue, apply: false });
  assert.deepEqual(result.moved, ["RST006"], "it still reports what it would do");
  assert.deepEqual(privates, {}, "nothing written");
  assert.equal(restaurants.RST006.adminEmail, "owner@example.com", "nothing deleted");
});

/* ---------------- the migration ---------------- */

test("the login e-mail and owner name leave the public document", async () => {
  const { db, privates, restaurants } = fakeDb({ RST006: legacyRestaurant() });
  await migratePrivateProfiles({ db, FieldValue, apply: true });
  assert.equal(restaurants.RST006.adminEmail, undefined, "adminEmail must be gone from the public doc");
  assert.equal(restaurants.RST006.email, undefined);
  assert.equal(restaurants.RST006.ownerName, undefined);
  const priv = privates["restaurants/RST006/private/profile"];
  assert.equal(priv.adminEmail, "owner@example.com", "and must be safe in private/profile");
  assert.equal(priv.ownerName, "A Person");
});

test("phone and adminUid are deliberately left in the public document", async () => {
  const { db, restaurants } = fakeDb({ RST006: legacyRestaurant() });
  await migratePrivateProfiles({ db, FieldValue, apply: true });
  assert.equal(restaurants.RST006.phone, "+919876543210", "the tracking page's Call Staff button needs this");
  assert.equal(restaurants.RST006.adminUid, "uid-1", "firestore.rules reads this to decide ownership");
});

test("the public fields the ordering site needs are untouched", async () => {
  const { db, restaurants } = fakeDb({ RST006: legacyRestaurant() });
  await migratePrivateProfiles({ db, FieldValue, apply: true });
  assert.equal(restaurants.RST006.restaurantName, "Old Monk Cafe");
  assert.equal(restaurants.RST006.status, "active");
});

/* ---------------- idempotence ---------------- */

test("running it twice is harmless", async () => {
  const { db, restaurants, privates } = fakeDb({ RST006: legacyRestaurant() });
  await migratePrivateProfiles({ db, FieldValue, apply: true });
  const second = await migratePrivateProfiles({ db, FieldValue, apply: true });
  assert.deepEqual(second.moved, [], "the second run has nothing to do");
  assert.deepEqual(second.skipped, ["RST006"]);
  assert.equal(privates["restaurants/RST006/private/profile"].adminEmail, "owner@example.com");
  assert.equal(restaurants.RST006.restaurantName, "Old Monk Cafe");
});

test("an already-migrated restaurant is skipped, not rewritten", async () => {
  const { db, privates } = fakeDb({ RST007: { restaurantName: "X", adminUid: "u", phone: "+91" } });
  const result = await migratePrivateProfiles({ db, FieldValue, apply: true });
  assert.deepEqual(result.skipped, ["RST007"]);
  assert.deepEqual(privates, {}, "no private doc is created for a restaurant with nothing to move");
});

test("blank leftovers are not treated as data to move", async () => {
  const { db, privates } = fakeDb({ RST008: { restaurantName: "X", adminEmail: "", ownerName: "   ", email: null } });
  const result = await migratePrivateProfiles({ db, FieldValue, apply: true });
  assert.deepEqual(result.skipped, ["RST008"]);
  assert.deepEqual(privates, {});
});

/* ---------------- interrupted runs ---------------- */

test("if the delete fails, the data is still safe in private/profile", async () => {
  const { db, privates, restaurants } = fakeDb({ RST006: legacyRestaurant() }, { failOnUpdate: "RST006" });
  const result = await migratePrivateProfiles({ db, FieldValue, apply: true });
  assert.equal(result.failed.length, 1);
  assert.equal(privates["restaurants/RST006/private/profile"].adminEmail, "owner@example.com", "the copy happened first");
  assert.equal(restaurants.RST006.adminEmail, "owner@example.com", "and the public doc is unchanged, so a rerun fixes it");
});

test("if the copy fails, nothing is deleted from the public document", async () => {
  const { db, restaurants } = fakeDb({ RST006: legacyRestaurant() }, { failOnSet: "private/profile" });
  const result = await migratePrivateProfiles({ db, FieldValue, apply: true });
  assert.equal(result.failed.length, 1);
  assert.equal(restaurants.RST006.adminEmail, "owner@example.com", "no data may be lost");
  assert.equal(restaurants.RST006.ownerName, "A Person");
});

test("one restaurant failing does not stop the others", async () => {
  const { db, restaurants } = fakeDb(
    { RST006: legacyRestaurant(), RST009: legacyRestaurant() },
    { failOnUpdate: "RST006" }
  );
  const result = await migratePrivateProfiles({ db, FieldValue, apply: true });
  assert.equal(result.failed.length, 1);
  assert.deepEqual(result.moved, ["RST009"]);
  assert.equal(restaurants.RST009.adminEmail, undefined, "the healthy one still migrated");
});

test("an empty collection is not an error", async () => {
  const { db } = fakeDb({});
  const result = await migratePrivateProfiles({ db, FieldValue, apply: true });
  assert.deepEqual(result, { moved: [], skipped: [], failed: [] });
});
