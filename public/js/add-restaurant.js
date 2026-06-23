import { db } from "./firebase.js";
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, deleteUser } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { qs, toast } from "./common.js";

const el = id => qs(`#${id}`);
const restaurantId = el("restaurantId"), restaurantName = el("restaurantName"), ownerName = el("ownerName"), phone = el("phone"), email = el("email"), plan = el("plan"), amount = el("amount"), status = el("status"), expiryDate = el("expiryDate"), tableCount = el("tableCount"), address = el("address"), adminName = el("adminName"), adminEmail = el("adminEmail"), saveRestaurantBtn = el("saveRestaurantBtn"), msg = el("msg");
const adminPassword = el("adminPassword"), restaurantType = el("restaurantType"), businessMode = el("businessMode"), city = el("city"), state = el("state"), pincode = el("pincode"), billingType = el("billingType"), planStartDate = el("planStartDate"), upiId = el("upiId"), gstNumber = el("gstNumber"), taxPercent = el("taxPercent"), logoUrl = el("logoUrl"), kitchenWhatsApp = el("kitchenWhatsApp"), supportWhatsApp = el("supportWhatsApp"), restaurantLat = el("restaurantLat"), restaurantLng = el("restaurantLng"), allowedOrderRadius = el("allowedOrderRadius"), useCurrentLocationBtn = el("useCurrentLocationBtn"), locationStatus = el("locationStatus");

const session = JSON.parse(localStorage.getItem("scan2serve_super_admin") || "{}");
if (session.role !== "super_admin") window.location.href = "./super-admin-login.html";
// Keep legacy onboarding HTML intact while exposing the expanded business-type list.
if (restaurantType) {
  ["Street Vendor", "Cloud Kitchen", "Food Court", "Bakery", "Sweet Shop", "Dhaba", "Fast Food", "Juice Shop", "Tea Stall"].forEach(type => {
    if (![...restaurantType.options].some(option => option.value === type)) restaurantType.add(new Option(type, type));
  });
}
// This only updates visible language. Legacy element IDs and Firestore paths
// remain unchanged so existing integrations continue to work.
function applyBusinessOnboardingLabels() {
  const replacements = [[/Restaurant onboarding/g, "Business onboarding"], [/Add New Restaurant/g, "Add New Business"], [/Restaurant Details/g, "Business Details"], [/Restaurant Name \*/g, "Business Name *"], [/Restaurant ID \*/g, "Business ID *"], [/Restaurant Type/g, "Business Type"], [/Restaurant Settings/g, "Business Settings"], [/Create Restaurant Account/g, "Create Business Account"]];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(node => {
    if (node.parentElement?.closest("script,style")) return;
    replacements.forEach(([find, replacement]) => { node.nodeValue = node.nodeValue.replace(find, replacement); });
  });
  if (restaurantName) restaurantName.placeholder = "Business name";
}
applyBusinessOnboardingLabels();
const safeDocIdFromEmail = value => String(value || "").trim().toLowerCase().replaceAll("@", "_").replaceAll(".", "_");
const dateString = date => date.toISOString().slice(0, 10);
const planAmounts = { basic: 1999, advance: 2999, enterprise: 4999 };

function setMessage(text, tone = "notice") { if (!msg) return; msg.classList.remove("hidden"); msg.textContent = text; msg.style.background = tone === "error" ? "#fff1f0" : ""; msg.style.color = tone === "error" ? "#b43731" : ""; }
function suggestedId(name) { return `RST_${String(name || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24)}`; }
function defaultDates() { const now = new Date(); const end = new Date(now); end.setDate(end.getDate() + 30); if (planStartDate && !planStartDate.value) planStartDate.value = dateString(now); if (expiryDate && !expiryDate.value) expiryDate.value = dateString(end); }

