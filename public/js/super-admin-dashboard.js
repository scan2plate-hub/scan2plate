import { auth, db } from "./firebase.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { collection, getDocs, updateDoc, doc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { escapeHtml, fmtCurrency } from "./common.js";

const $ = selector => document.querySelector(selector);
const logoutBtn = $("#logoutBtn");
const restaurantRows = $("#restaurantRows");
const recentRestaurants = $("#recentRestaurants");
const planSummary = $("#planSummary");
const onboardingRows = $("#onboardingRows");
const summaryCards = $("#summaryCards");
const adminAlerts = $("#adminAlerts");
const modal = $("#restaurantModal");
const modalBody = $("#restaurantModalBody");
const renewalModal = $("#renewalModal");
let renewingRestaurant = null;
const storageKey = "scan2plate_super_settings";
const legacyStorageKey = "scan2plate_super_admin_settings";
const defaultSuperSettings = { companyName:"Scan2Plate", supportPhone:"", supportEmail:"", basicPrice:249, advancePrice:999, enterprisePrice:1999 };
let superSettings = { ...defaultSuperSettings };
let restaurants = [];
let orders = [];

const session = JSON.parse(localStorage.getItem("scan2serve_super_admin") || "{}");
if (session.role !== "super_admin") window.location.href = "./super-admin-login.html";
$("#superAdminName").textContent = session.name || session.email || "Super Admin";

const planPrices = () => ({ basic: Number(superSettings.basicPrice) || 249, advance: Number(superSettings.advancePrice) || 999, enterprise: Number(superSettings.enterprisePrice) || 1999 });
const normalizePlan = value => ({ pro: "advance", premium: "enterprise" }[String(value || "").toLowerCase()] || String(value || "basic").toLowerCase());
const dateFrom = value => { if (!value) return null; if (value.toDate) return value.toDate(); if (typeof value.seconds === "number") return new Date(value.seconds * 1000); const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; };
const dateLabel = value => { const date = dateFrom(value); return date ? date.toLocaleDateString("en-IN") : "—"; };
const isExpired = restaurant => { const expiry = dateFrom(restaurant.expiryDate); return !!expiry && expiry.setHours(23,59,59,999) < Date.now(); };
const effectiveStatus = restaurant => isExpired(restaurant) ? "expired" : String(restaurant.status || "active").toLowerCase();
const orderStats = restaurantId => { const matching = orders.filter(order => String(order.restaurantId || "") === restaurantId); return { count: matching.length, revenue: matching.filter(order => String(order.paymentStatus || "").toLowerCase() === "paid").reduce((sum, order) => sum + Number(order.grandTotal || 0), 0) }; };
// Legacy documents deliberately receive defaults in memory only.  This keeps the
// existing `restaurants` collection and every old restaurant document untouched.
const businessTypeOf = business => business.businessType || business.restaurantType || "Restaurant";
const orderModeOf = business => business.orderMode || "Table";
const panelTypeOf = business => business.panelType || "RestaurantAdmin";
const panelRouteFor = business => {
  const type = String(businessTypeOf(business)).toLowerCase();
  const routes = {
    cafe: "./cafe-token-panel.html",
    "street vendor": "./vendor-panel.html",
    hotel: "./hotel-room-panel.html",
    "cloud kitchen": "./cloud-kitchen-panel.html",
    "food court": "./food-court-panel.html",
    bakery: "./cafe-token-panel.html",
    "sweet shop": "./cafe-token-panel.html",
    dhaba: "./cafe-token-panel.html",
    "fast food": "./cafe-token-panel.html",
    "juice shop": "./cafe-token-panel.html",
    "tea stall": "./cafe-token-panel.html"
  };
  return routes[type] || "./admin-dashboard.html";
};
const businessTypes = ["Restaurant","Cafe","Street Vendor","Hotel","Cloud Kitchen","Food Court","Bakery","Sweet Shop","Dhaba","Fast Food","Juice Shop","Tea Stall"];
function businessTypeConfig(value) {
  const type = String(value || "Restaurant").toLowerCase();
  const tokenTypes = ["cafe","street vendor","food court","bakery","sweet shop","dhaba","fast food","juice shop","tea stall"];
  const orderMode = tokenTypes.includes(type) ? "token" : type === "hotel" ? "room" : type === "cloud kitchen" ? "delivery" : "Table";
  const panelType = ({ cafe:"CafeToken", "street vendor":"VendorMobile", hotel:"HotelRoom", "cloud kitchen":"CloudKitchen", "food court":"FoodCourtToken", bakery:"CafeToken", "sweet shop":"CafeToken", dhaba:"CafeToken", "fast food":"CafeToken", "juice shop":"CafeToken", "tea stall":"CafeToken" })[type] || "RestaurantAdmin";
  return { businessType: value || "Restaurant", orderMode, panelType, qrMode: orderMode === "Table" ? "table" : orderMode === "room" ? "room" : "single", tokenEnabled: orderMode === "token" };
}

