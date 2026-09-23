import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection } from "firebase/firestore";
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const env = await initializeTestEnvironment({
  projectId: "scan2serve-23bf6",
  firestore: { rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 }
});

const RID = "RST006";
const OWNER_UID = "owner-uid-1";
const OTHER_UID = "other-uid-2";
const SUPER_UID = "super-uid-3";
const STAFF_UID = "staff-uid-4";     // a manager at RID, not the owner
const RID2 = "RST007";               // a different restaurant

// Seed with rules disabled, the way real data already exists.
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, "restaurants", RID), { restaurantName: "Old Monk Cafe", adminUid: OWNER_UID, status: "active", businessType: "cafe" });
  await setDoc(doc(db, "restaurants", RID, "private", "profile"), { ownerName: "A Person", adminEmail: "owner@example.com", phone: "+919876543210", gstNumber: "10ABCDE1234F1Z5" });
  await setDoc(doc(db, "restaurants", RID, "menu", "item1"), { name: "Masala Chai", price: 30 });
  await setDoc(doc(db, "restaurants", RID, "settings", "general"), { upiId: "x@ybl", taxPercent: 5 });
  await setDoc(doc(db, "restaurants", RID, "tables", "01"), { tableNo: "01" });
  await setDoc(doc(db, "restaurants", RID, "staff", "s1"), { name: "Staff One", salary: 12000 });
  await setDoc(doc(db, "restaurants", RID, "expenses", "e1"), { amount: 5000 });
  await setDoc(doc(db, "restaurants", RID, "attendance", "a1"), { present: true });
  await setDoc(doc(db, "restaurants", RID, "inventory_items", "i1"), { name: "Tea leaves" });
  await setDoc(doc(db, "restaurants", RID, "users", "owner_example_com"), { uid: OWNER_UID, role: "admin", email: "owner@example.com" });
  // A manager: their own Firebase account, not the restaurant's adminUid.
  await setDoc(doc(db, "restaurants", RID, "users", "manager_example_com"), { uid: STAFF_UID, role: "manager", email: "manager@example.com", status: "active" });
  // A second restaurant, to prove staff cannot cross the boundary.
  await setDoc(doc(db, "restaurants", RID2), { restaurantName: "Other Cafe", adminUid: "someone-else", status: "active" });
  await setDoc(doc(db, "restaurants", RID2, "staff", "s9"), { name: "Their Staff", salary: 20000 });
  await setDoc(doc(db, "orders", "ORD1"), { restaurantId: RID, grandTotal: 500, paymentStatus: "unpaid" });
  await setDoc(doc(db, "superAdmins", SUPER_UID), { role: "super_admin", status: "active" });
  await setDoc(doc(db, "subscriptionPlans", "p1"), { name: "Starter", monthlyPrice: 499 });
  await setDoc(doc(db, "offers", "o1"), { code: "FREE100", discountValue: 100 });
  await setDoc(doc(db, "subscriptions", "sub1"), { restaurantId: RID, status: "active" });
  await setDoc(doc(db, "auditLogs", "log1"), { action: "staff_login" });

  // A hotel, its own records, and a SECOND hotel to prove isolation.
  await setDoc(doc(db, "restaurants", RID, "hotel_rooms", "101"), { roomNumber: "101", status: "AVAILABLE" });
  await setDoc(doc(db, "restaurants", RID, "hotel_reservations", "bk1"), { roomId: "101", checkIn: "2026-10-01", checkOut: "2026-10-03" });
  await setDoc(doc(db, "restaurants", RID, "hotel_guests", "g1"), { name: "A Guest", phone: "+919000000000" });
  await setDoc(doc(db, "restaurants", RID, "hotel_guest_documents", "g1"), { passportNumber: "Z1234567", idScanUrl: "https://example.invalid/scan.jpg" });
  await setDoc(doc(db, "restaurants", RID, "hotel_folios", "f1"), { reservationId: "bk1", balance: 3000, status: "open" });
  await setDoc(doc(db, "restaurants", RID, "hotel_folios", "f2"), { reservationId: "bk2", status: "closed", invoiceNumber: "INV/00001", guestName: "A Guest" });
  await setDoc(doc(db, "hotelPayments", "pay1"), { restaurantId: RID, folioId: "f1", amount: 3000, status: "success" });
  await setDoc(doc(db, "hotelPayments", "pay2"), { restaurantId: RID, folioId: "f1", amount: 500, status: "pending" });
  await setDoc(doc(db, "hotelPayments", "pay9"), { restaurantId: RID2, folioId: "f9", amount: 100, status: "pending" });
  await setDoc(doc(db, "hotelInvoices", "INV_00001"), { restaurantId: RID, folioId: "f2", invoiceNumber: "INV/00001", guestName: "A Guest", totals: { total: 2500 } });
  await setDoc(doc(db, "restaurants", RID, "hotel_cashier_shifts", "S1"), { status: "ACTIVE", openingCash: 1000, cashierUid: STAFF_UID });
  await setDoc(doc(db, "restaurants", RID2, "hotel_cashier_shifts", "S9"), { status: "ACTIVE", openingCash: 500 });
  await setDoc(doc(db, "restaurants", RID, "hotel_corporate", "c1"), { name: "Acme", contractRate: 1900, commissionPercent: 12 });
  await setDoc(doc(db, "hotelNightAudits", "na1"), { restaurantId: RID, businessDate: "2026-10-01", roomRevenue: 50000 });
  await setDoc(doc(db, "hotelAuditLogs", "hal1"), { restaurantId: RID, action: "check_in", userId: STAFF_UID });
  await setDoc(doc(db, "hotelNightAudits", "na9"), { restaurantId: RID2, businessDate: "2026-10-01" });
  await setDoc(doc(db, "restaurants", RID2, "hotel_rooms", "201"), { roomNumber: "201", status: "AVAILABLE" });
  await setDoc(doc(db, "restaurants", RID2, "hotel_reservations", "bk9"), { roomId: "201", checkIn: "2026-10-01", checkOut: "2026-10-03" });
  await setDoc(doc(db, "restaurants", RID2, "hotel_guests", "g9"), { name: "Their Guest" });
  await setDoc(doc(db, "restaurants", RID, "hotel_room_nights", "101__2026-10-01"), { roomId: "101", stayDate: "2026-10-01", reservationId: "bk1", bookingId: "BK1" });
  await setDoc(doc(db, "restaurants", RID2, "hotel_room_nights", "201__2026-10-01"), { roomId: "201", stayDate: "2026-10-01", reservationId: "bk9" });
});

