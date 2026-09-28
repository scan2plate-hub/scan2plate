/* =========================================================
   WHICH BILL IS RUNNING ON WHICH TABLE
   ---------------------------------------------------------
   Two screens ask the same question about a table and used to
   answer it in two different places:

     · The Tables grid shows "Running" and offers Open Bill.
     · Quick Billing's table picker shows the same Running chip.

   The grid knew which order that was. The picker only knew that
   one existed, so tapping a Running chip changed the table number
   and left the cart empty — the counter could see the table was
   busy and still had no way to reach the bill without leaving the
   billing screen.

   Both now come through here, which means the chip that says
   Running and the bill that opens can never disagree: they are
   the same predicate over the same list.

   Nothing in this file knows about Firestore, the DOM or any
   business type. It is plain data in, a decision out, so the
   decision can be tested on its own.
========================================================= */

/**
 * Statuses that mean the kitchen and the counter are finished with an
 * order. Anything else is still live on the floor.
 */
export const CLOSED_WORKFLOW_STATUSES = ["completed", "served", "delivered", "cancelled", "rejected"];

/** Orders with no status at all are pending — the oldest rows in Firestore. */
export function isBillClosed(order = {}) {
  return CLOSED_WORKFLOW_STATUSES.includes(String(order.status || "pending").toLowerCase());
}

/**
 * The table an order sits on, in the one format the whole app compares:
 * zero-padded to two digits. Empty when the order has no table, which is
 * what a takeaway or delivery looks like.
 */
export function tableNumberOf(order = {}) {
  const raw = String(order.tableNo ?? order.tableNumber ?? "").trim();
  return raw ? raw.padStart(2, "0") : "";
}

/**
 * Still owed and still open. Paid is checked separately from status because
 * a table can be settled before the kitchen marks the order served, and a
 * paid bill must not come back as running.
 */
export function isOpenBill(order = {}) {
  return !isBillClosed(order) && String(order.paymentStatus || "").toLowerCase() !== "paid";
}

/** The doc id an order can be re-opened by, whichever field carries it. */
export function billDocId(order = {}) {
  return String(order.id || order.docId || "");
}

/**
 * The running bill on a table, or null.
 *
 * The caller passes its order list newest-first, and the first match wins.
 * When a table somehow carries two open bills, the one just rung up is the
 * one the counter is reaching for.
 */
export function openBillForTable(orders, tableNo) {
  const wanted = String(tableNo ?? "").trim();
  if (!wanted) return null;
  const padded = wanted.padStart(2, "0");
  return (orders || []).find(order => order && tableNumberOf(order) === padded && isOpenBill(order)) || null;
}

/** Does this table have a running bill? The Running chip and nothing else. */
export function tableIsRunning(orders, tableNo) {
  return openBillForTable(orders, tableNo) !== null;
}

/** Cart lines that belong to no saved bill yet — what a reload would lose. */
export function unsavedItemCount(cart) {
  return (cart || []).filter(item => item && item.existingBillItem !== true).length;
}

/**
 * What tapping a table in the Quick Billing picker should do.
 *
 *   set   — free table: change the number and nothing else. This is also
 *           how a running bill is moved to another table, so it stays
 *           exactly as it was.
 *   keep  — the running bill on that table is already in the cart. Re-loading
 *           it would throw away items added since, so it does not.
 *   load  — open that table's running bill. confirmMessage is non-empty only
 *           when doing so would discard unsaved cart lines; the caller must
 *           ask before going ahead, and do nothing at all if refused.
 */
export function tableSelectionPlan({ orders = [], tableNo, editingOrderDocId = null, cart = [] } = {}) {
  const table = String(tableNo ?? "").trim().padStart(2, "0");
  const stay = { action: "set", tableNo: table, orderDocId: null, confirmMessage: "" };

  const open = openBillForTable(orders, table);
  if (!open) return stay;

  // Without an id there is nothing to open; treating it as free at least
  // lets the counter carry on typing a bill.
  const orderDocId = billDocId(open);
  if (!orderDocId) return stay;

  if (editingOrderDocId && String(editingOrderDocId) === orderDocId) {
    return { action: "keep", tableNo: table, orderDocId, confirmMessage: "" };
  }

  const pending = unsavedItemCount(cart);
  return {
    action: "load",
    tableNo: table,
    orderDocId,
    confirmMessage: pending
      ? `Table ${table} already has a running bill.\n\nOpening it will discard the ${pending} item${pending === 1 ? "" : "s"} in the cart that are not saved to any bill yet.\n\nOpen the running bill?`
      : ""
  };
}