function renewalExpiry(months) { const date = new Date(); date.setMonth(date.getMonth() + Number(months || 1)); return date.toISOString().slice(0, 10); }
function updateRenewalPreview() { const plan = $("#renewalPlan")?.value || "basic"; const months = Number($("#renewalDuration")?.value || 1); if ($("#renewalExpiry")) $("#renewalExpiry").value = renewalExpiry(months); if ($("#renewalAmount")) $("#renewalAmount").value = fmtCurrency(Number(planPrices()[plan] || 0) * months); }
function openRenewalModal(restaurant) { renewingRestaurant = restaurant; $("#renewalRestaurantInfo").innerHTML = `<div><strong>${escapeHtml(restaurant.name || restaurant.id)}</strong><span class="sa-sub">${escapeHtml(restaurant.id)} · Current plan: ${escapeHtml(normalizePlan(restaurant.plan))} · Expiry: ${escapeHtml(restaurant.expiryDate || restaurant.planExpiryDate || "—")}</span></div>`; $("#renewalPlan").value = normalizePlan(restaurant.plan); $("#renewalDuration").value = "1"; updateRenewalPreview(); renewalModal?.classList.add("open"); }
async function confirmRenewal() { if (!renewingRestaurant) return; const selectedPlan = $("#renewalPlan").value; const durationMonths = Number($("#renewalDuration").value || 1); const newExpiryDate = renewalExpiry(durationMonths); const amount = Number(planPrices()[selectedPlan] || 0) * durationMonths; const button = $("#confirmRenewalBtn"); try { button.disabled=true; button.textContent="Renewing…"; await updateDoc(doc(db,"restaurants",renewingRestaurant.id),{plan:selectedPlan,status:"active",subscriptionStatus:"active",planStartDate:new Date().toISOString().slice(0,10),planExpiryDate:newExpiryDate,expiryDate:newExpiryDate,renewedAt:serverTimestamp(),updatedAt:serverTimestamp()}); await addDoc(collection(db,"restaurants",renewingRestaurant.id,"renewal_logs"),{restaurantId:renewingRestaurant.id,restaurantName:renewingRestaurant.name || renewingRestaurant.id,oldPlan:normalizePlan(renewingRestaurant.plan),newPlan:selectedPlan,oldExpiryDate:renewingRestaurant.planExpiryDate || renewingRestaurant.expiryDate || "",newExpiryDate,durationMonths,amount,renewedAt:serverTimestamp(),renewedBy:session.email || session.uid || "super_admin"}); renewalModal.classList.remove("open"); renewingRestaurant=null; await loadData(); alert("Plan renewed successfully"); } catch(error) { console.error("Renewal failed",error); alert("Could not renew plan: " + error.message); } finally { button.disabled=false; button.textContent="Confirm Renewal"; } }

logoutBtn?.addEventListener("click", async () => { localStorage.removeItem("scan2serve_super_admin"); await signOut(auth); window.location.href = "./super-admin-login.html"; });

