import { app, auth, db } from "./firebase.js";
import { collection, doc, addDoc, setDoc, deleteDoc, getDocs, onSnapshot, query, where, limit, orderBy, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { getBusinessDate, normalizeResetTime, installAppSafety, registerCleanup, devError, showStuckFallback, debounce, setHtmlIfChanged, billDisplayNumber, isActiveStaffRecord, selectPayrollStaff } from "./common.js?v=freeze-fix-20260816";
import { subscribeOrders } from "./orders-store.js?v=fast-refresh-20260916";

installAppSafety({ pageName: "Admin Modules", stuckTimeoutMs: 18000 });

const user = (() => {
  try {
    return JSON.parse(localStorage.getItem("scan2plate_user") || localStorage.getItem("scan2serve_user") || "{}");
  } catch {
    return {};
  }
})();
const restaurantId = user.restaurantId || localStorage.getItem("scan2plate_last_restaurant_id");
if (!restaurantId) throw new Error("Missing restaurant context");
const money = v => `₹${Number(v || 0).toFixed(2)}`;
const esc = v => String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
let orders=[], expenses=[], staff=[], attendance=[], advances=[], payroll=[], integrations=[], moduleSettings={};
/* ---------------------------------------------------------
   CURRENT vs PAST STAFF

   `staff` holds every Staff Master document, including people
   who have left. Attendance, current Payroll, the advance-salary
   picker and every staff dropdown must be driven by currentStaff()
   — never by the raw collection, because a departed employee's
   document has to stay for accounting history.
--------------------------------------------------------- */
const currentStaff = () => staff.filter(isActiveStaffRecord);
const pastStaff = () => staff.filter(member => !isActiveStaffRecord(member));
const staffById = id => staff.find(member => member.id === id);

const resetTime = () => normalizeResetTime(moduleSettings.dailyOrderResetTime || moduleSettings.businessDayStartTime || "04:00");
const timezone = () => moduleSettings.timezone || moduleSettings.timeZone || "Asia/Kolkata";
const today = () => getBusinessDate(resetTime(), timezone());
const dateOf = o => { const v=[o.createdAt,o.timestamp,o.date,o.orderDate,o.time].find(Boolean); if(!v)return null; if(v.toDate)return v.toDate(); if(typeof v.seconds==="number")return new Date(v.seconds*1000); const d=new Date(v); if(!Number.isNaN(d.getTime()))return d; const m=String(v).match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/); return m?new Date(+m[3],+m[2]-1,+m[1]):null; };
const businessDateOf = o => o.businessDate || o.dailyOrderDate || (dateOf(o) ? getBusinessDate(resetTime(), timezone(), dateOf(o)) : "");
const orderNoValue = o => {
  const numeric = Number(o?.dailyOrderNumber ?? o?.dailyOrderNo ?? o?.orderNumber ?? o?.orderNo ?? o?.displayOrderNumber ?? o?.displayOrderNo ?? o?.tokenNumber);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};
const orderNoLabel = o => {
  const numeric = orderNoValue(o);
  return numeric === null ? "Order No. unavailable" : `Order No. ${numeric}`;
};
const createdMs = o => dateOf(o)?.getTime() || 0;
const numberedSortValue = (o, dir = "asc") => {
  const numeric = orderNoValue(o);
  if (numeric === null) return dir === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return numeric;
};
function sortBills(list, sortMode = "newest") {
  const direction = sortMode === "order-desc" || sortMode === "newest" ? "desc" : "asc";
  return [...list].sort((a, b) => {
    const aNo = orderNoValue(a), bNo = orderNoValue(b);
    if (sortMode === "amount-asc" || sortMode === "amount-desc") {
      if (aNo === null && bNo !== null) return 1;
      if (aNo !== null && bNo === null) return -1;
      if (aNo === null && bNo === null) return createdMs(b) - createdMs(a);
      const amountDiff = Number(a.grandTotal || 0) - Number(b.grandTotal || 0);
      if (amountDiff) return sortMode === "amount-asc" ? amountDiff : -amountDiff;
      return createdMs(b) - createdMs(a);
    }
    if (sortMode === "order-asc" || sortMode === "order-desc") {
      if (aNo === null && bNo !== null) return 1;
      if (aNo !== null && bNo === null) return -1;
      const noDiff = numberedSortValue(a, direction) - numberedSortValue(b, direction);
      if (noDiff) return sortMode === "order-asc" ? noDiff : -noDiff;
      return createdMs(b) - createdMs(a);
    }
    const dayDiff = String(businessDateOf(a)).localeCompare(String(businessDateOf(b)));
    if (dayDiff) return sortMode === "oldest" ? dayDiff : -dayDiff;
    if (aNo === null && bNo !== null) return 1;
    if (aNo !== null && bNo === null) return -1;
    const noDiff = numberedSortValue(a, direction) - numberedSortValue(b, direction);
    if (noDiff) return sortMode === "oldest" ? noDiff : -noDiff;
    return sortMode === "oldest" ? createdMs(a) - createdMs(b) : createdMs(b) - createdMs(a);
  });
}
const billSearchText = o => [o.orderId,o.id,o.tableNo,o.tokenNumber,o.dailyOrderNumber,o.dailyOrderNo,o.orderNumber,o.orderNo,o.displayOrderNumber,o.displayOrderNo,o.billSerialNumber,billDisplayNumber(o),o.customerName,o.customerPhone].join(" ").toLowerCase();
const billCard = (o, viewClass = "pb-view", printClass = "pb-print") => {
  const paid = String(o.paymentStatus || "unpaid").toLowerCase() === "paid";
  const tableOrToken = o.businessMode === "vendor" || o.orderMode === "token" ? `Token ${esc(o.tokenNo || o.tokenNumber || "-")}` : `Table ${esc(o.tableNo || "-")}`;
  return `<div class="card" style="padding:12px;margin:8px 0">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
      <div><strong>Bill No. ${esc(billDisplayNumber(o))}</strong><div class="small muted">${esc(orderNoLabel(o))}</div><div class="small muted">Order ID: ${esc(o.orderId || o.id)}</div></div>
      <span class="status-badge ${paid ? "success" : "warning"}">${paid ? "PAID" : "UNPAID"}</span>
    </div>
    <div class="small" style="margin-top:6px;">${tableOrToken} · ${esc(o.customerName || "Walk-in Customer")}</div>
    <div class="small muted">${esc(dateOf(o)?.toLocaleDateString() || "-")} · ${esc(dateOf(o)?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) || "-")}</div>
    <div class="small" style="margin-top:6px;">${Number(o.items?.length || 0)} items · ${money(o.grandTotal)}<br>Payment: ${esc(o.paymentMethod || "cash")}</div>
    <div class="btn-group" style="margin-top:7px"><button class="btn btn-outline ${viewClass}" data-id="${esc(o.id)}">View Bill</button><button class="btn btn-primary ${printClass}" data-id="${esc(o.id)}">Print Bill</button></div>
  </div>`;
};

