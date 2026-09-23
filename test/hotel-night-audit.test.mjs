/* =========================================================
   NIGHT AUDIT AND CASHIER SHIFTS

   Section 25 contains the single most important negative
   requirement in the whole specification:

     "Do NOT automatically close the day based purely on
      frontend time."

   Closing a day does irreversible things — it charges rooms,
   releases inventory, and writes a record that can never be
   edited. Doing any of it because a browser tab was open past
   midnight, in the wrong timezone, on a laptop somebody left on,
   is how a hotel wakes up to a day it cannot unwind.

   So most of this file is about what the audit REFUSES to do,
   and section 26's cash variance — which must never be quietly
   rounded away, because it is the only signal that something is
   wrong.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createNightAuditService, AuditError, pendingArrivals, overdueDepartures,
  stayoverCharges, outstandingFolios, auditReadiness, auditTotals, expectedAuditDate
} from "../public/js/hotel-night-audit.js";
import {
  createCashierService, CashierError, SHIFT_STATUS, nextShiftStatus,
  expectedCash, reconcileShift, canCloseShift, describeVariance, isCashPayment
} from "../public/js/hotel-cashier.js";
import { RESERVATION_STATUS, ROOM_STATUS } from "../public/js/hotel-core.js";

function makeFirestore() {
  const store = new Map();
  let autoId = 0;
  const firestore = {
    doc: (dbOrRef, ...segments) => (segments.length
      ? { path: segments.filter(Boolean).join("/") }
      : { path: `${dbOrRef.path}/auto${autoId += 1}` }),
    collection: (db, ...segments) => ({ path: segments.join("/") }),
    serverTimestamp: () => "TS",
    writeBatch() {
      const writes = [];
      return {
        set(ref, data) { writes.push({ path: ref.path, data }); },
        async commit() { writes.forEach(write => store.set(write.path, { ...(store.get(write.path) || {}), ...write.data })); }
      };
    },
    async runTransaction(db, body) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const held = store.get(ref.path);
          return { exists: () => Boolean(held), data: () => (held ? { ...held } : undefined) };
        },
        set(ref, data, options) { writes.push({ path: ref.path, data, merge: options?.merge }); },
        delete(ref) { writes.push({ path: ref.path, remove: true }); }
      };
      const result = await body(transaction);
      writes.forEach(write => {
        if (write.remove) store.delete(write.path);
        else store.set(write.path, write.merge ? { ...(store.get(write.path) || {}), ...write.data } : write.data);
      });
      return result;
    }
  };
  return { firestore, store };
}

const db = {};
const RID = "RST006";
const TODAY = "2026-10-05";
const manager = { uid: "m1", name: "M Anager", role: "manager" };
const reception = { uid: "r1", name: "R Desk", role: "receptionist" };

const booking = (id, patch = {}) => ({
  id, bookingId: `BK${id}`, roomId: "101", guestName: `Guest ${id}`,
  checkIn: "2026-10-04", checkOut: "2026-10-07",
  status: RESERVATION_STATUS.CHECKED_IN, roomTotal: 7500, ...patch
});
const room = (id, patch = {}) => ({ id, roomNumber: id, status: ROOM_STATUS.AVAILABLE, ...patch });

const fresh = () => {
  const { firestore, store } = makeFirestore();
  return {
    audit: createNightAuditService({ db, restaurantId: RID, firestore }),
    cashier: createCashierService({ db, restaurantId: RID, firestore }),
    store
  };
};
const audits = store => [...store.entries()].filter(([path]) => path.startsWith("hotelAuditLogs/")).map(([, data]) => data);

/* =========================================================
   WHAT THE DAY IS CARRYING
========================================================= */

test("a booking due to arrive and not checked in is surfaced, not voided", () => {
  // Rule 10 releases a no-show's room — but DECIDING it is a no-show is a
  // human call. A guest on a delayed flight is not one who never intended
  // to come, and the software cannot tell them apart.
  const rows = pendingArrivals([
    booking("a", { status: RESERVATION_STATUS.CONFIRMED, checkIn: TODAY }),
    booking("b", { status: RESERVATION_STATUS.CONFIRMED, checkIn: "2026-10-03" }),
    booking("c", { status: RESERVATION_STATUS.CONFIRMED, checkIn: "2026-10-09" }),
    booking("d", { status: RESERVATION_STATUS.CHECKED_IN, checkIn: TODAY }),
    booking("e", { status: RESERVATION_STATUS.CANCELLED, checkIn: TODAY })
  ], TODAY);
  assert.deepEqual(rows.map(row => row.id), ["a", "b"], "today's and an earlier missed arrival");
});

