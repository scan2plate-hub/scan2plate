import { db, auth } from "./firebase.js";
import { collection, getDocs, doc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { qs, escapeHtml, fmtCurrency, toast } from "./common.js";
import { ownerEmailOf } from "./restaurant-private.js?v=s2p-20260922d";

/* -------------------------------------------------------------
   This page lists every restaurant with its owner e-mail, and its
   buttons suspend, re-activate and renew any of them. It had no
   sign-in code at all. It is now super-admin only.

   firestore.rules is what actually stops the writes; this gate
   stops the page being a self-serve control panel.
------------------------------------------------------------- */
function superAdminSession() {
  try {
    const raw = localStorage.getItem("scan2serve_super_admin") || localStorage.getItem("scan2plate_super_admin");
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return null;
    if (String(parsed.role || "").toLowerCase() !== "super_admin") return null;
    if (["disabled", "suspended", "inactive"].includes(String(parsed.status || "active").toLowerCase())) return null;
    return parsed;
  } catch { return null; }
}

function denyAccess(reason) {
  document.body.innerHTML = `<main class="container" style="padding:40px 16px;max-width:620px;margin:auto;">
    <h2>Super admin sign-in required</h2>
    <p class="muted" style="margin:10px 0 18px">${reason}</p>
    <a class="btn btn-primary" href="./super-admin-login.html">Go to Super Admin Login</a>
  </main>`;
  throw new Error("restaurant-list: access denied");
}

const session = superAdminSession();
if (!session) denyAccess("This page lists every business with its owner contact details, and can suspend or renew any of them, so it is limited to Scan2Plate super admins.");

// A localStorage entry is trivially forged, so the Firebase session has to agree.
await auth.authStateReady();
if (!auth.currentUser) denyAccess("Your session has expired. Please sign in again.");
if (session.uid && auth.currentUser.uid !== session.uid) denyAccess("This session does not match the signed-in account. Please sign in again.");
const restaurantList=qs("#restaurantList"), searchBox=qs("#searchBox"); let rows=[]; const p=(()=>{try{return JSON.parse(localStorage.getItem("scan2serve_super_admin")||localStorage.getItem("scan2plate_super_admin")||"{}");}catch{return {};}})(); if(p.role!=="super_admin") window.location.href="./admin-login.html"; searchBox?.addEventListener("input", renderList);
function dateFrom(value){ if(!value) return null; if(value.toDate) return value.toDate(); if(typeof value.seconds==="number") return new Date(value.seconds*1000); const date=new Date(value); return Number.isNaN(date.getTime())?null:date; }
function isExpired(expiryDate){ const date=dateFrom(expiryDate); if(!date) return false; date.setHours(23,59,59,999); return date<Date.now(); }
function sourceFor(id){ return rows.find(item=>item.id===id)?.sourceCollection || "restaurants"; }
async function loadBusinessCollection(collectionName){ try{const snap=await getDocs(collection(db,collectionName)); return snap.docs.map(d=>({id:d.id,sourceCollection:collectionName,...d.data()}));}catch(error){console.warn(`Could not load ${collectionName}`,error); return [];} }
async function loadRestaurants(){ const [restaurantDocs,businessDocs,settingsDocs]=await Promise.all([loadBusinessCollection("restaurants"),loadBusinessCollection("businesses"),loadBusinessCollection("restaurantSettings")]); const byId=new Map(); [...settingsDocs,...businessDocs,...restaurantDocs].forEach(item=>{const current=byId.get(item.id)||{}; byId.set(item.id,{...current,...item,name:item.name||item.restaurantName||item.businessName||current.name||current.restaurantName||current.businessName||item.id});}); rows=[...byId.values()].sort((a,b)=>(dateFrom(b.createdAt)?.getTime()||0)-(dateFrom(a.createdAt)?.getTime()||0)); renderList(); }
function renderList(){ const q=searchBox?.value.trim().toLowerCase()||""; const filtered=rows.filter(x=>`${x.id||""} ${x.name||""} ${x.restaurantName||""} ${x.businessName||""} ${ownerEmailOf(x)} ${x.businessType||""}`.toLowerCase().includes(q)); restaurantList.innerHTML=filtered.length?filtered.map(x=>{const expired=isExpired(x.expiryDate||x.planExpiryDate); const ownerEmail=ownerEmailOf(x)||"-"; const status=expired?"expired":String(x.status||"active").toLowerCase(); const toggle=status==="suspended"?"activate":"suspend"; const toggleLabel=status==="suspended"?"Enable":"Disable"; return `<div class="card" style="margin-bottom:12px;padding:14px"><div class="row" style="justify-content:space-between;align-items:flex-start"><div><strong>${escapeHtml(x.name||x.restaurantName||x.businessName||x.id)}</strong><br><span class="muted small">Restaurant ID: ${escapeHtml(x.id)}</span><br><span>Owner Email: ${escapeHtml(ownerEmail)}</span><br><span>Plan: ${escapeHtml(x.plan||"basic")} · ${fmtCurrency(x.amount||0)}</span><br><span>Status: ${escapeHtml(status)}</span><br><span>Expiry: ${escapeHtml(x.expiryDate||x.planExpiryDate||"-")}</span><br><span>Business Type: ${escapeHtml(x.businessType||x.restaurantType||"Restaurant")}</span></div><div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn btn-outline" data-admin="${escapeHtml(x.id)}">Open Admin</button><button class="btn btn-outline" data-renew="${escapeHtml(x.id)}">Renew +30d</button><button class="btn btn-outline" data-${toggle}="${escapeHtml(x.id)}">${toggleLabel}</button><button class="btn btn-outline" data-qr="${escapeHtml(x.id)}">View QR</button></div></div></div>`;}).join(""):`<p class="muted">No restaurants found.</p>`;
restaurantList.querySelectorAll("[data-admin]").forEach(btn=>btn.onclick=()=>{window.open("./admin-dashboard.html","_blank","noopener");}); restaurantList.querySelectorAll("[data-qr]").forEach(btn=>btn.onclick=()=>{window.location.href=`./qr-generator.html?restaurantId=${encodeURIComponent(btn.dataset.qr)}`;}); restaurantList.querySelectorAll("[data-activate]").forEach(btn=>btn.onclick=async()=>{await updateDoc(doc(db,sourceFor(btn.dataset.activate),btn.dataset.activate),{status:"active",subscriptionStatus:"active",updatedAt:serverTimestamp()}); toast("Restaurant activated"); await loadRestaurants();}); restaurantList.querySelectorAll("[data-suspend]").forEach(btn=>btn.onclick=async()=>{await updateDoc(doc(db,sourceFor(btn.dataset.suspend),btn.dataset.suspend),{status:"suspended",subscriptionStatus:"suspended",updatedAt:serverTimestamp()}); toast("Restaurant disabled"); await loadRestaurants();}); restaurantList.querySelectorAll("[data-renew]").forEach(btn=>btn.onclick=async()=>{const now=new Date(); now.setDate(now.getDate()+30); await updateDoc(doc(db,sourceFor(btn.dataset.renew),btn.dataset.renew),{status:"active",subscriptionStatus:"active",expiryDate:now.toISOString().slice(0,10),planExpiryDate:now.toISOString().slice(0,10),updatedAt:serverTimestamp()}); toast("Plan renewed for 30 days"); await loadRestaurants();}); }
await loadRestaurants();
