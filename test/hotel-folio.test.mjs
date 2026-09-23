/* =========================================================
   FOLIO AND CHECKOUT

   The money half. Four rules from section 56 decide almost every
   line of this file:

     12 — a failed payment is never recorded as successful
     13 — refunds are recorded separately, not netted away
     15 — invoice numbers stay serial and unique
     16/17 — history survives the deletion of people and guests

   Each is tested as a behaviour under retry and failure, not as
   a happy path, because every one of them fails in exactly the
   circumstances a happy-path test does not create.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createFolioService, chargeFromPosOrder, roomsAcceptingCharges,
  checkoutSummary, formatInvoiceNumber, normalizePaymentMethod,
  PAYMENT_STATUS, FolioError, INVOICE_COUNTER
} from "../public/js/hotel-folio.js";
import { folioTotals } from "../public/js/hotel-core.js";

/* ---------------------------------------------------------
   Firestore stub (same optimistic model as the reservation tests)
--------------------------------------------------------- */
function makeFirestore() {
  const store = new Map();
  let autoId = 0;
  const firestore = {
    doc: (dbOrRef, ...segments) => (segments.length
      ? { path: segments.filter(Boolean).join("/") }
      : { path: `${dbOrRef.path}/auto${autoId += 1}` }),
    collection: (db, ...segments) => ({ path: segments.join("/") }),
    serverTimestamp: () => "SERVER_TIMESTAMP",
    async runTransaction(db, body) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const held = store.get(ref.path);
          return { exists: () => Boolean(held), data: () => (held ? { ...held } : undefined) };
        },
        set(ref, data, options) { writes.push({ kind: "set", path: ref.path, data, merge: options?.merge }); },
        delete(ref) { writes.push({ kind: "delete", path: ref.path }); }
      };
      const result = await body(transaction);
      writes.forEach(write => {
        if (write.kind === "delete") store.delete(write.path);
        else store.set(write.path, write.merge ? { ...(store.get(write.path) || {}), ...write.data } : write.data);
      });
      return result;
    }
  };
  return { firestore, store };
}

const db = { name: "stub" };
const RID = "RST006";
const manager = { uid: "u1", name: "M Manager", role: "manager" };
const reception = { uid: "u2", name: "R Desk", role: "receptionist" };
const housekeeper = { uid: "u3", name: "H Keeper", role: "housekeeping" };

const P = {
  folio: id => `restaurants/${RID}/hotel_folios/${id}`,
  item: id => `restaurants/${RID}/hotel_folio_items/${id}`,
  payment: id => `hotelPayments/${id}`,
  invoice: number => `hotelInvoices/${String(number).replace(/\//g, "_")}`,
  counter: () => `restaurants/${RID}/counters/${INVOICE_COUNTER}`
};
const audits = store => [...store.entries()].filter(([path]) => path.startsWith("hotelAuditLogs/")).map(([, data]) => data);

function freshService() {
  const { firestore, store } = makeFirestore();
  const service = createFolioService({ db, restaurantId: RID, firestore });
  return { service, store };
}

async function openStay(service, folioId = "F1") {
  await service.openFolio({ folioId, reservationId: "BK1", guestId: "g1", guestName: "A Guest", roomId: "101", actor: reception });
  return folioId;
}

/* =========================================================
   CHARGES
========================================================= */

test("a folio opens once, however many times check-in is retried", async () => {
  const { service, store } = freshService();
  await openStay(service);
  const again = await service.openFolio({ folioId: "F1", reservationId: "BK1", actor: reception });
  assert.equal(again.duplicate, true);
  assert.equal(audits(store).filter(entry => entry.action === "folio_opened").length, 1);
});

test("a charge posts to the folio with tax on the discounted amount", async () => {
  const { service, store } = freshService();
  await openStay(service);
  await service.postCharge({
    folioId: "F1", chargeId: "c1", kind: "room",
    quantity: 2, rate: 2500, discount: 500, taxPercent: 12, actor: reception
  });
  const item = store.get(P.item("c1"));
  assert.equal(item.net, 4500);
  assert.equal(item.tax, 540);
  assert.equal(item.total, 5040);
  assert.equal(item.postedBy, "R Desk");
});