function switchSection(name) {
  document.querySelectorAll(".sa-section").forEach(section => section.classList.toggle("active", section.id === `section-${name}`));
  document.querySelectorAll("[data-section-target]").forEach(button => button.classList.toggle("active", button.dataset.sectionTarget === name));
  const titles = { dashboard:["Dashboard","A clear view of your Scan2Plate business."], restaurants:["Businesses","Manage every business account in one place."], add:["Add Business","Create a new business with the existing onboarding flow."], qr:["QR Generator","Create print-ready QR links."], onboarding:["Onboarding Sheet","Review business setup details."], plans:["Plans","Plan performance and subscription mix."], reports:["Reports","Revenue and business performance."], settings:["Settings","Company-level display preferences."] };
  $("#pageTitle").textContent = titles[name]?.[0] || "Dashboard"; $("#pageSubtitle").textContent = titles[name]?.[1] || "";
}
document.querySelectorAll("[data-section-target]").forEach(button => button.addEventListener("click", () => switchSection(button.dataset.sectionTarget)));

function renderSummary() {
  const active = restaurants.filter(restaurant => effectiveStatus(restaurant) === "active");
  const inactive = restaurants.filter(restaurant => ["suspended", "expired"].includes(effectiveStatus(restaurant)));
  const counts = { basic:0, advance:0, enterprise:0 };
  restaurants.forEach(restaurant => { counts[normalizePlan(restaurant.plan)] = (counts[normalizePlan(restaurant.plan)] || 0) + 1; });
  const monthlyRevenue = active.reduce((sum, restaurant) => sum + Number(planPrices()[normalizePlan(restaurant.plan)] || 0), 0);
  const totalOrders = orders.length;
  const cards = [["Total Businesses",restaurants.length,"fa-store","totalRestaurants"],["Active Businesses",active.length,"fa-circle-check","activeRestaurants"],["Suspended / Expired",inactive.length,"fa-triangle-exclamation","inactiveRestaurants"],["Monthly Revenue",fmtCurrency(monthlyRevenue),"fa-indian-rupee-sign","monthlyRevenue"],["Basic Plans",counts.basic,"fa-seedling","basicPlans"],["Advance Plans",counts.advance,"fa-bolt","advancePlans"],["Trial Businesses",restaurants.filter(restaurant => String(restaurant.plan || "").toLowerCase() === "trial").length,"fa-hourglass-half","trialRestaurants"],["Total Orders",totalOrders,"fa-receipt","totalOrders"]];
  summaryCards.innerHTML = cards.map(([label,value,icon,id]) => `<div class="sa-stat"><div class="sa-stat-top"><span>${label}</span><span class="sa-stat-icon"><i class="fa-solid ${icon}"></i></span></div><b id="${id}">${value}</b><small>Across all businesses</small></div>`).join("");
}

function renderAlerts() {
  const expired = restaurants.filter(restaurant => effectiveStatus(restaurant) === "expired");
  const suspended = restaurants.filter(restaurant => effectiveStatus(restaurant) === "suspended");
  const trials = restaurants.filter(restaurant => { const expiry = dateFrom(restaurant.expiryDate); return String(restaurant.plan || "").toLowerCase() === "trial" && expiry && expiry - Date.now() < 7 * 86400000 && expiry > Date.now(); });
  const noMenu = restaurants.filter(restaurant => restaurant.menuItemCount === 0);
  const messages = [...expired.map(x => `Expired plan: ${x.name || x.id}`), ...trials.map(x => `Trial ending soon: ${x.name || x.id}`), ...suspended.map(x => `Suspended restaurant: ${x.name || x.id}`), ...noMenu.map(x => `No menu items: ${x.name || x.id}`)];
  adminAlerts.innerHTML = messages.length ? messages.slice(0,8).map(message => `<div class="sa-alert"><i class="fa-solid fa-bell"></i><span>${escapeHtml(message)}</span></div>`).join("") : `<div class="sa-empty"><i class="fa-solid fa-circle-check"></i>No expired plans, trials ending soon, or suspended restaurants.</div>`;
}