// Runs after nav()/section() below have created the real "Print Bills"
// module UI. This used to keep its own parallel render()/onSnapshot(orders)
// pair (billCard with .pb-view/.pb-print classes) alongside the canonical
// one wired at the bottom of this file (renderBills(), .bill-view/.bill-print
// classes) — both writing into the same #bill-list on every order update,
// racing to bind two different sets of button handlers depending on which
// listener happened to fire last. That's why "View/Print Bill" clicks in
// this section could silently stop working. Only the DOM repositioning,
// the openOrderBillPicker entry point (used by the dashboard's quick
// action), and the restaurant-settings listener (the sole source of
// moduleSettings/today() in this file) are load-bearing; both are kept,
// now driving the single canonical renderBills().
setTimeout(() => {
  const nav=document.querySelector('.module-nav[data-module="print-bills"]'),main=document.querySelectorAll(".nav-group")[0],tables=document.querySelector('.nav-item[data-section="tables"]');
  if(nav&&main)main.insertBefore(nav,tables||null);
  window.openOrderBillPicker=()=>{open("print-bills","Print Bills","Select and print an order");renderBills();};
  const date=document.getElementById("bill-date");
  if(date&&!date.dataset.touched)date.value=today();
  if(date&&!date.dataset.touchTrackerBound){date.dataset.touchTrackerBound="1";date.addEventListener("input",()=>{date.dataset.touched="1"});}
  if(date&&!document.getElementById("bill-all-dates")){date.insertAdjacentHTML("afterend",'<button id="bill-all-dates" class="btn btn-outline btn-sm" type="button">All Dates</button>');document.getElementById("bill-all-dates")?.addEventListener("click",()=>{date.dataset.touched="1";date.value="";renderBills()});}
  subscribeWithAuthRetry("restaurant settings",doc(db,"restaurants",restaurantId),snap=>{moduleSettings=snap.exists()?snap.data():{};if(date&&!date.dataset.touched)date.value=today();scheduleModuleRender("print-bills");});
}, 0);

/* ---------------------------------------------------------
   RENDER ONLY WHAT IS ON SCREEN

   This was the main cause of the navigation lag. Every order
   write rebuilt the FULL Accounts table and the FULL Print Bills
   card list synchronously — thousands of DOM nodes — even when
   the user was looking at Tables or the Dashboard. The same
   applied to Attendance and Payroll on every attendance write.
   Switching sections then competed with that work on the main
   thread, so Print Bills -> Tables felt slow and got worse the
   more data the restaurant had.

   A hidden section is now only marked dirty; it renders once,
   when it is actually opened.
--------------------------------------------------------- */
const moduleSectionRenderers = {
  accounts: () => renderAccounts(),
  "print-bills": () => renderBills(),
  staff: () => renderStaff(),
  payroll: () => renderPayroll(),
  delivery: () => renderDelivery()
};
const dirtyModuleSections = new Set();

function isModuleSectionVisible(name) {
  return Boolean(document.getElementById(`module-${name}`)?.classList.contains("active"));
}

function scheduleModuleRender(name) {
  if (!moduleSectionRenderers[name]) return;
  if (!isModuleSectionVisible(name)) { dirtyModuleSections.add(name); return; }
  dirtyModuleSections.delete(name);
  try {
    moduleSectionRenderers[name]();
  } catch (error) {
    devError(`Module section render failed: ${name}`, error);
  }
}

function flushModuleSection(name) {
  if (!dirtyModuleSections.has(name)) return;
  dirtyModuleSections.delete(name);
  try {
    moduleSectionRenderers[name]?.();
  } catch (error) {
    devError(`Module section render failed: ${name}`, error);
  }
}

function nav(name, icon, title) { document.querySelectorAll(".nav-group")[1]?.insertAdjacentHTML("beforeend", `<a class="nav-item module-nav" data-module="${name}"><span class="nav-icon"><i class="fas ${icon}"></i></span>${title}</a>`); }
function section(name, html) { document.querySelector(".dashboard-content")?.insertAdjacentHTML("beforeend", `<section class="content-section module-section" id="module-${name}">${html}</section>`); }
function open(name,title,sub) { document.querySelectorAll(".content-section").forEach(x=>x.classList.remove("active")); document.querySelectorAll(".nav-item").forEach(x=>x.classList.remove("active")); document.getElementById(`module-${name}`)?.classList.add("active"); document.querySelector(`.module-nav[data-module="${name}"]`)?.classList.add("active"); document.getElementById("pageTitle").textContent=title;document.getElementById("pageSubtitle").textContent=sub; flushModuleSection(name); window.closeSidebarOnMobile?.(); }
function exportCsv(rows,name){const a=document.createElement("a"),csv=rows.map(r=>r.map(x=>`"${String(x??"").replaceAll('"','""')}"`).join(",")).join("\n");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download=name;a.click();}
function print(id,title){const w=window.open("","_blank");if(!w)return;w.document.write(`<title>${title}</title><style>body{font:14px Arial;color:#000}table{width:100%;border-collapse:collapse}th,td{border:1px solid #111;padding:7px}</style><h2>${title}</h2>${document.getElementById(id).innerHTML}`);w.document.close();w.print();}