test("SECTION 17: the same restaurant bill cannot post to a room twice", async () => {
  // The POS write and the folio write are two writes that must behave as one
  // fact. Pressing "post to room" twice, or a retry after a dropped
  // connection, must leave one line on the folio.
  const { service, store } = freshService();
  await openStay(service);
  const order = { id: "ORD7", grandTotal: 850, billNumber: "B12", outletName: "Coffee Shop" };
  const charge = chargeFromPosOrder(order);

  await service.postCharge({ folioId: "F1", actor: reception, ...charge });
  const second = await service.postCharge({ folioId: "F1", actor: reception, ...charge });

  assert.equal(second.duplicate, true);
  const lines = [...store.keys()].filter(path => path.includes("hotel_folio_items"));
  assert.equal(lines.length, 1);
  assert.equal(store.get(P.item("pos_ORD7")).total, 850);
});

test("a posted restaurant bill keeps the total the guest was shown", async () => {
  // Recomputing tax here could produce a folio line that disagrees with the
  // printed bill in the guest's hand.
  const charge = chargeFromPosOrder({ id: "ORD8", grandTotal: 1234.56 });
  assert.equal(charge.rate, 1234.56);
  assert.equal(charge.taxPercent, 0, "tax already sits inside the agreed total");
  assert.equal(charge.sourceType, "pos_order");
  assert.equal(charge.sourceId, "ORD8");
});

test("a bill with no total, or no id, is not postable", async () => {
  assert.equal(chargeFromPosOrder({ id: "ORD9", grandTotal: 0 }), null);
  assert.equal(chargeFromPosOrder({ grandTotal: 500 }), null);
  assert.equal(chargeFromPosOrder({}), null);
});

test("nothing can be posted to a closed folio", async () => {
  const { service } = freshService();
  await openStay(service);
  await service.postCharge({ folioId: "F1", chargeId: "c1", kind: "room", rate: 1000, actor: reception });
  await service.beginPayment({ folioId: "F1", paymentId: "p1", amount: 1000, method: "cash", actor: reception });
  await service.settlePayment({ folioId: "F1", paymentId: "p1", outcome: true, actor: reception });
  await service.closeFolio({
    folioId: "F1",
    charges: [{ kind: "room", quantity: 1, rate: 1000 }],
    payments: [{ amount: 1000, status: "success" }],
    actor: reception
  });
  await assert.rejects(
    () => service.postCharge({ folioId: "F1", chargeId: "late", kind: "food", rate: 200, actor: reception }),
    error => error.code === "closed"
  );
});

test("only the desk or a manager may remove a charge, and the removal is logged", async () => {
  const { service, store } = freshService();
  await openStay(service);
  await service.postCharge({ folioId: "F1", chargeId: "c1", kind: "minibar", rate: 300, actor: reception });

  await assert.rejects(
    () => service.voidCharge({ folioId: "F1", chargeId: "c1", actor: housekeeper }),
    error => error.code === "forbidden"
  );
  await service.voidCharge({ folioId: "F1", chargeId: "c1", actor: manager, reason: "Guest disputed" });
  assert.equal(store.has(P.item("c1")), false);
  const entry = audits(store).find(row => row.action === "folio_charge_voided");
  assert.equal(entry.detail.reason, "Guest disputed");
  assert.equal(entry.detail.total, 300, "a folio that shrank must always be explainable");
});

/* =========================================================
   RULE 12 — PAYMENTS
========================================================= */

test("RULE 12: a payment starts PENDING and does not reduce the balance", async () => {
  // The rule is not a check somewhere. It is that the payment document
  // starts out not counting.
  const { service, store } = freshService();
  await openStay(service);
  await service.beginPayment({ folioId: "F1", paymentId: "p1", amount: 3000, method: "card", actor: reception });

  const payment = store.get(P.payment("p1"));
  assert.equal(payment.status, PAYMENT_STATUS.PENDING);
  const totals = folioTotals([{ kind: "room", rate: 3000, quantity: 1 }], [payment]);
  assert.equal(totals.paid, 0);
  assert.equal(totals.balance, 3000, "the guest still owes it until the money confirms");
});

test("RULE 12: a declined card leaves the balance untouched and says why", async () => {
  const { service, store } = freshService();
  await openStay(service);
  await service.beginPayment({ folioId: "F1", paymentId: "p1", amount: 3000, method: "card", actor: reception });
  await service.settlePayment({
    folioId: "F1", paymentId: "p1", outcome: false, actor: reception, failureReason: "Card declined"
  });

  const payment = store.get(P.payment("p1"));
  assert.equal(payment.status, PAYMENT_STATUS.FAILED);
  assert.equal(payment.failureReason, "Card declined");
  assert.equal(folioTotals([{ kind: "room", rate: 3000, quantity: 1 }], [payment]).balance, 3000);
  assert.ok(audits(store).some(entry => entry.action === "payment_failed"));
});

