# Order types: dine-in, takeaway and delivery

## What changed

The Quick Billing screen in the admin dashboard could only create **table**
orders. Staff taking a takeaway or a phone-delivery order at the counter had
nowhere to record it, and nowhere to write the customer's address.

Quick Billing now has an **Order Type** selector with three options, and each
one asks only for what it needs:

| Order type | Asks for | Hides |
|---|---|---|
| Dine-in | Table number | — |
| Takeaway | Contact number, pickup time | Table, address |
| Delivery | Contact number, address, landmark, pincode, delivery fee, rider, delivery note | Table |

Dine-in remains the default, so nothing about the existing table workflow
changes.

## What already existed (and was left alone)

Three things already handled delivery and were **not** rebuilt:

1. **`customer-order.html`** — the public pre-order / delivery site. It already
   offered Dine-in Pre-Order, Takeaway and Delivery, and already captured the
   address, landmark and pincode.
2. **The "Online Orders" section** of the admin dashboard — already had
   Pre-orders / Delivery Orders / Takeaway Orders tabs with *Out for Delivery*,
   *Delivered* and *Ready for Pickup* actions.
3. **"Delivery Integrations"** — Zomato / Swiggy / ONDC aggregator settings.
   Unrelated to taking an order at the counter.

The gap was the counter, not the web. That is what this change fills.

## Where the details show up

A delivery or takeaway order now identifies itself everywhere the counter and
the kitchen look:

- **Order cards** (Live Orders, Dashboard) — a Delivery / Takeaway badge, plus a
  coloured strip with the address, landmark, delivery note, rider, fee, contact
  number and a one-tap **Call** button.
- **KOT preview and the kitchen display** — a `Type` row, and a `Deliver To` row
  carrying the address on the ticket that rides with the food.
- **Printed bill** — a `Type` row, the address, and a `Delivery Fee` line so the
  rows add up to the total. The Table row is hidden when there is no table.

## Money

The delivery fee is added to the order total in exactly one place —
`effectiveOrderTotals()` in `public/js/admin.js` — so the order card, the bill
and the reports all show the same figure the customer was charged.

`calculateOrderTotals()` in `common.js` still knows only about items, discount
and tax; it was not changed. The online-orders card previously added the fee
itself (`effective.grandTotal + order.deliveryFee`); that now happens upstream,
and the duplicate addition was removed so the fee is not counted twice.

A stored `grandTotal` on a legacy record already includes any fee, so that
branch does not re-add it.

**Note:** revenue reports now include delivery fees in the order total, because
that is what the customer paid.

### Default fee

A delivery order picks up the restaurant's own **Delivery Fee** from
*Settings → Delivery Settings* when the fee box is left blank, and respects the
**Free delivery threshold**. A threshold of `0` means *no threshold* — it does
not make every delivery free. Staff can always type over the suggested fee.

## Existing data

Orders saved before this change have no `orderType` field. `orderTypeOf()`
reads `orderType`, then the older `orderMode`, then `source`, and only then
falls back to `dine_in` — which is what those orders were. **No existing order
changes meaning, and no data migration is needed.**

Token orders (street vendor / cafe token mode) are still dine-in and still
print their token, not a table.

## Validation

A bill is blocked before it is saved when:

- a dine-in order has no table number;
- a takeaway or delivery order has no 10-digit contact number;
- a delivery order has no address.

Dine-in still needs no phone number, so walk-in billing is as fast as it was.

## Code

`public/js/order-types.js` is the single source of truth for what an order type
is called, what it needs, and how its fee is worked out. It is imported by the
billing screen, the order list, the bill, the KOT and the kitchen display, so
all five agree. It is covered by `test/order-types.test.mjs` (29 tests).