test("a guest past their checkout date is surfaced, never checked out automatically", () => {
  // One reading bills a night that was not agreed; the other loses a night
  // that was. Neither is the software's to choose.
  const rows = overdueDepartures([
    booking("a", { checkOut: TODAY }),
    booking("b", { checkOut: "2026-10-03" }),
    booking("c", { checkOut: "2026-10-09" }),
    booking("d", { checkOut: TODAY, status: RESERVATION_STATUS.CHECKED_OUT })
  ], TODAY);
  assert.deepEqual(rows.map(row => row.id), ["a", "b"]);
});

test("tonight's room charge is due from guests staying over, not those leaving", () => {
  // The checkout day is not a night. A guest leaving tomorrow is charged
  // tonight; a guest leaving today is not.
  const charges = stayoverCharges([
    booking("staying", { checkIn: "2026-10-04", checkOut: "2026-10-07" }),
    booking("leaving", { checkIn: "2026-10-04", checkOut: TODAY }),
    booking("future", { checkIn: "2026-10-09", checkOut: "2026-10-11", status: RESERVATION_STATUS.CONFIRMED })
  ], TODAY);
  assert.deepEqual(charges.map(charge => charge.reservationId), ["staying"]);
  assert.equal(charges[0].stayDate, TODAY);
});

test("the night is charged at the rate agreed, not tonight's price", () => {
  const charges = stayoverCharges([booking("a", {
    checkIn: "2026-10-04", checkOut: "2026-10-07",
    nightlyRates: [
      { stayDate: "2026-10-04", amount: 2000 },
      { stayDate: TODAY, amount: 2500 },
      { stayDate: "2026-10-06", amount: 4000 }
    ]
  })], TODAY);
  assert.equal(charges[0].amount, 2500, "a stay spanning a rate change bills what was quoted");
});

test("with no per-night breakdown the stay total is spread evenly", () => {
  const charges = stayoverCharges([booking("a", { roomTotal: 7500, checkIn: "2026-10-04", checkOut: "2026-10-07" })], TODAY);
  assert.equal(charges[0].amount, 2500, "7500 over three nights");
});

test("a room charge is keyed so it can never post twice", () => {
  // The same key check-in uses. Running the audit twice posts once.
  const charges = stayoverCharges([booking("BK9")], TODAY);
  assert.equal(charges[0].chargeId, `room_BK9_${TODAY}`);
});

/* =========================================================
   THE PRE-AUDIT CHECK — what blocks and what merely warns
========================================================= */

const readyInput = (patch = {}) => ({
  businessDate: TODAY,
  reservations: [booking("a")],
  folios: [],
  shifts: [{ id: "s1", status: SHIFT_STATUS.CLOSED }],
  rooms: [room("101"), room("102")],
  ...patch
});

test("an open cashier shift BLOCKS the close", () => {
  // The day's cash would be unreconciled, so the audit's own cash figure
  // would be a guess. That corrupts the books; it is not a judgement call.
  const readiness = auditReadiness(readyInput({ shifts: [{ id: "s1", status: SHIFT_STATUS.ACTIVE }] }));
  assert.equal(readiness.canRun, false);
  assert.equal(readiness.blocking[0].id, "open_shifts");
  assert.match(readiness.blocking[0].label, /still open/);
});

test("unpaid folios and missed arrivals WARN but do not block", () => {
  // A guest still in the hotel owing money is normal. A booking that did not
  // arrive is somebody's decision. Blocking on either means a hotel that can
  // never close its day.
  const readiness = auditReadiness(readyInput({
    folios: [{ id: "f1", status: "open", balance: 3000 }],
    reservations: [booking("a"), booking("b", { status: RESERVATION_STATUS.CONFIRMED, checkIn: TODAY })]
  }));
  assert.equal(readiness.canRun, true);
  assert.deepEqual(readiness.warnings.map(warning => warning.id).sort(), ["outstanding", "pending_arrivals"]);
});