const anon  = env.unauthenticatedContext().firestore();
const owner = env.authenticatedContext(OWNER_UID, { email: "owner@example.com" }).firestore();
const other = env.authenticatedContext(OTHER_UID, { email: "attacker@example.com" }).firestore();
const sup   = env.authenticatedContext(SUPER_UID, { email: "super@example.com" }).firestore();
const staff = env.authenticatedContext(STAFF_UID, { email: "manager@example.com" }).firestore();

/* ================= what a customer MUST still be able to do ================= */

test("a customer can read the menu without signing in", async () => {
  await assertSucceeds(getDoc(doc(anon, "restaurants", RID, "menu", "item1")));
  await assertSucceeds(getDocs(collection(anon, "restaurants", RID, "menu")));
});

test("a customer can read the restaurant profile and settings to order", async () => {
  await assertSucceeds(getDoc(doc(anon, "restaurants", RID)));
  await assertSucceeds(getDoc(doc(anon, "restaurants", RID, "settings", "general")));
  await assertSucceeds(getDoc(doc(anon, "restaurants", RID, "tables", "01")));
});

test("the public ordering site can still list restaurants", async () => {
  await assertSucceeds(getDocs(collection(anon, "restaurants")));
});

test("a customer can place an order without signing in", async () => {
  await assertSucceeds(addDoc(collection(anon, "orders"), { restaurantId: RID, grandTotal: 120, items: [] }));
});