test("a browser closed mid-authorisation leaves a PENDING record, not a paid one", async () => {
  // The case a single write after the gateway call cannot represent: nobody
  // ever told us the outcome. Unpaid is the only safe reading.
  const { service, store } = freshService();
  await openStay(service);
  await service.beginPayment({ folioId: "F1", paymentId: "p1", amount: 3000, method: "razorpay", actor: reception });
  const payment = store.get(P.payment("p1"));
  assert.equal(payment.status, PAYMENT_STATUS.PENDING);
  assert.equal(folioTotals([{ kind: "room", rate: 3000, quantity: 1 }], [payment]).paid, 0);
});

test("a settled payment is never settled twice", async () => {
  // A duplicate webhook, or a double-clicked Confirm, must not credit twice.
  const { service, store } = freshService();
  await openStay(service);
  await service.beginPayment({ folioId: "F1", paymentId: "p1", amount: 2000, method: "upi", actor: reception });
  await service.settlePayment({ folioId: "F1", paymentId: "p1", outcome: true, actor: reception });
  const again = await service.settlePayment({ folioId: "F1", paymentId: "p1", outcome: true, actor: reception });
  assert.equal(again.unchanged, true);
  assert.equal(audits(store).filter(entry => entry.action === "payment_settled").length, 1);
});

test("a failed payment can still succeed on a retry of the same attempt", async () => {
  // A card that failed and was re-presented is one attempt, not two.
  const { service, store } = freshService();
  await openStay(service);
  await service.beginPayment({ folioId: "F1", paymentId: "p1", amount: 2000, method: "card", actor: reception });
  await service.settlePayment({ folioId: "F1", paymentId: "p1", outcome: false, actor: reception });
  await service.settlePayment({ folioId: "F1", paymentId: "p1", outcome: true, actor: reception });
  assert.equal(store.get(P.payment("p1")).status, PAYMENT_STATUS.SUCCESS);
});

test("the same payment id cannot start twice", async () => {
  const { service } = freshService();
  await openStay(service);
  await service.beginPayment({ folioId: "F1", paymentId: "p1", amount: 500, method: "cash", actor: reception });
  const again = await service.beginPayment({ folioId: "F1", paymentId: "p1", amount: 500, method: "cash", actor: reception });
  assert.equal(again.duplicate, true);
});

test("a payment of zero or less is refused", async () => {
  const { service } = freshService();
  await openStay(service);
  for (const amount of [0, -100]) {
    await assert.rejects(
      () => service.beginPayment({ folioId: "F1", paymentId: `p${amount}`, amount, method: "cash", actor: reception }),
      error => error.code === "invalid"
    );
  }
});

test("payment methods normalise, and an unknown one is not invented", () => {
  assert.equal(normalizePaymentMethod("UPI"), "upi");
  assert.equal(normalizePaymentMethod("Bank Transfer"), "bank_transfer");
  assert.equal(normalizePaymentMethod("crypto"), "cash", "an unrecognised method falls back, never passes through");
});

/* =========================================================
   RULE 13 — REFUNDS
========================================================= */

test("RULE 13: a refund is its own record, and what was collected stays visible", async () => {
  const { service, store } = freshService();
  await openStay(service);
  await service.beginPayment({ folioId: "F1", paymentId: "p1", amount: 5000, method: "card", actor: reception });
  await service.settlePayment({ folioId: "F1", paymentId: "p1", outcome: true, actor: reception });
  await service.recordRefund({ folioId: "F1", refundId: "r1", amount: 1000, method: "card", actor: manager, reason: "Early departure" });

  const totals = folioTotals(
    [{ kind: "room", rate: 5000, quantity: 1 }],
    [store.get(P.payment("p1")), store.get(P.payment("r1"))]
  );
  assert.equal(totals.paid, 5000);
  assert.equal(totals.refunded, 1000);
  assert.equal(totals.netPaid, 4000);
});

test("housekeeping cannot record a refund", async () => {
  const { service } = freshService();
  await openStay(service);
  await assert.rejects(
    () => service.recordRefund({ folioId: "F1", refundId: "r1", amount: 100, method: "cash", actor: housekeeper }),
    error => error.code === "forbidden"
  );
});