restaurantName?.addEventListener("input", () => { if (restaurantId && (!restaurantId.value || restaurantId.dataset.suggested === "true")) { restaurantId.value = suggestedId(restaurantName.value); restaurantId.dataset.suggested = "true"; } });
restaurantId?.addEventListener("input", () => { restaurantId.dataset.suggested = "false"; });
restaurantType?.addEventListener("change", () => {
  const type = String(restaurantType.value || "").toLowerCase();
  const tokenTypes = ["cafe", "street vendor", "food court", "bakery", "sweet shop", "dhaba", "fast food", "juice shop", "tea stall"];
  if (businessMode) businessMode.value = tokenTypes.includes(type) ? "vendor" : "restaurant";
  const tableWrap = el("tableCount")?.closest(".ar-field");
  if (tableWrap) tableWrap.classList.toggle("hidden", ["street vendor", "cloud kitchen"].includes(type));
});
plan?.addEventListener("change", () => { if (amount) amount.value = String(planAmounts[plan.value] || 0); });
useCurrentLocationBtn?.addEventListener("click", () => {
  if (!navigator.geolocation) return setMessage("Geolocation is not supported by this browser.", "error");
  useCurrentLocationBtn.disabled = true; locationStatus.textContent = "Capturing location…";
  navigator.geolocation.getCurrentPosition(position => { restaurantLat.value = Number(position.coords.latitude).toFixed(7); restaurantLng.value = Number(position.coords.longitude).toFixed(7); locationStatus.textContent = "✓ Location captured"; useCurrentLocationBtn.disabled = false; }, error => { locationStatus.textContent = "Unable to capture location. Allow location permission and try again."; useCurrentLocationBtn.disabled = false; console.error("Location error", error); }, { enableHighAccuracy:true, timeout:12000, maximumAge:0 });
});