test("a customer can track their order", async () => {
  await assertSucceeds(getDoc(doc(anon, "orders", "ORD1")));
});

test("the pricing page can still read plans and offers", async () => {
  await assertSucceeds(getDocs(collection(anon, "subscriptionPlans")));
  await assertSucceeds(getDocs(collection(anon, "offers")));
});

test("the login audit entry can still be written", async () => {
  await assertSucceeds(addDoc(collection(anon, "auditLogs"), { action: "staff_login" }));
});

/* ================= the exposure this change is about ================= */

test("a stranger CANNOT read the owner's contact details", async () => {
  await assertFails(getDoc(doc(anon, "restaurants", RID, "private", "profile")));
});

test("a signed-in stranger CANNOT read another restaurant's owner details", async () => {
  await assertFails(getDoc(doc(other, "restaurants", RID, "private", "profile")));
});

test("the owner CAN read their own contact details", async () => {
  await assertSucceeds(getDoc(doc(owner, "restaurants", RID, "private", "profile")));
});

test("a super admin CAN read the private profile — the dashboard depends on it", async () => {
  await assertSucceeds(getDoc(doc(sup, "restaurants", RID, "private", "profile")));
});

test("the owner can update their own private profile", async () => {
  await assertSucceeds(setDoc(doc(owner, "restaurants", RID, "private", "profile"), { ownerName: "New Name" }, { merge: true }));
});

test("a stranger CANNOT write to the private profile", async () => {
  await assertFails(setDoc(doc(anon, "restaurants", RID, "private", "profile"), { adminEmail: "attacker@x.com" }));
  await assertFails(setDoc(doc(other, "restaurants", RID, "private", "profile"), { adminEmail: "attacker@x.com" }));
});

/* ================= staff and money data ================= */

test("a stranger CANNOT read staff records or salaries", async () => {
  await assertFails(getDoc(doc(anon, "restaurants", RID, "staff", "s1")));
  await assertFails(getDocs(collection(anon, "restaurants", RID, "staff")));
});

test("a stranger CANNOT read expenses, attendance or inventory", async () => {
  await assertFails(getDoc(doc(anon, "restaurants", RID, "expenses", "e1")));
  await assertFails(getDoc(doc(anon, "restaurants", RID, "attendance", "a1")));
  await assertFails(getDoc(doc(anon, "restaurants", RID, "inventory_items", "i1")));
});

test("a signed-in stranger CANNOT read another restaurant's staff", async () => {
  await assertFails(getDoc(doc(other, "restaurants", RID, "staff", "s1")));
});

test("the owner CAN read their own staff and expenses", async () => {
  await assertSucceeds(getDoc(doc(owner, "restaurants", RID, "staff", "s1")));
  await assertSucceeds(getDoc(doc(owner, "restaurants", RID, "expenses", "e1")));
});

/* ================= non-owner staff must still be able to work ================= */

test("a manager (not the owner) can read their restaurant's inventory and expenses", async () => {
  await assertSucceeds(getDoc(doc(staff, "restaurants", RID, "inventory_items", "i1")));
  await assertSucceeds(getDoc(doc(staff, "restaurants", RID, "expenses", "e1")));
});

test("a manager can read their restaurant's staff and attendance", async () => {
  await assertSucceeds(getDoc(doc(staff, "restaurants", RID, "staff", "s1")));
  await assertSucceeds(getDoc(doc(staff, "restaurants", RID, "attendance", "a1")));
});

test("a manager can edit the menu", async () => {
  await assertSucceeds(updateDoc(doc(staff, "restaurants", RID, "menu", "item1"), { price: 35 }));
});

test("a manager CANNOT read another restaurant's staff", async () => {
  await assertFails(getDoc(doc(staff, "restaurants", RID2, "staff", "s9")));
});

