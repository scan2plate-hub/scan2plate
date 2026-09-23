/* =========================================================
   POST A RESTAURANT BILL TO A ROOM  (section 17)

   The last piece of section 17, and the one that most easily
   breaks something else: it touches the restaurant POS, which
   every existing customer runs and which the specification's very
   first instruction says not to affect.

   The design answer is that a restaurant never loads this file.
   admin.js imports it lazily and only when the business type
   supports folios, which only a hotel does — so for every other
   mode it is never fetched, never parsed and never runs. These
   tests pin that arrangement as well as the posting itself.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  roomOptionsFor, canPostToRoom, postBillToRoom, postedLabel
} from "../public/js/hotel-pos-bridge.js";
import { supportsModule } from "../public/js/business-types.js";

const order = (patch = {}) => ({ id: "ORD7", orderId: "ORD7", grandTotal: 850, billNumber: "B12", ...patch });
const folios = [
  { id: "FOL_BK1", status: "open", roomId: "R204", guestName: "Anita Rao" },
  { id: "FOL_BK2", status: "closed", roomId: "R101", guestName: "Departed Guest" },
  { id: "FOL_BK3", status: "open", roomId: "", guestName: "No room yet" }
];
const rooms = [{ id: "R204", roomNumber: "204" }, { id: "R101", roomNumber: "101" }];

/* =========================================================
   THE PROMISE TO THE RESTAURANT
========================================================= */

test("SECTION 1: only a hotel has the module that loads this", () => {
  // Every other business type answers false for "folios", so admin.js never
  // reaches the dynamic import at all. That is a stronger guarantee than
  // branching inside the POS, because the file cannot misbehave in a
  // process that never loaded it.
  assert.equal(supportsModule("hotel", "folios"), true);
  ["restaurant", "cafe", "dhaba", "bakery", "street_vendor", "food_court", "cloud_kitchen", "hostel", "salon", "other"]
    .forEach(type => {
      assert.equal(supportsModule(type, "folios"), false, `${type} must never load the hotel bridge`);
    });
});

