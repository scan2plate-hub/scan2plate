import test from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_TYPES, normalizeOrderType, orderTypeLabel, orderTypeOf,
  needsTable, needsDeliveryAddress, needsCustomerPhone,
  deliveryFeeFor, formatDeliveryAddress, orderDestinationText, validateOrderTypeDetails
} from "../public/js/order-types.js";

/* ---------------- normalizing ---------------- */

test("the three order types are dine-in, takeaway and delivery", () => {
  assert.deepEqual(ORDER_TYPES, ["dine_in", "takeaway", "delivery"]);
});

test("the wordings other screens already write all normalize", () => {
  assert.equal(normalizeOrderType("Delivery"), "delivery");
  assert.equal(normalizeOrderType("home delivery"), "delivery");
  assert.equal(normalizeOrderType("Take Away"), "takeaway");
  assert.equal(normalizeOrderType("take-away"), "takeaway");
  assert.equal(normalizeOrderType("pickup"), "takeaway");
  assert.equal(normalizeOrderType("preorder_dine_in"), "dine_in");
  assert.equal(normalizeOrderType("table"), "dine_in");
  assert.equal(normalizeOrderType("token"), "dine_in");
});

test("anything unrecognised falls back to dine-in", () => {
  assert.equal(normalizeOrderType(""), "dine_in");
  assert.equal(normalizeOrderType(undefined), "dine_in");
  assert.equal(normalizeOrderType(null), "dine_in");
  assert.equal(normalizeOrderType("something else"), "dine_in");
});

test("labels are what the counter reads", () => {
  assert.equal(orderTypeLabel("delivery"), "Delivery");
  assert.equal(orderTypeLabel("takeaway"), "Takeaway");
  assert.equal(orderTypeLabel("dine_in"), "Dine-in");
});

/* ---------------- existing data must not change meaning ---------------- */

test("an order saved before this feature existed stays a dine-in order", () => {
  assert.equal(orderTypeOf({ tableNo: "04", grandTotal: 420 }), "dine_in");
  assert.equal(orderTypeOf({}), "dine_in");
});

test("orderType wins over the older orderMode field", () => {
  assert.equal(orderTypeOf({ orderType: "delivery", orderMode: "table" }), "delivery");
});

test("an order with only the old orderMode is still read correctly", () => {
  assert.equal(orderTypeOf({ orderMode: "delivery" }), "delivery");
  assert.equal(orderTypeOf({ orderMode: "takeaway" }), "takeaway");
  assert.equal(orderTypeOf({ orderMode: "token", businessMode: "vendor" }), "dine_in");
});

/* ---------------- what each type needs ---------------- */

test("only dine-in needs a table", () => {
  assert.equal(needsTable("dine_in"), true);
  assert.equal(needsTable("takeaway"), false);
  assert.equal(needsTable("delivery"), false);
});

test("only delivery needs an address", () => {
  assert.equal(needsDeliveryAddress("delivery"), true);
  assert.equal(needsDeliveryAddress("takeaway"), false);
  assert.equal(needsDeliveryAddress("dine_in"), false);
});

test("takeaway and delivery both need a number to call back on", () => {
  assert.equal(needsCustomerPhone("takeaway"), true);
  assert.equal(needsCustomerPhone("delivery"), true);
  assert.equal(needsCustomerPhone("dine_in"), false);
});

/* ---------------- delivery fee ---------------- */

test("dine-in and takeaway are never charged a delivery fee", () => {
  const settings = { deliveryFee: 40 };
  assert.equal(deliveryFeeFor("dine_in", 500, settings), 0);
  assert.equal(deliveryFeeFor("takeaway", 500, settings), 0);
});

test("delivery is charged the configured fee", () => {
  assert.equal(deliveryFeeFor("delivery", 200, { deliveryFee: 40 }), 40);
});