function renderRecent() { recentRestaurants.innerHTML = restaurants.length ? restaurants.slice(0,6).map(restaurant => { const stats=orderStats(restaurant.id); return `<div class="sa-report-row"><div><strong>${escapeHtml(restaurant.name || restaurant.id)}</strong><span class="sa-sub">${escapeHtml(restaurant.id)}</span></div><div style="text-align:right"><span class="sa-badge ${effectiveStatus(restaurant)}">${effectiveStatus(restaurant)}</span><span class="sa-sub">${stats.count} orders · ${fmtCurrency(stats.revenue)}</span></div></div>`; }).join("") : `<div class="sa-empty"><i class="fa-solid fa-store-slash"></i>No restaurants found.</div>`; }

function filteredRestaurants() {
  const text = $("#restaurantSearch")?.value.trim().toLowerCase() || ""; const plan = $("#planFilter")?.value || "all"; const status = $("#statusFilter")?.value || "all"; const sort = $("#restaurantSort")?.value || "newest";
  const list = restaurants.filter(restaurant => { const haystack = `${restaurant.name || ""} ${restaurant.id} ${restaurant.email || ""} ${restaurant.adminEmail || ""}`.toLowerCase(); return (!text || haystack.includes(text)) && (plan === "all" || normalizePlan(restaurant.plan) === plan) && (status === "all" || effectiveStatus(restaurant) === status); });
  return list.sort((a,b) => sort === "name" ? String(a.name || a.id).localeCompare(String(b.name || b.id)) : sort === "revenue" ? orderStats(b.id).revenue - orderStats(a.id).revenue : (dateFrom(b.createdAt)?.getTime() || 0) - (dateFrom(a.createdAt)?.getTime() || 0));
}

function renderRestaurants() {
  const list = filteredRestaurants();
  const tableHeader = restaurantRows?.closest("table")?.querySelector("thead");
  if (tableHeader) tableHeader.innerHTML = "<tr><th>Business Name</th><th>Business Type</th><th>Business ID</th><th>Owner Phone</th><th>Plan</th><th>Expiry Date</th><th>Status</th><th>Panel Type</th><th>Actions</th></tr>";
  restaurantRows.innerHTML = list.length ? list.map(business => { const plan = normalizePlan(business.plan); const status = effectiveStatus(business); return `<tr><td><span class="sa-restaurant">${escapeHtml(business.name || business.restaurantName || business.id)}</span></td><td>${escapeHtml(businessTypeOf(business))}</td><td><span class="sa-id">${escapeHtml(business.id)}</span></td><td>${escapeHtml(business.phone || business.ownerName || "—")}</td><td><span class="sa-badge ${plan}">${escapeHtml(plan)}</span></td><td>${dateLabel(business.expiryDate || business.planExpiryDate)}</td><td><span class="sa-badge ${status}">${escapeHtml(status)}</span></td><td>${escapeHtml(panelTypeOf(business))}</td><td><div class="sa-actions"><button class="sa-btn ghost" data-action="view" data-id="${escapeHtml(business.id)}">View</button><button class="sa-btn ghost" data-action="plan" data-id="${escapeHtml(business.id)}">Edit / Plan</button><button class="sa-btn ghost" data-action="admin" data-id="${escapeHtml(business.id)}">Open Panel</button><button class="sa-btn ghost" data-action="qr" data-id="${escapeHtml(business.id)}">QR</button><button class="sa-btn ghost" data-action="renew" data-id="${escapeHtml(business.id)}">Renew</button></div></td></tr>`; }).join("") : `<tr><td colspan="9"><div class="sa-empty"><i class="fa-solid fa-magnifying-glass"></i>No businesses found.</div></td></tr>`;
  restaurantRows.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => handleRestaurantAction(button.dataset.action, button.dataset.id)));
}

