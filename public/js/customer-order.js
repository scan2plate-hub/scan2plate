import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { calculateOrderTotals, normalizeCustomerPhone, installAppSafety, guardedAction } from "./common.js";

installAppSafety({ pageName: "Customer Order Workflow", stuckTimeoutMs: 18000 });

const params = new URLSearchParams(location.search);
let mode = params.get("mode") === "delivery" ? "delivery" : "preorder";
let restaurants = [];
let filteredRestaurants = [];
let selectedRestaurant = null;
let menuItems = [];
let activeCategory = "All";
let cart = [];
let selectedTable = "";
let geoPosition = null;

const $ = id => document.getElementById(id);
const panels = ["locationPanel", "restaurantsPanel", "menuPanel", "detailsPanel", "paymentPanel"];
const modeButtons = [ $("preorderModeBtn"), $("deliveryModeBtn") ].filter(Boolean);

function escapeHtml(value = "") {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function money(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value || 0));
}

function boolSetting(value, fallback = false) {
  if (value === true || value === false) return value;
  const text = String(value ?? "").toLowerCase();
  if (["true", "yes", "enabled", "on", "1"].includes(text)) return true;
  if (["false", "no", "disabled", "off", "0"].includes(text)) return false;
  return fallback;
}

function text(value = "") { return String(value || "").trim(); }
function norm(value = "") { return text(value).toLowerCase(); }
function canonicalCity(data = {}) { return text(data.district || data.city || data.locationCity || data.addressCity || ""); }
function canonicalState(data = {}) { return text(data.state || data.locationState || ""); }
function canonicalCountry(data = {}) { return text(data.country || data.locationCountry || "India"); }
function settingNumber(data = {}, key, fallback = 0) {
  const value = Number(data[key]);
  return Number.isFinite(value) ? value : fallback;
}

function status(message = "", type = "info") {
  const el = $("statusMessage");
  if (!el) return;
  el.className = `status-message${message ? "" : " hidden"}`;
  el.textContent = message;
  el.style.background = type === "error" ? "#fff0ec" : "#fff8e8";
  el.style.color = type === "error" ? "#aa2e12" : "#805400";
}

function setMode(nextMode) {
  mode = nextMode === "delivery" ? "delivery" : "preorder";
  modeButtons.forEach(button => button.classList.toggle("active", button.dataset.mode === mode));
  document.body.classList.toggle("delivery-mode", mode === "delivery");
  document.querySelectorAll(".delivery-only").forEach(el => el.classList.toggle("hidden", mode !== "delivery"));
  $("pageTitle").textContent = mode === "delivery" ? "Order food from home." : "Choose food before you arrive.";
  $("pageCopy").textContent = mode === "delivery"
    ? "Select your location, choose a delivery-enabled restaurant, add food, enter your address and track the restaurant confirmation."
    : "Select your location, choose a restaurant, add menu items, reserve a table or request takeaway, then track confirmation from the restaurant.";
  const deliveryRadio = document.querySelector('input[name="diningType"][value="delivery"]');
  const dineInRadio = document.querySelector('input[name="diningType"][value="preorder_dine_in"]');
  if (mode === "delivery" && deliveryRadio) deliveryRadio.checked = true;
  if (mode === "preorder" && dineInRadio) dineInRadio.checked = true;
  updateDiningVisibility();
  history.replaceState(null, "", `./customer-order.html?mode=${mode}`);
}

