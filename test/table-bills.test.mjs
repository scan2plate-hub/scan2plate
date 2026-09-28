/* =========================================================
   TAPPING A RUNNING TABLE IN QUICK BILLING

   The bug this covers: the picker chip said "Running", the
   counter tapped it, and the cart stayed empty. The table
   number changed and that was all.

   What is worth testing is not that a function was added. It
   is that the chip's label and the bill that opens are decided
   by the same predicate, and that opening one can never quietly
   throw away work the counter has already typed.
========================================================= */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CLOSED_WORKFLOW_STATUSES, isBillClosed, tableNumberOf, isOpenBill, billDocId,
  openBillForTable, tableIsRunning, unsavedItemCount, tableSelectionPlan
} from "../public/js/table-bills.js";

const running = (over = {}) => ({ id: "ORD1", tableNo: "05", status: "pending", paymentStatus: "unpaid", ...over });

/* ---------------------------------------------------------
   WHAT COUNTS AS A RUNNING BILL
--------------------------------------------------------- */
test("an order with no status at all is still live", () => {
  assert.equal(isBillClosed({}), false);
  assert.equal(isOpenBill({}), true);
});

test("every closed workflow status closes the bill", () => {
  for (const status of CLOSED_WORKFLOW_STATUSES) {
    assert.equal(isBillClosed({ status }), true, status);
    assert.equal(isOpenBill({ status }), false, status);
  }
});

test("status is matched however it was cased", () => {
  assert.equal(isBillClosed({ status: "Completed" }), true);
  assert.equal(isBillClosed({ status: "CANCELLED" }), true);
});

test("a paid bill is not running even while the kitchen still has it", () => {
  assert.equal(isOpenBill({ status: "preparing", paymentStatus: "paid" }), false);
  assert.equal(isOpenBill({ status: "preparing", paymentStatus: "Paid" }), false);
  assert.equal(isOpenBill({ status: "preparing", paymentStatus: "unpaid" }), true);
});

/* ---------------------------------------------------------
   TABLE NUMBERS
--------------------------------------------------------- */
test("table numbers compare in one padded format, whichever field holds them", () => {
  assert.equal(tableNumberOf({ tableNo: "5" }), "05");
  assert.equal(tableNumberOf({ tableNumber: 5 }), "05");
  assert.equal(tableNumberOf({ tableNo: "05" }), "05");
  assert.equal(tableNumberOf({ tableNo: " 7 " }), "07");
  assert.equal(tableNumberOf({ tableNo: "12" }), "12");
});

test("an order with no table is not on table zero", () => {
  assert.equal(tableNumberOf({}), "");
  assert.equal(tableNumberOf({ tableNo: "" }), "");
  assert.equal(openBillForTable([{ id: "A", status: "pending" }], "00"), null);
});

test("an unpadded tap finds a padded order and the other way round", () => {
  assert.equal(openBillForTable([running({ tableNo: "05" })], "5")?.id, "ORD1");
  assert.equal(openBillForTable([running({ tableNo: "5" })], "05")?.id, "ORD1");
});

/* ---------------------------------------------------------
   FINDING THE BILL
--------------------------------------------------------- */
test("a closed or paid bill leaves the table free", () => {
  assert.equal(openBillForTable([running({ status: "completed" })], "05"), null);
  assert.equal(openBillForTable([running({ paymentStatus: "paid" })], "05"), null);
  assert.equal(tableIsRunning([running({ status: "served" })], "05"), false);
});

test("the running badge and the bill that opens are the same decision", () => {
  // The whole point of the module: these two can never disagree, because
  // one is defined as the other.
  const orders = [
    running({ id: "A", tableNo: "01", status: "completed" }),
    running({ id: "B", tableNo: "02", paymentStatus: "paid" }),
    running({ id: "C", tableNo: "03" }),
    running({ id: "D", tableNo: "04", status: "preparing" })
  ];
  for (const table of ["01", "02", "03", "04", "05"]) {
    assert.equal(tableIsRunning(orders, table), openBillForTable(orders, table) !== null, table);
  }
});

test("orders come newest first, so the bill just rung up is the one opened", () => {
  const orders = [running({ id: "NEW" }), running({ id: "OLD" })];
  assert.equal(openBillForTable(orders, "05").id, "NEW");
});

test("an empty or missing order list is not a crash", () => {
  assert.equal(openBillForTable([], "05"), null);
  assert.equal(openBillForTable(undefined, "05"), null);
  assert.equal(openBillForTable([null, undefined], "05"), null);
});

test("no table tapped means no bill", () => {
  assert.equal(openBillForTable([running()], ""), null);
  assert.equal(openBillForTable([running()], null), null);
});

test("the doc id is read from whichever field carries it", () => {
  assert.equal(billDocId({ id: "A" }), "A");
  assert.equal(billDocId({ docId: "B" }), "B");
  assert.equal(billDocId({}), "");
});

/* ---------------------------------------------------------
   WHAT A TAP DOES
--------------------------------------------------------- */
test("a free table just changes the number", () => {
  const plan = tableSelectionPlan({ orders: [], tableNo: "7" });
  assert.equal(plan.action, "set");
  assert.equal(plan.tableNo, "07");
  assert.equal(plan.orderDocId, null);
  assert.equal(plan.confirmMessage, "");
});