function renderAccounts(){const paid=orders.filter(o=>String(o.paymentStatus).toLowerCase()==="paid"), todayPaid=paid.filter(o=>businessDateOf(o)===today()), rev=paid.reduce((s,o)=>s+Number(o.grandTotal||0),0), exp=expenses.reduce((s,x)=>s+Number(x.amount||0),0), cash=todayPaid.filter(o=>o.paymentMethod==="cash").reduce((s,o)=>s+Number(o.grandTotal||0),0),upi=todayPaid.filter(o=>o.paymentMethod==="upi").reduce((s,o)=>s+Number(o.grandTotal||0),0);setHtmlIfChanged(document.getElementById("acc-stats"),[["Total Revenue",rev],["Today's Revenue",todayPaid.reduce((s,o)=>s+Number(o.grandTotal||0),0)],["Cash",cash],["UPI",upi],["Paid Bills",paid.length],["Unpaid Bills",orders.length-paid.length],["Expenses",exp],["Net Profit",rev-exp]].map(x=>`<div class="stat-card blue"><div class="stat-label">${x[0]}</div><div class="stat-value">${typeof x[1]==="number"&&x[0]!=="Paid Bills"&&x[0]!=="Unpaid Bills"?money(x[1]):x[1]}</div></div>`).join("")); const rows=[...paid.map(o=>[dateOf(o)?.toLocaleDateString()||"", "Revenue",o.orderId||"",o.paymentMethod||"",o.grandTotal]),...expenses.map(e=>[e.date,"Expense",e.expenseName||e.category,e.paymentMode,-Number(e.amount)])];setHtmlIfChanged(document.getElementById("acc-table"),`<table class="data-table"><tr><th>Date</th><th>Type</th><th>Reference</th><th>Mode</th><th>Amount</th></tr>${rows.map(r=>`<tr>${r.map((x,i)=>`<td>${i===4?money(x):esc(x)}</td>`).join("")}</tr>`).join("")}</table>`);}
async function saveExpense(){const amt=Number(document.getElementById("ex-amount").value||0);if(!amt)return alert("Enter amount");const f=document.getElementById("ex-file").files[0];let receiptUrl="";if(f){const p=`restaurants/${restaurantId}/expense-receipts/${Date.now()}-${f.name}`;await uploadBytes(ref(getStorage(app),p),f);receiptUrl=await getDownloadURL(ref(getStorage(app),p));}await addDoc(collection(db,"restaurants",restaurantId,"expenses"),{expenseName:document.getElementById("ex-name").value||document.getElementById("ex-category").value,category:document.getElementById("ex-category").value,amount:amt,date:document.getElementById("ex-date").value||today(),paymentMode:document.getElementById("ex-mode").value,vendorName:document.getElementById("ex-vendor").value,note:document.getElementById("ex-note").value,receiptUrl,createdAt:serverTimestamp(),createdBy:user.email||user.uid||"admin"});}
function renderBills(){const q=(document.getElementById("bill-q")?.value||"").toLowerCase(),status=document.getElementById("bill-status")?.value||"", date=document.getElementById("bill-date")?.value||"",method=document.getElementById("bill-method")?.value||"",sortMode=document.getElementById("bill-sort")?.value||"newest";const rows=sortBills(orders.filter(o=>billSearchText(o).includes(q)&&(!status||String(o.paymentStatus||"unpaid").toLowerCase()===status)&&(!method||String(o.paymentMethod||"cash").toLowerCase()===method)&&(!date||businessDateOf(o)===date)),sortMode);setHtmlIfChanged(document.getElementById("bill-list"),rows.map(o=>billCard(o,"bill-view","bill-print")).join("")||"<p class='muted'>No orders.</p>");bindBillListActions();}

// Bound once on #bill-list. Previously every render walked the whole list
// reassigning onclick handlers card by card, which on a long bill list was
// itself a measurable part of opening Print Bills.
function bindBillListActions(){
  const host=document.getElementById("bill-list");
  if(!host||host.dataset.s2pBound==="true")return;
  host.dataset.s2pBound="true";
  host.addEventListener("click",event=>{
    const button=event.target.closest(".bill-view,.bill-print");
    if(!button)return;
    const order=orders.find(x=>x.id===button.dataset.id);
    if(!order)return;
    window.fillBillPreview?.(order);
    document.getElementById("billModal")?.classList.add("active");
    if(button.classList.contains("bill-print"))setTimeout(()=>document.getElementById("printBillBtn")?.click(),100);
  });
}
/* ---------------------------------------------------------
   STAFF MASTER (attendance / payroll records)

   The form doubles as an editor. When editingStaffMasterId is
   set, the save writes back to THAT document with setDoc(merge)
   instead of addDoc — so editing updates the existing record,
   keeps the same staff id, and never creates a duplicate or
   detaches the attendance/advance history keyed to that id.
   The live `staff` listener re-renders afterwards; nothing is
   re-fetched and the page never reloads.
--------------------------------------------------------- */
let editingStaffMasterId = "";
let pendingStaffDeleteId = "";
let showPastStaff = false;

function staffMasterFormValues(){
  return {
    name: document.getElementById("st-name").value.trim(),
    phone: document.getElementById("st-phone").value.trim(),
    email: document.getElementById("st-email").value.trim().toLowerCase(),
    role: document.getElementById("st-role").value.trim(),
    department: document.getElementById("st-department").value.trim(),
    joiningDate: document.getElementById("st-join").value,
    salaryType: document.getElementById("st-type").value,
    salary: Number(document.getElementById("st-salary").value||0)
  };
}