test("a property with no business date cannot close at all", () => {
  const readiness = auditReadiness(readyInput({ businessDate: "" }));
  assert.equal(readiness.canRun, false);
  assert.equal(readiness.blocking[0].id, "no_date");
});

test("the check counts what the close will actually do", () => {
  const readiness = auditReadiness(readyInput({
    reservations: [booking("a"), booking("b", { roomId: "102", roomTotal: 3000, checkIn: "2026-10-04", checkOut: "2026-10-06" })]
  }));
  assert.equal(readiness.counts.roomChargesDue, 2);
  assert.equal(readiness.counts.roomChargeTotal, 2500 + 1500);
});

/* =========================================================
   THE DAY'S NUMBERS
========================================================= */

test("collections are split by method, because they reconcile in different places", () => {
  // Cash reconciles against a drawer, a card against a gateway. One
  // "collected" figure hides which of them is wrong when the day does not
  // balance.
  const totals = auditTotals({
    businessDate: TODAY,
    rooms: [room("101"), room("102")],
    reservations: [booking("a", { status: RESERVATION_STATUS.CHECKED_OUT, checkIn: "2026-10-04", checkOut: TODAY, roomTotal: 2500 })],
    folioItems: [
      { kind: "room", total: 2500, businessDate: TODAY },
      { kind: "food", total: 850, businessDate: TODAY },
      { kind: "room", total: 9999, businessDate: "2026-10-04" }
    ],
    payments: [
      { method: "cash", amount: 2000, status: "success", businessDate: TODAY },
      { method: "card", amount: 1350, status: "success", businessDate: TODAY },
      { method: "cash", amount: 500, status: "failed", businessDate: TODAY },
      { method: "cash", amount: 5000, status: "success", businessDate: "2026-10-04" }
    ]
  });
  assert.equal(totals.revenue.byKind.room, 2500, "yesterday's revenue is not counted today");
  assert.equal(totals.revenue.total, 3350);
  assert.equal(totals.collection.byMethod.cash, 2000, "a failed payment is not collection");
  assert.equal(totals.collection.byMethod.card, 1350);
  assert.equal(totals.collection.collected, 3350);
});

test("a refund reduces the method it went out on", () => {
  const totals = auditTotals({
    businessDate: TODAY,
    payments: [
      { method: "cash", amount: 5000, status: "success", businessDate: TODAY },
      { method: "cash", amount: 1000, status: "success", kind: "refund", businessDate: TODAY }
    ]
  });
  assert.equal(totals.collection.collected, 5000, "what was taken stays visible");
  assert.equal(totals.collection.refunded, 1000);
  assert.equal(totals.collection.net, 4000);
  assert.equal(totals.collection.byMethod.cash, 4000);
});

test("occupancy for the closing day is one night, not the whole stay", () => {
  const totals = auditTotals({
    businessDate: TODAY,
    rooms: [room("101"), room("102"), room("103"), room("104")],
    reservations: [booking("a", { checkIn: "2026-10-04", checkOut: "2026-10-07", roomTotal: 7500 })]
  });
  assert.equal(totals.availableRoomNights, 4, "four rooms, one night");
  assert.equal(totals.roomNightsSold, 1);
  assert.equal(totals.occupancy, 25);
});

/* =========================================================
   RULE 20 / SECTION 25 — THE DAY IS NOT CLOSED BY A CLOCK
========================================================= */

test("SECTION 25: the audit never runs on frontend time", async () => {
  // The service exposes no scheduler, no timer and no automatic trigger.
  // Closing the day is something a manager does, on purpose.
  const source = await import("node:fs").then(fs =>
    fs.readFileSync(new URL("../public/js/hotel-night-audit.js", import.meta.url), "utf8"));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  ["setInterval", "setTimeout", "requestIdleCallback"].forEach(scheduler => {
    assert.ok(!code.includes(scheduler), `the audit must not use ${scheduler}`);
  });
  assert.ok(!code.includes("new Date().getHours"), "nor decide the day from a browser clock");
});

