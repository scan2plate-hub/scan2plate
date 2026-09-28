/* =========================================================
   SETTLING A BILL FROM THE BILLING SCREEN

   Paid -> how the money arrived -> print or not.

   The order of those three is the point. A counter takes the
   money before it asks about paper, so the payment is
   recorded before the print is offered: a cancelled print
   dialog or an empty roll then costs a slip, not a payment.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PAYMENT_METHODS, paymentMethodLabel, isPaid, billActionState, settleSteps
} from "../public/js/billing-actions.js";

/* ---------------------------------------------------------
   PAYMENT METHODS
--------------------------------------------------------- */
test("the four methods a counter reaches for are offered", () => {
  assert.deepEqual(PAYMENT_METHODS.map(method => method.key), ["cash", "upi", "card", "other"]);
});

test("a method is labelled however it was stored", () => {
  assert.equal(paymentMethodLabel("upi"), "UPI");
  assert.equal(paymentMethodLabel("UPI"), "UPI");
  assert.equal(paymentMethodLabel("Card"), "Card");
});

test("an unknown method reads as Other rather than blank", () => {
  assert.equal(paymentMethodLabel("bitcoin"), "Other");
  assert.equal(paymentMethodLabel(""), "Other");
  assert.equal(paymentMethodLabel(undefined), "Other");
});

test("paid is recognised however it was cased", () => {
  assert.equal(isPaid("paid"), true);
  assert.equal(isPaid("Paid"), true);
  assert.equal(isPaid("unpaid"), false);
  assert.equal(isPaid(""), false);
  assert.equal(isPaid(undefined), false);
});

/* ---------------------------------------------------------
   WHAT IS AVAILABLE, AND WHEN
--------------------------------------------------------- */
test("nothing can be settled before the order is saved", () => {
  // A bill has no number until then, and a printed slip without one cannot
  // be found again.
  const state = billActionState({ savedOrderId: "", cartCount: 3 });
  assert.equal(state.saved, false);
  assert.equal(state.canPrint, false);
  assert.equal(state.canMarkPaid, false);
  assert.equal(state.canMarkUnpaid, false);
});

test("the reason says what to do next, not what went wrong", () => {
  assert.match(billActionState({ savedOrderId: "", cartCount: 3 }).reason, /Create the order first/);
  assert.match(billActionState({ savedOrderId: "", cartCount: 0 }).reason, /Add items/);
});

test("a saved unpaid bill can be printed and marked paid", () => {
  const state = billActionState({ savedOrderId: "ORD1", cartCount: 2, paymentStatus: "unpaid" });
  assert.equal(state.canPrint, true);
  assert.equal(state.canMarkPaid, true);
  assert.equal(state.canMarkUnpaid, false);
});

test("a paid bill offers unpaid, not paid again", () => {
  const state = billActionState({ savedOrderId: "ORD1", cartCount: 2, paymentStatus: "paid" });
  assert.equal(state.paid, true);
  assert.equal(state.canMarkPaid, false);
  assert.equal(state.canMarkUnpaid, true);
  assert.equal(state.canPrint, true, "a paid bill is exactly the one a customer asks to be printed");
});

test("an emptied cart cannot be printed even on a saved order", () => {
  assert.equal(billActionState({ savedOrderId: "ORD1", cartCount: 0 }).canPrint, false);
});

test("called with nothing it does not throw", () => {
  assert.equal(billActionState().saved, false);
});

/* ---------------------------------------------------------
   THE SEQUENCE
--------------------------------------------------------- */
test("the payment is recorded before the print is offered", () => {
  const steps = settleSteps({ method: "upi", print: true });
  assert.deepEqual(steps.map(step => step.step), ["record-payment", "print-bill"]);
});

test("declining the print still records the payment", () => {
  const steps = settleSteps({ method: "cash", print: false });
  assert.deepEqual(steps.map(step => step.step), ["record-payment"]);
  assert.equal(steps[0].status, "paid");
  assert.equal(steps[0].method, "cash");
});

test("the method chosen is the method recorded", () => {
  for (const { key } of PAYMENT_METHODS) {
    assert.equal(settleSteps({ method: key }).at(0).method, key);
  }
});

/* ---------------------------------------------------------
   THE WIRING
--------------------------------------------------------- */
const adminCode = readFileSync(`${import.meta.dirname}/../public/js/admin.js`, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const dashboardHtml = readFileSync(`${import.meta.dirname}/../public/admin-dashboard.html`, "utf8");

test("the Current Bill panel carries the three buttons", () => {
  for (const id of ["manualMarkPaidBtn", "manualMarkUnpaidBtn", "manualPrintBillBtn"]) {
    assert.match(dashboardHtml, new RegExp(`id="${id}"`), id);
  }
});

test("Mark Paid asks for the method rather than assuming cash", () => {
  const handler = adminCode.match(/manualMarkPaidBtn\?\.addEventListener\([\s\S]*?\n\}\);/)?.[0] || "";
  assert.match(handler, /showPaymentMethodModal\(editingOrderDocId/);
  assert.doesNotMatch(handler, /updatePaymentStatus\([^)]*"paid"/, "it must not settle without asking");
});

test("the print is offered after the payment is saved, inside the paid callback", () => {
  const handler = adminCode.match(/manualMarkPaidBtn\?\.addEventListener\([\s\S]*?\n\}\);/)?.[0] || "";
  const paidAt = handler.indexOf("onPaid");
  const askAt = handler.indexOf("askPrintBill");
  assert.ok(paidAt > -1 && askAt > paidAt, "asking about paper happens after the money is recorded");
});

test("declining the print does not open the bill", () => {
  const handler = adminCode.match(/manualMarkPaidBtn\?\.addEventListener\([\s\S]*?\n\}\);/)?.[0] || "";
  assert.match(handler, /if \(await askPrintBill\([\s\S]*?\)\) \{[\s\S]*?openBillPreviewFor/);
});

test("every way of dismissing the print prompt means no", () => {
  // Escape, the backdrop and Cancel all resolve false. The payment is saved
  // either way, so the safe default is the quiet one.
  const fn = adminCode.match(/function askPrintBill\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(fn, /Escape[\s\S]*?finish\(false\)/);
  assert.match(fn, /event\.target === overlay\) return finish\(false\)/);
  assert.match(fn, /data-print="no"/);
});

test("the print prompt unbinds its key listener when it closes", () => {
  // It is added to document, so leaving it attached would make every later
  // Escape resolve a promise nobody is waiting on.
  const fn = adminCode.match(/function askPrintBill\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(fn, /removeEventListener\("keydown", onKey\)/);
});

test("other screens still settle exactly as they did", () => {
  // showPaymentMethodModal gained an optional continuation; callers that pass
  // nothing must be unchanged.
  assert.match(adminCode, /function showPaymentMethodModal\(orderId, \{ onPaid \} = \{\}\)/);
  assert.match(adminCode, /showPaymentMethodModal\(paid\.dataset\.id \|\| ""\)/, "the Tables screen call is untouched");
});

test("the settle row stays hidden until the order exists", () => {
  const fn = adminCode.match(/function renderManualSettleRow\([\s\S]*?\n\}\n/)?.[0] || "";
  assert.match(fn, /billActionState\(/);
  assert.match(fn, /classList\.toggle\("hidden", !state\.saved\)/);
});