function resetStaffMasterForm(){
  editingStaffMasterId="";
  ["st-name","st-phone","st-email","st-role","st-department","st-join","st-salary"].forEach(id=>{const el=document.getElementById(id);if(el)el.value="";});
  const type=document.getElementById("st-type");if(type)type.value="monthly";
  const status=document.getElementById("st-status");if(status){status.value="active";status.closest(".form-group")?.classList.add("hidden");}
  const save=document.getElementById("st-save");if(save)save.textContent="Add Staff";
  const heading=document.getElementById("st-heading");if(heading)heading.textContent="Staff Master";
  document.getElementById("st-cancel")?.classList.add("hidden");
}

function editStaffMaster(id){
  const member=staffById(id);
  if(!member)return;
  editingStaffMasterId=id;
  const set=(elId,value)=>{const el=document.getElementById(elId);if(el)el.value=value??"";};
  set("st-name",member.name);set("st-phone",member.phone);set("st-email",member.email);
  set("st-role",member.role);set("st-department",member.department||member.position);
  set("st-join",member.joiningDate);set("st-type",member.salaryType||"monthly");set("st-salary",member.salary);
  const status=document.getElementById("st-status");
  if(status){status.value=isActiveStaffRecord(member)?"active":"inactive";status.closest(".form-group")?.classList.remove("hidden");}
  const save=document.getElementById("st-save");if(save)save.textContent="Save Changes";
  const heading=document.getElementById("st-heading");if(heading)heading.textContent=`Edit: ${member.name||"Staff"}`;
  document.getElementById("st-cancel")?.classList.remove("hidden");
  document.getElementById("st-name")?.scrollIntoView({behavior:"smooth",block:"center"});
}

async function saveStaff(){
  const values=staffMasterFormValues();
  if(!values.name)return alert("Staff name is required.");
  if(!values.salary||values.salary<0)return alert("Enter a valid salary amount.");
  if(values.phone&&values.phone.replace(/\D/g,"").length<10)return alert("Enter a valid phone number, or leave it empty.");
  if(values.email&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email))return alert("Enter a valid email address, or leave it empty.");

  const editingId=editingStaffMasterId;
  const previous=editingId?{...staffById(editingId)}:null;
  try{
    if(editingId){
      const statusValue=document.getElementById("st-status")?.value==="inactive"?"inactive":"active";
      const update={...values,status:statusValue,isActive:statusValue==="active",updatedAt:serverTimestamp(),updatedBy:user.email||user.uid||"admin"};
      // Optimistic: show the edit straight away, then persist. The live
      // listener confirms it; a failure restores the previous values below.
      applyStaffPatch(editingId,{...values,status:statusValue,isActive:statusValue==="active"});
      resetStaffMasterForm();
      // Same document id — attendance and advances keyed to it stay attached.
      await setDoc(doc(db,"restaurants",restaurantId,"staff",editingId),update,{merge:true});
    }else{
      await addDoc(collection(db,"restaurants",restaurantId,"staff"),{...values,isActive:true,status:"active",createdAt:serverTimestamp(),createdBy:user.email||user.uid||"admin"});
      resetStaffMasterForm();
    }
  }catch(error){
    devError("saveStaff failed",error);
    if(previous)applyStaffPatch(editingId,previous);
    alert("Could not save this staff record. Please check your connection and try again.");
  }
}

// Patches the in-memory record and re-renders the staff surfaces immediately,
// so an edit or a status change shows without waiting for the server round
// trip. Reverted by the caller if the write fails.
function applyStaffPatch(id,patch){
  const index=staff.findIndex(member=>member.id===id);
  if(index<0)return;
  staff[index]={...staff[index],...patch};
  renderStaffSurfaces();
}

/* ---------------------------------------------------------
   DELETE STAFF

   A soft delete: the document is kept (so attendance, advances
   and past payroll stay intact and reportable) but the record
   is marked inactive, which removes the person from Attendance,
   current Payroll, the advance picker and every staff dropdown.

   A record with no history at all can additionally be removed
   outright from the Past Staff list.
--------------------------------------------------------- */
function openStaffDeleteConfirm(id){
  const member=staffById(id);
  if(!member)return;
  pendingStaffDeleteId=id;
  const nameEl=document.getElementById("st-del-name");
  if(nameEl)nameEl.textContent=member.name||"this staff member";
  document.getElementById("st-delete-modal")?.classList.add("active");
}

function closeStaffDeleteConfirm(){
  pendingStaffDeleteId="";
  document.getElementById("st-delete-modal")?.classList.remove("active");
}

async function confirmStaffDelete(){
  const id=pendingStaffDeleteId;
  const member=staffById(id);
  if(!id||!member)return closeStaffDeleteConfirm();
  const previous={...member};
  closeStaffDeleteConfirm();
  if(editingStaffMasterId===id)resetStaffMasterForm();
  applyStaffPatch(id,{status:"inactive",isActive:false});
  try{
    await setDoc(doc(db,"restaurants",restaurantId,"staff",id),{
      status:"inactive",
      isActive:false,
      deactivatedAt:serverTimestamp(),
      deactivatedBy:user.email||user.uid||"admin"
    },{merge:true});
  }catch(error){
    devError("staff delete failed",error);
    applyStaffPatch(id,previous);
    alert("Could not remove this staff member. Please check your connection and try again.");
  }
}

async function reactivateStaffMaster(id,name){
  if(!confirm(`Restore ${name} to current staff?\n\nThey will appear again in Staff Attendance, Payroll and staff dropdowns.`))return;
  const previous={...(staffById(id)||{})};
  applyStaffPatch(id,{status:"active",isActive:true});
  try{
    await setDoc(doc(db,"restaurants",restaurantId,"staff",id),{isActive:true,status:"active",reactivatedAt:serverTimestamp()},{merge:true});
  }catch(error){
    devError("staff reactivate failed",error);
    applyStaffPatch(id,previous);
    alert("Could not restore this staff member. Please try again.");
  }
}