test("the next day to close follows the last one closed, in order", () => {
  // Each day's figures depend on the one before, so a property that has not
  // closed for three days works through them rather than jumping to today.
  const stub = () => "2026-10-05";
  const behind = expectedAuditDate(stub, {}, "2026-10-02");
  assert.equal(behind.next, "2026-10-03", "the day after the last close");
  assert.equal(behind.behindBy, 2);
  assert.equal(behind.upToDate, false);
});

test("a property that has never closed a day closes today", () => {
  const first = expectedAuditDate(() => "2026-10-05", {}, "");
  assert.equal(first.next, "2026-10-05");
  assert.equal(first.behindBy, 0);
});

test("a property already closed for today is up to date", () => {
  const done = expectedAuditDate(() => "2026-10-05", {}, "2026-10-05");
  assert.equal(done.upToDate, true);
  assert.equal(done.behindBy, 0);
});

/* =========================================================
   CLOSING THE DAY
========================================================= */

test("only a manager may close the day", async () => {
  const { audit } = fresh();
  const readiness = auditReadiness(readyInput());
  await assert.rejects(
    () => audit.closeDay({ readiness, totals: {}, actor: reception }),
    error => error.code === "forbidden"
  );
});

test("a blocking item refuses the close and says which", async () => {
  const { audit } = fresh();
  const readiness = auditReadiness(readyInput({ shifts: [{ id: "s1", status: SHIFT_STATUS.ACTIVE }] }));
  await assert.rejects(
    () => audit.closeDay({ readiness, totals: {}, actor: manager }),
    error => {
      assert.equal(error.code, "blocked");
      assert.match(error.message, /cashier shift/);
      return true;
    }
  );
});

test("a warning must be acknowledged, and what was acknowledged is recorded", async () => {
  // So a month later it is possible to see that Tuesday closed with three
  // unpaid folios and that somebody chose that.
  const { audit, store } = fresh();
  const readiness = auditReadiness(readyInput({ folios: [{ id: "f1", status: "open", balance: 3000 }] }));

  await assert.rejects(
    () => audit.closeDay({ readiness, totals: {}, actor: manager }),
    error => error.code === "unacknowledged"
  );

  const result = await audit.closeDay({
    readiness, totals: auditTotals({ businessDate: TODAY }), actor: manager,
    acknowledgedWarnings: ["outstanding"], notes: "Two corporate accounts on credit"
  });
  const record = store.get(`hotelNightAudits/${result.auditId}`);
  assert.equal(record.businessDate, TODAY);
  assert.deepEqual(record.acknowledgedWarnings.map(entry => entry.id), ["outstanding"]);
  assert.equal(record.acknowledgedWarnings[0].count, 1);
  assert.equal(record.notes, "Two corporate accounts on credit");
  assert.equal(record.closedByName, "M Anager");
});

test("a retried close returns the audit already recorded", async () => {
  const { audit, store } = fresh();
  const readiness = auditReadiness(readyInput());
  const totals = auditTotals({ businessDate: TODAY });
  const first = await audit.closeDay({ readiness, totals, actor: manager });
  const again = await audit.closeDay({ readiness, totals, actor: manager });
  assert.equal(again.duplicate, true);
  assert.equal(again.auditId, first.auditId);
  assert.equal(audits(store).filter(entry => entry.action === "night_audit_closed").length, 1);
});

test("room charges post once however many times the audit is run", async () => {
  const { audit, store } = fresh();
  const charges = stayoverCharges([booking("a")], TODAY);
  const folioIdFor = reservationId => `FOL_${reservationId}`;
  await audit.postRoomCharges({ charges, folioIdFor, actor: manager, taxPercent: 12 });
  await audit.postRoomCharges({ charges, folioIdFor, actor: manager, taxPercent: 12 });

  const items = [...store.keys()].filter(path => path.includes("hotel_folio_items"));
  assert.equal(items.length, 1);
  const item = store.get(`restaurants/${RID}/hotel_folio_items/room_a_${TODAY}`);
  assert.equal(item.rate, 2500);
  assert.equal(item.total, 2800, "tax applied once");
  assert.equal(item.sourceType, "night_audit");
});

/* =========================================================
   SECTION 26 — CASHIER SHIFTS
========================================================= */

