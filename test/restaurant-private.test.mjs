import test from "node:test";
import assert from "node:assert/strict";
import {
  PRIVATE_PROFILE_FIELDS, splitRestaurantPayload, mergeRestaurantProfile,
  ownerEmailOf, ownerNameOf, needsPrivateMigration
} from "../public/js/restaurant-private.js";

const legacy = {
  restaurantName: "Old Monk Cafe", adminUid: "uid-1", phone: "+919876543210",
  adminEmail: "owner@example.com", email: "owner@example.com", ownerName: "A Person",
  status: "active", businessType: "cafe"
};

/* ---------------- what moves and what does not ---------------- */

test("only the login identity and the owner's name move", () => {
  assert.deepEqual(PRIVATE_PROFILE_FIELDS, ["adminEmail", "email", "ownerName"]);
});

test("phone stays public — the tracking page renders a Call Staff button from it", () => {
  const { publicFields, privateFields } = splitRestaurantPayload(legacy);
  assert.equal(publicFields.phone, "+919876543210");
  assert.equal(privateFields.phone, undefined);
});

test("adminUid stays public — firestore.rules reads it to decide ownership", () => {
  const { publicFields, privateFields } = splitRestaurantPayload(legacy);
  assert.equal(publicFields.adminUid, "uid-1");
  assert.equal(privateFields.adminUid, undefined);
});

test("the login e-mail never lands in the public half", () => {
  const { publicFields, privateFields } = splitRestaurantPayload(legacy);
  assert.equal(publicFields.adminEmail, undefined, "adminEmail must not stay public");
  assert.equal(publicFields.email, undefined, "email must not stay public");
  assert.equal(publicFields.ownerName, undefined, "ownerName must not stay public");
  assert.equal(privateFields.adminEmail, "owner@example.com");
  assert.equal(privateFields.email, "owner@example.com");
  assert.equal(privateFields.ownerName, "A Person");
});

test("the discovery fields the public site needs are all still public", () => {
  const { publicFields } = splitRestaurantPayload(legacy);
  assert.equal(publicFields.restaurantName, "Old Monk Cafe");
  assert.equal(publicFields.status, "active");
  assert.equal(publicFields.businessType, "cafe");
});

test("splitting an empty payload is safe", () => {
  assert.deepEqual(splitRestaurantPayload(), { publicFields: {}, privateFields: {} });
  assert.deepEqual(splitRestaurantPayload(null), { publicFields: {}, privateFields: {} });
});

test("a payload with no private fields produces an empty private half", () => {
  const { publicFields, privateFields } = splitRestaurantPayload({ taxPercent: 5 });
  assert.deepEqual(privateFields, {});
  assert.deepEqual(publicFields, { taxPercent: 5 });
});

/* ---------------- reading it back ---------------- */

test("an authorised reader sees the private profile laid over the public doc", () => {
  const root = { restaurantName: "Old Monk Cafe", adminUid: "uid-1" };
  const priv = { adminEmail: "owner@example.com", ownerName: "A Person" };
  const merged = mergeRestaurantProfile(root, priv);
  assert.equal(merged.adminEmail, "owner@example.com");
  assert.equal(merged.ownerName, "A Person");
  assert.equal(merged.restaurantName, "Old Monk Cafe", "public fields survive the merge");
});

test("with no private profile the reader just gets the public document", () => {
  const merged = mergeRestaurantProfile({ restaurantName: "X" }, null);
  assert.deepEqual(merged, { restaurantName: "X" });
});

test("a blank private field does not wipe a value that is still in the root", () => {
  const merged = mergeRestaurantProfile({ adminEmail: "still@here.com" }, { adminEmail: "   " });
  assert.equal(merged.adminEmail, "still@here.com");
});

test("merging never mutates the caller's objects", () => {
  const root = { restaurantName: "X" };
  const priv = { adminEmail: "a@b.com" };
  mergeRestaurantProfile(root, priv);
  assert.equal(root.adminEmail, undefined, "the root object must be left alone");
});

/* ---------------- both shapes must read correctly ---------------- */

test("a restaurant created before the split still resolves its owner e-mail", () => {
  assert.equal(ownerEmailOf(legacy), "owner@example.com");
  assert.equal(ownerNameOf(legacy), "A Person");
});

test("a migrated restaurant resolves its owner e-mail from the private profile", () => {
  const root = { restaurantName: "Old Monk Cafe", adminUid: "uid-1" };
  const priv = { adminEmail: "owner@example.com", ownerName: "A Person" };
  assert.equal(ownerEmailOf(root, priv), "owner@example.com");
  assert.equal(ownerNameOf(root, priv), "A Person");
});

test("a migrated restaurant read WITHOUT its private profile leaks nothing", () => {
  const root = { restaurantName: "Old Monk Cafe", adminUid: "uid-1" };
  assert.equal(ownerEmailOf(root), "", "there must be no e-mail left to read in the public doc");
  assert.equal(ownerNameOf(root), "");
});

test("ownerEmail wins when a record carries that older field too", () => {
  assert.equal(ownerEmailOf({ ownerEmail: "first@x.com", adminEmail: "second@x.com" }), "first@x.com");
});

test("a missing owner e-mail is an empty string, not undefined or a dash", () => {
  assert.equal(ownerEmailOf({}), "");
  assert.equal(ownerEmailOf(), "");
});

/* ---------------- the migration flag ---------------- */

test("a root document still holding private fields is flagged for migration", () => {
  assert.equal(needsPrivateMigration(legacy), true);
});

test("an already-migrated root document is not flagged", () => {
  assert.equal(needsPrivateMigration({ restaurantName: "X", adminUid: "uid-1", phone: "+91..." }), false);
});

test("blank leftovers do not count as needing migration", () => {
  assert.equal(needsPrivateMigration({ adminEmail: "", email: null, ownerName: "   " }), false);
});
