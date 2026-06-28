import { auth, db } from "./firebase.js";
import { EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { addDoc, collection, deleteDoc, doc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const allowedRoles = new Set(["admin", "owner", "super_admin"]);
const chunks = (list, size = 400) => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, index * size + size));
const esc = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function deleteSnapshots(snapshots) {
  for (const part of chunks(snapshots)) { const batch = writeBatch(db); part.forEach(snapshot => batch.delete(snapshot.ref)); await batch.commit(); }
}

async function deleteRestaurantCollection(restaurantId, name) {
  const snapshot = await getDocs(collection(db, "restaurants", restaurantId, name));
  await deleteSnapshots(snapshot.docs);
}

async function deletePurchaseBills(restaurantId) {
  const bills = await getDocs(collection(db, "restaurants", restaurantId, "purchase_bills"));
  for (const bill of bills.docs) {
    const items = await getDocs(collection(db, "restaurants", restaurantId, "purchase_bills", bill.id, "purchase_bill_items"));
    await deleteSnapshots(items.docs);
  }
  await deleteSnapshots(bills.docs);
}

export function mountSafeReset({ restaurantId, role, host, panelName = "Admin", defaultTokenReset = false, defaultTableReset = false }) {
  if (!host || !restaurantId || document.getElementById("safeResetZone")) return { deleteStaff: async () => {}, restoreStaff: async () => {} };
  const canReset = allowedRoles.has(String(role || "").toLowerCase());
  host.insertAdjacentHTML("beforeend", `<section id="safeResetZone" style="margin-top:22px;padding:18px;border:1px solid #f3b8b4;border-radius:12px;background:#fff5f5"><h3 style="margin:0;color:#aa2f2a">⚠ Danger Zone / Reset Data</h3><p style="margin:7px 0 14px;color:#7b3330;font-size:13px">Only current-business operational test data is affected. Menu, settings, QR links, login users, subscription and business profile are always kept.</p><div style="display:flex;gap:8px;flex-wrap:wrap" id="safeResetActions"><button class="btn btn-danger" data-reset="orders" type="button">Reset Test Orders</button><button class="btn btn-danger" data-reset="bills" type="button">Reset Bills & KOT</button><button class="btn btn-danger" data-reset="accounts" type="button">Reset Accounts Data</button><button class="btn btn-danger" data-reset="attendance" type="button">Reset Staff Attendance</button><button class="btn btn-danger" data-reset="payroll" type="button">Reset Payroll Data</button><button class="btn btn-danger" data-reset="expenses" type="button">Reset Expenses</button><button class="btn btn-danger" data-reset="delivery" type="button">Reset Delivery Orders</button><button class="btn btn-danger" data-reset="inventory" type="button">Reset Inventory Transactions</button><button class="btn btn-danger" data-reset="full" type="button">Full Fresh Start Reset</button></div><div style="margin-top:14px;display:flex;gap:14px;flex-wrap:wrap;font-size:13px"><label><input id="safeResetStaff" type="checkbox"> Also delete staff master (soft delete only)</label><label><input id="safeResetTokens" type="checkbox" ${defaultTokenReset ? "checked" : ""}> Also reset token counter</label><label><input id="safeResetTables" type="checkbox" ${defaultTableReset ? "checked" : ""}> Also reset table status</label><button class="btn btn-outline" id="safeResetDeletedStaff" type="button">View Deleted Staff</button></div><div id="safeResetDeletedList" style="margin-top:12px"></div></section>`);

  const audit = async (actionType, affectedCollections, confirmationText) => addDoc(collection(db, "restaurants", restaurantId, "resetLogs"), { restaurantId, businessId: restaurantId, actionType, moduleName: panelName, performedBy: auth.currentUser?.email || auth.currentUser?.uid || "unknown", performedAt: serverTimestamp(), affectedCollections, confirmationText, deviceInfo: navigator.userAgent || "" });
  const authorize = async (verb, actionType, affectedCollections) => {
    if (!canReset) { alert("Only Admin, Owner, or Super Admin can reset data."); return false; }
    const user = auth.currentUser;
    const password = window.prompt(`Enter your admin password to ${verb}.`);
    if (!password || !user?.email) { alert("Password incorrect. Reset cancelled."); return false; }
    try { await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password)); }
    catch { alert("Password incorrect. Reset cancelled."); return false; }
    const confirmation = window.prompt(`You are about to ${verb}. This cannot be undone. Type ${actionType === "delete_staff" ? "DELETE" : "RESET"} to continue.`);
    if (confirmation !== (actionType === "delete_staff" ? "DELETE" : "RESET")) { alert("Reset cancelled."); return false; }
    await audit(actionType, affectedCollections, confirmation);
    return true;
  };
  const deleteGlobalOrders = async () => deleteSnapshots((await getDocs(query(collection(db, "orders"), where("restaurantId", "==", restaurantId)))).docs);
  const deleteCompletedOrders = async () => { const orders = await getDocs(query(collection(db, "orders"), where("restaurantId", "==", restaurantId))); await deleteSnapshots(orders.docs.filter(row => ["completed", "served", "cancelled", "rejected"].includes(String(row.data().status || "").toLowerCase()) || row.data().billClosed === true)); };
  const resetTableStatus = async () => {
    const tables = await getDocs(collection(db, "restaurants", restaurantId, "tables"));
    for (const part of chunks(tables.docs)) { const batch = writeBatch(db); part.forEach(row => batch.set(row.ref, { status: "available", active: true, disabled: false, currentOrderId: null, activeBillId: null, customerName: null, billStatus: null, updatedAt: serverTimestamp() }, { merge: true })); await batch.commit(); }
  };
  const resetStaffFields = async (field) => {
    const staff = await getDocs(collection(db, "restaurants", restaurantId, "staff"));
    for (const part of chunks(staff.docs)) { const batch = writeBatch(db); part.forEach(row => batch.set(row.ref, field === "attendance" ? { attendance: {}, updatedAt: serverTimestamp() } : { advance: 0, deduction: 0, bonus: 0, payrollStatus: "Unpaid", updatedAt: serverTimestamp() }, { merge: true })); await batch.commit(); }
  };
  const resetInventory = async () => {
    const zero = window.prompt("Type KEEP to keep current stock quantities, or ZERO to set stock quantities to 0.", "KEEP");
    if (!["KEEP", "ZERO"].includes(zero)) throw new Error("Inventory reset cancelled.");
    await deleteRestaurantCollection(restaurantId, "inventory_logs"); await deletePurchaseBills(restaurantId);
    if (zero === "ZERO") for (const collectionName of ["inventory", "inventory_items"]) { const stock = await getDocs(collection(db, "restaurants", restaurantId, collectionName)); for (const part of chunks(stock.docs)) { const batch = writeBatch(db); part.forEach(row => batch.set(row.ref, { currentStock: 0, updatedAt: serverTimestamp(), lastUpdated: serverTimestamp() }, { merge: true })); await batch.commit(); } }
    return zero;
  };
  const operations = {
    orders: async () => { await deleteGlobalOrders(); await deleteRestaurantCollection(restaurantId, "live_orders"); },
    bills: async () => { await deleteCompletedOrders(); await deleteRestaurantCollection(restaurantId, "printed_bills"); await deleteRestaurantCollection(restaurantId, "kot_records"); },
    accounts: async () => { await deleteRestaurantCollection(restaurantId, "account_entries"); await deleteRestaurantCollection(restaurantId, "payments"); await deleteRestaurantCollection(restaurantId, "revenue_records"); },
    attendance: async () => { await resetStaffFields("attendance"); await deleteRestaurantCollection(restaurantId, "attendance_logs"); },
    payroll: async () => { await resetStaffFields("payroll"); await deleteRestaurantCollection(restaurantId, "payroll"); await deleteRestaurantCollection(restaurantId, "salary_slips"); },
    expenses: async () => deleteRestaurantCollection(restaurantId, "expenses"),
    delivery: async () => { await deleteRestaurantCollection(restaurantId, "delivery_orders"); await deleteRestaurantCollection(restaurantId, "delivery_settlements"); },
    inventory: resetInventory
  };
  const affected = { orders:["orders (restaurantId only)","live_orders"], bills:["printed_bills","kot_records"], accounts:["account_entries","payments","revenue_records"], attendance:["staff.attendance","attendance_logs"], payroll:["staff payroll fields","payroll","salary_slips"], expenses:["expenses"], delivery:["delivery_orders","delivery_settlements"], inventory:["inventory_logs","purchase_bills"] };
  document.getElementById("safeResetActions")?.addEventListener("click", async event => {
    const action = event.target.closest("button")?.dataset.reset; if (!action) return;
    const affectedCollections = action === "full" ? Object.values(affected).flat() : affected[action];
    if (!(await authorize(action === "full" ? "perform a full fresh-start reset" : `reset ${action} data`, action, affectedCollections))) return;
    try {
      if (action === "full") { for (const name of ["orders","bills","accounts","attendance","payroll","expenses","delivery"]) await operations[name](); await operations.inventory(); if (document.getElementById("safeResetTokens").checked) await deleteRestaurantCollection(restaurantId, "token_counters"); if (document.getElementById("safeResetTables").checked) await resetTableStatus(); if (document.getElementById("safeResetStaff").checked) { const staff = await getDocs(collection(db,"restaurants",restaurantId,"staff")); for (const row of staff.docs) await updateDoc(row.ref,{isDeleted:true,deletedAt:serverTimestamp(),deletedBy:auth.currentUser?.email||auth.currentUser?.uid||"admin"}); } }
      else { await operations[action](); if (action === "orders" && document.getElementById("safeResetTokens").checked) await deleteRestaurantCollection(restaurantId, "token_counters"); if (action === "orders" && document.getElementById("safeResetTables").checked) await resetTableStatus(); }
      alert("Selected data reset completed for this business only.");
    } catch (error) { alert(error.message || "Reset could not be completed."); }
  });
  const renderDeletedStaff = async () => { const root=document.getElementById("safeResetDeletedList"); const rows=await getDocs(query(collection(db,"restaurants",restaurantId,"staff"),where("isDeleted","==",true))); root.innerHTML=rows.docs.length ? rows.docs.map(row=>`<div style="display:flex;gap:8px;align-items:center;margin:5px 0"><span>${esc(row.data().name||"Staff")}</span><button class="btn btn-outline btn-sm" data-restore-staff="${row.id}" type="button">Restore</button></div>`).join("") : "<span class=\"muted\">No deleted staff.</span>"; root.querySelectorAll("[data-restore-staff]").forEach(button=>button.onclick=async()=>{await updateDoc(doc(db,"restaurants",restaurantId,"staff",button.dataset.restoreStaff),{isDeleted:false,restoredAt:serverTimestamp(),restoredBy:auth.currentUser?.email||auth.currentUser?.uid||"admin"});await audit("restore_staff",["staff"],"RESTORE");renderDeletedStaff();}); };
  document.getElementById("safeResetDeletedStaff")?.addEventListener("click", renderDeletedStaff);
  return { deleteStaff: async staffId => { if (!staffId || !(await authorize("soft delete this staff member", "delete_staff", ["staff"]))) return; await updateDoc(doc(db,"restaurants",restaurantId,"staff",staffId),{isDeleted:true,deletedAt:serverTimestamp(),deletedBy:auth.currentUser?.email||auth.currentUser?.uid||"admin"}); alert("Staff deleted safely. You can restore them from View Deleted Staff."); }, restoreStaff: async staffId => { await updateDoc(doc(db,"restaurants",restaurantId,"staff",staffId),{isDeleted:false,restoredAt:serverTimestamp()}); await audit("restore_staff",["staff"],"RESTORE"); } };
}