async function createAdminAuthUser(adminEmailValue, password) {
  const secondaryApp = initializeApp(firebaseConfig, `restaurant-admin-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  try { const credential = await createUserWithEmailAndPassword(secondaryAuth, adminEmailValue, password); return { uid: credential.user.uid, secondaryApp, user: credential.user }; }
  catch (error) { await deleteApp(secondaryApp); throw error; }
}

saveRestaurantBtn?.addEventListener("click", async () => {
  const id = restaurantId?.value.trim().toUpperCase(), name = restaurantName?.value.trim(), owner = ownerName?.value.trim() || "", phoneValue = phone?.value.trim(), adminEmailValue = adminEmail?.value.trim().toLowerCase(), password = adminPassword?.value || "";
  const planValue = plan?.value || "basic", amountValue = Number(amount?.value || 0), statusValue = status?.value || "active", expiryValue = expiryDate?.value || "", startValue = planStartDate?.value || "", tables = Math.max(1, Number(tableCount?.value || 10));
  if (!id || !name || !adminEmailValue || !phoneValue || !password || !planValue) return setMessage("Restaurant name, Restaurant ID, phone, admin email, password, and plan are required.", "error");
  if (!/^RST[_A-Z0-9-]+$/.test(id)) return setMessage("Use a Restaurant ID like RST_OLD_MONK.", "error");
  if (password.length < 6) return setMessage("Admin password must contain at least 6 characters.", "error");
  saveRestaurantBtn.disabled = true; saveRestaurantBtn.textContent = "Creating restaurant…"; msg?.classList.add("hidden");
  let authUser = null;
  try {
    const existing = await getDoc(doc(db, "restaurants", id));
    if (existing.exists()) throw new Error("A restaurant with this Restaurant ID already exists.");
    authUser = await createAdminAuthUser(adminEmailValue, password);
    const locationLat = restaurantLat?.value === "" ? null : Number(restaurantLat?.value); const locationLng = restaurantLng?.value === "" ? null : Number(restaurantLng?.value);
    const settings = { restaurantName:name, phone:phoneValue, address:address?.value.trim() || "", upiId:upiId?.value.trim() || "", taxPercent:Number(taxPercent?.value || 0), logoUrl:logoUrl?.value.trim() || "", kitchenWhatsApp:kitchenWhatsApp?.value.trim() || "", gstNumber:gstNumber?.value.trim() || "", restaurantLat:Number.isFinite(locationLat) ? locationLat : null, restaurantLng:Number.isFinite(locationLng) ? locationLng : null, allowedOrderRadiusMeters:Number(allowedOrderRadius?.value || 150), updatedAt:serverTimestamp() };
    await setDoc(doc(db, "restaurants", id), { name, restaurantName:name, restaurantId:id, slug:name.toLowerCase().replace(/\s+/g,"-"), restaurantType:restaurantType?.value || "Restaurant", ownerName:owner, phone:phoneValue, email:adminEmailValue, adminEmail:adminEmailValue, adminUid:authUser.uid, address:address?.value.trim() || "", city:city?.value.trim() || "", state:state?.value.trim() || "", pincode:pincode?.value.trim() || "", plan:planValue, amount:amountValue, billingType:billingType?.value || "monthly", planStartDate:startValue, expiryDate:expiryValue, planExpiryDate:expiryValue, status:statusValue, upiId:settings.upiId, gstNumber:settings.gstNumber, taxPercent:settings.taxPercent, logoUrl:settings.logoUrl, kitchenWhatsApp:settings.kitchenWhatsApp, supportWhatsApp:supportWhatsApp?.value.trim() || "", restaurantLat:settings.restaurantLat, restaurantLng:settings.restaurantLng, allowedOrderRadiusMeters:settings.allowedOrderRadiusMeters, tableCount:tables, createdAt:serverTimestamp(), updatedAt:serverTimestamp() });
    const businessType = restaurantType?.value || "Restaurant";
    const type = businessType.toLowerCase();
    const orderMode = ["cafe", "street vendor", "food court", "bakery", "sweet shop", "dhaba", "fast food", "juice shop", "tea stall"].includes(type) ? "token" : type === "hotel" ? "room" : type === "cloud kitchen" ? "delivery" : "table";
    const panelType = ({ cafe:"CafeToken", "street vendor":"VendorMobile", hotel:"HotelRoom", "cloud kitchen":"CloudKitchen", "food court":"FoodCourtToken", bakery:"CafeToken", "sweet shop":"CafeToken", dhaba:"CafeToken", "fast food":"CafeToken", "juice shop":"CafeToken", "tea stall":"CafeToken" })[type] || "RestaurantAdmin";
    await setDoc(doc(db, "restaurants", id), { businessType, orderMode, qrMode: orderMode === "table" ? "table" : orderMode === "room" ? "room" : "single", panelType, tokenEnabled:["token","room"].includes(orderMode), roomServiceEnabled:orderMode === "room", roomCount:orderMode === "room" ? tables : 0 }, { merge:true });
    await setDoc(doc(db, "restaurants", id, "settings", "general"), { businessType, orderMode, qrMode: orderMode === "table" ? "table" : orderMode === "room" ? "room" : "single", panelType, tokenEnabled:["token","room"].includes(orderMode), roomServiceEnabled:orderMode === "room" }, { merge:true });
    await setDoc(doc(db, "restaurants", id, "settings", "general"), settings, { merge:true });
    await setDoc(doc(db, "restaurants", id, "users", safeDocIdFromEmail(adminEmailValue)), { uid:authUser.uid, name:adminName?.value.trim() || "Restaurant Admin", email:adminEmailValue, role:"admin", restaurantId:id, status:"active", createdAt:serverTimestamp(), updatedAt:serverTimestamp() }, { merge:true });
    for (let index=1; index<=tables; index++) { const tableNo=String(index).padStart(2,"0"); await setDoc(doc(db,"restaurants",id,"tables",tableNo), { tableNo, active:true, qrUrl:`${location.origin}/index.html?restaurantId=${encodeURIComponent(id)}&table=${encodeURIComponent(tableNo)}`, updatedAt:serverTimestamp() }, { merge:true }); }
    try { await deleteApp(authUser.secondaryApp); } catch (cleanupError) { console.warn("Secondary Auth cleanup failed", cleanupError); }
    el("creationForm").classList.add("hidden"); el("successScreen").classList.add("show"); el("successDetails").textContent = `Restaurant ID: ${id} · Admin login: ${adminEmailValue} · Plan: ${planValue}`; el("successQr").href = `./qr-generator.html?restaurantId=${encodeURIComponent(id)}&start=1&end=${tables}`; toast("Restaurant created successfully");
  } catch (error) {
    console.error("Restaurant creation error", error);
    if (authUser?.user) { try { await deleteUser(authUser.user); } catch (cleanupError) { console.warn("Could not remove incomplete Auth user", cleanupError); } }
    if (authUser?.secondaryApp) { try { await deleteApp(authUser.secondaryApp); } catch {} }
    const readable = error.code === "auth/email-already-in-use" ? "This admin email already has a Firebase Authentication account." : error.message || "Failed to create restaurant.";
    setMessage(readable, "error"); toast("Failed to create restaurant");
  } finally { saveRestaurantBtn.disabled = false; saveRestaurantBtn.textContent = "Create Restaurant Account →"; }
});

defaultDates();