function renderOnboarding() { onboardingRows.innerHTML = restaurants.length ? restaurants.map(restaurant => `<tr><td><strong>${escapeHtml(restaurant.name || restaurant.id)}</strong><span class="sa-sub">${escapeHtml(restaurant.id)}</span></td><td>${escapeHtml(restaurant.ownerName || "—")}</td><td>${escapeHtml(restaurant.phone || "—")}</td><td>${escapeHtml(restaurant.email || restaurant.adminEmail || "—")}</td><td>${escapeHtml(restaurant.address || "—")}</td><td>${escapeHtml(normalizePlan(restaurant.plan))}</td><td>${escapeHtml(restaurant.upiId || "—")}</td><td>${escapeHtml(restaurant.gstNumber || "—")}</td><td><span class="sa-badge ${effectiveStatus(restaurant)}">${effectiveStatus(restaurant)}</span></td></tr>`).join("") : `<tr><td colspan="9"><div class="sa-empty">No restaurants found.</div></td></tr>`; }

function renderPlans() { const prices = planPrices(); const details = { basic:[["QR ordering","Kitchen dashboard","Order tracking"]], advance:[["Everything in Basic","WhatsApp alerts","Reports & payments"]], enterprise:[["Multi-location support","Priority support","Advanced controls"]] }; planSummary.innerHTML = Object.entries(details).map(([plan,[features]]) => { const list = restaurants.filter(restaurant => normalizePlan(restaurant.plan) === plan); const revenue = list.filter(restaurant => effectiveStatus(restaurant)==="active").length * Number(prices[plan] || 0); return `<article class="sa-plan ${plan === "advance" ? "featured" : ""}"><h3>${plan[0].toUpperCase()+plan.slice(1)}</h3><div class="sa-plan-price">${fmtCurrency(prices[plan])}<small style="font-size:12px;color:var(--sa-muted)"> / month</small></div><ul>${features.map(feature=>`<li>${feature}</li>`).join("")}</ul><div class="sa-plan-meta"><span>${list.length} restaurants</span><strong>${fmtCurrency(revenue)}</strong></div></article>`; }).join(""); }

function reportRows(entries) { return entries.length ? entries.map(([label,value]) => `<div class="sa-report-row"><span>${escapeHtml(label)}</span><strong>${fmtCurrency(value)}</strong></div>`).join("") : `<div class="sa-empty">No revenue yet.</div>`; }
function renderReports() { const thisMonth = new Date().toISOString().slice(0,7); const monthly = new Map(); orders.filter(order => String(order.paymentStatus || "").toLowerCase()==="paid").forEach(order => { const date=dateFrom(order.createdAt); if (!date) return; const key=date.toISOString().slice(0,7); monthly.set(key,(monthly.get(key)||0)+Number(order.grandTotal||0)); }); const byPlan = new Map(); restaurants.forEach(restaurant => { const plan=normalizePlan(restaurant.plan); byPlan.set(plan,(byPlan.get(plan)||0)+orderStats(restaurant.id).revenue); }); const byRestaurant = restaurants.map(restaurant => [restaurant.name || restaurant.id, orderStats(restaurant.id).revenue]).filter(([,value])=>value>0).sort((a,b)=>b[1]-a[1]).slice(0,10); $("#monthlyRevenueReport").innerHTML = reportRows([...monthly.entries()].sort((a,b)=>b[0].localeCompare(a[0])).slice(0,6)); $("#planRevenueReport").innerHTML = reportRows([...byPlan.entries()]); $("#restaurantRevenueReport").innerHTML = reportRows(byRestaurant); }

