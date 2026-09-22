import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, collection } from "firebase/firestore";
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const env = await initializeTestEnvironment({
  projectId: "scan2plate-test",
  firestore: { rules: readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 }
});

const RID = "RST006";
const OWNER_UID = "owner-uid-1";
const OTHER_UID = "other-uid-2";
const SUPER_UID = "super-uid-3";

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
  await setDoc(doc(db, "orders", "ORD1"), { restaurantId: RID, grandTotal: 500, paymentStatus: "unpaid" });
  await setDoc(doc(db, "superAdmins", SUPER_UID), { role: "super_admin", status: "active" });
  await setDoc(doc(db, "subscriptionPlans", "p1"), { name: "Starter", monthlyPrice: 499 });
  await setDoc(doc(db, "offers", "o1"), { code: "FREE100", discountValue: 100 });
  await setDoc(doc(db, "subscriptions", "sub1"), { restaurantId: RID, status: "active" });
  await setDoc(doc(db, "auditLogs", "log1"), { action: "staff_login" });
});

const anon  = env.unauthenticatedContext().firestore();
const owner = env.authenticatedContext(OWNER_UID, { email: "owner@example.com" }).firestore();
const other = env.authenticatedContext(OTHER_UID, { email: "attacker@example.com" }).firestore();
const sup   = env.authenticatedContext(SUPER_UID, { email: "super@example.com" }).firestore();

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