test("an order at or above the free-delivery threshold pays nothing", () => {
  const settings = { deliveryFee: 40, freeDeliveryThreshold: 500 };
  assert.equal(deliveryFeeFor("delivery", 499, settings), 40);
  assert.equal(deliveryFeeFor("delivery", 500, settings), 0, "at the threshold delivery is free");
  assert.equal(deliveryFeeFor("delivery", 900, settings), 0);
});

test("a zero threshold means no threshold, not free delivery for everyone", () => {
  assert.equal(deliveryFeeFor("delivery", 10, { deliveryFee: 40, freeDeliveryThreshold: 0 }), 40);
});

test("a missing or nonsense fee setting charges nothing rather than NaN", () => {
  assert.equal(deliveryFeeFor("delivery", 200, {}), 0);
  assert.equal(deliveryFeeFor("delivery", 200, { deliveryFee: "abc" }), 0);
  assert.equal(deliveryFeeFor("delivery", 200, { deliveryFee: -10 }), 0);
});

/* ---------------- address formatting ---------------- */

test("the address joins only the parts that were filled in", () => {
  assert.equal(
    formatDeliveryAddress({ deliveryAddress: "12 Laheriasarai Rd", landmark: "Near SBI", postalCode: "846001" }),
    "12 Laheriasarai Rd, Near SBI, 846001"
  );
  assert.equal(formatDeliveryAddress({ deliveryAddress: "12 Laheriasarai Rd" }), "12 Laheriasarai Rd");
  assert.equal(formatDeliveryAddress({}), "");
});

test("blank fields never leave stray commas", () => {
  assert.equal(formatDeliveryAddress({ deliveryAddress: "House 4", landmark: "   ", postalCode: "846004" }), "House 4, 846004");
});

/* ---------------- destination shown on tickets ---------------- */

test("a dine-in order still prints its table", () => {
  assert.equal(orderDestinationText({ tableNo: "07" }), "Table 07");
});

test("a token order still prints its token", () => {
  assert.equal(orderDestinationText({ orderMode: "token", businessMode: "vendor", tokenNo: "T-12" }), "Token T-12");
});

test("a delivery order prints where it is going", () => {
  assert.equal(
    orderDestinationText({ orderType: "delivery", deliveryAddress: "House 4", landmark: "Near SBI" }),
    "House 4, Near SBI"
  );
});

test("a delivery order with no address typed still says Delivery", () => {
  assert.equal(orderDestinationText({ orderType: "delivery" }), "Delivery");
});

test("a takeaway order says so", () => {
  assert.equal(orderDestinationText({ orderType: "takeaway" }), "Takeaway / Pickup");
});

/* ---------------- validation ---------------- */

test("a dine-in bill needs a table and nothing else", () => {
  assert.equal(validateOrderTypeDetails("dine_in", { tableNo: "04" }), "");
  assert.notEqual(validateOrderTypeDetails("dine_in", { tableNo: "" }), "");
});

test("a dine-in bill does not need a phone number", () => {
  assert.equal(validateOrderTypeDetails("dine_in", { tableNo: "04", customerPhone: "" }), "");
});

test("a delivery bill without an address is blocked", () => {
  const error = validateOrderTypeDetails("delivery", { customerPhone: "9876543210", deliveryAddress: "" });
  assert.match(error, /address/i);
});

test("a delivery bill without a usable phone number is blocked", () => {
  const error = validateOrderTypeDetails("delivery", { customerPhone: "98765", deliveryAddress: "House 4" });
  assert.match(error, /contact number/i);
});

test("a complete delivery bill passes", () => {
  assert.equal(validateOrderTypeDetails("delivery", { customerPhone: "+91 98765 43210", deliveryAddress: "House 4" }), "");
});

test("a takeaway bill needs a phone but no address", () => {
  assert.equal(validateOrderTypeDetails("takeaway", { customerPhone: "9876543210" }), "");
  assert.match(validateOrderTypeDetails("takeaway", { customerPhone: "" }), /contact number/i);
});

test("a formatted phone number counts its digits, not its punctuation", () => {
  assert.equal(validateOrderTypeDetails("takeaway", { customerPhone: "+91-98765-43210" }), "");
});
