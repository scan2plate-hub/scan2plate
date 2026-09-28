/* =========================================================
   SETTLING A BILL FROM THE BILLING SCREEN
   ---------------------------------------------------------
   Marking a bill paid and printing it were both possible, on
   two other screens. A counter finishing an order in Quick
   Billing had to leave it, find the order in a list, and act
   there — while the customer waited at the counter.

   The sequence a counter actually performs is: take the
   money, record how it came in, decide whether this customer
   wants paper. So that is the sequence: Paid -> method ->
   print or not. Printing is asked, never assumed, because
   most customers do not want the slip and the roll is not
   free.

   What decides whether those buttons are available is here,
   as data. The rules are small but each one exists because
   the alternative is wrong, and they are easier to trust
   when they can be read in one place and tested.
========================================================= */

/** The four ways money arrives, in the order a counter reaches for them. */
export const PAYMENT_METHODS = [
  { key: "cash", label: "Cash" },
  { key: "upi", label: "UPI" },
  { key: "card", label: "Card" },
  { key: "other", label: "Other" }
];

export function paymentMethodLabel(key) {
  return PAYMENT_METHODS.find(method => method.key === String(key || "").toLowerCase())?.label || "Other";
}

export function isPaid(paymentStatus) {
  return String(paymentStatus || "").toLowerCase() === "paid";
}

/**
 * Which bill actions are live, and why not when they are not.
 *
 * `reason` is written to be shown to the person, so it says what to do next
 * rather than what went wrong. A disabled button with no explanation is the
 * thing a counter calls the owner about.
 *
 *   savedOrderId — the order exists in Firestore. Nothing can be settled or
 *                  printed before that: a bill has no number until it is
 *                  saved, and a printed slip without one cannot be found again.
 *   cartCount    — an order with no items is not a bill.
 */
export function billActionState({ savedOrderId = "", cartCount = 0, paymentStatus = "unpaid" } = {}) {
  const saved = Boolean(String(savedOrderId || ""));
  const paid = isPaid(paymentStatus);

  if (!saved) {
    return {
      saved: false,
      paid: false,
      canPrint: false,
      canMarkPaid: false,
      canMarkUnpaid: false,
      reason: cartCount
        ? "Create the order first — a bill needs a number before it can be printed or settled."
        : "Add items to start a bill."
    };
  }

  return {
    saved: true,
    paid,
    canPrint: cartCount > 0,
    // Already paid is not an error worth a prompt; the button simply rests.
    canMarkPaid: !paid,
    canMarkUnpaid: paid,
    reason: ""
  };
}

/**
 * The steps a Paid tap runs through.
 *
 * Returned rather than performed so the order can be asserted. Recording the
 * payment comes before offering the print: if the printer dialog is
 * cancelled, or the roll is out, the money is still recorded. The reverse
 * loses the payment to a paper problem.
 */
export function settleSteps({ method = "cash", print = false } = {}) {
  const steps = [{ step: "record-payment", method, status: "paid" }];
  if (print) steps.push({ step: "print-bill" });
  return steps;
}