async function handleRestaurantAction(action, id) { const restaurant = restaurants.find(item => item.id === id); if (!restaurant) return; if (action === "view" || action === "plan") { modal.classList.add("open"); modalBody.innerHTML = `<div class="sa-form-grid"><div><strong>${escapeHtml(restaurant.name || id)}</strong><p class="sa-sub">${escapeHtml(id)} · ${escapeHtml(restaurant.adminEmail || restaurant.email || "No email")}</p><p>Business type: ${escapeHtml(businessTypeOf(restaurant))}</p><p>Panel: ${escapeHtml(panelTypeOf(restaurant))}</p><p>Owner: ${escapeHtml(restaurant.ownerName || "—")}</p><p>Orders: ${orderStats(id).count} · Revenue: ${fmtCurrency(orderStats(id).revenue)}</p></div><div><label class="sa-sub">Change plan</label><select id="modalPlan" class="sa-select" style="width:100%"><option value="basic">Basic</option><option value="advance">Advance</option><option value="enterprise">Enterprise</option></select><button id="saveModalPlan" class="sa-btn" style="margin-top:10px">Save plan</button><label class="sa-sub" style="display:block;margin-top:16px">Business type</label><select id="modalBusinessType" class="sa-select" style="width:100%">${businessTypes.map(type=>`<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join("")}</select><button id="saveModalBusinessType" class="sa-btn ghost" style="margin-top:10px">Save business type</button></div></div>`; $("#modalPlan").value = normalizePlan(restaurant.plan); $("#modalBusinessType").value = businessTypeOf(restaurant); $("#saveModalPlan").onclick = () => updateRestaurant(id,{plan:$("#modalPlan").value}); $("#saveModalBusinessType").onclick = () => { const next=$("#modalBusinessType").value; if (!confirm("You are changing this business type. This may change login panel and QR mode. Continue?")) return; updateRestaurant(id,businessTypeConfig(next)); }; return; } if (action === "admin") { window.open(panelRouteFor(restaurant), "_blank", "noopener"); return; } if (action === "qr") { $("#qrRestaurant").value=id; switchSection("qr"); return; } if (action === "renew") { openRenewalModal(restaurant); return; } if (action === "activate") return updateRestaurant(id,{status:"active",subscriptionStatus:"active"}); if (action === "suspend" && confirm(`Suspend ${restaurant.name || id}?`)) return updateRestaurant(id,{status:"suspended",subscriptionStatus:"suspended"}); }
async function updateRestaurant(id,payload) { try { await updateDoc(doc(db,"restaurants",id),{...payload,updatedAt:serverTimestamp()}); await loadData(); modal.classList.remove("open"); } catch(error) { console.error(error); alert("Could not update restaurant: " + error.message); } }

function populateQrRestaurants() { const select=$("#qrRestaurant"); select.innerHTML=restaurants.length ? restaurants.map(restaurant=>`<option value="${escapeHtml(restaurant.id)}">${escapeHtml(restaurant.name || restaurant.id)} (${escapeHtml(restaurant.id)})</option>`).join("") : `<option value="">No restaurants available</option>`; }
$("#openQrGenerator")?.addEventListener("click", () => { const id=$("#qrRestaurant").value; if(!id) return alert("Select a restaurant first."); const start=Math.max(1,Number($("#qrStart").value||1)); const end=Math.max(start,Number($("#qrEnd").value||start)); window.location.href=`./qr-generator.html?restaurantId=${encodeURIComponent(id)}&start=${start}&end=${end}`; });
$("#closeRestaurantModal")?.addEventListener("click",()=>modal.classList.remove("open")); modal?.addEventListener("click",event=>{if(event.target===modal) modal.classList.remove("open")});
$("#renewalPlan")?.addEventListener("change",updateRenewalPreview); $("#renewalDuration")?.addEventListener("change",updateRenewalPreview); $("#closeRenewalModal")?.addEventListener("click",()=>renewalModal?.classList.remove("open")); $("#cancelRenewalBtn")?.addEventListener("click",()=>renewalModal?.classList.remove("open")); $("#confirmRenewalBtn")?.addEventListener("click",confirmRenewal); renewalModal?.addEventListener("click",event=>{if(event.target===renewalModal) renewalModal.classList.remove("open")});
["#restaurantSearch","#planFilter","#statusFilter","#restaurantSort"].forEach(selector => $(selector)?.addEventListener(selector==="#restaurantSearch"?"input":"change",renderRestaurants));
$("#exportCsvBtn")?.addEventListener("click",()=>{const header=["Restaurant","ID","Plan","Status","Owner","Email","Orders","Revenue","Expiry"];const rows=restaurants.map(restaurant=>{const stats=orderStats(restaurant.id);return [restaurant.name||"",restaurant.id,normalizePlan(restaurant.plan),effectiveStatus(restaurant),restaurant.ownerName||"",restaurant.adminEmail||restaurant.email||"",stats.count,stats.revenue,restaurant.expiryDate||""]});const csv=[header,...rows].map(row=>row.map(value=>`"${String(value).replaceAll('"','""')}"`).join(",")).join("\n");const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));link.download="scan2plate-saas-report.csv";link.click();URL.revokeObjectURL(link.href);});

function loadSettings(){try{const raw=localStorage.getItem(storageKey) || localStorage.getItem(legacyStorageKey) || "{}"; superSettings={...defaultSuperSettings,...JSON.parse(raw)}; localStorage.setItem(storageKey,JSON.stringify(superSettings)); ["companyName","supportPhone","supportEmail","basicPrice","advancePrice","enterprisePrice"].forEach(id=>{if($("#"+id)) $("#"+id).value=superSettings[id] ?? defaultSuperSettings[id];});}catch{superSettings={...defaultSuperSettings};}} $("#saveCompanySettings")?.addEventListener("click",()=>{const settings={};["companyName","supportPhone","supportEmail","basicPrice","advancePrice","enterprisePrice"].forEach(id=>settings[id]=$("#"+id)?.value||"");superSettings={...defaultSuperSettings,...settings,basicPrice:Number(settings.basicPrice)||1999,advancePrice:Number(settings.advancePrice)||2999,enterprisePrice:Number(settings.enterprisePrice)||4999};localStorage.setItem(storageKey,JSON.stringify(superSettings));renderSummary();renderPlans();renderRestaurants();alert("Settings saved. Plan prices are updated everywhere immediately.");});

async function loadData() { try { const [restaurantSnap,orderSnap] = await Promise.all([getDocs(collection(db,"restaurants")),getDocs(collection(db,"orders"))]); restaurants=restaurantSnap.docs.map(snapshot=>{ const data = snapshot.data(); return { id:snapshot.id, ...data, businessType:businessTypeOf(data), orderMode:orderModeOf(data), panelType:panelTypeOf(data) }; }).sort((a,b)=>(dateFrom(b.createdAt)?.getTime()||0)-(dateFrom(a.createdAt)?.getTime()||0)); orders=orderSnap.docs.map(snapshot=>({id:snapshot.id,...snapshot.data()})); await Promise.all(restaurants.map(async restaurant => { try { restaurant.menuItemCount=(await getDocs(collection(db,"restaurants",restaurant.id,"menu"))).size; } catch { restaurant.menuItemCount=null; } })); renderSummary();renderAlerts();renderRecent();renderRestaurants();renderOnboarding();renderPlans();renderReports();populateQrRestaurants(); applyBusinessTerminology(); } catch(error) { console.error("Super admin data load failed",error); [recentRestaurants,restaurantRows,onboardingRows].filter(Boolean).forEach(element=>element.innerHTML=`<div class="sa-empty">Unable to load data. Please refresh.</div>`); } }

// Static markup still uses legacy IDs and class names. Change only visible text
// nodes, never script/style content or Firebase field/collection names.
function applyBusinessTerminology() {
  const replacements = [[/Add Restaurant/g,"Add Business"],[/Create restaurant/g,"Create business"],[/Restaurant Details/g,"Business Details"],[/Restaurant details/g,"Business details"],[/Restaurant Name/g,"Business Name"],[/Restaurant Type/g,"Business Type"],[/Restaurant Onboarding Sheet/g,"Business Onboarding Sheet"],[/Table-wise QR Generator/g,"Business QR Generator"],[/Restaurants/g,"Businesses"],[/restaurants/g,"businesses"]];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(node => { if (node.parentElement?.closest("script,style")) return; replacements.forEach(([find, replacement]) => { node.nodeValue = node.nodeValue.replace(find, replacement); }); });
}

loadSettings();
await loadData();