test("a shift moves one step at a time", () => {
  assert.equal(nextShiftStatus(SHIFT_STATUS.OPEN), SHIFT_STATUS.ACTIVE);
  assert.equal(nextShiftStatus(SHIFT_STATUS.ACTIVE), SHIFT_STATUS.CLOSING);
  assert.equal(nextShiftStatus(SHIFT_STATUS.CLOSING), SHIFT_STATUS.CLOSED);
  assert.equal(nextShiftStatus(SHIFT_STATUS.CLOSED), null);
});

test("only cash reaches the drawer", () => {
  assert.equal(isCashPayment({ method: "cash" }), true);
  assert.equal(isCashPayment({ method: "CARD" }), false);
  assert.equal(isCashPayment({ method: "upi" }), false);
  // Counting a card here would make every shift look wildly over.
  const expected = expectedCash({ openingCash: 1000 }, [
    { method: "cash", amount: 500, status: "success" },
    { method: "card", amount: 9000, status: "success" }
  ]);
  assert.equal(expected.expected, 1500);
});

test("an unsettled cash payment is not money in a drawer", () => {
  // Counting it would make an honest cashier look short by exactly the
  // amount of a payment that never completed.
  const expected = expectedCash({ openingCash: 1000 }, [
    { method: "cash", amount: 500, status: "success" },
    { method: "cash", amount: 700, status: "pending" }
  ]);
  assert.equal(expected.expected, 1500);
  assert.equal(expected.unsettledCount, 1, "but the cashier is told it was attempted");
});

test("refunds and pay-outs come out of the expected figure", () => {
  const expected = expectedCash({ openingCash: 2000, paidOut: 300 }, [
    { method: "cash", amount: 5000, status: "success" },
    { method: "cash", amount: 800, status: "success", kind: "refund" }
  ]);
  assert.equal(expected.cashTaken, 5000);
  assert.equal(expected.cashRefunded, 800);
  assert.equal(expected.expected, 2000 + 5000 - 800 - 300);
});

test("the drawer is never pre-filled with the answer", () => {
  // A screen that fills in the expected figure is a screen where nobody
  // counts.
  const uncounted = reconcileShift({ openingCash: 1000 }, [], {});
  assert.equal(uncounted.counted, false);
  assert.equal(uncounted.actual, null);
  assert.equal(uncounted.variance, null);
  assert.equal(describeVariance(uncounted), "Not counted yet.");
});

test("a variance is reported plainly, in both directions", () => {
  const payments = [{ method: "cash", amount: 5000, status: "success" }];
  const short = reconcileShift({ openingCash: 1000 }, payments, { actualCash: 5800 });
  assert.equal(short.variance, -200);
  assert.equal(short.verdict, "short");
  assert.match(describeVariance(short), /short by 200/);

  const over = reconcileShift({ openingCash: 1000 }, payments, { actualCash: 6100 });
  assert.equal(over.verdict, "over");
  assert.match(describeVariance(over), /over by 100/);

  const exact = reconcileShift({ openingCash: 1000 }, payments, { actualCash: 6000 });
  assert.equal(exact.verdict, "balanced");
  assert.equal(exact.variance, 0);
});

test("a difference needs a reason, but never blocks the shift forever", async () => {
  // Cash is messy. A shift that cannot be closed is a shift that stays open,
  // which is worse than one that closed with an explanation.
  const short = reconcileShift({ openingCash: 1000 }, [{ method: "cash", amount: 5000, status: "success" }], { actualCash: 5900 });
  assert.equal(canCloseShift(short, { role: "receptionist" }).ok, false);
  assert.match(canCloseShift(short, { role: "receptionist" }).reason, /Record why/);
  // With a note and within tolerance, the cashier closes their own shift.
  assert.equal(canCloseShift(short, { role: "receptionist", note: "Change given from float", toleranceAmount: 200 }).ok, true);
  // Beyond tolerance it needs a manager.
  assert.equal(canCloseShift(short, { role: "receptionist", note: "Unexplained", toleranceAmount: 50 }).ok, false);
  assert.equal(canCloseShift(short, { role: "manager", note: "Unexplained", toleranceAmount: 50 }).ok, true);
});