test("a manager CANNOT read the owner's private contact details", async () => {
  await assertFails(getDoc(doc(staff, "restaurants", RID, "private", "profile")));
});

/* ================= tampering ================= */

test("a stranger CANNOT edit the menu or prices", async () => {
  await assertFails(updateDoc(doc(anon, "restaurants", RID, "menu", "item1"), { price: 1 }));
  await assertFails(deleteDoc(doc(anon, "restaurants", RID, "menu", "item1")));
});

test("a stranger CANNOT change the restaurant's plan or settings", async () => {
  await assertFails(updateDoc(doc(anon, "restaurants", RID), { plan: "advance" }));
  await assertFails(updateDoc(doc(anon, "restaurants", RID, "settings", "general"), { upiId: "attacker@ybl" }));
});

test("a signed-in stranger CANNOT upgrade someone else's plan", async () => {
  await assertFails(updateDoc(doc(other, "restaurants", RID), { plan: "advance" }));
});

test("a stranger CANNOT mark a bill paid or delete an order", async () => {
  await assertFails(updateDoc(doc(anon, "orders", "ORD1"), { paymentStatus: "paid" }));
  await assertFails(deleteDoc(doc(anon, "orders", "ORD1")));
});

test("a stranger CANNOT redirect payments by rewriting the UPI ID", async () => {
  await assertFails(updateDoc(doc(anon, "restaurants", RID, "settings", "general"), { upiId: "attacker@upi" }));
});

/* ================= privilege escalation ================= */

test("nobody can make themselves a super admin", async () => {
  await assertFails(setDoc(doc(anon,  "superAdmins", "anyone"), { role: "super_admin" }));
  await assertFails(setDoc(doc(other, "superAdmins", OTHER_UID), { role: "super_admin" }));
  await assertFails(setDoc(doc(owner, "superAdmins", OWNER_UID), { role: "super_admin" }));
});

test("a stranger CANNOT enumerate the super admin list", async () => {
  await assertFails(getDocs(collection(anon, "superAdmins")));
  await assertFails(getDocs(collection(other, "superAdmins")));
});

test("a stranger CANNOT mint a 100% discount coupon", async () => {
  await assertFails(setDoc(doc(anon,  "offers", "evil"), { code: "FREE", discountValue: 100 }));
  await assertFails(setDoc(doc(other, "offers", "evil"), { code: "FREE", discountValue: 100 }));
});

test("a stranger CANNOT rewrite subscription plan pricing", async () => {
  await assertFails(setDoc(doc(other, "subscriptionPlans", "p1"), { monthlyPrice: 0 }));
});

test("a stranger CANNOT activate a subscription", async () => {
  await assertFails(updateDoc(doc(other, "subscriptions", "sub1"), { status: "active" }));
});

test("a super admin CAN manage plans and offers", async () => {
  await assertSucceeds(setDoc(doc(sup, "subscriptionPlans", "p2"), { name: "Pro", monthlyPrice: 999 }));
  await assertSucceeds(setDoc(doc(sup, "offers", "o2"), { code: "HALF", discountValue: 50 }));
});

/* ================= audit log integrity ================= */

test("audit history cannot be edited or erased by anyone", async () => {
  await assertFails(updateDoc(doc(anon,  "auditLogs", "log1"), { action: "x" }));
  await assertFails(deleteDoc(doc(owner, "auditLogs", "log1")));
  await assertFails(deleteDoc(doc(sup,   "auditLogs", "log1")));
});

test("a stranger CANNOT read the audit log", async () => {
  await assertFails(getDocs(collection(anon, "auditLogs")));
});

/* ================= default deny ================= */

test("a collection nobody wrote a rule for is closed", async () => {
  await assertFails(getDoc(doc(anon, "someFutureCollection", "x")));
  await assertFails(setDoc(doc(anon, "someFutureCollection", "x"), { a: 1 }));
});

test.after(async () => { await env.cleanup(); });