// Permanent removal, offered only from Past Staff and only for someone with
// no attendance or advance history — otherwise deleting the document would
// orphan records that payroll reports still need.
async function deleteStaffMaster(id,name){
  const [attendanceSnap,advanceSnap]=await Promise.all([
    getDocs(query(collection(db,"restaurants",restaurantId,"attendance"),where("staffId","==",id),limit(1))),
    getDocs(query(collection(db,"restaurants",restaurantId,"staff_advances"),where("staffId","==",id),limit(1)))
  ]);
  if(!attendanceSnap.empty||!advanceSnap.empty){alert(`${name} has attendance or payroll history, which is kept for accounting. They stay in Past Staff and will not appear in current Attendance or Payroll.`);return;}
  const typed=prompt(`Permanently erase "${name}"?\n\nThey have no attendance or payroll history. This cannot be undone. Type DELETE to confirm.`);
  if(typed!=="DELETE")return;
  try{
    await deleteDoc(doc(db,"restaurants",restaurantId,"staff",id));
  }catch(error){
    devError("permanent staff delete failed",error);
    alert("Could not erase this staff record. Please try again.");
  }
}

/* ---------------------------------------------------------
   STAFF ATTENDANCE

   Driven by currentStaff() — the ACTIVE staff collection — not
   by which attendance documents happen to exist. A departed
   employee's attendance rows stay in Firestore for reporting,
   but they are never used to populate this list, which is why
   deleted staff used to reappear here.

   Past staff are behind an off-by-default toggle so they can be
   restored or erased, and are never mixed into the day's
   attendance marking.
--------------------------------------------------------- */
function attendanceRow(member,markedStatus,hasOpenCheckIn){
  return `<div class="card" style="padding:9px;margin:7px 0"><strong>${esc(member.name)}</strong> <small>${esc(member.role)}</small>${member.department?` <small class="muted">· ${esc(member.department)}</small>`:""} · ${esc(markedStatus||"Not marked")}<div class="btn-group" style="margin-top:5px"><button class="btn btn-sm btn-primary at" data-id="${member.id}" data-s="Present">Check In</button><button class="btn btn-sm btn-outline at" data-id="${member.id}" data-s="Half Day">Half Day</button><button class="btn btn-sm btn-outline at" data-id="${member.id}" data-s="Paid Leave">Paid Leave</button><button class="btn btn-sm btn-danger at" data-id="${member.id}" data-s="Absent">Absent</button>${hasOpenCheckIn?`<button class="btn btn-sm btn-primary checkout" data-id="${member.id}">Check Out</button>`:""}<button class="btn btn-sm btn-primary edit-staff" data-id="${member.id}">Edit</button><button class="btn btn-sm btn-danger delete-staff" data-id="${member.id}">Delete</button></div></div>`;
}

function renderStaff(){
  const d=document.getElementById("at-date").value||today();
  const active=currentStaff();
  const past=pastStaff();

  const activeHtml=active.length
    ?active.map(member=>{
      const a=attendance.find(x=>x.staffId===member.id&&x.date===d);
      return attendanceRow(member,a?.status,Boolean(a?.checkIn&&!a?.checkOut));
    }).join("")
    :`<p class="muted">No current staff. Add a staff member to start marking attendance.</p>`;

  const toggleHtml=past.length
    ?`<div style="margin-top:14px"><button class="btn btn-sm btn-outline" id="st-past-toggle" type="button">${showPastStaff?"Hide":"Show"} past staff (${past.length})</button></div>`
    :"";

  // Past staff are listed read-only: no attendance marking, because they are
  // not current employees. Their history remains in reports.
  const pastHtml=past.length&&showPastStaff
    ?`<div style="margin-top:10px"><div class="muted small" style="margin-bottom:6px">Past staff — kept for payroll and attendance history. Not included in current Attendance or Payroll.</div>${past.map(member=>`<div class="card" style="padding:9px;margin:7px 0;opacity:.75"><strong>${esc(member.name)}</strong> <small>${esc(member.role)}</small> · <span class="status-badge warning">Past staff</span><div class="btn-group" style="margin-top:5px"><button class="btn btn-sm btn-outline reactivate-staff" data-id="${member.id}" data-name="${esc(member.name)}">Restore</button><button class="btn btn-sm btn-danger erase-staff" data-id="${member.id}" data-name="${esc(member.name)}">Erase Permanently</button></div></div>`).join("")}</div>`
    :"";

  setHtmlIfChanged(document.getElementById("at-list"),activeHtml+toggleHtml+pastHtml);
  bindStaffListActions();
}

// Bound ONCE on #at-list. Re-rendering the list can therefore never stack
// duplicate click handlers, which is what made repeated navigation between
// sections progressively slower and could fire an action twice.
function bindStaffListActions(){
  const host=document.getElementById("at-list");
  if(!host||host.dataset.s2pBound==="true")return;
  host.dataset.s2pBound="true";
  host.addEventListener("click",async event=>{
    const d=document.getElementById("at-date").value||today();
    const mark=event.target.closest(".at");
    if(mark){
      return setDoc(doc(db,"restaurants",restaurantId,"attendance",`${mark.dataset.id}_${d}`),{staffId:mark.dataset.id,date:d,status:mark.dataset.s,checkIn:mark.dataset.s==="Present"?new Date().toISOString():null,checkOut:null,totalHours:0,updatedAt:serverTimestamp()},{merge:true})
        .catch(error=>{devError("attendance mark failed",error);alert("Could not save attendance. Please try again.");});
    }
    const checkout=event.target.closest(".checkout");
    if(checkout){
      const a=attendance.find(x=>x.staffId===checkout.dataset.id&&x.date===d);
      if(!a?.checkIn)return;
      const hours=(Date.now()-new Date(a.checkIn))/36e5;
      return setDoc(doc(db,"restaurants",restaurantId,"attendance",`${checkout.dataset.id}_${d}`),{checkOut:new Date().toISOString(),totalHours:+hours.toFixed(2),updatedAt:serverTimestamp()},{merge:true})
        .catch(error=>{devError("attendance checkout failed",error);alert("Could not save check out. Please try again.");});
    }
    const edit=event.target.closest(".edit-staff");
    if(edit)return editStaffMaster(edit.dataset.id);
    const del=event.target.closest(".delete-staff");
    if(del)return openStaffDeleteConfirm(del.dataset.id);
    const restore=event.target.closest(".reactivate-staff");
    if(restore)return reactivateStaffMaster(restore.dataset.id,restore.dataset.name);
    const erase=event.target.closest(".erase-staff");
    if(erase)return deleteStaffMaster(erase.dataset.id,erase.dataset.name);
    if(event.target.closest("#st-past-toggle")){showPastStaff=!showPastStaff;renderStaff();}
  });
}