/* =========================================================
   RULE 15 — INVOICE NUMBERS
========================================================= */

test("RULE 15: invoice numbers are serial and never repeat", async () => {
  const { service, store } = freshService();
  const paid = { charges: [{ kind: "room", rate: 1000, quantity: 1 }], payments: [{ amount: 1000, status: "success" }] };

  const numbers = [];
  for (const id of ["F1", "F2", "F3"]) {
    await service.openFolio({ folioId: id, reservationId: id, roomId: "101", actor: reception });
    const result = await service.closeFolio({ folioId: id, ...paid, actor: reception });
    numbers.push(result.invoiceNumber);
  }
  assert.deepEqual(numbers, ["INV/00001", "INV/00002", "INV/00003"]);
  assert.equal(new Set(numbers).size, 3);
  assert.equal(store.get(P.counter()).lastInvoiceSerial, 3);
});

test("a retried checkout returns the invoice it already raised, never a second one", async () => {
  const { service, store } = freshService();
  await openStay(service);
  const settled = { charges: [{ kind: "room", rate: 1000, quantity: 1 }], payments: [{ amount: 1000, status: "success" }] };
  const first = await service.closeFolio({ folioId: "F1", ...settled, actor: reception });
  const again = await service.closeFolio({ folioId: "F1", ...settled, actor: reception });

  assert.equal(again.duplicate, true);
  assert.equal(again.invoiceNumber, first.invoiceNumber);
  assert.equal(store.get(P.counter()).lastInvoiceSerial, 1, "a retry must not burn a serial");
});

test("a failed checkout does not consume an invoice number", async () => {
  const { service, store } = freshService();
  await openStay(service);
  await assert.rejects(
    () => service.closeFolio({
      folioId: "F1",
      charges: [{ kind: "room", rate: 5000, quantity: 1 }],
      payments: [],
      actor: reception
    }),
    error => error.code === "unsettled"
  );
  assert.equal(store.has(P.counter()), false, "no serial taken by a checkout that did not happen");
});

test("the invoice format is configurable without the serial ever being lost", () => {
  assert.equal(formatInvoiceNumber(7), "INV/00007");
  assert.equal(formatInvoiceNumber(7, { prefix: "OM", width: 4, financialYear: "2026-27" }), "OM/2026-27/0007");
  assert.equal(formatInvoiceNumber(123456, { width: 3 }), "INV/123456", "a serial is never truncated to fit");
});

/* =========================================================
   RULE 3 — CHECKOUT
========================================================= */

test("RULE 3: an unsettled folio blocks checkout", async () => {
  const { service } = freshService();
  await openStay(service);
  await assert.rejects(
    () => service.closeFolio({
      folioId: "F1", charges: [{ kind: "room", rate: 4000, quantity: 1 }], payments: [], actor: reception
    }),
    error => {
      assert.equal(error.code, "unsettled");
      assert.equal(error.balance, 4000);
      return true;
    }
  );
});

test("checkout on credit is possible, deliberately, and recorded as such", async () => {
  const { service, store } = freshService();
  await openStay(service);
  const result = await service.closeFolio({
    folioId: "F1",
    charges: [{ kind: "room", rate: 4000, quantity: 1 }],
    payments: [],
    actor: manager, allowCredit: true
  });
  assert.equal(result.ok, true);
  const folio = store.get(P.folio("F1"));
  assert.equal(folio.closedOnCredit, true);
  // The amount owed is on the INVOICE, which is the document that has to
  // survive; the folio only points at it.
  const invoice = store.get(P.invoice(result.invoiceNumber));
  assert.equal(invoice.onCredit, true);
  assert.equal(invoice.totals.balance, 4000);
});

test("the balance is recomputed at checkout, not trusted from the screen", async () => {
  // A receptionist's display can be stale. Trusting it is how a guest leaves
  // owing money that nobody notices until the night audit.
  const { service } = freshService();
  await openStay(service);
  await assert.rejects(
    () => service.closeFolio({
      folioId: "F1",
      charges: [{ kind: "room", rate: 4000, quantity: 1 }],
      // The screen "knew" about a payment that never settled.
      payments: [{ amount: 4000, status: "pending" }],
      actor: reception
    }),
    error => error.code === "unsettled"
  );
});