/* ================= hotel PMS =================

   Section 45: hotel data is isolated by business, sensitive guest
   documents are not exposed to unauthorised staff, and the records that
   close the books cannot be rewritten afterwards.
============================================================ */

test("hotel front-desk records are readable and writable by the hotel's own staff", async () => {
  for (const name of ["hotel_rooms", "hotel_reservations", "hotel_guests", "hotel_folios"]) {
    await assertSucceeds(getDocs(collection(staff, "restaurants", RID, name)));
  }
  await assertSucceeds(setDoc(doc(staff, "restaurants", RID, "hotel_reservations", "bk-new"),
    { roomId: "101", checkIn: "2026-11-01", checkOut: "2026-11-03" }));
  await assertSucceeds(updateDoc(doc(staff, "restaurants", RID, "hotel_rooms", "101"), { status: "OCCUPIED" }));
});

test("ONE HOTEL CANNOT READ ANOTHER HOTEL'S DATA", async () => {
  // The whole of section 45 in one test. Staff of RID are strangers at RID2.
  for (const name of ["hotel_rooms", "hotel_reservations", "hotel_guests"]) {
    await assertFails(getDocs(collection(staff, "restaurants", RID2, name)));
    await assertFails(getDoc(doc(staff, "restaurants", RID2, name, name === "hotel_rooms" ? "201" : name === "hotel_guests" ? "g9" : "bk9")));
  }
  await assertFails(setDoc(doc(staff, "restaurants", RID2, "hotel_reservations", "hijack"), { roomId: "201" }));
});

test("a signed-out stranger cannot read any hotel record", async () => {
  for (const name of ["hotel_rooms", "hotel_reservations", "hotel_guests", "hotel_folios", "hotel_corporate"]) {
    await assertFails(getDocs(collection(anon, "restaurants", RID, name)));
  }
  await assertFails(getDoc(doc(anon, "restaurants", RID, "hotel_guest_documents", "g1")));
});

test("a signed-in stranger cannot read a hotel's guests or bookings", async () => {
  await assertFails(getDocs(collection(other, "restaurants", RID, "hotel_guests")));
  await assertFails(getDoc(doc(other, "restaurants", RID, "hotel_reservations", "bk1")));
});

test("SECTION 9: staff see the guest, but NOT the guest's passport", async () => {
  // A receptionist needs the guest's name and phone to do their job. Nobody
  // below the owner needs their passport number or ID scan, which is why the
  // two live in different collections — Firestore rules are per document, so
  // one record with "sensitive fields" could not be half-readable.
  await assertSucceeds(getDoc(doc(staff, "restaurants", RID, "hotel_guests", "g1")));
  await assertFails(getDoc(doc(staff, "restaurants", RID, "hotel_guest_documents", "g1")));
  await assertFails(getDocs(collection(staff, "restaurants", RID, "hotel_guest_documents")));
  await assertSucceeds(getDoc(doc(owner, "restaurants", RID, "hotel_guest_documents", "g1")));
});

test("commercial terms are owner-level, not front-desk", async () => {
  // A corporate contract rate and an agent's commission are what the hotel
  // sells at, not what it sells. A receptionist has no business rewriting them.
  await assertFails(getDoc(doc(staff, "restaurants", RID, "hotel_corporate", "c1")));
  await assertFails(setDoc(doc(staff, "restaurants", RID, "hotel_corporate", "c2"), { name: "Forged", contractRate: 1 }));
  await assertSucceeds(getDoc(doc(owner, "restaurants", RID, "hotel_corporate", "c1")));
});