/* ---------------------------------------------------------
   PAYROLL

   Current month  -> current (active) staff only.
   A PAST month   -> active staff PLUS any past staff who
                     actually have attendance or advance records
                     in that month, because that is historical
                     accounting data and must stay reportable.

   Nothing is ever deleted to achieve this: a departed employee
   simply stops being a current employee.
--------------------------------------------------------- */
function renderPayroll(){
  const m=document.getElementById("pay-month").value||today().slice(0,7);
  const rows=selectPayrollStaff({staff,attendance,advances,month:m,currentMonth:today().slice(0,7)});
  const body=rows.length
    ?rows.map(({member:s,historical})=>{
      const a=attendance.filter(x=>x.staffId===s.id&&x.date?.startsWith(m)),p=a.filter(x=>x.status==="Present").length,h=a.filter(x=>x.status==="Half Day").length,l=a.filter(x=>x.status==="Paid Leave").length,ab=a.filter(x=>x.status==="Absent").length,ad=advances.filter(x=>x.staffId===s.id&&x.date?.startsWith(m)).reduce((z,x)=>z+Number(x.amount||0),0),base=s.salaryType==="daily"?s.salary*(p+h*.5+l):s.salary,final=Math.max(0,base-ad);
      // Historical rows are a record of what was paid, so they offer no edit
      // or delete action — those would change a closed accounting period.
      const actions=historical
        ?`<span class="small muted">Past staff</span>`
        :`<button class="btn btn-sm btn-primary edit-staff" data-id="${s.id}">Edit</button><button class="btn btn-sm btn-danger delete-staff" data-id="${s.id}">Delete</button>`;
      return `<tr${historical?' style="opacity:.75"':""}><td>${esc(s.name)}${historical?' <span class="status-badge warning">Past</span>':""}</td><td>${esc(s.salaryType)}</td><td>${p}</td><td>${h}</td><td>${l}</td><td>${ab}</td><td>${money(ad)}</td><td>0</td><td>0</td><td>${money(final)}</td><td>${historical?"Historical":"Unpaid"}</td><td><div class="btn-group">${actions}</div></td></tr>`;
    }).join("")
    :`<tr><td colspan="12" class="muted">No staff for this period.</td></tr>`;
  setHtmlIfChanged(document.getElementById("pay-table"),`<table class="data-table"><tr><th>Staff</th><th>Type</th><th>Present</th><th>Half</th><th>Leave</th><th>Absent</th><th>Advance</th><th>Bonus</th><th>Deductions</th><th>Final</th><th>Status</th><th>Actions</th></tr>${body}</table>`);
  bindPayrollActions();
}

function bindPayrollActions(){
  const host=document.getElementById("pay-table");
  if(!host||host.dataset.s2pBound==="true")return;
  host.dataset.s2pBound="true";
  host.addEventListener("click",event=>{
    const edit=event.target.closest(".edit-staff");
    if(edit){open("staff","Staff Attendance","");return editStaffMaster(edit.dataset.id);}
    const del=event.target.closest(".delete-staff");
    if(del)return openStaffDeleteConfirm(del.dataset.id);
  });
}

// Every surface that shows staff, refreshed together so a single edit or a
// delete can never leave one list stale while another updates.
function renderStaffSurfaces(){
  const picker=document.getElementById("adv-staff");
  if(picker){
    // Advance salary can only ever be given to a CURRENT employee.
    const selected=picker.value;
    const options=currentStaff().map(member=>`<option value="${member.id}">${esc(member.name)}</option>`).join("");
    if(setHtmlIfChanged(picker,options)&&currentStaff().some(member=>member.id===selected))picker.value=selected;
  }
  scheduleModuleRender("staff");
  scheduleModuleRender("payroll");
}

async function addAdvance(){
  const s=staffById(document.getElementById("adv-staff").value),a=Number(document.getElementById("adv-amount").value||0);
  if(!s||!a)return;
  if(!isActiveStaffRecord(s))return alert("Advance salary can only be given to current staff.");
  try{
    await addDoc(collection(db,"restaurants",restaurantId,"staff_advances"),{staffId:s.id,staffName:s.name||"",amount:a,date:today(),createdAt:serverTimestamp(),createdBy:user.email||user.uid||"admin"});
    document.getElementById("adv-amount").value="";
  }catch(error){devError("addAdvance failed",error);alert("Could not save this advance. Please try again.");}
}
export async function fetchZomatoOrders(){return []} export async function fetchSwiggyOrders(){return []} export async function fetchONDCOrders(){return []} export async function updateOrderStatus(){return false} export function calculateCommission(amount,percent=0){return Number(amount||0)*Number(percent||0)/100}
function renderDelivery(){setHtmlIfChanged(document.getElementById("del-list"),integrations.map(x=>`<tr><td>${esc(x.platform)}</td><td>${x.enabled?"Enabled":"Disabled"}</td><td>${esc(x.merchantId||"-")}</td><td>${Number(x.commissionPercent||0)}%</td></tr>`).join("")||"<tr><td colspan=4>No integrations configured.</td></tr>");}
async function saveIntegration(){const p=document.getElementById("del-platform").value;await setDoc(doc(db,"restaurants",restaurantId,"delivery_integrations",p.toLowerCase()),{platform:p,enabled:document.getElementById("del-enabled").checked,merchantId:document.getElementById("del-merchant").value,apiKey:document.getElementById("del-key").value,webhookUrl:document.getElementById("del-webhook").value,commissionPercent:Number(document.getElementById("del-commission").value||0),updatedAt:serverTimestamp()},{merge:true});}