test("a free table still changes the number while a bill is being edited", () => {
  // This is how a running bill is moved to another table. It must not become
  // a prompt or a reload.
  const plan = tableSelectionPlan({
    orders: [running({ id: "ORD1", tableNo: "05" })],
    tableNo: "09",
    editingOrderDocId: "ORD1",
    cart: [{ existingBillItem: true }]
  });
  assert.equal(plan.action, "set");
  assert.equal(plan.tableNo, "09");
});

test("tapping a running table opens its bill — the bug", () => {
  const plan = tableSelectionPlan({ orders: [running({ id: "ORD9" })], tableNo: "05" });
  assert.equal(plan.action, "load");
  assert.equal(plan.orderDocId, "ORD9");
  assert.equal(plan.confirmMessage, "", "an empty cart has nothing to lose, so nothing to ask");
});

test("the bill already in the cart is not re-loaded over itself", () => {
  // Re-loading would drop the items added since it was opened.
  const plan = tableSelectionPlan({
    orders: [running({ id: "ORD9" })],
    tableNo: "05",
    editingOrderDocId: "ORD9",
    cart: [{ existingBillItem: true }, { existingBillItem: false }]
  });
  assert.equal(plan.action, "keep");
  assert.equal(plan.orderDocId, "ORD9");
  assert.equal(plan.confirmMessage, "");
});

test("editing a different table's bill still opens the tapped one", () => {
  const plan = tableSelectionPlan({
    orders: [running({ id: "ORD9", tableNo: "05" })],
    tableNo: "05",
    editingOrderDocId: "ORD_OTHER",
    cart: [{ existingBillItem: true }]
  });
  assert.equal(plan.action, "load");
  assert.equal(plan.orderDocId, "ORD9");
  assert.equal(plan.confirmMessage, "", "saved lines belong to the other bill and are not lost work");
});

test("unsaved lines are counted, saved ones are not", () => {
  assert.equal(unsavedItemCount([]), 0);
  assert.equal(unsavedItemCount(undefined), 0);
  assert.equal(unsavedItemCount([{ existingBillItem: true }, { existingBillItem: true }]), 0);
  assert.equal(unsavedItemCount([{ existingBillItem: true }, {}, { existingBillItem: false }]), 2);
});

test("unsaved items in the cart are named before they are discarded", () => {
  const plan = tableSelectionPlan({
    orders: [running({ id: "ORD9" })],
    tableNo: "05",
    cart: [{ existingBillItem: false }, {}]
  });
  assert.equal(plan.action, "load");
  assert.match(plan.confirmMessage, /\b2 items\b/);
  assert.match(plan.confirmMessage, /Table 05/);
});

test("one unsaved item is one item, not one items", () => {
  const plan = tableSelectionPlan({ orders: [running()], tableNo: "05", cart: [{}] });
  assert.match(plan.confirmMessage, /\b1 item\b/);
  assert.doesNotMatch(plan.confirmMessage, /1 items/);
});

test("a running bill with no doc id cannot be opened, so the tap still works", () => {
  const plan = tableSelectionPlan({ orders: [running({ id: "" })], tableNo: "05" });
  assert.equal(plan.action, "set");
  assert.equal(plan.orderDocId, null);
});

test("called with nothing at all it does not throw", () => {
  assert.equal(tableSelectionPlan().action, "set");
});

/* ---------------------------------------------------------
   THE WIRING IN admin.js

   Source checks, because admin.js imports the Firebase CDN and
   cannot be loaded here. Comments are stripped first so a check
   never matches the prose explaining itself.
--------------------------------------------------------- */
const adminCode = readFileSync(`${import.meta.dirname}/../public/js/admin.js`, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("admin.js imports the shared decision rather than keeping its own", () => {
  assert.match(adminCode, /import \{[^}]*tableSelectionPlan[^}]*\} from "\.\/table-bills\.js/);
  assert.match(adminCode, /import \{[^}]*openBillForTable[^}]*\} from "\.\/table-bills\.js/);
});

test("the running badge is decided by the shared predicate", () => {
  const body = adminCode.match(/function tableHasOpenBill\([^)]*\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "tableHasOpenBill still exists");
  assert.match(body, /openBillForTable\(/);
});

test("the closed-status list exists in exactly one place", () => {
  assert.doesNotMatch(adminCode, /const CLOSED_WORKFLOW_STATUSES\s*=/,
    "admin.js must import the list, not redeclare it");
  assert.match(adminCode, /CLOSED_WORKFLOW_STATUSES[^=]*\} from "\.\/table-bills\.js/);
});

test("only a deliberate chip tap opens a bill", () => {
  assert.match(adminCode, /closest\("\[data-pick-table\]"\)[\s\S]{0,160}loadOpenBill: true/,
    "the picker chip asks for the bill");
  const step = adminCode.match(/function stepManualTable\([\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(step, /loadOpenBill/, "stepping past a table must not open it");
  const quick = adminCode.match(/function startQuickOrder\([\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(quick, /loadOpenBill/, "New Bill starts a new bill");
});

test("the confirm is asked before anything is loaded, and refusing does nothing", () => {
  const body = adminCode.match(/async function setManualTable\([\s\S]*?\n\}\n/)?.[0];
  assert.ok(body, "setManualTable is the one place a table is picked");
  const askedAt = body.indexOf("confirm(plan.confirmMessage)");
  const loadedAt = body.indexOf("loadOrderIntoManualBill(plan.orderDocId)");
  assert.ok(askedAt > -1 && loadedAt > -1, "it both asks and loads");
  assert.ok(askedAt < loadedAt, "it asks first");
  assert.match(body.slice(askedAt, loadedAt), /return;/, "refusing returns without changing the table");
});