test("a closed night audit can never be edited or deleted", async () => {
  // A closing that can be rewritten afterwards is not a closing. This is the
  // test that forced these two collections out of restaurants/{rid}: under
  // that path the owner-level catch-all granted write, and `if false` on the
  // subcollection could not take it away.
  await assertSucceeds(getDoc(doc(staff, "hotelNightAudits", "na1")));
  await assertFails(updateDoc(doc(owner, "hotelNightAudits", "na1"), { roomRevenue: 1 }));
  await assertFails(deleteDoc(doc(owner, "hotelNightAudits", "na1")));
  await assertFails(updateDoc(doc(sup, "hotelNightAudits", "na1"), { roomRevenue: 1 }),
    "not even a super admin rewrites a closed day");
  // Creating tomorrow's close is the owner's to do.
  await assertSucceeds(setDoc(doc(owner, "hotelNightAudits", "na2"), { restaurantId: RID, businessDate: "2026-10-02" }));
  // And one hotel cannot read another's closed books.
  await assertFails(getDoc(doc(staff, "hotelNightAudits", "na9")));
});

test("SECTION 43: hotel audit entries are append-only", async () => {
  // Staff generate the trail by working; nobody may go back and change it.
  await assertSucceeds(setDoc(doc(staff, "hotelAuditLogs", "hal2"),
    { restaurantId: RID, action: "check_out", userId: STAFF_UID }));
  await assertFails(updateDoc(doc(staff, "hotelAuditLogs", "hal1"), { action: "tampered" }));
  await assertFails(updateDoc(doc(owner, "hotelAuditLogs", "hal1"), { action: "tampered" }));
  await assertFails(deleteDoc(doc(owner, "hotelAuditLogs", "hal1")));
  await assertFails(updateDoc(doc(sup, "hotelAuditLogs", "hal1"), { action: "tampered" }));
  // A staff member cannot forge an entry against a hotel they do not work at.
  await assertFails(setDoc(doc(staff, "hotelAuditLogs", "forged"), { restaurantId: RID2, action: "check_in" }));
});

test("adding hotel collections did not open anything for restaurants", async () => {
  // The regression that matters most: every existing business type must be
  // exactly as locked down as it was before the hotel rules were added.
  await assertFails(getDoc(doc(anon, "restaurants", RID, "private", "profile")));
  await assertFails(getDocs(collection(other, "restaurants", RID, "staff")));
  await assertFails(getDocs(collection(anon, "restaurants", RID, "expenses")));
  await assertSucceeds(getDoc(doc(anon, "restaurants", RID, "menu", "item1")));
});

test("room night locks are readable publicly but writable only by the hotel's staff", async () => {
  // The public booking engine needs to show what is free without a login.
  await assertSucceeds(getDoc(doc(anon, "restaurants", RID, "hotel_room_nights", "101__2026-10-01")));
  await assertSucceeds(getDocs(collection(anon, "restaurants", RID, "hotel_room_nights")));
  // But nobody outside the hotel may take, move or release a hold — that
  // would let a stranger block every room in the property, or free a night
  // a paying guest is standing in.
  await assertFails(setDoc(doc(anon, "restaurants", RID, "hotel_room_nights", "101__2026-11-01"), { roomId: "101" }));
  await assertFails(deleteDoc(doc(anon, "restaurants", RID, "hotel_room_nights", "101__2026-10-01")));
  await assertFails(deleteDoc(doc(other, "restaurants", RID, "hotel_room_nights", "101__2026-10-01")));
  await assertSucceeds(setDoc(doc(staff, "restaurants", RID, "hotel_room_nights", "101__2026-11-01"), { roomId: "101" }));
});

test("a hotel cannot release or take a hold at another hotel", async () => {
  await assertFails(deleteDoc(doc(staff, "restaurants", RID2, "hotel_room_nights", "201__2026-10-01")));
  await assertFails(setDoc(doc(staff, "restaurants", RID2, "hotel_room_nights", "201__2026-12-01"), { roomId: "201" }));
});