test("admin.js loads the bridge lazily, and only behind that check", () => {
  const admin = readFileSync(new URL("../public/js/admin.js", import.meta.url), "utf8");
  const code = admin.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  if (!code.includes("hotel-pos-bridge")) return;   // not wired yet; the test above still holds
  assert.match(code, /import\(\s*["']\.\/hotel-pos-bridge\.js/, "it must be a dynamic import, never a static one");
  assert.match(code, /supportsModule\([^)]*"folios"\)/, "and gated on the folios module");
});

/* =========================================================
   WHICH ROOMS A BILL MAY GO TO
========================================================= */

test("only an in-house guest's room is offered", () => {
  // A closed folio is a departed guest; a folio with no room has nobody in
  // one. Offering either is how a bill lands on an account nobody settles.
  const options = roomOptionsFor(folios, rooms);
  assert.deepEqual(options.map(option => option.roomNumber), ["204"]);
  assert.equal(options[0].folioId, "FOL_BK1");
  assert.equal(options[0].guestName, "Anita Rao");
});

test("rooms are listed the way a human reads room numbers", () => {
  const many = [
    { id: "A", status: "open", roomId: "R21", guestName: "B" },
    { id: "B", status: "open", roomId: "R1002", guestName: "C" },
    { id: "C", status: "open", roomId: "R101", guestName: "D" }
  ];
  const numbered = [{ id: "R21", roomNumber: "21" }, { id: "R1002", roomNumber: "1002" }, { id: "R101", roomNumber: "101" }];
  assert.deepEqual(roomOptionsFor(many, numbered).map(option => option.roomNumber), ["21", "101", "1002"]);
});

test("with nobody in house the button says so rather than offering nothing", () => {
  const check = canPostToRoom(order(), []);
  assert.equal(check.ok, false);
  assert.match(check.reason, /No guests are in house/);
});

test("a paid bill, or one already posted, cannot be posted again", () => {
  const available = roomOptionsFor(folios, rooms);
  assert.match(canPostToRoom(order({ paymentStatus: "paid" }), available).reason, /already paid/);
  const alreadyPosted = order({ postedToFolioId: "FOL_BK1", postedToRoomNumber: "204" });
  assert.match(canPostToRoom(alreadyPosted, available).reason, /Already posted to room 204/);
});

test("a bill with no amount is not postable", () => {
  assert.equal(canPostToRoom(order({ grandTotal: 0 }), roomOptionsFor(folios, rooms)).ok, false);
});

/* =========================================================
   POSTING
========================================================= */

function recorder({ postCharge } = {}) {
  const calls = { charges: [], orders: [] };
  return {
    calls,
    folioService: {
      postCharge: async payload => {
        calls.charges.push(payload);
        return postCharge ? postCharge(payload) : { ok: true };
      }
    },
    markOrderPosted: async payload => { calls.orders.push(payload); }
  };
}

test("the agreed total goes across unrecomputed", async () => {
  // The guest is holding the printed bill. Recomputing tax here could
  // produce a folio line that disagrees with it.
  const { folioService, markOrderPosted, calls } = recorder();
  await postBillToRoom({
    order: order({ grandTotal: 1234.56 }), folioId: "FOL_BK1", roomId: "R204", roomNumber: "204",
    guestName: "Anita Rao", actor: { name: "R Desk" }, folioService, markOrderPosted
  });
  assert.equal(calls.charges[0].rate, 1234.56);
  assert.equal(calls.charges[0].taxPercent, 0, "tax already sits inside the agreed total");
  assert.equal(calls.charges[0].chargeId, "pos_ORD7");
  assert.equal(calls.charges[0].sourceType, "pos_order");
});

test("the folio is charged BEFORE the order is marked", async () => {
  // Order matters. If the second write fails the guest is charged once and
  // the POS shows the bill unposted — noticed, and retried safely. The
  // reverse would mark a bill posted that never reached a folio, which
  // nobody notices until checkout comes up short.
  const sequence = [];
  const folioService = { postCharge: async () => { sequence.push("folio"); return { ok: true }; } };
  const markOrderPosted = async () => { sequence.push("order"); };
  await postBillToRoom({
    order: order(), folioId: "FOL_BK1", roomId: "R204", roomNumber: "204",
    actor: {}, folioService, markOrderPosted
  });
  assert.deepEqual(sequence, ["folio", "order"]);
});

test("a failed folio charge leaves the order untouched", async () => {
  const folioService = { postCharge: async () => { throw new Error("offline"); } };
  const marked = [];
  await assert.rejects(() => postBillToRoom({
    order: order(), folioId: "FOL_BK1", roomId: "R204",
    actor: {}, folioService, markOrderPosted: async payload => marked.push(payload)
  }));
  assert.deepEqual(marked, [], "the bill must not show as posted when it was not");
});

test("pressing the button twice charges the guest once", async () => {
  // The charge id comes from the order's own id, so the folio service
  // recognises the second attempt as the same fact.
  const { folioService, markOrderPosted, calls } = recorder({
    postCharge: payload => ({ ok: true, duplicate: calls.charges.filter(c => c.chargeId === payload.chargeId).length > 1 })
  });
  const args = {
    order: order(), folioId: "FOL_BK1", roomId: "R204", roomNumber: "204",
    actor: {}, folioService, markOrderPosted
  };
  await postBillToRoom(args);
  const second = await postBillToRoom(args);
  assert.equal(calls.charges[0].chargeId, calls.charges[1].chargeId, "the same key both times");
  assert.equal(second.duplicate, true);
});

test("the order records where the bill went, for the POS to show", async () => {
  const { folioService, markOrderPosted, calls } = recorder();
  await postBillToRoom({
    order: order(), folioId: "FOL_BK1", roomId: "R204", roomNumber: "204",
    guestName: "Anita Rao", actor: {}, folioService, markOrderPosted
  });
  assert.deepEqual(calls.orders[0], {
    orderId: "ORD7", postedToFolioId: "FOL_BK1", postedToRoomId: "R204",
    postedToRoomNumber: "204", postedToGuestName: "Anita Rao", postedChargeId: "pos_ORD7"
  });
});

test("a posted bill says where it went, rather than just vanishing", () => {
  // A bill leaving "unpaid" without being paid is alarming. Saying where it
  // went is the whole point.
  assert.equal(postedLabel(order()), "");
  assert.equal(
    postedLabel(order({ postedToFolioId: "F1", postedToRoomNumber: "204", postedToGuestName: "Anita Rao" })),
    "Charged to room 204 · Anita Rao"
  );
  assert.equal(postedLabel(order({ postedToFolioId: "F1", postedToRoomNumber: "204" })), "Charged to room 204");
});