nav("accounts","fa-wallet","Accounts");nav("print-bills","fa-print","Print Bills");nav("staff","fa-users","Staff Attendance");nav("payroll","fa-money-check-dollar","Payroll");nav("delivery","fa-motorcycle","Delivery Integrations");
section("accounts",`<div id="acc-stats" class="stats-grid"></div><div class="grid-2" style="margin-top:18px"><div class="card"><div class="card-header"><h3 class="card-title">Expense Management</h3></div><div class="card-body"><input id="ex-name" class="form-input" placeholder="Expense name"/><select id="ex-category" class="form-select"><option>Electricity Bill</option><option>Rent</option><option>Raw Material Purchase</option><option>Staff Salary</option><option>Grocery Purchase</option><option>Gas Cylinder</option><option>Water Bill</option><option>Internet/WiFi</option><option>Cleaning</option><option>Maintenance</option><option>Packaging</option><option>Marketing</option><option>Fuel</option><option>Delivery Expense</option><option>Miscellaneous</option></select><input id="ex-amount" class="form-input" type="number" placeholder="Amount"/><input id="ex-date" class="form-input" type="date" value="${today()}"/><select id="ex-mode" class="form-select"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank">Bank Transfer</option></select><input id="ex-vendor" class="form-input" placeholder="Vendor name"/><input id="ex-note" class="form-input" placeholder="Notes"/><input id="ex-file" class="form-input" type="file" accept="image/*,application/pdf"/><button id="ex-save" class="btn btn-primary">Save Expense</button></div></div><div class="card"><div class="card-header"><h3 class="card-title">Accounts Report</h3><button id="acc-csv" class="btn btn-outline btn-sm">Excel CSV</button><button id="acc-print" class="btn btn-outline btn-sm">PDF / Print</button></div><div class="card-body" id="acc-table"></div></div></div>`);
section("print-bills",`<div class="card"><div class="card-header"><h3 class="card-title">Select an Order</h3></div><div class="card-body"><div class="form-row"><input id="bill-q" class="form-input" placeholder="Order no, order ID, table, customer, phone"/><input id="bill-date" class="form-input" type="date"/><select id="bill-status" class="form-select"><option value="">All payments</option><option value="paid">Paid</option><option value="unpaid">Unpaid</option></select><select id="bill-method" class="form-select"><option value="">All methods</option><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="online">Online</option></select><select id="bill-sort" class="form-select"><option value="newest">Newest Order First</option><option value="oldest">Oldest Order First</option><option value="order-asc">Order Number: Low to High</option><option value="order-desc">Order Number: High to Low</option><option value="amount-asc">Amount: Low to High</option><option value="amount-desc">Amount: High to Low</option></select></div><div id="bill-list"></div></div></div>`);
section("staff",`<div class="grid-2"><div class="card"><div class="card-header"><h3 class="card-title" id="st-heading">Staff Master</h3></div><div class="card-body"><input id="st-name" class="form-input" placeholder="Name"/><input id="st-phone" class="form-input" placeholder="Phone"/><input id="st-email" class="form-input" type="email" placeholder="Email (optional)"/><input id="st-role" class="form-input" placeholder="Role"/><input id="st-department" class="form-input" placeholder="Department / position (optional)"/><input id="st-join" class="form-input" type="date"/><select id="st-type" class="form-select"><option value="monthly">Monthly Salary</option><option value="daily">Daily Wage</option></select><input id="st-salary" class="form-input" type="number" placeholder="Salary"/><div class="form-group hidden"><label class="form-label">Status</label><select id="st-status" class="form-select"><option value="active">Active</option><option value="inactive">Inactive</option></select></div><div class="btn-group"><button id="st-save" class="btn btn-primary">Add Staff</button><button id="st-cancel" class="btn btn-outline hidden" type="button">Cancel</button></div></div></div><div class="card"><div class="card-header"><h3 class="card-title">Daily Attendance</h3></div><div class="card-body"><input id="at-date" class="form-input" type="date" value="${today()}"/><div id="at-list"></div></div></div></div>`);

