import test from "node:test";
import assert from "node:assert/strict";
import { allocateFromCounter, formatBillSerial, billDisplayNumber } from "../public/js/common.js";

// allocateFromCounter is the arithmetic inside the Firestore transaction that
// hands out bill serials. Firestore guarantees the transaction is atomic; these
// tests pin down the part that lives in our code — that the number always moves
// forward, never repeats, and copes with the documents already in production.

test("numbers bills sequentially from an empty counter", () => {
  let counter = {};
  const issued = [];
  for (let i = 0; i < 5; i += 1) {
    const { dailyOrderNo, billSerialNumber } = allocateFromCounter(counter);
    issued.push(formatBillSerial(billSerialNumber));
    counter = { lastDailyOrderNo: dailyOrderNo, lastBillSerialNumber: billSerialNumber };
  }
  assert.deepEqual(issued, ["001", "002", "003", "004", "005"]);
});

test("continues from an existing counter rather than restarting", () => {
  // Reopening the browser, or a second device joining mid-shift, both read the
  // same stored counter — neither may restart the sequence.
  const { billSerialNumber } = allocateFromCounter({ lastDailyOrderNo: 125, lastBillSerialNumber: 125 });
  assert.equal(billSerialNumber, 126);
  assert.equal(formatBillSerial(billSerialNumber), "126");
});

test("seeds the bill serial from the daily order counter for a day that predates bill serials", () => {
  // A business day already part-way through when this feature shipped: the
  // counter has lastDailyOrderNo but no lastBillSerialNumber. Restarting at 1
  // would collide with bills already printed earlier the same day.
  const { billSerialNumber } = allocateFromCounter({ lastDailyOrderNo: 12 });
  assert.equal(billSerialNumber, 13);
});

test("a cancelled or deleted bill never releases its number", () => {
  // Bill 3 is cancelled. The counter is untouched, so the next bill is 4 — the
  // cancelled number is retired, not handed out again.
  const afterThreeBills = { lastDailyOrderNo: 3, lastBillSerialNumber: 3 };
  assert.equal(allocateFromCounter(afterThreeBills).billSerialNumber, 4);
});

test("two same-instant allocations off the same counter snapshot collide, which is what the transaction retries", () => {
  // Both devices read the same pre-write snapshot and compute the same number.
  // This is precisely the contention Firestore's runTransaction detects and
  // retries; the test documents why the allocation MUST stay inside it.
  const snapshot = { lastDailyOrderNo: 7, lastBillSerialNumber: 7 };
  assert.equal(allocateFromCounter(snapshot).billSerialNumber, allocateFromCounter(snapshot).billSerialNumber);
  // After the winner commits, the loser re-reads and gets the next number.
  assert.equal(allocateFromCounter({ lastDailyOrderNo: 8, lastBillSerialNumber: 8 }).billSerialNumber, 9);
});

test("ignores corrupt or negative counter values instead of going backwards", () => {
  assert.equal(allocateFromCounter({ lastBillSerialNumber: -4 }).billSerialNumber, 1);
  assert.equal(allocateFromCounter({ lastBillSerialNumber: "not a number" }).billSerialNumber, 1);
  assert.equal(allocateFromCounter({ lastBillSerialNumber: 4.7 }).billSerialNumber, 5);
});

test("pads serials for display without changing the stored number", () => {
  assert.equal(formatBillSerial(1), "001");
  assert.equal(formatBillSerial(24), "024");
  assert.equal(formatBillSerial(1042), "1042");
  assert.equal(formatBillSerial(0), "");
  assert.equal(formatBillSerial(undefined), "");
});

// Backward compatibility: bills already in production have no billSerialNumber.
// They must still open and print, showing the number they have always shown.
test("falls back gracefully for bills created before serials existed", () => {
  assert.equal(billDisplayNumber({ billSerialNumber: 24, dailyOrderNo: 99 }), "024");
  assert.equal(billDisplayNumber({ dailyOrderNo: 7 }), "007");
  assert.equal(billDisplayNumber({ displayOrderNo: "12" }), "012");
  assert.equal(billDisplayNumber({ orderId: "ORD1737000000" }), "ORD1737000000");
  assert.equal(billDisplayNumber({}), "-");
});