test("RULE 12: a settled payment can never be edited or deleted", async () => {
  // The two-step write stops a failed payment counting. This stops a counted
  // one being rewritten afterwards — by anyone, owner and super admin alike.
  await assertFails(updateDoc(doc(staff, "hotelPayments", "pay1"), { amount: 1 }));
  await assertFails(updateDoc(doc(owner, "hotelPayments", "pay1"), { status: "failed" }));
  await assertFails(updateDoc(doc(sup, "hotelPayments", "pay1"), { amount: 1 }));
  await assertFails(deleteDoc(doc(owner, "hotelPayments", "pay1")));
  // A payment still awaiting its outcome must remain settleable — settling
  // it IS an edit, and refusing that would make the two-step write unusable.
  await assertSucceeds(updateDoc(doc(staff, "hotelPayments", "pay2"), { status: "success" }));
});

test("RULES 15 and 16: an invoice is written once and never changed", async () => {
  await assertSucceeds(getDoc(doc(staff, "hotelInvoices", "INV_00001")));
  await assertFails(updateDoc(doc(staff, "hotelInvoices", "INV_00001"), { invoiceNumber: "INV/99999" }));
  await assertFails(updateDoc(doc(owner, "hotelInvoices", "INV_00001"), { totals: { total: 1 } }));
  await assertFails(updateDoc(doc(sup, "hotelInvoices", "INV_00001"), { totals: { total: 1 } }));
  await assertFails(deleteDoc(doc(owner, "hotelInvoices", "INV_00001")));
  await assertSucceeds(setDoc(doc(staff, "hotelInvoices", "INV_00002"),
    { restaurantId: RID, invoiceNumber: "INV/00002", totals: { total: 100 } }));
});

test("one hotel cannot read or forge another's payments and invoices", async () => {
  await assertFails(getDoc(doc(staff, "hotelPayments", "pay9")));
  await assertFails(updateDoc(doc(staff, "hotelPayments", "pay9"), { status: "success" }));
  await assertFails(setDoc(doc(staff, "hotelInvoices", "forged"), { restaurantId: RID2, invoiceNumber: "X" }));
  await assertFails(getDocs(collection(anon, "hotelPayments")));
  await assertFails(getDoc(doc(other, "restaurants", RID, "hotel_folios", "f1")));
});

test("SECTION 26: a cashier shift is the hotel's own, and nobody else's", async () => {
  await assertSucceeds(getDoc(doc(staff, "restaurants", RID, "hotel_cashier_shifts", "S1")));
  await assertSucceeds(updateDoc(doc(staff, "restaurants", RID, "hotel_cashier_shifts", "S1"), { status: "CLOSED" }));
  // A cashier at one property cannot read or touch another's drawer.
  await assertFails(getDoc(doc(staff, "restaurants", RID2, "hotel_cashier_shifts", "S9")));
  await assertFails(updateDoc(doc(staff, "restaurants", RID2, "hotel_cashier_shifts", "S9"), { openingCash: 0 }));
  await assertFails(getDocs(collection(anon, "restaurants", RID, "hotel_cashier_shifts")));
});

test("SECTION 25: a closed day is created once and can never be rewritten", async () => {
  // The audit is written at the top level precisely so this deny holds —
  // under restaurants/{rid} the owner-level catch-all would grant write.
  await assertSucceeds(setDoc(doc(owner, "hotelNightAudits", `${RID}_2026-10-05`),
    { restaurantId: RID, businessDate: "2026-10-05", occupancy: 62 }));
  await assertFails(updateDoc(doc(owner, "hotelNightAudits", `${RID}_2026-10-05`), { occupancy: 99 }));
  await assertFails(updateDoc(doc(sup, "hotelNightAudits", `${RID}_2026-10-05`), { occupancy: 99 }));
  await assertFails(deleteDoc(doc(owner, "hotelNightAudits", `${RID}_2026-10-05`)));
  // Staff may read the day that was closed; another property may not.
  await assertSucceeds(getDoc(doc(staff, "hotelNightAudits", `${RID}_2026-10-05`)));
  await assertFails(setDoc(doc(staff, "hotelNightAudits", "forged"), { restaurantId: RID2, businessDate: "2026-10-05" }));
});