test("an uncounted drawer cannot be closed at all", () => {
  const uncounted = reconcileShift({ openingCash: 1000 }, [], {});
  assert.equal(canCloseShift(uncounted, { role: "manager", note: "whatever" }).ok, false);
});

test("closing a shift records the variance rather than the claim", async () => {
  const { cashier, store } = fresh();
  await cashier.openShift({ shiftId: "S1", openingCash: 1000, actor: reception, businessDate: TODAY });
  const result = await cashier.closeShift({
    shiftId: "S1",
    payments: [{ method: "cash", amount: 5000, status: "success" }],
    actualCash: 5900, note: "Float taken for the bar", actor: manager
  });
  assert.equal(result.reconciliation.expected, 6000);
  assert.equal(result.reconciliation.actual, 5900);
  assert.equal(result.reconciliation.variance, -100);

  const shift = store.get(`restaurants/${RID}/hotel_cashier_shifts/S1`);
  assert.equal(shift.status, SHIFT_STATUS.CLOSED);
  assert.equal(shift.reconciliation.variance, -100);
  const entry = audits(store).find(row => row.action === "shift_closed");
  assert.equal(entry.detail.variance, -100);
  assert.equal(entry.detail.note, "Float taken for the bar");
});

test("the close recomputes from the payments, not from a stale screen", async () => {
  const { cashier } = fresh();
  await cashier.openShift({ shiftId: "S1", openingCash: 1000, actor: reception });
  // The screen thought the drawer balanced; another payment landed since.
  await assert.rejects(
    () => cashier.closeShift({
      shiftId: "S1",
      payments: [{ method: "cash", amount: 5000, status: "success" }, { method: "cash", amount: 2000, status: "success" }],
      actualCash: 6000, actor: manager
    }),
    error => {
      assert.equal(error.code, "unbalanced");
      assert.equal(error.reconciliation.variance, -2000);
      return true;
    }
  );
});

test("a pay-out needs a reason and reduces what the drawer should hold", async () => {
  const { cashier, store } = fresh();
  await cashier.openShift({ shiftId: "S1", openingCash: 2000, actor: reception });
  await assert.rejects(
    () => cashier.recordPayOut({ shiftId: "S1", amount: 300, reason: "", actor: reception }),
    error => error.code === "invalid"
  );
  await cashier.recordPayOut({ shiftId: "S1", amount: 300, reason: "Float to the bar till", actor: reception });
  assert.equal(store.get(`restaurants/${RID}/hotel_cashier_shifts/S1`).paidOut, 300);
  const entry = audits(store).find(row => row.action === "shift_pay_out");
  assert.equal(entry.detail.reason, "Float to the bar till");
});

test("nothing can be recorded against a closed shift", async () => {
  const { cashier } = fresh();
  await cashier.openShift({ shiftId: "S1", openingCash: 1000, actor: reception });
  await cashier.closeShift({ shiftId: "S1", payments: [], actualCash: 1000, actor: manager });
  await assert.rejects(
    () => cashier.recordPayOut({ shiftId: "S1", amount: 100, reason: "late", actor: reception }),
    error => error.code === "closed"
  );
});

test("reopening the same shift id is a retry, not a second shift", async () => {
  const { cashier, store } = fresh();
  await cashier.openShift({ shiftId: "S1", openingCash: 1000, actor: reception });
  const again = await cashier.openShift({ shiftId: "S1", openingCash: 9999, actor: reception });
  assert.equal(again.duplicate, true);
  assert.equal(store.get(`restaurants/${RID}/hotel_cashier_shifts/S1`).openingCash, 1000);
});

test("a closed shift is closed once, and reports what it recorded", async () => {
  const { cashier, store } = fresh();
  await cashier.openShift({ shiftId: "S1", openingCash: 1000, actor: reception });
  await cashier.closeShift({ shiftId: "S1", payments: [], actualCash: 1000, actor: manager });
  const again = await cashier.closeShift({ shiftId: "S1", payments: [], actualCash: 4000, actor: manager });
  assert.equal(again.duplicate, true);
  assert.equal(store.get(`restaurants/${RID}/hotel_cashier_shifts/S1`).reconciliation.actual, 1000);
});