test("RULES 16 and 17: the invoice is its own document, snapshotted not referenced", async () => {
  // It must still render after the guest record and the staff account that
  // raised it are gone, so it follows no references at all.
  const { service, store } = freshService();
  await openStay(service);
  const result = await service.closeFolio({
    folioId: "F1",
    charges: [{ kind: "room", rate: 2000, quantity: 1 }, { kind: "food", rate: 500, quantity: 1 }],
    payments: [{ amount: 2500, status: "success" }],
    actor: reception
  });
  const invoice = store.get(P.invoice(result.invoiceNumber));
  assert.ok(invoice, "the invoice is a document of its own, not a field on the folio");
  assert.equal(invoice.guestName, "A Guest", "the name is copied, not looked up");
  assert.equal(invoice.raisedBy, "R Desk", "and so is who raised it");
  assert.equal(invoice.roomId, "101");
  assert.equal(invoice.totals.total, 2500);
  assert.deepEqual(invoice.totals.byKind, { room: 2000, food: 500 });
  assert.equal(invoice.restaurantId, RID, "and it carries its own isolation key");
});

test("the folio keeps only a pointer; the invoice holds the money", async () => {
  // The working account and the permanent document are different things.
  // Keeping them as one record is what makes "reopen the folio" rewrite an
  // invoice the guest is already holding.
  const { service, store } = freshService();
  await openStay(service);
  const result = await service.closeFolio({
    folioId: "F1",
    charges: [{ kind: "room", rate: 1000, quantity: 1 }],
    payments: [{ amount: 1000, status: "success" }],
    actor: reception
  });
  const folio = store.get(P.folio("F1"));
  assert.equal(folio.status, "closed");
  assert.equal(folio.invoiceNumber, result.invoiceNumber, "the folio points at it");
  assert.equal(folio.invoiceTotals, undefined, "but does not carry a second copy of the money");
  assert.equal(store.get(P.invoice(result.invoiceNumber)).totals.total, 1000);
});

test("closing a folio writes exactly one invoice", async () => {
  const { service, store } = freshService();
  await openStay(service);
  const settled = { charges: [{ kind: "room", rate: 1000, quantity: 1 }], payments: [{ amount: 1000, status: "success" }] };
  await service.closeFolio({ folioId: "F1", ...settled, actor: reception });
  await service.closeFolio({ folioId: "F1", ...settled, actor: reception });
  const invoices = [...store.keys()].filter(path => path.startsWith("hotelInvoices/"));
  assert.equal(invoices.length, 1, "a retried checkout must not raise a second invoice");
});

/* =========================================================
   THE CHECKOUT SUMMARY
========================================================= */

test("the summary lists charges in the order section 11 asks for", () => {
  const summary = checkoutSummary([
    { kind: "laundry", rate: 200, quantity: 1 },
    { kind: "room", rate: 2500, quantity: 2 },
    { kind: "food", rate: 850, quantity: 1 },
    { kind: "minibar", rate: 150, quantity: 1 }
  ], []);
  assert.deepEqual(summary.lines.map(line => line.kind), ["room", "food", "laundry", "minibar"]);
  assert.equal(summary.total, 5000 + 850 + 200 + 150);
});

test("the summary shows that a payment was attempted and did not go through", () => {
  // Otherwise a receptionist stares at an unchanged balance with no reason.
  const summary = checkoutSummary(
    [{ kind: "room", rate: 3000, quantity: 1 }],
    [{ amount: 3000, status: "failed" }, { amount: 1000, status: "success" }]
  );
  assert.equal(summary.paid, 1000);
  assert.equal(summary.balance, 2000);
  assert.equal(summary.unsettledAttempts, 1);
  assert.equal(summary.payments.length, 1, "only settled payments are listed as payments");
});

test("a kind with nothing on it is not shown as a zero line", () => {
  const summary = checkoutSummary([{ kind: "room", rate: 1000, quantity: 1 }], []);
  assert.deepEqual(summary.lines.map(line => line.kind), ["room"]);
});

test("only an in-house guest's room accepts a restaurant bill", () => {
  // Offering a checked-out or merely-booked room is how a bill lands on an
  // account nobody is going to settle.
  const rooms = roomsAcceptingCharges([
    { id: "F1", status: "open", roomId: "101", guestName: "In House" },
    { id: "F2", status: "closed", roomId: "102", guestName: "Departed" },
    { id: "F3", status: "open", roomId: "", guestName: "No room yet" }
  ]);
  assert.deepEqual(rooms, [{ folioId: "F1", roomId: "101", guestName: "In House" }]);
});