// The confirmation modal lives on <body>, NOT inside the Staff section:
// .content-section is display:none unless active, so a modal nested there
// would never appear when Delete is pressed from the Payroll table.
document.body.insertAdjacentHTML("beforeend", `<div class="modal-overlay" id="st-delete-modal"><div class="modal" style="max-width:420px;"><div class="modal-header"><h3><i class="fas fa-triangle-exclamation" style="color:#c0392b;margin-right:6px;"></i>Delete this staff member?</h3><button class="modal-close" id="st-del-close">&times;</button></div><div class="modal-body"><p>You are about to remove <strong id="st-del-name"></strong>.</p><p class="muted" style="margin-top:10px;">This will remove the staff member from current Staff, Attendance and Payroll lists. Historical payroll/attendance records will be preserved.</p></div><div class="modal-footer"><button class="btn btn-outline" id="st-del-cancel" type="button">Cancel</button><button class="btn btn-danger" id="st-del-confirm" type="button">Delete Staff</button></div></div></div>`);
section("payroll",`<div class="card"><div class="card-header"><h3 class="card-title">Attendance-based Payroll</h3><button id="pay-print" class="btn btn-outline btn-sm">Salary Slips / Print</button></div><div class="card-body"><input id="pay-month" class="form-input" type="month" value="${today().slice(0,7)}"/><div class="form-row"><select id="adv-staff" class="form-select"></select><input id="adv-amount" class="form-input" type="number" placeholder="Advance salary"/><button id="adv-save" class="btn btn-outline">Add Advance</button></div><div id="pay-table"></div></div></div>`);
section("delivery",`<div class="grid-2"><div class="card"><div class="card-header"><h3 class="card-title">Integration Settings</h3></div><div class="card-body"><select id="del-platform" class="form-select"><option>Zomato</option><option>Swiggy</option><option>ONDC</option><option>Magicpin</option><option>Manual Orders</option><option>Other Platform</option></select><label><input id="del-enabled" type="checkbox"/> Enable platform</label><input id="del-merchant" class="form-input" placeholder="Merchant ID"/><input id="del-key" class="form-input" placeholder="API key"/><input id="del-webhook" class="form-input" placeholder="Webhook URL"/><input id="del-commission" class="form-input" type="number" placeholder="Commission %"/><button id="del-save" class="btn btn-primary">Save Integration</button></div></div><div class="card"><div class="card-header"><h3 class="card-title">Platform Reports</h3></div><div class="card-body"><table class="data-table"><thead><tr><th>Platform</th><th>Status</th><th>Merchant</th><th>Commission</th></tr></thead><tbody id="del-list"></tbody></table><p class="small muted">Gross sales, commission, net receivable and settlement reports become available as platform orders are imported.</p></div></div></div>`);
document.querySelectorAll(".module-nav").forEach(a=>a.onclick=e=>{e.preventDefault();open(a.dataset.module,a.textContent.trim(),"")});document.getElementById("ex-save").onclick=saveExpense;document.getElementById("st-save").onclick=saveStaff;document.getElementById("st-cancel").onclick=resetStaffMasterForm;
["st-del-close","st-del-cancel"].forEach(id=>{const el=document.getElementById(id);if(el)el.onclick=closeStaffDeleteConfirm;});
document.getElementById("st-del-confirm").onclick=confirmStaffDelete;
document.getElementById("st-delete-modal").addEventListener("click",event=>{if(event.target.id==="st-delete-modal")closeStaffDeleteConfirm();});document.getElementById("adv-save").onclick=addAdvance;document.getElementById("del-save").onclick=saveIntegration;const debouncedRenderBills=debounce(renderBills,180);["bill-q","bill-date","bill-status","bill-method","bill-sort"].forEach(id=>{const el=document.getElementById(id);if(el)el.oninput=debouncedRenderBills;});document.getElementById("at-date").onchange=renderStaff;document.getElementById("pay-month").onchange=renderPayroll;document.getElementById("pay-print").onclick=()=>print("pay-table","Salary Slip / Payroll");document.getElementById("acc-print").onclick=()=>print("acc-table","Accounts Report");document.getElementById("acc-csv").onclick=()=>exportCsv([["Report","Generated"],["Accounts",today()]],"accounts-report.csv");
// Every onSnapshot below previously had no error callback: a transient
// permission-denied — e.g. the ID token not yet restored from IndexedDB on
// a cold page load (this file fires all of these synchronously at module
// load, with no onAuthStateChanged gate anywhere in the app), or a token
// expiring mid-shift — silently killed that section's realtime updates
// forever with zero UI feedback: "sometimes works, sometimes doesn't" with
// no way to tell why. admin.js's own orders listener already had a
// one-shot "refresh token and resubscribe" retry for exactly this reason;
// subscribeWithAuthRetry generalizes that same proven pattern to every
// listener in this file instead of only surfacing the failure. The orders
// listener is also debounced (matches the fix in admin.js) since it was
// re-filtering the full order history and re-rendering Accounts+Bills on
// every single write.
function subscribeWithAuthRetry(label, ref, onNext) {
  let retried = false, unsub = () => {};
  const start = () => {
    unsub = onSnapshot(ref, onNext, async error => {
      if (error?.code === "permission-denied" && auth.currentUser && !retried) {
        retried = true;
        try {
          await auth.currentUser.getIdToken(true);
          start();
          return;
        } catch (refreshError) {
          devError(`${label} token refresh retry failed`, refreshError);
        }
      }
      devError(`${label} listener failed`, error);
      showStuckFallback("Unable to load this data. Refresh if needed.");
    });
  };
  start();
  registerCleanup(() => unsub());
}
// This file used to open its OWN live query over the whole `orders`
// collection, duplicating the one admin.js already runs: two full copies of
// the same data, twice the Firestore reads, and two render pipelines firing
// on every single write. Both now read from one shared listener.
registerCleanup(subscribeOrders(restaurantId, liveOrders => {
  orders = liveOrders;
  scheduleModuleRender("accounts");
  scheduleModuleRender("print-bills");
}));
subscribeWithAuthRetry("expenses",collection(db,"restaurants",restaurantId,"expenses"),s=>{expenses=s.docs.map(d=>d.data());scheduleModuleRender("accounts")});
subscribeWithAuthRetry("staff",collection(db,"restaurants",restaurantId,"staff"),s=>{staff=s.docs.map(d=>({id:d.id,...d.data()}));renderStaffSurfaces();});
subscribeWithAuthRetry("attendance",collection(db,"restaurants",restaurantId,"attendance"),s=>{attendance=s.docs.map(d=>d.data());scheduleModuleRender("staff");scheduleModuleRender("payroll")});
subscribeWithAuthRetry("staff_advances",collection(db,"restaurants",restaurantId,"staff_advances"),s=>{advances=s.docs.map(d=>d.data());scheduleModuleRender("payroll")});
subscribeWithAuthRetry("delivery_integrations",collection(db,"restaurants",restaurantId,"delivery_integrations"),s=>{integrations=s.docs.map(d=>d.data());scheduleModuleRender("delivery")});