function showPanel(id) {
  panels.forEach(panelId => $(panelId)?.classList.toggle("active", panelId === id));
  const index = panels.indexOf(id);
  document.querySelectorAll("[data-step-dot]").forEach((dot, dotIndex) => dot.classList.toggle("active", dotIndex <= index));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function isRestaurantAccepting(data = {}) {
  const status = norm(data.status || data.subscriptionStatus || "active");
  const accepting = boolSetting(data.acceptingOrders ?? data.isAcceptingOrders ?? data.onlineOrderingEnabled, true);
  return accepting && !["suspended", "expired", "inactive", "closed"].includes(status);
}

function preorderEnabled(data = {}) {
  return boolSetting(data.preorderEnabled ?? data.preOrderEnabled ?? data.enablePreOrder, false);
}

function deliveryEnabled(data = {}) {
  return boolSetting(data.deliveryEnabled ?? data.enableDelivery, false);
}

async function loadBusinessCollection(collectionName) {
  try {
    const snap = await getDocs(collection(db, collectionName));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (error) {
    console.warn(`Could not load ${collectionName}`, error);
    return [];
  }
}

async function loadSettingsForRestaurant(id, root = {}) {
  try {
    const snap = await getDoc(doc(db, "restaurants", id, "settings", "general"));
    return { ...root, ...(snap.exists() ? snap.data() : {}) };
  } catch {
    return root;
  }
}

async function loadRestaurants() {
  status("Loading available restaurants...");
  const roots = await loadBusinessCollection("restaurants");
  const hydrated = await Promise.all(roots.map(root => loadSettingsForRestaurant(root.id, root)));
  restaurants = hydrated
    .map(item => ({
      ...item,
      restaurantName: item.restaurantName || item.name || item.businessName || item.id,
      country: canonicalCountry(item),
      state: canonicalState(item),
      city: canonicalCity(item),
      cuisine: item.cuisine || item.category || item.businessType || item.restaurantType || "Restaurant"
    }))
    .filter(item => item.restaurantName && (preorderEnabled(item) || deliveryEnabled(item)));
  populateLocationOptions();
  status(restaurants.length ? "" : "No restaurants have public pre-order or delivery enabled yet.");
}

function uniqueValues(key, parentFilter = () => true) {
  return [...new Set(restaurants.filter(parentFilter).map(item => text(item[key])).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function setOptions(select, values, fallbackLabel) {
  if (!select) return;
  select.innerHTML = `<option value="">${fallbackLabel}</option>${values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`;
  if (values.length === 1) select.value = values[0];
}

function populateLocationOptions() {
  setOptions($("countryField"), uniqueValues("country"), "Choose country");
  updateStateOptions();
}

function updateStateOptions() {
  const country = $("countryField").value;
  setOptions($("stateField"), uniqueValues("state", item => !country || item.country === country), "Choose state");
  updateCityOptions();
}

function updateCityOptions() {
  const country = $("countryField").value;
  const state = $("stateField").value;
  setOptions($("cityField"), uniqueValues("city", item => (!country || item.country === country) && (!state || item.state === state)), "Choose district / city");
}

function restaurantMatchesMode(item) {
  return mode === "delivery" ? deliveryEnabled(item) : preorderEnabled(item);
}

function restaurantInsideDeliveryArea(item) {
  if (mode !== "delivery") return true;
  const radius = settingNumber(item, "deliveryRadiusKm", settingNumber(item, "deliveryRadius", 0));
  if (!geoPosition || !radius || !Number(item.restaurantLat) || !Number(item.restaurantLng)) return true;
  const distanceKm = distanceInKm(geoPosition.lat, geoPosition.lng, Number(item.restaurantLat), Number(item.restaurantLng));
  return distanceKm <= radius;
}

function distanceInKm(lat1, lon1, lat2, lon2) {
  const toRad = deg => deg * Math.PI / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findRestaurants() {
  const country = $("countryField").value;
  const state = $("stateField").value;
  const city = $("cityField").value;
  const search = norm($("restaurantSearch").value);
  const openOnly = $("openOnlyFilter").checked;
  const deliveryOnly = $("deliveryOnlyFilter").checked;
  filteredRestaurants = restaurants.filter(item => {
    if (!restaurantMatchesMode(item)) return false;
    if (country && item.country !== country) return false;
    if (state && item.state !== state) return false;
    if (city && item.city !== city) return false;
    if (openOnly && !isRestaurantAccepting(item)) return false;
    if (mode === "delivery" && deliveryOnly && !deliveryEnabled(item)) return false;
    if (mode === "delivery" && !restaurantInsideDeliveryArea(item)) return false;
    if (search && !`${item.restaurantName} ${item.cuisine} ${item.address}`.toLowerCase().includes(search)) return false;
    return true;
  });
  renderRestaurants();
  showPanel("restaurantsPanel");
}

function renderRestaurants() {
  const wrap = $("restaurantResults");
  wrap.innerHTML = filteredRestaurants.length ? filteredRestaurants.map(item => {
    const logo = item.logoDataUrl || item.restaurantLogoUrl || item.logoUrl || item.logo || "./assets/logo.PNG";
    const prep = item.preparationTime || item.preparationTimeMinutes || item.estimatedPreparationTime || "";
    return `<article class="restaurant-card">
      <img src="${escapeHtml(logo)}" alt="${escapeHtml(item.restaurantName)} logo" loading="lazy" onerror="this.src='./assets/logo.PNG'">
      <div>
        <h3>${escapeHtml(item.restaurantName)}</h3>
        <p>${escapeHtml(item.address || [item.city, item.state].filter(Boolean).join(", ") || "Address not added")}</p>
        <div class="badge-row">
          <span class="badge">${escapeHtml(item.cuisine)}</span>
          <span class="badge">${isRestaurantAccepting(item) ? "Accepting orders" : "Not accepting"}</span>
          ${preorderEnabled(item) ? `<span class="badge">Pre-order</span>` : ""}
          ${deliveryEnabled(item) ? `<span class="badge">Delivery</span>` : ""}
          ${prep ? `<span class="badge">${escapeHtml(prep)} min</span>` : ""}
        </div>
      </div>
      <button class="primary-btn select-restaurant-btn" type="button" data-id="${escapeHtml(item.id)}">Select Restaurant</button>
    </article>`;
  }).join("") : `<div class="status-message">No restaurants match this location and mode. Restaurants must enable ${mode === "delivery" ? "delivery" : "pre-order"} in settings before appearing here.</div>`;
  wrap.querySelectorAll(".select-restaurant-btn").forEach(button => button.addEventListener("click", () => selectRestaurant(button.dataset.id)));
}

async function selectRestaurant(id) {
  selectedRestaurant = restaurants.find(item => item.id === id);
  if (!selectedRestaurant) return;
  status("Loading restaurant menu...");
  const snap = await getDocs(collection(db, "restaurants", selectedRestaurant.id, "menu"));
  menuItems = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(item => item.available !== false)
    .sort((a, b) => String(a.category || "Other").localeCompare(String(b.category || "Other")) || Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  activeCategory = "All";
  cart = [];
  selectedTable = "";
  $("menuRestaurantTitle").textContent = selectedRestaurant.restaurantName;
  renderCategories();
  renderMenu();
  renderCart();
  renderTables();
  updatePaymentOptions();
  status("");
  showPanel("menuPanel");
}

function validVariants(item = {}) {
  return Array.isArray(item.variants) ? item.variants.filter(v => text(v.name) && Number(v.price) > 0) : [];
}

function itemPrice(item = {}, variantName = "") {
  const variant = validVariants(item).find(v => v.name === variantName);
  return Number(variant?.price ?? item.price ?? item.basePrice ?? 0);
}

function renderCategories() {
  const cats = ["All", ...new Set(menuItems.map(item => item.category || "Other"))];
  $("categoryTabs").innerHTML = cats.map(cat => `<button type="button" class="${cat === activeCategory ? "active" : ""}" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`).join("");
  $("categoryTabs").querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
    activeCategory = button.dataset.cat;
    renderCategories();
    renderMenu();
  }));
}

function foodBadge(item = {}) {
  const type = norm(item.foodType || (item.isNonVeg ? "nonveg" : item.isEgg ? "egg" : "veg"));
  return type === "nonveg" ? "Non Veg" : type === "egg" ? "Egg" : type === "other" ? "Other" : "Veg";
}

function renderMenu() {
  const items = activeCategory === "All" ? menuItems : menuItems.filter(item => (item.category || "Other") === activeCategory);
  $("menuGrid").innerHTML = items.length ? items.map(item => {
    const variants = validVariants(item);
    const image = item.imageUrl || item.image || "./assets/placeholder-food.jpg";
    return `<article class="menu-card">
      <img src="${escapeHtml(image)}" alt="${escapeHtml(item.name || "Menu item")}" loading="lazy" onerror="this.src='./assets/placeholder-food.jpg'">
      <div>
        <h3>${escapeHtml(item.name || "Item")}</h3>
        <p>${escapeHtml(item.description || item.category || "")}</p>
        <div class="badge-row"><span class="badge">${escapeHtml(foodBadge(item))}</span>${variants.length ? `<span class="badge">Half / Full</span>` : ""}</div>
        <div class="menu-meta">
          ${variants.length ? `<select data-variant-for="${escapeHtml(item.id)}">${variants.map(v => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} · ${money(v.price)}</option>`).join("")}</select>` : `<strong>${money(itemPrice(item))}</strong>`}
          <button type="button" data-add="${escapeHtml(item.id)}">Add</button>
        </div>
      </div>
    </article>`;
  }).join("") : `<div class="status-message">No available menu items found for this restaurant.</div>`;
  $("menuGrid").querySelectorAll("[data-add]").forEach(button => button.addEventListener("click", () => {
    const item = menuItems.find(entry => entry.id === button.dataset.add);
    const variant = document.querySelector(`[data-variant-for="${CSS.escape(item.id)}"]`)?.value || "";
    addToCart(item, variant);
  }));
}

function cartKey(item, variantName = "") { return `${item.id || item.name}|${variantName}`; }
function addToCart(item, variantName = "") {
  const key = cartKey(item, variantName);
  const existing = cart.find(entry => entry.key === key);
  if (existing) existing.qty += 1;
  else cart.push({ key, id: item.id, name: item.name || "Item", category: item.category || "", variantName, price: itemPrice(item, variantName), qty: 1 });
  renderCart();
}

function updateCart(key, delta) {
  const item = cart.find(entry => entry.key === key);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) cart = cart.filter(entry => entry.key !== key);
  renderCart();
}

function deliveryFee() {
  if (selectedDiningType() !== "delivery") return 0;
  const subtotal = totals().grandTotal;
  const freeAbove = settingNumber(selectedRestaurant, "freeDeliveryThreshold", 0);
  if (freeAbove && subtotal >= freeAbove) return 0;
  return settingNumber(selectedRestaurant, "deliveryFee", 0);
}

function totals() {
  return calculateOrderTotals(cart, selectedRestaurant || {}, {});
}

function renderCart() {
  const wrap = $("cartItems");
  wrap.innerHTML = cart.length ? cart.map(item => `<div class="cart-row">
    <div><strong>${escapeHtml(item.name)}</strong><br><small>${escapeHtml(item.variantName || item.category || "")}</small><div class="qty-controls"><button class="qty-btn" data-dec="${escapeHtml(item.key)}">-</button><span>${item.qty}</span><button class="qty-btn" data-inc="${escapeHtml(item.key)}">+</button></div></div>
    <strong>${money(item.price * item.qty)}</strong>
  </div>`).join("") : `<p class="muted">Your cart is empty.</p>`;
  wrap.querySelectorAll("[data-dec]").forEach(button => button.addEventListener("click", () => updateCart(button.dataset.dec, -1)));
  wrap.querySelectorAll("[data-inc]").forEach(button => button.addEventListener("click", () => updateCart(button.dataset.inc, 1)));
  const summary = totals();
  $("cartSummary").innerHTML = summaryHtml(summary);
}

function summaryHtml(summary = totals(), extraFee = deliveryFee()) {
  const grand = Number(summary.grandTotal || 0) + Number(extraFee || 0);
  return `<div class="summary-row"><span>Items</span><strong>${money(summary.itemsTotal)}</strong></div>
    <div class="summary-row"><span>Discount</span><strong>${money(summary.discountAmount || 0)}</strong></div>
    <div class="summary-row"><span>Tax</span><strong>${money(summary.tax)}</strong></div>
    ${extraFee ? `<div class="summary-row"><span>Delivery fee</span><strong>${money(extraFee)}</strong></div>` : ""}
    <div class="summary-row total"><span>Total</span><strong>${money(grand)}</strong></div>`;
}

function selectedDiningType() {
  return document.querySelector('input[name="diningType"]:checked')?.value || (mode === "delivery" ? "delivery" : "preorder_dine_in");
}

function updateDiningVisibility() {
  const type = selectedDiningType();
  $("tableSection")?.classList.toggle("hidden", type !== "preorder_dine_in");
  $("deliveryAddressSection")?.classList.toggle("hidden", type !== "delivery");
  updatePaymentOptions();
}

function renderTables() {
  const count = Math.max(0, Number(selectedRestaurant?.tableCount || 0));
  const tables = Array.isArray(selectedRestaurant?.tables) ? selectedRestaurant.tables : Array.from({ length: count || 12 }, (_, i) => ({ tableNo: String(i + 1).padStart(2, "0") }));
  $("tableGrid").innerHTML = tables.map(table => {
    const tableNo = text(table.tableNo || table.number || table.id);
    const unavailable = boolSetting(table.unavailable || table.disabled, false);
    return `<button class="table-btn ${unavailable ? "unavailable" : ""}" type="button" data-table="${escapeHtml(tableNo)}" ${unavailable ? "disabled" : ""}>${escapeHtml(tableNo)}<br><small>${unavailable ? "Unavailable" : table.capacity ? `${escapeHtml(table.capacity)} seats` : "Available"}</small></button>`;
  }).join("");
  $("tableGrid").querySelectorAll(".table-btn:not(.unavailable)").forEach(button => button.addEventListener("click", () => {
    selectedTable = button.dataset.table;
    document.querySelectorAll(".table-btn").forEach(btn => btn.classList.toggle("selected", btn === button));
  }));
}

function advanceOptions() {
  const min = Math.max(0, settingNumber(selectedRestaurant, "preorderAdvancePercentage", settingNumber(selectedRestaurant, "minimumAdvancePercentage", 25)));
  const options = [{ label: `Pay ${min}% advance`, value: min, method: "advance" }];
  if (boolSetting(selectedRestaurant?.allowHalfAdvance, false) || boolSetting(selectedRestaurant?.allow50Advance, false)) options.push({ label: "Pay 50% advance", value: 50, method: "advance_50" });
  if (boolSetting(selectedRestaurant?.allowFullPayment, true)) options.push({ label: "Pay full amount", value: 100, method: "full" });
  if (boolSetting(selectedRestaurant?.allowPayAtRestaurant, false) && selectedDiningType() !== "delivery") options.push({ label: "Pay at restaurant", value: 0, method: "pay_at_restaurant" });
  if (selectedDiningType() === "delivery" && boolSetting(selectedRestaurant?.cashOnDeliveryEnabled, false)) options.push({ label: "Cash on delivery", value: 0, method: "cod" });
  return options;
}

function updatePaymentOptions() {
  const options = advanceOptions();
  $("paymentOptions").innerHTML = options.map((option, index) => `<label><input type="radio" name="paymentOption" value="${option.value}" data-method="${option.method}" ${index === 0 ? "checked" : ""} /> ${escapeHtml(option.label)}<span>${option.value ? "Advance is recorded now; online gateway remains the existing restaurant payment setup." : "No online amount collected now."}</span></label>`).join("");
  renderFinalSummary();
}

function renderFinalSummary() {
  const summary = totals();
  const fee = deliveryFee();
  const total = Number(summary.grandTotal || 0) + fee;
  const selected = document.querySelector('input[name="paymentOption"]:checked');
  const pct = Number(selected?.value || 0);
  const amountPaid = Math.round(total * pct / 100);
  $("finalSummary").innerHTML = `${summaryHtml(summary, fee)}
    <div class="summary-row"><span>Advance payable now</span><strong>${money(amountPaid)}</strong></div>
    <div class="summary-row"><span>Remaining balance</span><strong>${money(Math.max(0, total - amountPaid))}</strong></div>
    <div class="summary-row"><span>Confirmation status</span><strong>Pending</strong></div>`;
}

function validateDetails() {
  if (!cart.length) return "Add at least one item to cart.";
  if (!$("customerName").value.trim()) return "Enter customer name.";
  if (normalizeCustomerPhone($("customerPhone").value).length !== 10) return "Enter a valid 10 digit mobile number.";
  if (!$("arrivalTime").value) return "Select expected arrival or delivery time.";
  const type = selectedDiningType();
  if (type === "preorder_dine_in" && !selectedTable) return "Select an available table.";
  if (type === "delivery" && !$("deliveryAddress").value.trim()) return "Enter delivery address.";
  if (type === "delivery" && !deliveryEnabled(selectedRestaurant)) return "This restaurant has not enabled delivery.";
  if (type === "delivery") {
    const minimumOrderValue = settingNumber(selectedRestaurant, "minimumOrderValue", 0);
    if (minimumOrderValue && totals().grandTotal < minimumOrderValue) return `Minimum delivery order is ${money(minimumOrderValue)}.`;
  }
  return "";
}

function publicOrderStatusFor(type) {
  if (boolSetting(selectedRestaurant?.automaticAcceptance, false)) return { status: "confirmed", restaurantConfirmationStatus: "confirmed" };
  return { status: "pending", restaurantConfirmationStatus: "pending_confirmation" };
}

async function confirmOrder() {
  const error = validateDetails();
  if (error) { status(error, "error"); return; }
  const type = selectedDiningType();
  const summary = totals();
  const fee = deliveryFee();
  const total = Number(summary.grandTotal || 0) + fee;
  const payment = document.querySelector('input[name="paymentOption"]:checked');
  const advancePercentage = Number(payment?.value || 0);
  const amountPaid = Math.round(total * advancePercentage / 100);
  const orderId = `ORD${Date.now()}`;
  const statusFields = publicOrderStatusFor(type);
  const payload = {
    orderId,
    restaurantId: selectedRestaurant.id,
    restaurantName: selectedRestaurant.restaurantName,
    source: mode === "delivery" ? "delivery_web" : "preorder_web",
    orderType: type,
    orderMode: type === "delivery" ? "delivery" : type === "takeaway" ? "takeaway" : "table",
    businessType: selectedRestaurant.businessType || "Restaurant",
    items: cart.map(item => ({ ...item, quantity: item.qty, total: item.price * item.qty })),
    itemsTotal: summary.itemsTotal,
    subtotal: summary.subtotal,
    discountAmount: summary.discountAmount || 0,
    taxableAmount: summary.taxableAmount,
    tax: summary.tax,
    deliveryFee: fee,
    grandTotal: total,
    total,
    advancePercentage,
    amountPaid,
    paidAmount: amountPaid,
    remainingAmount: Math.max(0, total - amountPaid),
    paymentMethod: payment?.dataset.method || "advance",
    paymentStatus: amountPaid >= total && total > 0 ? "paid" : amountPaid > 0 ? "partially_paid" : "unpaid",
    ...statusFields,
    customerName: $("customerName").value.trim(),
    customerPhone: `+91${normalizeCustomerPhone($("customerPhone").value)}`,
    customerEmail: $("customerEmail").value.trim(),
    note: $("customerNote").value.trim(),
    specialInstructions: $("customerNote").value.trim(),
    expectedArrivalTime: $("arrivalTime").value,
    tableNo: type === "preorder_dine_in" ? selectedTable : null,
    tableNumber: type === "preorder_dine_in" ? selectedTable : null,
    country: $("countryField").value,
    state: $("stateField").value,
    district: $("cityField").value,
    city: $("cityField").value,
    area: $("areaField").value.trim(),
    deliveryAddress: type === "delivery" ? $("deliveryAddress").value.trim() : "",
    landmark: type === "delivery" ? $("landmarkField").value.trim() : "",
    postalCode: type === "delivery" ? $("postalCodeField").value.trim() : "",
    coordinates: geoPosition,
    scheduledPreparationTime: $("arrivalTime").value,
    tableHoldExpiresAt: type === "preorder_dine_in" ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null,
    billClosed: false,
    etaMinutes: settingNumber(selectedRestaurant, type === "delivery" ? "estimatedDeliveryTime" : "preparationTimeMinutes", 30),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  status("Creating your order...");
  await addDoc(collection(db, "orders"), payload);
  location.href = `./track.html?orderId=${encodeURIComponent(orderId)}`;
}

$("countryField").addEventListener("change", updateStateOptions);
$("stateField").addEventListener("change", updateCityOptions);
$("findRestaurantsBtn").addEventListener("click", findRestaurants);
$("restaurantSearch").addEventListener("input", findRestaurants);
$("openOnlyFilter").addEventListener("change", findRestaurants);
$("deliveryOnlyFilter").addEventListener("change", findRestaurants);
$("backToRestaurantsBtn").addEventListener("click", () => showPanel("restaurantsPanel"));
$("continueDetailsBtn").addEventListener("click", () => {
  if (!cart.length) return status("Add at least one item before continuing.", "error");
  showPanel("detailsPanel");
});
$("backToMenuBtn").addEventListener("click", () => showPanel("menuPanel"));
$("continuePaymentBtn").addEventListener("click", () => {
  const error = validateDetails();
  if (error) return status(error, "error");
  status("");
  updatePaymentOptions();
  showPanel("paymentPanel");
});
$("backToDetailsBtn").addEventListener("click", () => showPanel("detailsPanel"));
$("confirmOrderBtn").addEventListener("click", () => guardedAction($("confirmOrderBtn"), confirmOrder, { loadingText: "Confirming...", timeoutMs: 25000 }));
$("useGeoBtn").addEventListener("click", () => {
  if (!navigator.geolocation) return status("Geolocation is not available on this device.", "error");
  navigator.geolocation.getCurrentPosition(pos => {
    geoPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
    status("Location captured. You can still enter address manually.");
  }, () => status("Location permission skipped. Manual address entry is available.", "error"), { enableHighAccuracy: true, timeout: 10000 });
});
document.querySelectorAll('input[name="diningType"]').forEach(input => input.addEventListener("change", updateDiningVisibility));
document.addEventListener("change", event => {
  if (event.target?.name === "paymentOption") renderFinalSummary();
});
modeButtons.forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));

setMode(mode);
await loadRestaurants();
