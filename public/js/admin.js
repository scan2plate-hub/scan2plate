import { db, auth } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  onSnapshot,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

/* =========================================================
   LOGIN / USER
========================================================= */
const rawUser =
  localStorage.getItem("scan2plate_user") ||
  localStorage.getItem("scan2serve_user");

if (!rawUser) {
  alert("Please login first.");
  window.location.href = "./admin-login.html";
  throw new Error("No login data");
}

let currentUser = {};
try {
  currentUser = JSON.parse(rawUser);
} catch (e) {
  localStorage.removeItem("scan2plate_user");
  localStorage.removeItem("scan2serve_user");
  alert("Login session invalid. Please login again.");
  window.location.href = "./admin-login.html";
  throw e;
}

const restaurantId =
  currentUser.restaurantId ||
  localStorage.getItem("scan2plate_last_restaurant_id");

if (!restaurantId) {
  alert("Restaurant ID not found. Please login again.");
  window.location.href = "./admin-login.html";
  throw new Error("Restaurant ID missing");
}

/* =========================================================
   SUBSCRIPTION PROTECTION
========================================================= */
const subscriptionLockEl = document.getElementById("subscriptionLock");
const subscriptionRestaurantNameEl = document.getElementById("subscriptionRestaurantName");
const subscriptionPlanNameEl = document.getElementById("subscriptionPlanName");
const subscriptionExpiryDateEl = document.getElementById("subscriptionExpiryDate");
const subscriptionSupportEl = document.getElementById("subscriptionSupport");
const renewSubscriptionBtn = document.getElementById("renewSubscriptionBtn");
const contactSuperAdminBtn = document.getElementById("contactSuperAdminBtn");
const subscriptionLogoutBtn = document.getElementById("subscriptionLogoutBtn");
let isSubscriptionLocked = false;
let currentRestaurantPlan = "advance";
let canUseOrdering = true;

function subscriptionDate(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRestaurantExpired(restaurantData = {}) {
  const status = String(restaurantData.status || "").toLowerCase();
  const subscriptionStatus = String(restaurantData.subscriptionStatus || "").toLowerCase();
  if (["expired", "suspended"].includes(status) || subscriptionStatus === "expired") return true;
  const expiry = subscriptionDate(restaurantData.planExpiryDate || restaurantData.expiryDate);
  if (!expiry) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  expiry.setHours(0, 0, 0, 0);
  return expiry < today;
}

function getRestaurantPlan(restaurantData = {}) { return String(restaurantData.plan || "advance").toLowerCase(); }
function isBasicPlan(restaurantData = {}) { return getRestaurantPlan(restaurantData) === "basic"; }
function applyPlanAccess(restaurantData = {}) {
  currentRestaurantPlan = getRestaurantPlan(restaurantData);
  canUseOrdering = !isBasicPlan(restaurantData) && !isRestaurantExpired(restaurantData);
  const basic = isBasicPlan(restaurantData);
  document.getElementById("basicPlanNotice")?.classList.toggle("hidden", !basic);
  ["orders", "billing", "kot"].forEach(section => {
    document.getElementById(`section-${section}`)?.classList.toggle("hidden", basic);
    document.querySelector(`.nav-item[data-section="${section}"]`)?.classList.toggle("hidden", basic);
  });
  document.querySelectorAll('[data-action="new-order"],[data-action="print-kot"],[data-action="print-bill"]').forEach(button => button.classList.toggle("hidden", basic));
}

function clearAdminSession() {
  localStorage.removeItem("scan2plate_user");
  localStorage.removeItem("scan2serve_user");
  localStorage.removeItem("scan2plate_last_restaurant_id");
}

function showSubscriptionLock(restaurantData = {}) {
  isSubscriptionLocked = true;
  document.body.classList.add("subscription-locked");
  subscriptionRestaurantNameEl.textContent = restaurantData.restaurantName || restaurantData.name || restaurantId;
  subscriptionPlanNameEl.textContent = String(restaurantData.plan || "Basic").replace(/^./, char => char.toUpperCase());
  const expiry = subscriptionDate(restaurantData.planExpiryDate || restaurantData.expiryDate);
  subscriptionExpiryDateEl.textContent = expiry ? expiry.toLocaleDateString("en-IN") : "Subscription inactive";
  try {
    const support = JSON.parse(localStorage.getItem("scan2plate_super_settings") || "{}");
    const contact = [support.supportPhone, support.supportEmail].filter(Boolean).join(" · ");
    if (contact) subscriptionSupportEl.textContent = `For renewal, contact Scan2Plate Support: ${contact}`;
  } catch {}
  subscriptionLockEl?.classList.add("show");
}

async function checkRestaurantSubscription() {
  try {
    const restaurantSnap = await getDoc(doc(db, "restaurants", restaurantId));
    if (restaurantSnap.exists() && isRestaurantExpired(restaurantSnap.data())) {
      applyPlanAccess(restaurantSnap.data());
      showSubscriptionLock(restaurantSnap.data());
      return true;
    }
    if (restaurantSnap.exists()) applyPlanAccess(restaurantSnap.data());
    if (isSubscriptionLocked) {
      window.location.reload();
      return false;
    }
    subscriptionLockEl?.classList.remove("show");
    return false;
  } catch (error) {
    console.error("Subscription check failed", error);
    return false;
  }
}

renewSubscriptionBtn?.addEventListener("click", () => {
  const support = (() => { try { return JSON.parse(localStorage.getItem("scan2plate_super_settings") || "{}"); } catch { return {}; } })();
  const subject = encodeURIComponent(`Renew Scan2Plate subscription — ${restaurantId}`);
  if (support.supportEmail) window.location.href = `mailto:${encodeURIComponent(support.supportEmail)}?subject=${subject}`;
  else alert("Please contact your Super Admin to renew this subscription.");
});
contactSuperAdminBtn?.addEventListener("click", () => {
  const support = (() => { try { return JSON.parse(localStorage.getItem("scan2plate_super_settings") || "{}"); } catch { return {}; } })();
  if (support.supportPhone) window.location.href = `tel:${String(support.supportPhone).replace(/[^+\d]/g, "")}`;
  else if (support.supportEmail) window.location.href = `mailto:${encodeURIComponent(support.supportEmail)}`;
  else alert("Please contact your Super Admin for renewal assistance.");
});
subscriptionLogoutBtn?.addEventListener("click", async () => {
  clearAdminSession();
  try { await signOut(auth); } catch (error) { console.warn("Logout error", error); }
  window.location.href = "./admin-login.html";
});

/* =========================================================
   DOM REFS
========================================================= */
const todayOrdersEl = document.getElementById("todayOrders");
const pendingOrdersEl = document.getElementById("pendingOrders");
const todayRevenueEl = document.getElementById("todayRevenue");
const completedOrdersEl = document.getElementById("completedOrders");
const pendingOrdersBadgeEl = document.getElementById("pendingOrdersBadge");

const orderListEl = document.getElementById("orderList");
const allOrdersListEl = document.getElementById("allOrdersList");
const pendingKotListEl = document.getElementById("pendingKotList");
const kotHistoryListEl = document.getElementById("kotHistoryList");

const menuListEl = document.getElementById("menuList");
const bestSellingListEl = document.getElementById("bestSellingList");
const reportRowsEl = document.getElementById("reportRows");
const reportSummaryEl = document.getElementById("reportSummary");
const reportDateEl = document.getElementById("reportDate");
const reportMonthEl = document.getElementById("reportMonth");
const reportYearEl = document.getElementById("reportYear");
const reportStartDateEl = document.getElementById("reportStartDate");
const reportEndDateEl = document.getElementById("reportEndDate");
const applyReportRangeBtn = document.getElementById("applyReportRangeBtn");
const reportPaymentBreakdownEl = document.getElementById("reportPaymentBreakdown");
const reportBestSellingEl = document.getElementById("reportBestSelling");
const reportTableWiseEl = document.getElementById("reportTableWise");
const exportReportBtn = document.getElementById("exportReportBtn");
const printReportBtn = document.getElementById("printReportBtn");
const kotHistoryDateEl = document.getElementById("kotHistoryDate");

const tablesGridEl = document.getElementById("tablesGrid");
const tableSummaryEl = document.getElementById("tableSummary");
const addTablesCountEl = document.getElementById("addTablesCount");
const addTablesBtn = document.getElementById("addTablesBtn");
const downloadAllTableQrsBtn = document.getElementById("downloadAllTableQrsBtn");
let managedTables = [];

const logoutBtn = document.getElementById("logoutBtn");
const refreshBtn = document.getElementById("refreshBtn");

const itemNameEl = document.getElementById("itemName");
const itemCategoryEl = document.getElementById("itemCategory");
const itemCategoryQuickPickEl = document.getElementById("itemCategoryQuickPick");
const itemCategoryStatusEl = document.getElementById("itemCategoryStatus");
const itemCategorySuggestionsEl = document.getElementById("itemCategorySuggestions");
const itemPriceEl = document.getElementById("itemPrice");
const itemAvailableEl = document.getElementById("itemAvailable");
const itemImageEl = document.getElementById("itemImage");
const itemSortOrderEl = document.getElementById("itemSortOrder");
const itemCategorySortEl = document.getElementById("itemCategorySort");
const itemInCategorySortEl = document.getElementById("itemInCategorySort");
const itemDescriptionEl = document.getElementById("itemDescription");
const menuDocIdEl = document.getElementById("menuDocId");
const saveMenuBtn = document.getElementById("saveMenuBtn");
const deleteMenuBtn = document.getElementById("deleteMenuBtn");
const clearMenuFormBtn = document.getElementById("clearMenuForm");
const menuSearchEl = document.getElementById("menuSearch");
const uploadMenuPdfBtn = document.getElementById("uploadMenuPdfBtn");
const menuPdfInput = document.getElementById("menuPdfInput");
const downloadMenuPdfSampleBtn = document.getElementById("downloadMenuPdfSampleBtn");
const menuImportCard = document.getElementById("menuImportCard");
const menuImportRowsEl = document.getElementById("menuImportRows");
const menuImportStatusEl = document.getElementById("menuImportStatus");
const menuImportUpdateDuplicatesEl = document.getElementById("menuImportUpdateDuplicates");
const importMenuBtn = document.getElementById("importMenuBtn");
const cancelMenuImportBtn = document.getElementById("cancelMenuImportBtn");
let menuImportItems = [];
let menuImportInvalidCount = 0;
let menuImportWarning = "";
const inventoryUsageRowsEl = document.getElementById("inventoryUsageRows");
const addInventoryUsageBtn = document.getElementById("addInventoryUsageBtn");
const inventoryItemNameEl = document.getElementById("inventoryItemName");
const inventoryUnitEl = document.getElementById("inventoryUnit");
const inventoryCurrentStockEl = document.getElementById("inventoryCurrentStock");
const inventoryMinStockEl = document.getElementById("inventoryMinStock");
const inventoryPurchasePriceEl = document.getElementById("inventoryPurchasePrice");
const inventorySupplierNameEl = document.getElementById("inventorySupplierName");
const inventoryDocIdEl = document.getElementById("inventoryDocId");
const saveInventoryBtn = document.getElementById("saveInventoryBtn");
const clearInventoryBtn = document.getElementById("clearInventoryBtn");
const inventoryRowsEl = document.getElementById("inventoryRows");
const adjustmentItemEl = document.getElementById("adjustmentItem");
const adjustmentTypeEl = document.getElementById("adjustmentType");
const adjustmentQuantityEl = document.getElementById("adjustmentQuantity");
const adjustmentReasonEl = document.getElementById("adjustmentReason");
const saveAdjustmentBtn = document.getElementById("saveAdjustmentBtn");
const inventoryHistoryRowsEl = document.getElementById("inventoryHistoryRows");
const inventoryReportEl = document.getElementById("inventoryReport");
const inventoryMostUsedEl = document.getElementById("inventoryMostUsed");
const lowStockAlertEl = document.getElementById("lowStockAlert");
const purchaseBillFileEl = document.getElementById("purchaseBillFile");
const purchaseSupplierNameEl = document.getElementById("purchaseSupplierName");
const purchaseBillPreviewEl = document.getElementById("purchaseBillPreview");
const scanPurchaseBillBtn = document.getElementById("scanPurchaseBillBtn");
const rescanPurchaseBillBtn = document.getElementById("rescanPurchaseBillBtn");
const purchaseReviewEl = document.getElementById("purchaseReview");
const purchaseReviewRowsEl = document.getElementById("purchaseReviewRows");
const addPurchaseReviewRowBtn = document.getElementById("addPurchaseReviewRowBtn");
const purchaseBillNumberEl = document.getElementById("purchaseBillNumber");
const purchaseBillDateEl = document.getElementById("purchaseBillDate");
const purchaseTaxAmountEl = document.getElementById("purchaseTaxAmount");
const purchaseGrandTotalEl = document.getElementById("purchaseGrandTotal");
const savePurchaseBillBtn = document.getElementById("savePurchaseBillBtn");
const purchaseHistoryRowsEl = document.getElementById("purchaseHistoryRows");

const restaurantFieldEl = document.getElementById("restaurantField");
const businessModeFieldEl = document.getElementById("businessModeField");
const orderModeFieldEl = document.getElementById("orderModeField");
const upiFieldEl = document.getElementById("upiField");
const taxFieldEl = document.getElementById("taxField");
const phoneFieldEl = document.getElementById("phoneField");
const addressFieldEl = document.getElementById("addressField");
const logoFieldEl = document.getElementById("logoField");
const kitchenWhatsAppFieldEl = document.getElementById("kitchenWhatsAppField");
const backendUrlFieldEl = document.getElementById("backendUrlField");
const gstFieldEl = document.getElementById("gstField");
const restaurantLatFieldEl = document.getElementById("restaurantLatField");
const restaurantLngFieldEl = document.getElementById("restaurantLngField");
const allowedOrderRadiusFieldEl = document.getElementById("allowedOrderRadiusField");
const useCurrentLocationBtn = document.getElementById("useCurrentLocationBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");

const manualCustomerNameEl = document.getElementById("manualCustomerName");
const manualCustomerPhoneEl = document.getElementById("manualCustomerPhone");
const manualTableNoEl = document.getElementById("manualTableNo");
const manualPaymentMethodEl = document.getElementById("manualPaymentMethod");
const manualPaymentStatusEl = document.getElementById("manualPaymentStatus");
const createManualBillBtn = document.getElementById("createManualBillBtn");
const printKotFromBillingBtn = document.getElementById("printKotFromBilling");
const manualUpiBtn = document.getElementById("manualUpiBtn");
const clearCartBtn = document.getElementById("clearCartBtn");

const manualBillMsgEl = document.getElementById("manualBillMsg");
const manualUpiQrWrap = document.getElementById("manualUpiQrWrap");
const manualUpiQrImg = document.getElementById("manualUpiQrImg");
const manualMenuPickerEl = document.getElementById("manualMenuPicker");
const manualCartListEl = document.getElementById("manualCartList");
const manualItemsTotalEl = document.getElementById("manualItemsTotal");
const manualTaxTotalEl = document.getElementById("manualTaxTotal");
const manualGrandTotalTextEl = document.getElementById("manualGrandTotalText");
const manualCategoryTabsEl = document.getElementById("manualCategoryTabs");
const menuCategoryTabsEl = document.getElementById("menuCategoryTabs");

const printAllKotBtn = document.getElementById("printAllKotBtn");
const kotModal = document.getElementById("kotModal");
const billModal = document.getElementById("billModal");

const kotRestaurantNameEl = document.getElementById("kotRestaurantName");
const kotNumberEl = document.getElementById("kotNumber");
const kotTableEl = document.getElementById("kotTable");
const kotDateEl = document.getElementById("kotDate");
const kotTimeEl = document.getElementById("kotTime");
const kotServerEl = document.getElementById("kotServer");
const kotItemsEl = document.getElementById("kotItems");
const kotNotesEl = document.getElementById("kotNotes");

const billRestaurantNameEl = document.getElementById("billRestaurantName");
const billAddressEl = document.getElementById("billAddress");
const billPhoneEl = document.getElementById("billPhone");
const billNumberEl = document.getElementById("billNumber");
const billTableEl = document.getElementById("billTable");
const billDateEl = document.getElementById("billDate");
const billCustomerEl = document.getElementById("billCustomer");
const billItemsEl = document.getElementById("billItems");
const billSubtotalEl = document.getElementById("billSubtotal");
const billTaxEl = document.getElementById("billTax");
const billTotalEl = document.getElementById("billTotal");
const billPaymentMethodEl = document.getElementById("billPaymentMethod");
const billUpiQrSectionEl = document.getElementById("billUpiQrSection");
const billUpiQrImgEl = document.getElementById("billUpiQrImg");
const billQrUpiIdEl = document.getElementById("billQrUpiId");
const billQrAmountEl = document.getElementById("billQrAmount");
const billQrRestaurantEl = document.getElementById("billQrRestaurant");
const billUpiMissingEl = document.getElementById("billUpiMissing");

const userNameEl = document.getElementById("userName");
const userRoleEl = document.getElementById("userRole");
const userAvatarEl = document.getElementById("userAvatar");

/* =========================================================
   STATE
========================================================= */
let restaurantSettings = {};
let allMenuItems = [];
let manualMenuItems = [];
let allOrders = [];
let manualCart = [];
let allInventoryItems = [];
let inventoryLogs = [];
let purchaseBills = [];
let reviewedPurchaseFileUrl = "";

let editingOrderDocId = null;
let editingOrderPublicId = null;

let selectedManualCategory = "all";
let selectedMenuCategory = "all";
let selectedOrderFilter = "all";
let selectedReportType = "daily";

let ordersUnsubscribe = null;
let inventoryUnsubscribe = null;
let inventoryLogsUnsubscribe = null;
const adminAcceptedSnapshots = new Map();
const seenSnapshotMap = new Map();

/* =========================================================
   UTILS
========================================================= */
function money(v) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Number(v || 0));
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeCategory(value = "") {
  return String(value || "").trim() || "Uncategorized";
}

function getUniqueCategories(items = []) {
  return [...new Set(items.map(item => normalizeCategory(item.category)))].sort((a, b) =>
    a.localeCompare(b)
  );
}

const MENU_PDF_CATEGORIES = ["Kadak Chai", "Hot Coffee", "Cold Coffee", "Milk Shake", "Coolers", "Hot Milk", "Firangi French Fries", "Garlic Bread", "Old Monk Special", "Magical Momos", "Magestic Maggie", "Burger Buffet", "Shahi Sandwich", "Pristine Pizza", "Aakhri Pasta", "Noodles", "Rolls", "Chinese Snacks", "Fried Rice", "Pav", "Soup", "Desi Paneer", "Marvellous Mushroom", "Roti & Rice", "South Indian", "Dessert Dhamaka", "Burger", "Pasta", "Drinks", "Chinese", "Tea", "Coffee", "Snacks", "Pizza", "Sandwich", "Momos", "Rice", "Dessert", "Starters", "Main Course", "Beverages"];
const normalizedMenuName = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
const MENU_PDF_NOISE = /^(menu|open\s*10\s*am|basudeopur|@?old\s*monk\s*cafe|thanks|about\s*us|our\s*story|follow\s*us|rate\s*us|scan2plate)$/i;

function categoryFromMenuLine(line) {
  const clean = String(line || "").replace(/[₹|]/g, "").replace(/[:]/g, "").replace(/\s+/g, " ").trim();
  const match = MENU_PDF_CATEGORIES.find(category => { const value = clean.toLowerCase(); const base = category.toLowerCase(); return value === base || value === `${base}s`; });
  if (match) return match;
  if (!MENU_PDF_NOISE.test(clean) && !/\d/.test(clean) && clean.length <= 38 && clean.split(/\s+/).length <= 5 && clean === clean.toUpperCase()) return clean.toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
  return "";
}

function cleanMenuName(value) {
  return String(value || "").replace(/[₹]/g, " ").replace(/(?:rs\.?|inr\.?)/ig, " ").replace(/[|–—]+/g, " ").replace(/\s+/g, " ").trim();
}

function isValidMenuName(value) {
  const name = cleanMenuName(value);
  return /[A-Za-z]/.test(name) && !/^[-₹\d./\s]+$/.test(name) && !MENU_PDF_NOISE.test(name);
}

function priceFromText(line) {
  const value = String(line || "");
  const match = value.match(/(?:₹\s*|rs\.?\s*|inr\.?\s*)(\d{1,5}(?:\.\d{1,2})?)|\b(\d{1,5}(?:\.\d{1,2})?)\s*\/-/i);
  if (match) return Number(match[1] || match[2]);
  const trailing = /[A-Za-z].*?\s(\d{1,5}(?:\.\d{1,2})?)\s*$/.exec(value);
  return trailing ? Number(trailing[1]) : null;
}

function isPriceOnlyLine(line) {
  return /^(?:₹\s*|rs\.?\s*|inr\.?\s*)?\d{1,5}(?:\.\d{1,2})?\s*(?:\/-)?\s*₹?$/i.test(String(line || "").trim());
}

function addParsedMenuItem(target, candidate, category) {
  const name = cleanMenuName(candidate?.name);
  const price = Number(candidate?.price);
  if (!isValidMenuName(name) || !Number.isFinite(price) || price <= 0) return false;
  target.push({ category: category || "Uncategorized", name, price });
  return true;
}

function parsePdfColumnLines(lines) {
  let category = "Uncategorized", pendingName = "", invalid = 0, headings = 0;
  const items = [];
  lines.forEach(rawLine => {
    const line = String(rawLine || "").replace(/\s+/g, " ").trim();
    if (!line || MENU_PDF_NOISE.test(line)) return;
    const heading = categoryFromMenuLine(line);
    if (heading) { category = heading; pendingName = ""; headings++; return; }
    const price = priceFromText(line);
    if (price !== null && !isPriceOnlyLine(line)) {
      const name = cleanMenuName(line.replace(/(?:₹\s*|rs\.?\s*|inr\.?\s*)?\d{1,5}(?:\.\d{1,2})?\s*(?:\/-)?\s*₹?$/i, ""));
      if (addParsedMenuItem(items, { name, price }, category)) pendingName = "";
      else invalid++;
      return;
    }
    if (price !== null && isPriceOnlyLine(line)) {
      if (pendingName && addParsedMenuItem(items, { name: pendingName, price }, category)) pendingName = "";
      else invalid++;
      return;
    }
    if (isValidMenuName(line)) pendingName = pendingName ? `${pendingName} ${line}` : cleanMenuName(line);
  });
  return { items, invalid, headings };
}

async function extractMenuPdf(file) {
  if (!window.pdfjsLib) throw new Error("PDF reader is unavailable. Please check your internet connection and try again.");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const parsed = { items: [], invalid: 0, headings: 0 };
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo); const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const lines = new Map();
    content.items.forEach(item => {
      const x = Number(item.transform?.[4] || 0); const y = Math.round(Number(item.transform?.[5] || 0) / 3) * 3;
      const column = Math.min(2, Math.floor(x / Math.max(viewport.width / 2, 1)));
      const key = `${column}:${y}`; const row = lines.get(key) || [];
      row.push({ x: Number(item.transform?.[4] || 0), text: item.str || "" });
      lines.set(key, row);
    });
    const columns = new Map();
    lines.forEach((row, key) => { const [column, y] = key.split(":"); const list = columns.get(column) || []; list.push({ y:Number(y), text:row.sort((a,b) => a.x - b.x).map(word => word.text).join(" ") }); columns.set(column, list); });
    [...columns.keys()].sort((a,b) => Number(a) - Number(b)).forEach(column => { const result = parsePdfColumnLines(columns.get(column).sort((a,b) => b.y - a.y).map(line => line.text)); parsed.items.push(...result.items); parsed.invalid += result.invalid; parsed.headings += result.headings; });
  }
  const unique = new Map(); parsed.items.forEach(item => unique.set(`${normalizedMenuName(item.category)}|${normalizedMenuName(item.name)}|${item.price}`, item));
  return { items:[...unique.values()], invalid:parsed.invalid, headings:parsed.headings };
}

function menuDuplicateFor(item) {
  return allMenuItems.find(existing => normalizedMenuName(existing.name) === normalizedMenuName(item.name) && normalizedMenuName(existing.category) === normalizedMenuName(item.category));
}

function renderMenuImportReview() {
  if (!menuImportRowsEl) return;
  menuImportCard.style.display = menuImportItems.length ? "block" : "none";
  if (!menuImportItems.length) return;
  menuImportRowsEl.innerHTML = menuImportItems.map((item, index) => {
    const duplicate = menuDuplicateFor(item);
    return `<tr data-import-index="${index}"><td><input class="form-input import-category" value="${escapeHtml(item.category)}" /></td><td><input class="form-input import-name" value="${escapeHtml(item.name)}" /></td><td><input class="form-input import-price" type="number" min="1" value="${Number(item.price || 0)}" /></td><td>${duplicate ? `<span class="status-badge warning">Already exists</span>` : `<span class="status-badge success">New</span>`}</td><td><button class="btn btn-outline btn-sm import-edit" type="button">Edit</button></td><td><button class="btn btn-danger btn-sm import-remove" type="button">Remove</button></td></tr>`;
  }).join("");
  menuImportRowsEl.querySelectorAll(".import-edit").forEach(button => button.onclick = () => button.closest("tr")?.querySelector(".import-name")?.focus());
  menuImportRowsEl.querySelectorAll(".import-remove").forEach(button => button.onclick = () => { menuImportItems.splice(Number(button.closest("tr")?.dataset.importIndex), 1); renderMenuImportReview(); });
  if (menuImportStatusEl) menuImportStatusEl.textContent = `${menuImportItems.length} item${menuImportItems.length === 1 ? "" : "s"} ready for review${menuImportInvalidCount ? ` · ${menuImportInvalidCount} invalid row${menuImportInvalidCount === 1 ? "" : "s"} skipped` : ""}${menuImportWarning ? ` · ${menuImportWarning}` : ""}`;
}

async function importReviewedMenuItems() {
  const rows = [...(menuImportRowsEl?.querySelectorAll("tr[data-import-index]") || [])];
  const allReviewed = rows.map(row => ({ category: normalizeCategory(row.querySelector(".import-category")?.value), name: cleanMenuName(row.querySelector(".import-name")?.value), price: Number(row.querySelector(".import-price")?.value || 0) }));
  const invalidRows = allReviewed.filter(item => !item.category || !isValidMenuName(item.name) || !Number.isFinite(item.price) || item.price <= 0).length;
  const reviewed = allReviewed.filter(item => item.category && isValidMenuName(item.name) && Number.isFinite(item.price) && item.price > 0);
  if (!reviewed.length) return alert("Add at least one valid item before importing.");
  const updateDuplicates = Boolean(menuImportUpdateDuplicatesEl?.checked);
  if (updateDuplicates && !confirm("Update category and price for matching existing menu items? Images and descriptions will stay unchanged.")) return;
  importMenuBtn.disabled = true; importMenuBtn.textContent = "Importing…";
  try {
    const nextSortByCategory = new Map();
    reviewed.forEach(item => { const key = normalizedMenuName(item.category); if (!nextSortByCategory.has(key)) nextSortByCategory.set(key, allMenuItems.filter(existing => normalizedMenuName(existing.category) === key).length + 1); });
    let added = 0, updated = 0, skipped = 0;
    for (const item of reviewed) {
      const duplicate = menuDuplicateFor(item);
      if (duplicate && !updateDuplicates) { skipped++; continue; }
      const categoryKey = normalizedMenuName(item.category);
      const sortOrder = nextSortByCategory.get(categoryKey) || 1;
      nextSortByCategory.set(categoryKey, sortOrder + 1);
      const payload = { name:item.name, category:item.category, price:item.price, available:true, sortOrder, updatedAt:serverTimestamp() };
      if (duplicate) { await setDoc(doc(db, "restaurants", restaurantId, "menu", duplicate.id), payload, { merge:true }); updated++; }
      else { await addDoc(collection(db, "restaurants", restaurantId, "menu"), { ...payload, imageUrl:"", image:"", description:"", createdAt:serverTimestamp() }); added++; }
    }
    alert(`Menu import complete: Imported: ${added + updated}, Skipped duplicates: ${skipped}, Invalid rows: ${invalidRows}.`);
    menuImportItems = []; menuImportInvalidCount = 0; menuImportWarning = ""; if (menuPdfInput) menuPdfInput.value = ""; if (menuImportUpdateDuplicatesEl) menuImportUpdateDuplicatesEl.checked = false;
    await loadMenuData(); renderMenuManagement(); renderManualMenuPicker(); renderMenuImportReview();
  } catch (error) { console.error("Menu PDF import failed", error); alert("Could not import menu. Please review the items and try again."); }
  finally { importMenuBtn.disabled = false; importMenuBtn.innerHTML = '<i class="fas fa-file-import"></i> Import Menu'; }
}

function downloadSampleMenuPdf() {
  const lines = ["SCAN2PLATE MENU IMPORT SAMPLE", "", "BURGERS", "Aloo Burger 79", "Cheese Burger 99", "", "DRINKS", "Cold Coffee 89", "Lemon Tea 30"];
  const stream = `BT /F1 15 Tf 50 780 Td ${lines.map((line, index) => `${index ? "0 -22 Td " : ""}(${line.replace(/[()\\]/g, "\\$&")}) Tj`).join(" ")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n", offsets = [0]; objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }); const xref = pdf.length; pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([pdf], { type:"application/pdf" })); link.download = "scan2plate-menu-import-sample.pdf"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function getTaxPercent() {
  return Number(restaurantSettings.taxPercent || 0);
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timestampToDate(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate();
  if (typeof ts.seconds === "number") return new Date(ts.seconds * 1000);
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateTime(ts) {
  const d = timestampToDate(ts);
  if (!d) return "-";
  return d.toLocaleString("en-IN");
}

function formatDateOnly(ts) {
  const d = timestampToDate(ts);
  if (!d) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getStatusClass(status = "") {
  const s = String(status).toLowerCase();
  if (s === "pending" || s === "accepted") return "pending";
  if (s === "preparing") return "preparing";
  if (s === "ready" || s === "served" || s === "completed") return "ready";
  if (s === "cancelled" || s === "rejected") return "cancelled";
  return "pending";
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  if (ts instanceof Date) return ts.getTime();
  const parsed = new Date(ts).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getEtaStartedMs(order) {
  return tsToMs(order.etaStartedAt) || 0;
}

function getRemainingSeconds(order) {
  const status = String(order?.status || "").toLowerCase();
  const etaMinutes = Number(order?.etaMinutes || 10);
  const startMs = getEtaStartedMs(order);

  if (!startMs || !["accepted", "preparing", "ready"].includes(status)) return null;

  const endMs = startMs + etaMinutes * 60 * 1000;
  return Math.max(0, Math.floor((endMs - Date.now()) / 1000));
}

function formatRemaining(seconds) {
  if (seconds === null) return "Not Started";
  const safe = Math.max(0, Number(seconds || 0));
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function buildOrderItemSnapshot(items = []) {
  const map = new Map();
  items.forEach(i => {
    const key = String(i.id || i.name || "");
    map.set(key, Number(i.qty || 0));
  });
  return map;
}

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function buildUpiUrl({ upiId, name, amount, orderId }) {
  return (
    `upi://pay?pa=${encodeURIComponent(upiId)}` +
    `&pn=${encodeURIComponent(name)}` +
    `&am=${encodeURIComponent(Number(amount).toFixed(2))}` +
    `&cu=INR` +
    `&tn=${encodeURIComponent("Bill Payment " + orderId)}`
  );
}

function buildQrUrl(upiUrl) {
  // High-resolution, pure black QR with a four-module quiet zone. qrserver's
  // `ecc=H` is the high error-correction setting used for printed UPI QR codes.
  return `https://api.qrserver.com/v1/create-qr-code/?format=png&size=1800x1800&ecc=H&margin=4&color=000000&bgcolor=FFFFFF&data=${encodeURIComponent(upiUrl)}`;
}

function waitForImageLoad(image) {
  if (!image) return Promise.reject(new Error("QR image is missing"));
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("QR image load timed out")), 8000);
    image.addEventListener("load", () => { clearTimeout(timeout); resolve(); }, { once: true });
    image.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("QR image failed to load")); }, { once: true });
  });
}

async function billQrAsPngDataUrl() {
  if (!billUpiQrImgEl || billUpiQrImgEl.style.display === "none" || !billUpiQrImgEl.src) throw new Error("UPI QR unavailable");
  await waitForImageLoad(billUpiQrImgEl);
  if (billUpiQrImgEl.src.startsWith("data:image/png")) return billUpiQrImgEl.src;
  const response = await fetch(billUpiQrImgEl.src, { mode: "cors", cache: "no-store" });
  if (!response.ok) throw new Error("Unable to download QR image");
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("QR conversion failed")); image.src = objectUrl; });
    const canvas = document.createElement("canvas");
    // Keep the full high-resolution source (normally 1800px) for crisp thermal output.
    canvas.width = image.naturalWidth || 1800;
    canvas.height = image.naturalHeight || 1800;
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function updateUserCard() {
  const name = currentUser.name || currentUser.email || "Admin";
  const role = currentUser.role || "Restaurant Admin";
  if (userNameEl) userNameEl.textContent = name;
  if (userRoleEl) userRoleEl.textContent = role;
  if (userAvatarEl) userAvatarEl.textContent = String(name).charAt(0).toUpperCase();
}

function renderCategoryChips(container, categories, selected, clickHandler) {
  if (!container) return;

  const allChips = ["all", ...categories];

  container.innerHTML = allChips
    .map(cat => `
      <button type="button" class="tab-pill ${cat === selected ? "active" : ""}" data-category="${escapeHtml(cat)}">
        ${escapeHtml(cat === "all" ? "All" : cat)}
      </button>
    `)
    .join("");

  container.querySelectorAll("[data-category]").forEach(btn => {
    btn.addEventListener("click", () => clickHandler(btn.dataset.category || "all"));
  });
}

function setNotice(message = "", type = "info") {
  if (!manualBillMsgEl) return;

  if (!message) {
    manualBillMsgEl.className = "notice-box info hidden";
    manualBillMsgEl.innerHTML = `<i class="fas fa-info-circle"></i><span></span>`;
    return;
  }

  manualBillMsgEl.className = `notice-box ${type}`;
  manualBillMsgEl.innerHTML = `<i class="fas fa-info-circle"></i><span>${escapeHtml(message)}</span>`;
}

function getTableOptions() {
  const seen = new Set();
  const count = Math.max(1, Number(restaurantSettings.tableCount || 20));
  for (let i = 1; i <= count; i++) seen.add(String(i).padStart(2, "0"));
  managedTables.filter(table => table.disabled !== true).forEach(table => seen.add(String(table.tableNo || table.id).padStart(2,"0")));

  allOrders.forEach(order => {
    const t = String(order.tableNo || "").trim();
    if (t) seen.add(t);
  });

  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function renderTableNumberOptions(selectedValue = "") {
  if (!manualTableNoEl) return;

  const selected = String(selectedValue || manualTableNoEl.value || "01").padStart(2, "0");

  manualTableNoEl.innerHTML = getTableOptions()
    .map(t => {
      const value = String(t).padStart(2, "0");
      return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>Table ${escapeHtml(value)}</option>`;
    })
    .join("");

  manualTableNoEl.value = selected; // ✅ force update
}

/* =========================================================
   ADMIN FULLSCREEN POPUP ALERT
========================================================= */
const adminAudioNewOrder = new Audio("./assets/notification.mp3");
adminAudioNewOrder.loop = true;
adminAudioNewOrder.preload = "auto";

const adminAudioUpdatedOrder = new Audio("./assets/notification.mp3");
adminAudioUpdatedOrder.loop = true;
adminAudioUpdatedOrder.preload = "auto";
adminAudioUpdatedOrder.playbackRate = 1.12;

let adminAudioUnlocked = false;
let adminAlertPlaying = false;
let adminAlertType = "";
let adminFirstRealtimeLoad = true;
const adminSeenRealtimeKeys = new Map();
const adminMutedOrderIds = new Set(JSON.parse(localStorage.getItem("scan2plate_muted_order_alerts") || "[]"));
let adminPendingAlarmIds = new Set();

async function unlockAdminAudio() {
  if (adminAudioUnlocked) return;
  try {
    adminAudioNewOrder.muted = true;
    await adminAudioNewOrder.play();
    adminAudioNewOrder.pause();
    adminAudioNewOrder.currentTime = 0;
    adminAudioNewOrder.muted = false;

    adminAudioUpdatedOrder.muted = true;
    await adminAudioUpdatedOrder.play();
    adminAudioUpdatedOrder.pause();
    adminAudioUpdatedOrder.currentTime = 0;
    adminAudioUpdatedOrder.muted = false;

    adminAudioUnlocked = true;
  } catch (err) {
    console.log("Admin audio locked until user interaction");
  }
}

document.addEventListener("click", unlockAdminAudio, { once: true });
document.addEventListener("touchstart", unlockAdminAudio, { once: true });
document.addEventListener("keydown", unlockAdminAudio, { once: true });

function ensureAdminAlertBanner() {
  let banner = document.getElementById("adminAlertBanner");
  if (banner) return banner;

  banner = document.createElement("div");
  banner.id = "adminAlertBanner";
  banner.style.cssText = `
    position:fixed;
    inset:0;
    background:rgba(0,0,0,.76);
    z-index:999999;
    display:none;
    align-items:center;
    justify-content:center;
    padding:20px;
  `;

  banner.innerHTML = `
    <div style="
      width:min(92vw,640px);
      background:#ffffff;
      border-radius:28px;
      padding:30px 24px;
      box-shadow:0 20px 70px rgba(0,0,0,.25);
      text-align:center;
    ">
      <div id="adminAlertEmoji" style="font-size:56px;line-height:1;margin-bottom:12px;">🔔</div>
      <div id="adminAlertTitle" style="font-size:30px;font-weight:800;margin-bottom:10px;color:#111;">New Order</div>
      <div id="adminAlertText" style="font-size:18px;color:#555;line-height:1.6;margin-bottom:20px;">
        Please check live orders now.
      </div>
      <button id="dismissAdminAlertBtn" style="
        border:none;
        background:#111;
        color:#fff;
        padding:14px 26px;
        border-radius:14px;
        font-size:16px;
        font-weight:800;
        cursor:pointer;
      ">Mute Pending Alarm</button>
    </div>
  `;

  document.body.appendChild(banner);
  document.getElementById("dismissAdminAlertBtn")?.addEventListener("click", () => {
    adminPendingAlarmIds.forEach(id => adminMutedOrderIds.add(id));
    localStorage.setItem("scan2plate_muted_order_alerts", JSON.stringify([...adminMutedOrderIds]));
    stopAdminAlert();
  });

  return banner;
}

function showAdminAlertBanner(type = "new_order") {
  ensureAdminAlertBanner();

  const emoji = document.getElementById("adminAlertEmoji");
  const title = document.getElementById("adminAlertTitle");
  const text = document.getElementById("adminAlertText");
  const banner = document.getElementById("adminAlertBanner");

  if (type === "updated_order") {
    if (emoji) emoji.textContent = "🆕";
    if (title) title.textContent = "Order Updated!";
    if (text) text.textContent = "Customer added new items to an existing order. Please check now.";
  } else {
    if (emoji) emoji.textContent = "🔔";
    if (title) title.textContent = "New Order Arrived!";
    if (text) text.textContent = `${adminPendingAlarmIds.size} New Order${adminPendingAlarmIds.size === 1 ? "" : "s"} Pending — accept, reject, or mute the alarm.`;
  }

  if (banner) banner.style.display = "flex";
}

function hideAdminAlertBanner() {
  const banner = document.getElementById("adminAlertBanner");
  if (banner) banner.style.display = "none";
}

function startAdminAlert(type = "new_order") {
  if (adminAlertPlaying && adminAlertType === type) return;

  stopAdminAlert(false);
  adminAlertPlaying = true;
  adminAlertType = type;
  showAdminAlertBanner(type);

  try {
    const audio = type === "updated_order" ? adminAudioUpdatedOrder : adminAudioNewOrder;
    audio.currentTime = 0;
    audio.play().catch(err => console.log("Admin audio blocked", err));
  } catch (err) {
    console.log(err);
  }

  document.title = type === "updated_order" ? "🆕 Order Updated!" : "🚨 New Order!";
}

function stopAdminAlert(resetTitle = true) {
  try {
    adminAudioNewOrder.pause();
    adminAudioNewOrder.currentTime = 0;
    adminAudioUpdatedOrder.pause();
    adminAudioUpdatedOrder.currentTime = 0;
  } catch (err) {}

  adminAlertPlaying = false;
  adminAlertType = "";
  hideAdminAlertBanner();

  if (resetTitle) document.title = "Admin Dashboard";
}

// Do not stop a new-order alarm merely because the tab loses focus.

function buildRealtimeKey(order) {
  return JSON.stringify({
    status: String(order.status || "").toLowerCase(),
    hasNewItems: order.hasNewItems === true,
    updatedAt: tsToMs(order.updatedAt),
    itemsText: order.newlyAddedItemsText || "",
    grandTotal: Number(order.grandTotal || 0)
  });
}

function handleRealtimeAdminAlerts(orders) {
  let shouldPlay = false;
  let type = "new_order";

  orders.forEach(order => {
    const key = buildRealtimeKey(order);
    const oldKey = adminSeenRealtimeKeys.get(order.id);

    if (!adminFirstRealtimeLoad) {
      if (!oldKey) {
        shouldPlay = true;
        type = "new_order";
      } else if (oldKey !== key) {
        if (order.hasNewItems === true) {
          shouldPlay = true;
          type = "updated_order";
        } else if (String(order.status || "").toLowerCase() === "pending") {
          shouldPlay = true;
          type = "new_order";
        }
      }
    }

    adminSeenRealtimeKeys.set(order.id, key);
  });

  const currentIds = new Set(orders.map(o => o.id));
  [...adminSeenRealtimeKeys.keys()].forEach(id => {
    if (!currentIds.has(id)) adminSeenRealtimeKeys.delete(id);
  });

  adminFirstRealtimeLoad = false;
  adminPendingAlarmIds = new Set(orders.filter(order => String(order.status || "").toLowerCase() === "pending").map(order => order.id));
  [...adminMutedOrderIds].forEach(id => { if (!adminPendingAlarmIds.has(id)) adminMutedOrderIds.delete(id); });
  localStorage.setItem("scan2plate_muted_order_alerts", JSON.stringify([...adminMutedOrderIds]));
  const unmutedPending = [...adminPendingAlarmIds].filter(id => !adminMutedOrderIds.has(id));
  if (unmutedPending.length) startAdminAlert(type);
  else if (adminAlertPlaying) stopAdminAlert();
}

/* =========================================================
   PAYMENT MODAL
========================================================= */
function showPaymentMethodModal(orderId) {
  const old = document.getElementById("paymentMethodModal");
  if (old) old.remove();

  const overlay = document.createElement("div");
  overlay.id = "paymentMethodModal";
  overlay.style.cssText = `
    position:fixed;
    inset:0;
    background:rgba(0,0,0,.62);
    z-index:999999;
    display:flex;
    align-items:center;
    justify-content:center;
    padding:18px;
  `;

  overlay.innerHTML = `
    <div style="
      width:min(92vw,420px);
      background:#fff;
      border-radius:22px;
      padding:22px;
      box-shadow:0 20px 60px rgba(0,0,0,.22);
    ">
      <div style="font-size:24px;font-weight:800;margin-bottom:6px;">Select Payment Method</div>
      <div style="color:#666;font-size:14px;line-height:1.6;margin-bottom:18px;">
        Choose payment mode for this paid order.
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <button class="pay-method-btn" data-method="cash">💵 Cash</button>
        <button class="pay-method-btn" data-method="upi">📱 UPI</button>
        <button class="pay-method-btn" data-method="debit_card">💳 Debit Card</button>
        <button class="pay-method-btn" data-method="credit_card">💳 Credit Card</button>
      </div>

      <button id="closePaymentMethodModal" style="
        margin-top:16px;
        width:100%;
        border:none;
        background:#f3f4f6;
        color:#111;
        border-radius:12px;
        padding:12px;
        font-weight:700;
        cursor:pointer;
      ">Cancel</button>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelectorAll(".pay-method-btn").forEach(btn => {
    btn.style.cssText = `
      border:none;
      background:#111827;
      color:#fff;
      border-radius:14px;
      padding:14px 10px;
      font-size:15px;
      font-weight:800;
      cursor:pointer;
    `;

    btn.addEventListener("click", async () => {
      await updatePaymentStatus(orderId, "paid", btn.dataset.method || "cash");
      overlay.remove();
    });
  });

  document.getElementById("closePaymentMethodModal")?.addEventListener("click", () => {
    overlay.remove();
  });

  overlay.addEventListener("click", e => {
    if (e.target === overlay) overlay.remove();
  });
}

/* =========================================================
   SETTINGS
========================================================= */
async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, "restaurants", restaurantId, "settings", "general"));
    const restaurantSnap = await getDoc(doc(db, "restaurants", restaurantId));
    // Root fallback keeps legacy restaurants in Restaurant Mode and supports mode set by Super Admin.
    restaurantSettings = { ...(restaurantSnap.exists() ? restaurantSnap.data() : {}), ...(snap.exists() ? snap.data() : {}) };

    if (restaurantFieldEl) restaurantFieldEl.value = restaurantSettings.restaurantName || "";
    if (businessModeFieldEl) businessModeFieldEl.value = restaurantSettings.businessMode === "vendor" ? "vendor" : "restaurant";
    if (orderModeFieldEl) orderModeFieldEl.value = restaurantSettings.orderMode || (restaurantSettings.businessMode === "vendor" ? "token" : "table");
    if (upiFieldEl) upiFieldEl.value = restaurantSettings.upiId || "";
    if (taxFieldEl) taxFieldEl.value = restaurantSettings.taxPercent ?? "";
    if (phoneFieldEl) phoneFieldEl.value = restaurantSettings.phone || "";
    if (addressFieldEl) addressFieldEl.value = restaurantSettings.address || "";
    if (logoFieldEl) logoFieldEl.value = restaurantSettings.logoUrl || "";
    if (kitchenWhatsAppFieldEl) kitchenWhatsAppFieldEl.value = restaurantSettings.kitchenWhatsApp || "";
    if (backendUrlFieldEl) backendUrlFieldEl.value = restaurantSettings.backendUrl || "";
    if (gstFieldEl) gstFieldEl.value = restaurantSettings.gstNumber || "";
    if (restaurantLatFieldEl) restaurantLatFieldEl.value = restaurantSettings.restaurantLat ?? "";
    if (restaurantLngFieldEl) restaurantLngFieldEl.value = restaurantSettings.restaurantLng ?? "";
    if (allowedOrderRadiusFieldEl) allowedOrderRadiusFieldEl.value = restaurantSettings.allowedOrderRadiusMeters ?? 150;
    ensureTableCountControl();
    const tableCountField = document.getElementById("tableCountField");
    if (tableCountField) tableCountField.value = restaurantSettings.tableCount ?? 20;
    ensureLocationProtectionControl();
    const locationToggle = document.getElementById("locationProtectionEnabled");
    if (locationToggle) locationToggle.checked = restaurantSettings.locationProtectionEnabled === true || restaurantSettings.enableLocationProtection === true;
  } catch (err) {
    console.error("loadSettings error", err);
  }
  ensureOcrStatusControl();
  testOcrConnection();
}

async function saveSettings() {
  try {
    const restaurantLatRaw = restaurantLatFieldEl?.value.trim() || "";
    const restaurantLngRaw = restaurantLngFieldEl?.value.trim() || "";
    const radiusRaw = allowedOrderRadiusFieldEl?.value || "150";
    const restaurantLat = restaurantLatRaw === "" ? null : Number(restaurantLatRaw);
    const restaurantLng = restaurantLngRaw === "" ? null : Number(restaurantLngRaw);
    const allowedOrderRadiusMeters = Number(radiusRaw) > 0 ? Number(radiusRaw) : 150;

    if (
      (restaurantLatRaw !== "" && !Number.isFinite(restaurantLat)) ||
      (restaurantLngRaw !== "" && !Number.isFinite(restaurantLng))
    ) {
      alert("Enter valid restaurant latitude and longitude.");
      return;
    }

    const payload = {
      restaurantName: restaurantFieldEl?.value.trim() || "",
      businessMode: businessModeFieldEl?.value === "vendor" ? "vendor" : "restaurant",
      orderMode: ["table", "token", "hybrid"].includes(orderModeFieldEl?.value) ? orderModeFieldEl.value : "table",
      upiId: upiFieldEl?.value.trim() || "",
      taxPercent: Number(taxFieldEl?.value || 0),
      phone: phoneFieldEl?.value.trim() || "",
      address: addressFieldEl?.value.trim() || "",
      logoUrl: logoFieldEl?.value.trim() || "",
      kitchenWhatsApp: kitchenWhatsAppFieldEl?.value.trim() || "",
      backendUrl: backendUrlFieldEl?.value.trim() || "",
      gstNumber: gstFieldEl?.value.trim() || "",
      restaurantLat,
      restaurantLng,
      allowedOrderRadiusMeters,
      locationProtectionEnabled: document.getElementById("locationProtectionEnabled")?.checked === true,
      tableCount: Math.max(1, Number(document.getElementById("tableCountField")?.value || restaurantSettings.tableCount || 20)),
      updatedAt: serverTimestamp()
    };

    await setDoc(doc(db, "restaurants", restaurantId, "settings", "general"), payload, { merge: true });
    await setDoc(doc(db, "restaurants", restaurantId), { businessMode: payload.businessMode, orderMode: payload.orderMode, tableCount: payload.tableCount, updatedAt: serverTimestamp() }, { merge: true });
    restaurantSettings = { ...restaurantSettings, ...payload };
    alert("Settings saved successfully.");
  } catch (err) {
    console.error("saveSettings error", err);
    alert("Failed to save settings: " + err.message);
  }
}

function ensureLocationProtectionControl() {
  if (document.getElementById("locationProtectionEnabled") || !allowedOrderRadiusFieldEl) return;
  const wrap = document.createElement("div"); wrap.className = "form-group";
  wrap.innerHTML = `<label class="form-label" style="display:flex;align-items:center;gap:9px;"><input id="locationProtectionEnabled" type="checkbox" /> Enable Location Protection</label><div style="font-size:11px;color:#6b7280;margin-top:5px;">When disabled, customers can order without GPS or radius checks.</div>`;
  allowedOrderRadiusFieldEl.closest(".form-group")?.insertAdjacentElement("afterend", wrap);
}

function ensureTableCountControl() {
  if (document.getElementById("tableCountField") || !allowedOrderRadiusFieldEl) return;
  const wrap = document.createElement("div"); wrap.className = "form-group";
  wrap.innerHTML = `<label class="form-label">Table Count</label><input id="tableCountField" class="form-input" type="number" min="1" step="1" /><div style="font-size:11px;color:#6b7280;margin-top:5px;">Use Tables → Add More Tables to safely create additional QR-enabled tables.</div>`;
  allowedOrderRadiusFieldEl.closest(".form-group")?.insertAdjacentElement("afterend", wrap);
}

function useAdminCurrentLocation() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by this browser.");
    return;
  }

  if (useCurrentLocationBtn) useCurrentLocationBtn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    position => {
      const { latitude, longitude } = position.coords || {};
      if (restaurantLatFieldEl) restaurantLatFieldEl.value = Number(latitude).toFixed(7);
      if (restaurantLngFieldEl) restaurantLngFieldEl.value = Number(longitude).toFixed(7);
      if (allowedOrderRadiusFieldEl && !allowedOrderRadiusFieldEl.value) {
        allowedOrderRadiusFieldEl.value = 150;
      }
      if (useCurrentLocationBtn) useCurrentLocationBtn.disabled = false;
    },
    error => {
      console.error("Admin geolocation error", error);
      alert("Unable to get current location. Please allow location permission and try again.");
      if (useCurrentLocationBtn) useCurrentLocationBtn.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

/* =========================================================
   MENU DATA
========================================================= */
async function loadMenuData() {
  try {
    const snap = await getDocs(collection(db, "restaurants", restaurantId, "menu"));

    const items = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const catCmp = normalizeCategory(a.category).localeCompare(normalizeCategory(b.category));
        if (catCmp !== 0) return catCmp;
        return Number(a.sortOrder || 0) - Number(b.sortOrder || 0);
      });

    allMenuItems = items;
    manualMenuItems = items.filter(item => item.available !== false);

    renderMenuCategoryHelpers();
    renderMenuSortSelectors();
  } catch (err) {
    console.error("loadMenuData error", err);
  }
}

/* =========================================================
   MENU HELPERS
========================================================= */
function renderMenuCategoryHelpers() {
  const categories = getUniqueCategories(allMenuItems);
  const typedRaw = String(itemCategoryEl?.value || "").trim();
  const typed = normalizeCategory(typedRaw);
  const hasTyped = Boolean(typedRaw);
  const exists = categories.includes(typed);

  if (itemCategorySuggestionsEl) {
    itemCategorySuggestionsEl.innerHTML = categories
      .map(c => `<option value="${escapeHtml(c)}"></option>`)
      .join("");
  }

  if (itemCategoryQuickPickEl) {
    const filtered = categories.filter(c => !hasTyped || c.toLowerCase().includes(typed.toLowerCase()));

    const quickButtons = filtered.slice(0, 10).map(c => `
      <button type="button" class="tab-pill ${c === typed ? "active" : ""}" data-category-pick="${escapeHtml(c)}">
        ${escapeHtml(c)}
      </button>
    `);

    if (hasTyped && !exists) {
      quickButtons.unshift(`
        <button type="button" class="tab-pill active" data-category-pick="${escapeHtml(typed)}">
          Add "${escapeHtml(typed)}"
        </button>
      `);
    }

    itemCategoryQuickPickEl.innerHTML = quickButtons.join("");

    itemCategoryQuickPickEl.querySelectorAll("[data-category-pick]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (itemCategoryEl) itemCategoryEl.value = btn.dataset.categoryPick || "";
        renderMenuCategoryHelpers();
        renderMenuSortSelectors();
      });
    });
  }

  if (itemCategoryStatusEl) {
    if (!hasTyped) itemCategoryStatusEl.textContent = "Choose existing category or type new one.";
    else if (exists) itemCategoryStatusEl.textContent = `Using existing category: ${typed}`;
    else itemCategoryStatusEl.textContent = `New category will be created: ${typed}`;
  }
}

function getCategoryOrderMap() {
  return getUniqueCategories(allMenuItems).map((name, index) => ({
    name,
    position: index + 1
  }));
}

function getItemsInCategory(category) {
  return allMenuItems
    .filter(item => normalizeCategory(item.category) === normalizeCategory(category))
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
}

function renderMenuSortSelectors() {
  const typedCategory = normalizeCategory(itemCategoryEl?.value || "");
  const categoryOrder = getCategoryOrderMap();

  if (itemCategorySortEl) {
    itemCategorySortEl.innerHTML = categoryOrder.length
      ? categoryOrder.map(e => `<option value="${e.position}">${e.position}. ${escapeHtml(e.name)}</option>`).join("")
      : `<option value="1">1. First Category</option>`;
  }

  const itemsInCategory = getItemsInCategory(typedCategory);
  const nextItemPosition = itemsInCategory.length + 1;

  if (itemInCategorySortEl) {
    itemInCategorySortEl.innerHTML =
      itemsInCategory
        .map((item, i) => `<option value="${i + 1}">${i + 1}. ${escapeHtml(item.name || "Item")}</option>`)
        .join("") +
      `<option value="${nextItemPosition}" selected>${nextItemPosition}. Add at end</option>`;
  }

  if (itemSortOrderEl) {
    itemSortOrderEl.value = itemInCategorySortEl?.value || String(nextItemPosition);
  }
}

function clearMenuForm() {
  if (itemNameEl) itemNameEl.value = "";
  if (itemCategoryEl) itemCategoryEl.value = "";
  if (itemPriceEl) itemPriceEl.value = "";
  if (itemAvailableEl) itemAvailableEl.value = "true";
  if (itemImageEl) itemImageEl.value = "";
  if (itemSortOrderEl) itemSortOrderEl.value = "";
  if (itemDescriptionEl) itemDescriptionEl.value = "";
  renderInventoryUsageRows([]);
  if (menuDocIdEl) menuDocIdEl.value = "";
  deleteMenuBtn?.classList.add("hidden");
  renderMenuCategoryHelpers();
  renderMenuSortSelectors();
}

async function saveMenuItem() {
  try {
    const name = itemNameEl?.value.trim() || "";
    const category = normalizeCategory(itemCategoryEl?.value);
    const price = Number(itemPriceEl?.value || 0);
    const available = itemAvailableEl?.value === "true";
    const imageUrl = itemImageEl?.value.trim() || "";
    const sortOrder = Number(itemInCategorySortEl?.value || itemSortOrderEl?.value || 0);
    const description = itemDescriptionEl?.value.trim() || "";
    const customDocId = menuDocIdEl?.value.trim() || "";
    const inventoryUsage = getInventoryUsageFromForm();

    if (!name) return alert("Enter item name.");
    if (!category) return alert("Enter category.");
    if (!price || price <= 0) return alert("Enter valid price.");

    const payload = {
      name,
      category,
      price,
      available,
      imageUrl,
      image: imageUrl,
      sortOrder,
      description,
      inventoryUsage,
      updatedAt: serverTimestamp()
    };

    if (customDocId) {
      await setDoc(doc(db, "restaurants", restaurantId, "menu", customDocId), {
        ...payload,
        createdAt: serverTimestamp()
      }, { merge: true });
    } else {
      await addDoc(collection(db, "restaurants", restaurantId, "menu"), {
        ...payload,
        createdAt: serverTimestamp()
      });
    }

    alert("Menu item saved successfully.");
    clearMenuForm();
    await loadMenuData();
    renderMenuManagement();
    renderManualMenuPicker();
  } catch (err) {
    console.error("saveMenuItem error", err);
    alert("Failed to save menu item: " + err.message);
  }
}

async function deleteMenuItem() {
  try {
    const docId = menuDocIdEl?.value.trim() || "";
    if (!docId) return alert("Select a menu item first.");
    if (!confirm("Are you sure you want to delete this menu item?")) return;

    await deleteDoc(doc(db, "restaurants", restaurantId, "menu", docId));

    alert("Menu item deleted successfully.");
    clearMenuForm();
    await loadMenuData();
    renderMenuManagement();
    renderManualMenuPicker();
  } catch (err) {
    console.error("deleteMenuItem error", err);
    alert("Failed to delete item: " + err.message);
  }
}

function renderMenuManagement() {
  const categories = getUniqueCategories(allMenuItems);

  if (selectedMenuCategory !== "all" && !categories.includes(selectedMenuCategory)) {
    selectedMenuCategory = "all";
  }

  renderCategoryChips(menuCategoryTabsEl, categories, selectedMenuCategory, category => {
    selectedMenuCategory = category;
    renderMenuManagement();
  });

  const search = String(menuSearchEl?.value || "").trim().toLowerCase();

  const filteredItems = allMenuItems.filter(item => {
    const categoryOk = selectedMenuCategory === "all" || normalizeCategory(item.category) === selectedMenuCategory;
    const text = `${item.name || ""} ${item.category || ""} ${item.description || ""}`.toLowerCase();
    return categoryOk && (!search || text.includes(search));
  });

  if (!menuListEl) return;

  if (!filteredItems.length) {
    menuListEl.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-utensils"></i>
        <h4>No menu items found</h4>
        <p>Add menu items or change filter</p>
      </div>
    `;
    return;
  }

  menuListEl.innerHTML = filteredItems.map(item => `
    <div class="menu-item-card edit-menu-btn" data-id="${item.id}">
      <img
        class="menu-item-img"
        src="${escapeHtml(item.imageUrl || item.image || "./assets/placeholder-food.jpg")}"
        alt="${escapeHtml(item.name || "Item")}"
        onerror="this.src='./assets/placeholder-food.jpg'"
      />
      <div class="menu-item-info">
        <div class="menu-item-name">${escapeHtml(item.name || "")}</div>
        <div class="menu-item-category">${escapeHtml(normalizeCategory(item.category))}</div>
        <div class="menu-item-footer">
          <div class="menu-item-price">${money(item.price || 0)}</div>
          <span class="menu-item-badge ${item.available === false ? "unavailable" : "available"}">
            ${item.available === false ? "Off" : "On"}
          </span>
        </div>
      </div>
    </div>
  `).join("");

  menuListEl.querySelectorAll(".edit-menu-btn").forEach(card => {
    card.addEventListener("click", async () => {
      const id = card.dataset.id;
      if (!id) return;

      const snap = await getDoc(doc(db, "restaurants", restaurantId, "menu", id));
      if (!snap.exists()) return;

      const item = snap.data();

      if (itemNameEl) itemNameEl.value = item.name || "";
      if (itemCategoryEl) itemCategoryEl.value = item.category || "";
      if (itemPriceEl) itemPriceEl.value = item.price || "";
      if (itemAvailableEl) itemAvailableEl.value = String(item.available !== false);
      if (itemImageEl) itemImageEl.value = item.imageUrl || item.image || "";
      if (itemSortOrderEl) itemSortOrderEl.value = item.sortOrder || "";
      renderMenuSortSelectors();
      if (itemInCategorySortEl && item.sortOrder) itemInCategorySortEl.value = String(item.sortOrder);
      if (itemDescriptionEl) itemDescriptionEl.value = item.description || "";
      renderInventoryUsageRows(item.inventoryUsage || []);
      if (menuDocIdEl) menuDocIdEl.value = id;

      deleteMenuBtn?.classList.remove("hidden");
      renderMenuCategoryHelpers();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

/* =========================================================
   INVENTORY
========================================================= */
function inventoryStatus(item) {
  return Number(item.currentStock || 0) <= Number(item.minStockAlert || 0);
}

function clearInventoryForm() {
  if (inventoryDocIdEl) inventoryDocIdEl.value = "";
  if (inventoryItemNameEl) inventoryItemNameEl.value = "";
  if (inventoryUnitEl) inventoryUnitEl.value = "kg";
  if (inventoryCurrentStockEl) inventoryCurrentStockEl.value = "";
  if (inventoryMinStockEl) inventoryMinStockEl.value = "";
  if (inventoryPurchasePriceEl) inventoryPurchasePriceEl.value = "";
  if (inventorySupplierNameEl) inventorySupplierNameEl.value = "";
}

function inventoryOptions(selectedId = "") {
  return `<option value="">Select ingredient</option>` + allInventoryItems.map(item =>
    `<option value="${escapeHtml(item.id)}" ${item.id === selectedId ? "selected" : ""}>${escapeHtml(item.itemName)} (${escapeHtml(item.unit)})</option>`
  ).join("");
}

function renderInventoryUsageRows(usages = null) {
  if (!inventoryUsageRowsEl) return;
  const rows = usages || [...inventoryUsageRowsEl.querySelectorAll(".inventory-usage-row")].map(row => ({
    inventoryItemId: row.querySelector(".usage-item")?.value || "",
    quantity: row.querySelector(".usage-qty")?.value || "",
    unit: row.querySelector(".usage-unit")?.value || ""
  }));
  inventoryUsageRowsEl.innerHTML = rows.map(usage => `
    <div class="form-row inventory-usage-row" style="align-items:end;margin-bottom:8px;">
      <div class="form-group" style="flex:2;margin-bottom:0;"><select class="form-select usage-item">${inventoryOptions(usage.inventoryItemId)}</select></div>
      <div class="form-group" style="margin-bottom:0;"><input class="form-input usage-qty" type="number" min="0" step="any" placeholder="Qty" value="${escapeHtml(usage.quantity)}" /></div>
      <div class="form-group" style="margin-bottom:0;"><input class="form-input usage-unit" placeholder="Unit" value="${escapeHtml(usage.unit)}" /></div>
      <button type="button" class="btn btn-danger btn-sm remove-usage-btn">×</button>
    </div>`).join("");
  inventoryUsageRowsEl.querySelectorAll(".usage-item").forEach(select => select.addEventListener("change", () => {
    const item = allInventoryItems.find(x => x.id === select.value);
    const unit = select.closest(".inventory-usage-row")?.querySelector(".usage-unit");
    if (item && unit) unit.value = item.unit || "";
  }));
  inventoryUsageRowsEl.querySelectorAll(".remove-usage-btn").forEach(btn => btn.addEventListener("click", () => {
    btn.closest(".inventory-usage-row")?.remove();
  }));
}

function getInventoryUsageFromForm() {
  return [...(inventoryUsageRowsEl?.querySelectorAll(".inventory-usage-row") || [])].map(row => {
    const inventoryItemId = row.querySelector(".usage-item")?.value || "";
    const source = allInventoryItems.find(item => item.id === inventoryItemId);
    return {
      inventoryItemId,
      itemName: source?.itemName || "",
      quantity: Number(row.querySelector(".usage-qty")?.value || 0),
      unit: row.querySelector(".usage-unit")?.value.trim() || source?.unit || ""
    };
  }).filter(usage => usage.inventoryItemId && usage.quantity > 0);
}

async function saveInventoryItem() {
  const itemName = inventoryItemNameEl?.value.trim() || "";
  const currentStock = Number(inventoryCurrentStockEl?.value);
  const minStockAlert = Number(inventoryMinStockEl?.value);
  if (!itemName || !Number.isFinite(currentStock) || !Number.isFinite(minStockAlert) || currentStock < 0 || minStockAlert < 0) {
    alert("Enter an item name, current stock, and minimum stock alert.");
    return;
  }
  const payload = {
    itemName,
    unit: inventoryUnitEl?.value || "piece",
    currentStock,
    minStockAlert,
    purchasePrice: Number(inventoryPurchasePriceEl?.value || 0),
    supplierName: inventorySupplierNameEl?.value.trim() || "",
    lastUpdated: serverTimestamp()
  };
  try {
    const id = inventoryDocIdEl?.value.trim();
    if (id) await setDoc(doc(db, "restaurants", restaurantId, "inventory", id), payload, { merge: true });
    else await addDoc(collection(db, "restaurants", restaurantId, "inventory"), payload);
    clearInventoryForm();
  } catch (error) {
    console.error("saveInventoryItem error", error);
    alert("Could not save inventory item: " + error.message);
  }
}

function renderInventory() {
  const lowStock = allInventoryItems.filter(inventoryStatus);
  if (lowStockAlertEl) {
    lowStockAlertEl.style.display = lowStock.length ? "block" : "none";
    lowStockAlertEl.textContent = lowStock.length ? `Low stock: ${lowStock.map(item => `${item.itemName} only ${item.currentStock}${item.unit} left`).join(" · ")}` : "";
  }
  if (inventoryRowsEl) inventoryRowsEl.innerHTML = allInventoryItems.length ? allInventoryItems.map(item => {
    const low = inventoryStatus(item);
    return `<tr><td><strong>${escapeHtml(item.itemName)}</strong></td><td>${Number(item.currentStock || 0)}</td><td>${escapeHtml(item.unit)}</td><td>${Number(item.minStockAlert || 0)}</td><td>${money(item.purchasePrice)}</td><td>${escapeHtml(item.supplierName || "-")}</td><td><span class="status-badge ${low ? "danger" : "success"}">${low ? "Low Stock" : "In Stock"}</span></td><td><button class="btn btn-outline btn-sm edit-inventory-btn" data-id="${item.id}">Edit</button></td></tr>`;
  }).join("") : `<tr><td colspan="8" class="muted">No inventory items yet.</td></tr>`;
  inventoryRowsEl?.querySelectorAll(".edit-inventory-btn").forEach(btn => btn.addEventListener("click", () => {
    const item = allInventoryItems.find(x => x.id === btn.dataset.id); if (!item) return;
    if (inventoryDocIdEl) inventoryDocIdEl.value = item.id;
    if (inventoryItemNameEl) inventoryItemNameEl.value = item.itemName || "";
    if (inventoryUnitEl) inventoryUnitEl.value = item.unit || "piece";
    if (inventoryCurrentStockEl) inventoryCurrentStockEl.value = item.currentStock ?? "";
    if (inventoryMinStockEl) inventoryMinStockEl.value = item.minStockAlert ?? "";
    if (inventoryPurchasePriceEl) inventoryPurchasePriceEl.value = item.purchasePrice ?? "";
    if (inventorySupplierNameEl) inventorySupplierNameEl.value = item.supplierName || "";
  }));
  if (adjustmentItemEl) adjustmentItemEl.innerHTML = inventoryOptions(adjustmentItemEl.value);
  renderInventoryUsageRows();
  renderInventoryReports(lowStock);
}

function renderInventoryReports(lowStock) {
  const stockValue = allInventoryItems.reduce((sum, item) => sum + Number(item.currentStock || 0) * Number(item.purchasePrice || 0), 0);
  if (inventoryReportEl) inventoryReportEl.innerHTML = `
    <div class="stat-card green"><div class="stat-label">Stock Value</div><div class="stat-value">${money(stockValue)}</div></div>
    <div class="stat-card orange"><div class="stat-label">Low Stock</div><div class="stat-value">${lowStock.length}</div></div>
    <div class="stat-card blue"><div class="stat-label">Ingredients</div><div class="stat-value">${allInventoryItems.length}</div></div>`;
  const usage = new Map();
  inventoryLogs.filter(log => log.type === "stock_out" && log.reason === "Completed order").forEach(log => {
    usage.set(log.itemName, (usage.get(log.itemName) || 0) + Number(log.quantity || 0));
  });
  if (inventoryMostUsedEl) inventoryMostUsedEl.innerHTML = usage.size ? [...usage.entries()].sort((a,b) => b[1] - a[1]).slice(0, 5).map(([name, quantity]) => `<div>${escapeHtml(name)}: <strong>${quantity}</strong></div>`).join("") : "No completed-order usage yet.";
}

function renderInventoryHistory() {
  if (!inventoryHistoryRowsEl) return;
  inventoryHistoryRowsEl.innerHTML = inventoryLogs.length ? inventoryLogs.slice(0, 50).map(log => `<tr><td>${escapeHtml(formatDateTime(log.createdAt))}</td><td>${escapeHtml(log.itemName)}</td><td><span class="status-badge ${log.type === "stock_in" ? "success" : "warning"}">${log.type === "stock_in" ? "Stock In" : "Stock Out"}</span></td><td>${Number(log.quantity || 0)} ${escapeHtml(log.unit || "")}</td><td>${escapeHtml(log.reason || "-")}</td><td>${escapeHtml(log.createdBy || "-")}</td></tr>`).join("") : `<tr><td colspan="6" class="muted">No stock adjustments yet.</td></tr>`;
}

function purchaseBackendUrl() {
  // A saved override is useful for separate backends. Otherwise every hosted panel uses its own origin.
  // When the field is visible, an intentionally blank value means use this site's API now.
  const configuredOverride = backendUrlFieldEl ? backendUrlFieldEl.value.trim() : (restaurantSettings.backendUrl || "");
  return String(configuredOverride || window.location.origin).replace(/\/+$/, "");
}

function showPurchaseOcrMessage(message = "", tone = "error") {
  let messageEl = document.getElementById("purchaseOcrMessage");
  if (!messageEl && scanPurchaseBillBtn) {
    messageEl = document.createElement("div"); messageEl.id = "purchaseOcrMessage"; messageEl.setAttribute("role", "status");
    scanPurchaseBillBtn.parentElement?.insertAdjacentElement("afterend", messageEl);
  }
  if (!messageEl) return;
  messageEl.textContent = message; messageEl.style.display = message ? "block" : "none";
  messageEl.style.cssText += tone === "success" ? ";margin-top:12px;padding:10px 12px;border-radius:9px;font-size:13px;background:#ecfdf3;color:#18794e;" : ";margin-top:12px;padding:10px 12px;border-radius:9px;font-size:13px;background:#fff1f0;color:#b43731;";
}

function ensureOcrStatusControl() {
  if (document.getElementById("testOcrConnectionBtn") || !backendUrlFieldEl) return;
  const wrap = document.createElement("div"); wrap.className = "form-group";
  wrap.innerHTML = `<label class="form-label">Inventory OCR Service</label><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;"><button class="btn btn-outline" id="testOcrConnectionBtn" type="button">Test OCR Connection</button><span id="ocrServiceStatus" class="small muted">Checking…</span></div><div class="small muted" style="margin-top:5px;">Uses this deployment's API automatically. Backend URL is only an optional override.</div>`;
  backendUrlFieldEl.closest(".form-group")?.insertAdjacentElement("afterend", wrap);
  document.getElementById("testOcrConnectionBtn")?.addEventListener("click", testOcrConnection);
}

async function testOcrConnection() {
  const statusEl = document.getElementById("ocrServiceStatus"); const button = document.getElementById("testOcrConnectionBtn");
  if (statusEl) statusEl.textContent = "Checking…"; if (button) button.disabled = true;
  try {
    const response = await fetch(`${purchaseBackendUrl()}/api/ocr/test`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.connected !== true) throw new Error(data.error || "The OCR endpoint did not return a ready status.");
    if (statusEl) { statusEl.textContent = "Connected ✅"; statusEl.title = "OCR endpoint is reachable and ready."; statusEl.style.color = "#18794e"; }
  } catch (error) {
    const reason = error.message === "Failed to fetch" || /Unexpected token|not valid JSON/i.test(error.message) ? "OCR needs backend deployment. Add backend URL in Settings." : error.message;
    if (statusEl) { statusEl.textContent = `Disconnected ❌ — ${reason}`; statusEl.title = reason; statusEl.style.color = "#b43731"; }
  } finally { if (button) button.disabled = false; }
}

async function purchaseAuthHeaders() {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Please sign in again before uploading a purchase bill.");
  return { Authorization: `Bearer ${token}` };
}

function purchaseReviewRow(item = {}) {
  return `<tr>
    <td><input class="form-input purchase-item-name" value="${escapeHtml(item.itemName || "")}" /></td>
    <td><input class="form-input purchase-qty" type="number" min="0" step="any" value="${Number(item.quantity || 0)}" /></td>
    <td><select class="form-select purchase-unit"><option value="kg" ${item.unit === "kg" ? "selected" : ""}>kg</option><option value="gm" ${item.unit === "gm" ? "selected" : ""}>gm</option><option value="litre" ${item.unit === "litre" ? "selected" : ""}>litre</option><option value="ml" ${item.unit === "ml" ? "selected" : ""}>ml</option><option value="pcs" ${!item.unit || item.unit === "pcs" ? "selected" : ""}>pcs</option><option value="packet" ${item.unit === "packet" ? "selected" : ""}>packet</option><option value="box" ${item.unit === "box" ? "selected" : ""}>box</option></select></td>
    <td><input class="form-input purchase-unit-price" type="number" min="0" step="any" value="${Number(item.unitPrice || 0)}" /></td>
    <td><input class="form-input purchase-total-price" type="number" min="0" step="any" value="${Number(item.totalPrice || 0)}" /></td>
    <td><input class="form-input purchase-category" value="${escapeHtml(item.category || "")}" /></td>
    <td><button class="btn btn-outline btn-sm remove-purchase-row" type="button">Remove</button></td>
  </tr>`;
}

function bindPurchaseReviewRowActions() {
  purchaseReviewRowsEl?.querySelectorAll(".remove-purchase-row").forEach(button => button.addEventListener("click", () => button.closest("tr")?.remove()));
}

function renderPurchaseReview(items = []) {
  if (!purchaseReviewRowsEl) return;
  purchaseReviewRowsEl.innerHTML = items.length ? items.map(purchaseReviewRow).join("") : purchaseReviewRow();
  bindPurchaseReviewRowActions();
}

function reviewedPurchaseItems() {
  return [...(purchaseReviewRowsEl?.querySelectorAll("tr") || [])].map(row => ({
    itemName: row.querySelector(".purchase-item-name")?.value.trim() || "",
    quantity: Number(row.querySelector(".purchase-qty")?.value || 0),
    unit: row.querySelector(".purchase-unit")?.value || "pcs",
    unitPrice: Number(row.querySelector(".purchase-unit-price")?.value || 0),
    totalPrice: Number(row.querySelector(".purchase-total-price")?.value || 0),
    category: row.querySelector(".purchase-category")?.value.trim() || ""
  })).filter(item => item.itemName && item.quantity > 0);
}

function previewPurchaseFile() {
  const file = purchaseBillFileEl?.files?.[0];
  if (!purchaseBillPreviewEl) return;
  if (!file) { purchaseBillPreviewEl.classList.add("hidden"); purchaseBillPreviewEl.innerHTML = ""; return; }
  purchaseBillPreviewEl.classList.remove("hidden");
  const url = URL.createObjectURL(file);
  purchaseBillPreviewEl.innerHTML = file.type === "application/pdf" ? `<a class="btn btn-outline" href="${url}" target="_blank" rel="noopener">Preview PDF: ${escapeHtml(file.name)}</a>` : `<img src="${url}" alt="Purchase bill preview" style="max-width:320px;max-height:260px;border:1px solid var(--border);border-radius:10px;" />`;
}

async function preparePurchaseBillForUpload(file) {
  if (!file?.type.startsWith("image/") || file.size <= 2 * 1024 * 1024) return file;
  const source = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas"); canvas.width = Math.round(source.width * scale); canvas.height = Math.round(source.height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height); source.close?.();
  const compressed = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.82));
  return compressed ? new File([compressed], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }) : file;
}

async function scanPurchaseBill() {
  const file = purchaseBillFileEl?.files?.[0];
  if (!file) return alert("Choose a JPG, PNG, WEBP, or PDF purchase bill first.");
  const backendUrl = purchaseBackendUrl();
  showPurchaseOcrMessage("");
  scanPurchaseBillBtn.disabled = true; scanPurchaseBillBtn.textContent = "Scanning…";
  try {
    const uploadFile = await preparePurchaseBillForUpload(file);
    const form = new FormData(); form.append("bill", uploadFile); form.append("restaurantId", restaurantId);
    const response = await fetch(`${backendUrl}/api/ocr/scan`, { method: "POST", headers: await purchaseAuthHeaders(), body: form });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "Could not read bill clearly. Please upload a clearer image or enter manually.");
    reviewedPurchaseFileUrl = data.file?.fileUrl || "";
    if (purchaseSupplierNameEl && !purchaseSupplierNameEl.value.trim()) purchaseSupplierNameEl.value = data.supplierName || "";
    if (purchaseBillNumberEl) purchaseBillNumberEl.value = data.billNumber || "";
    if (purchaseBillDateEl) purchaseBillDateEl.value = /^\d{4}-\d{2}-\d{2}$/.test(data.billDate || "") ? data.billDate : "";
    if (purchaseTaxAmountEl) purchaseTaxAmountEl.value = data.taxAmount || "";
    if (purchaseGrandTotalEl) purchaseGrandTotalEl.value = data.grandTotal || "";
    renderPurchaseReview(data.items || []); purchaseReviewEl?.classList.remove("hidden"); rescanPurchaseBillBtn?.classList.remove("hidden");
  } catch (error) { showPurchaseOcrMessage(error.message === "Failed to fetch" || /Unexpected token|not valid JSON/i.test(error.message) ? "OCR needs backend deployment. Add backend URL in Settings." : (error.message || "Could not read bill clearly. Please upload a clearer image or enter manually.")); }
  finally { scanPurchaseBillBtn.disabled = false; scanPurchaseBillBtn.textContent = "Scan Bill for Review"; }
}

async function saveReviewedPurchase() {
  const items = reviewedPurchaseItems(); if (!items.length) return alert("Review the bill and provide at least one valid item.");
  const backendUrl = purchaseBackendUrl(); showPurchaseOcrMessage("");
  savePurchaseBillBtn.disabled = true; savePurchaseBillBtn.textContent = "Saving…";
  try {
    const response = await fetch(`${backendUrl}/api/inventory/save-purchase`, { method: "POST", headers: { ...(await purchaseAuthHeaders()), "Content-Type": "application/json" }, body: JSON.stringify({ restaurantId, supplierName: purchaseSupplierNameEl?.value.trim() || "", billNumber: purchaseBillNumberEl?.value.trim() || "", billDate: purchaseBillDateEl?.value || "", taxAmount: Number(purchaseTaxAmountEl?.value || 0), grandTotal: Number(purchaseGrandTotalEl?.value || 0), fileUrl: reviewedPurchaseFileUrl, items }) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "Could not save the reviewed purchase.");
    alert("Purchase saved and stock updated."); purchaseReviewEl?.classList.add("hidden"); purchaseBillFileEl.value = ""; reviewedPurchaseFileUrl = ""; previewPurchaseFile();
  } catch (error) { showPurchaseOcrMessage(error.message || "Could not save the reviewed purchase."); }
  finally { savePurchaseBillBtn.disabled = false; savePurchaseBillBtn.textContent = "Save to Inventory"; }
}

function renderPurchaseHistory() {
  if (!purchaseHistoryRowsEl) return;
  purchaseHistoryRowsEl.innerHTML = purchaseBills.length ? purchaseBills.map(bill => `<tr><td>${escapeHtml(formatDateTime(bill.uploadedAt))}</td><td>${escapeHtml(bill.supplierName || "-")}</td><td>${escapeHtml(bill.billDate || "-")}</td><td>${money(bill.grandTotal || 0)}</td><td><span class="status-badge success">${escapeHtml(bill.status || "saved")}</span></td></tr>`).join("") : `<tr><td colspan="5" class="muted">No purchase bills yet.</td></tr>`;
}

async function saveInventoryAdjustment() {
  const inventoryItemId = adjustmentItemEl?.value || "";
  const quantity = Number(adjustmentQuantityEl?.value);
  const item = allInventoryItems.find(x => x.id === inventoryItemId);
  if (!item || !Number.isFinite(quantity) || quantity <= 0) return alert("Select an item and enter a valid quantity.");
  const type = adjustmentTypeEl?.value === "stock_out" ? "stock_out" : "stock_in";
  if (type === "stock_out" && quantity > Number(item.currentStock || 0)) return alert("Stock out quantity cannot exceed available stock.");
  try {
    await runTransaction(db, async transaction => {
      const ref = doc(db, "restaurants", restaurantId, "inventory", inventoryItemId);
      const fresh = await transaction.get(ref);
      if (!fresh.exists()) throw new Error("Inventory item no longer exists.");
      const data = fresh.data();
      const nextStock = Number(data.currentStock || 0) + (type === "stock_in" ? quantity : -quantity);
      if (nextStock < 0) throw new Error("Insufficient stock.");
      transaction.update(ref, { currentStock: nextStock, lastUpdated: serverTimestamp() });
      transaction.set(doc(collection(db, "restaurants", restaurantId, "inventory_logs")), { inventoryItemId, itemName: data.itemName, type, quantity, unit: data.unit, reason: adjustmentReasonEl?.value.trim() || "Manual adjustment", createdAt: serverTimestamp(), createdBy: currentUser.email || currentUser.name || currentUser.uid || "admin" });
    });
    if (adjustmentQuantityEl) adjustmentQuantityEl.value = "";
    if (adjustmentReasonEl) adjustmentReasonEl.value = "";
  } catch (error) { alert("Could not save adjustment: " + error.message); }
}

async function deductInventoryForCompletedOrder(orderDocId) {
  const orderRef = doc(db, "orders", orderDocId);
  try {
    await runTransaction(db, async transaction => {
      const orderSnap = await transaction.get(orderRef);
      if (!orderSnap.exists()) return;
      const order = orderSnap.data();
      if (String(order.restaurantId || "") !== restaurantId || !["completed", "served"].includes(String(order.status || "").toLowerCase()) || order.inventoryDeductedAt) return;
      const usages = [];
      for (const orderedItem of (order.items || [])) {
        const menuSnap = await transaction.get(doc(db, "restaurants", restaurantId, "menu", orderedItem.id));
        if (!menuSnap.exists()) continue;
        (menuSnap.data().inventoryUsage || []).forEach(usage => usages.push({ ...usage, orderedQty: Number(orderedItem.qty || 0) }));
      }
      const combinedUsages = [...usages.reduce((map, usage) => {
        const id = usage.inventoryItemId;
        if (!id) return map;
        const existing = map.get(id) || { ...usage, quantity: 0 };
        existing.quantity += Number(usage.quantity || 0) * Number(usage.orderedQty || 0);
        map.set(id, existing);
        return map;
      }, new Map()).values()];
      const inventoryReads = await Promise.all(combinedUsages.map(usage => transaction.get(doc(db, "restaurants", restaurantId, "inventory", usage.inventoryItemId))));
      transaction.update(orderRef, { inventoryDeductedAt: serverTimestamp() });
      combinedUsages.forEach((usage, index) => {
        const inventorySnap = inventoryReads[index];
        if (!inventorySnap.exists()) return;
        const inventory = inventorySnap.data();
        const quantity = Number(usage.quantity || 0);
        const nextStock = Math.max(0, Number(inventory.currentStock || 0) - quantity);
        const inventoryRef = inventorySnap.ref;
        transaction.update(inventoryRef, { currentStock: nextStock, lastUpdated: serverTimestamp() });
        transaction.set(doc(collection(db, "restaurants", restaurantId, "inventory_logs")), { inventoryItemId: usage.inventoryItemId, itemName: usage.itemName || inventory.itemName, type: "stock_out", quantity, unit: usage.unit || inventory.unit, reason: "Completed order", orderId: order.orderId || orderDocId, createdAt: serverTimestamp(), createdBy: "system" });
      });
    });
  } catch (error) { console.error("Inventory deduction error", error); }
}

function startInventoryListeners() {
  inventoryUnsubscribe?.(); inventoryLogsUnsubscribe?.();
  inventoryUnsubscribe = onSnapshot(collection(db, "restaurants", restaurantId, "inventory"), snap => {
    allInventoryItems = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => String(a.itemName).localeCompare(String(b.itemName)));
    renderInventory();
  });
  inventoryLogsUnsubscribe = onSnapshot(collection(db, "restaurants", restaurantId, "inventory_logs"), snap => {
    inventoryLogs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderInventoryHistory();
    renderInventoryReports(allInventoryItems.filter(inventoryStatus));
  });
  onSnapshot(collection(db, "restaurants", restaurantId, "purchase_bills"), snap => {
    purchaseBills = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (b.uploadedAt?.seconds || 0) - (a.uploadedAt?.seconds || 0));
    renderPurchaseHistory();
  });
}

/* =========================================================
   TABLES
========================================================= */
function renderTablesSection() {
  if (!tablesGridEl || !tableSummaryEl) return;

  const latestOrderByTable = new Map();

  allOrders.forEach(order => {
    const tableNo = String(order.tableNo || "").trim();
    if (!tableNo) return;

    const current = latestOrderByTable.get(tableNo);
    const currentTs = current?.createdAt?.seconds || 0;
    const orderTs = order?.createdAt?.seconds || 0;

    if (!current || orderTs >= currentTs) {
      latestOrderByTable.set(tableNo, order);
    }
  });

  const tableOptions = getTableOptions();
  const disabledTableNos = new Set(managedTables.filter(table => table.disabled === true || table.active === false).map(table => String(table.tableNo || table.id).padStart(2, "0")));

  const openCount = [...latestOrderByTable.values()].filter(order => {
    if (!order) return false;
    const status = String(order.status || "").toLowerCase();
    const payment = String(order.paymentStatus || "").toLowerCase();
    return payment !== "paid" && !["served", "completed", "cancelled", "rejected"].includes(status) && order.billClosed !== true;
  }).length;

  const disabledCount = disabledTableNos.size;
  const closedCount = Math.max(0, tableOptions.length - openCount - disabledCount);

  tableSummaryEl.innerHTML = `
    <div class="stat-card">
      <div class="stat-icon orange"><i class="fas fa-chair"></i></div>
      <div class="stat-info"><h3>Occupied Tables</h3><div class="value">${openCount}</div></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon green"><i class="fas fa-check-circle"></i></div>
      <div class="stat-info"><h3>Available Tables</h3><div class="value">${closedCount}</div></div>
    </div>
    <div class="stat-card"><div class="stat-icon blue"><i class="fas fa-table"></i></div><div class="stat-info"><h3>Total Tables</h3><div class="value">${tableOptions.length}</div></div></div>
    <div class="stat-card"><div class="stat-icon danger"><i class="fas fa-ban"></i></div><div class="stat-info"><h3>Disabled Tables</h3><div class="value">${disabledCount}</div></div></div>
  `;

  tablesGridEl.innerHTML = tableOptions.map(tableNo => {
    const disabled = disabledTableNos.has(String(tableNo).padStart(2, "0"));
    const order = latestOrderByTable.get(tableNo);

    const payment = String(order?.paymentStatus || "").toLowerCase();
    const status = String(order?.status || "").toLowerCase();

    const occupied = Boolean(
      order &&
      payment !== "paid" &&
      !["served", "completed", "cancelled", "rejected"].includes(status) &&
      order.billClosed !== true
    );

    const cardClass = disabled ? "disabled" : (occupied ? "occupied" : "available");
    const statusText = disabled ? "Disabled" : (occupied ? "Customer Sitting" : "Bill Closed");
    const orderText = order?.orderId ? `Order: ${order.orderId}` : "No recent bill";
    const customerText = occupied
      ? order.customerName || "Walk-in"
      : order?.customerName || "Ready for next customer";

    const actionBtn = disabled
      ? `<button class="btn btn-sm btn-outline table-toggle-btn" data-table="${escapeHtml(tableNo)}" data-disabled="false">Enable Table</button>`
      : occupied
      ? `<button class="btn btn-sm btn-outline table-open-bill-btn" data-id="${order.id}"><i class="fas fa-edit"></i> Open Bill</button>`
      : `<button class="btn btn-sm btn-primary table-new-bill-btn" data-table="${escapeHtml(tableNo)}"><i class="fas fa-plus"></i> New Bill</button>`;

    return `
      <div class="table-card ${cardClass}">
        <div class="table-card-head">
          <div>
            <div class="table-title">Table ${escapeHtml(tableNo)}</div>
            <div class="table-subtitle">${escapeHtml(orderText)}</div>
          </div>
          <span class="table-state">${escapeHtml(statusText)}</span>
        </div>
        <div class="table-customer">${escapeHtml(customerText)}</div>
        <div class="table-actions">${actionBtn}${disabled ? "" : `<button class="btn btn-sm btn-outline table-toggle-btn" data-table="${escapeHtml(tableNo)}" data-disabled="true">Disable</button>`}<button class="btn btn-sm btn-outline table-qr-btn" data-table="${escapeHtml(tableNo)}">Download QR</button></div>
      </div>
    `;
  }).join("");

  tablesGridEl.querySelectorAll(".table-open-bill-btn").forEach(btn => {
    btn.addEventListener("click", () => loadOrderIntoManualBill(btn.dataset.id || ""));
  });

  tablesGridEl.querySelectorAll(".table-new-bill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const selectedTable = String(btn.dataset.table || "01").padStart(2, "0");

resetManualBillForm();
renderTableNumberOptions(selectedTable);

if (manualTableNoEl) {
  manualTableNoEl.value = selectedTable;
}
      if (typeof window.switchSection === "function") window.switchSection("billing");
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
  tablesGridEl.querySelectorAll(".table-toggle-btn").forEach(btn => btn.addEventListener("click", async () => {
    const tableNo = String(btn.dataset.table || "").padStart(2,"0");
    await setDoc(doc(db,"restaurants",restaurantId,"tables",tableNo), { tableNo, disabled: btn.dataset.disabled === "true", active: btn.dataset.disabled !== "true", updatedAt: serverTimestamp() }, { merge:true });
  }));
  tablesGridEl.querySelectorAll(".table-qr-btn").forEach(btn => btn.addEventListener("click", () => {
    const tableNo = String(btn.dataset.table || "").padStart(2,"0"); const url = `${location.origin}/index.html?restaurantId=${encodeURIComponent(restaurantId)}&table=${encodeURIComponent(tableNo)}`;
    const link = document.createElement("a"); link.href = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=${encodeURIComponent(url)}`; link.download = `${restaurantId}-table-${tableNo}-qr.png`; link.target = "_blank"; link.click();
  }));
}

/* =========================================================
   MANUAL BILLING
========================================================= */
function renderManualTotals() {
  const itemsTotal = manualCart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 0), 0);
  const tax = itemsTotal * (getTaxPercent() / 100);
  const grandTotal = itemsTotal + tax;

  if (manualItemsTotalEl) manualItemsTotalEl.textContent = money(itemsTotal);
  if (manualTaxTotalEl) manualTaxTotalEl.textContent = money(tax);
  if (manualGrandTotalTextEl) manualGrandTotalTextEl.textContent = money(grandTotal);

  return { itemsTotal, tax, grandTotal };
}

function updateManualQty(id, delta) {
  const found = manualCart.find(x => x.id === id);
  if (!found) return;
  found.qty += delta;
  if (found.qty <= 0) manualCart = manualCart.filter(x => x.id !== id);
  renderManualCart();
}

function addManualItem(id) {
  const item = manualMenuItems.find(x => x.id === id);
  if (!item) return;

  const found = manualCart.find(x => x.id === id);
  if (found) found.qty += 1;
  else {
    manualCart.push({
      id: item.id,
      name: item.name || "",
      price: Number(item.price || 0),
      qty: 1
    });
  }
  renderManualCart();
}

function renderManualCart() {
  if (!manualCartListEl) return;

  if (!manualCart.length) {
    manualCartListEl.innerHTML = `
      <div class="empty-state" style="padding:24px 10px;">
        <i class="fas fa-shopping-cart"></i>
        <h4>Cart is empty</h4>
        <p>Select items from the menu</p>
      </div>
    `;
    renderManualTotals();
    return;
  }

  manualCartListEl.innerHTML = manualCart.map(item => `
    <div class="cart-item">
      <div class="cart-item-info">
        <div class="cart-item-name">${escapeHtml(item.name)}</div>
        <div class="cart-item-price">${money(item.price)} each</div>
      </div>

      <div class="cart-qty-control">
        <button class="cart-qty-btn manual-minus" data-id="${item.id}">-</button>
        <div class="cart-qty-value">${item.qty}</div>
        <button class="cart-qty-btn manual-plus" data-id="${item.id}">+</button>
      </div>

      <div class="cart-item-total">${money(item.price * item.qty)}</div>

      <button class="cart-item-remove manual-remove" data-id="${item.id}">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `).join("");

  manualCartListEl.querySelectorAll(".manual-minus").forEach(btn => {
    btn.addEventListener("click", () => updateManualQty(btn.dataset.id || "", -1));
  });

  manualCartListEl.querySelectorAll(".manual-plus").forEach(btn => {
    btn.addEventListener("click", () => updateManualQty(btn.dataset.id || "", 1));
  });

  manualCartListEl.querySelectorAll(".manual-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      manualCart = manualCart.filter(item => item.id !== (btn.dataset.id || ""));
      renderManualCart();
    });
  });

  renderManualTotals();
}

function renderManualMenuPicker() {
  if (!manualMenuPickerEl) return;

  if (!manualMenuItems.length) {
    manualMenuPickerEl.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-utensils"></i>
        <h4>No menu items found</h4>
        <p>Add menu items first</p>
      </div>
    `;
    if (manualCategoryTabsEl) manualCategoryTabsEl.innerHTML = "";
    return;
  }

  const categories = getUniqueCategories(manualMenuItems);

  if (selectedManualCategory !== "all" && !categories.includes(selectedManualCategory)) {
    selectedManualCategory = "all";
  }

  renderCategoryChips(manualCategoryTabsEl, categories, selectedManualCategory, category => {
    selectedManualCategory = category;
    renderManualMenuPicker();
  });

  const filteredItems = selectedManualCategory === "all"
    ? manualMenuItems
    : manualMenuItems.filter(item => normalizeCategory(item.category) === selectedManualCategory);

  if (!filteredItems.length) {
    manualMenuPickerEl.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-filter"></i>
        <h4>No items in this category</h4>
        <p>Choose another category</p>
      </div>
    `;
    return;
  }

  manualMenuPickerEl.innerHTML = filteredItems.map(item => `
    <div class="menu-item-card">
      <img
        class="menu-item-img"
        src="${escapeHtml(item.imageUrl || item.image || "./assets/placeholder-food.jpg")}"
        alt="${escapeHtml(item.name || "Item")}"
        onerror="this.src='./assets/placeholder-food.jpg'"
      />
      <div class="menu-item-info">
        <div class="menu-item-name">${escapeHtml(item.name)}</div>
        <div class="menu-item-category">${escapeHtml(normalizeCategory(item.category))}</div>
        <div class="menu-item-footer">
          <div class="menu-item-price">${money(item.price || 0)}</div>
          <button class="btn btn-sm btn-primary manual-add-btn" data-id="${item.id}">Add</button>
        </div>
      </div>
    </div>
  `).join("");

  manualMenuPickerEl.querySelectorAll(".manual-add-btn").forEach(btn => {
    btn.addEventListener("click", () => addManualItem(btn.dataset.id || ""));
  });
}

function resetManualBillForm() {
  if (manualCustomerNameEl) manualCustomerNameEl.value = "";
  if (manualCustomerPhoneEl) manualCustomerPhoneEl.value = "";
  renderTableNumberOptions();
  if (manualPaymentMethodEl) manualPaymentMethodEl.value = "cash";
  if (manualPaymentStatusEl) manualPaymentStatusEl.value = "unpaid";

  manualCart = [];
  editingOrderDocId = null;
  editingOrderPublicId = null;

  if (createManualBillBtn) createManualBillBtn.innerHTML = `<i class="fas fa-check"></i> Create Order`;
  manualUpiQrWrap?.classList.add("hidden");
  setNotice("");
  renderManualCart();
}

async function loadOrderIntoManualBill(orderDocId) {
  if (!canUseOrdering) { alert("Your Basic plan supports digital menu only. Upgrade to Advance to use billing."); return; }
  try {
    const snap = await getDoc(doc(db, "orders", orderDocId));
    if (!snap.exists()) return alert("Order not found.");

    const order = snap.data();

    editingOrderDocId = orderDocId;
    editingOrderPublicId = order.orderId || "";

    if (manualCustomerNameEl) manualCustomerNameEl.value = order.customerName || "";
    if (manualCustomerPhoneEl) manualCustomerPhoneEl.value = order.customerPhone || "";
    renderTableNumberOptions(order.tableNo || "01");
    if (manualPaymentMethodEl) manualPaymentMethodEl.value = order.paymentMethod || "cash";
    if (manualPaymentStatusEl) manualPaymentStatusEl.value = order.paymentStatus || "unpaid";

    manualCart = Array.isArray(order.items)
      ? order.items.map(item => ({
          id: item.id || "",
          name: item.name || "",
          price: Number(item.price || 0),
          qty: Number(item.qty || 1)
        }))
      : [];

    if (createManualBillBtn) createManualBillBtn.innerHTML = `<i class="fas fa-check"></i> Update Order`;

    manualUpiQrWrap?.classList.add("hidden");
    renderManualCart();
    setNotice(`Editing order: ${editingOrderPublicId}`, "info");

    if (typeof window.switchSection === "function") window.switchSection("billing");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    console.error("loadOrderIntoManualBill error", err);
    alert("Failed to load order: " + err.message);
  }
}

function openManualUpi() {
  const upiId = upiFieldEl?.value.trim() || restaurantSettings.upiId || "";
  if (!upiId) return alert("Save restaurant UPI ID first in settings.");
  if (!manualCart.length) return alert("Select items first.");

  const { grandTotal } = renderManualTotals();
  const refId = editingOrderPublicId || "MANUAL" + Date.now();

  const upiUrl = buildUpiUrl({
    upiId,
    name: restaurantFieldEl?.value.trim() || restaurantSettings.restaurantName || "Restaurant",
    amount: grandTotal,
    orderId: refId
  });

  if (manualUpiQrImg) manualUpiQrImg.src = buildQrUrl(upiUrl);
  manualUpiQrWrap?.classList.remove("hidden");

  if (isMobileDevice()) {
    window.location.href = upiUrl;
  } else {
    setNotice(`Scan QR to collect UPI payment for ${refId}`, "info");
  }
}

function fillKotPreviewFromCart(orderId = "") {
  const now = new Date();
  const restaurantName =
    restaurantFieldEl?.value.trim() ||
    restaurantSettings.restaurantName ||
    "Restaurant";

  const tableNo = manualTableNoEl?.value.trim() || "01";

  if (kotRestaurantNameEl) kotRestaurantNameEl.textContent = restaurantName;
  if (kotNumberEl) kotNumberEl.textContent = orderId || "KOT" + Date.now();
  if (kotTableEl) kotTableEl.textContent = tableNo;
  if (kotDateEl) kotDateEl.textContent = now.toLocaleDateString();
  if (kotTimeEl) kotTimeEl.textContent = now.toLocaleTimeString();
  if (kotServerEl) kotServerEl.textContent = currentUser.name || "Admin";

  if (kotItemsEl) {
    kotItemsEl.innerHTML = manualCart.length
      ? manualCart.map(item => `
          <div class="kot-item">
            <span><strong>${item.qty}x</strong> ${escapeHtml(item.name)}</span>
          </div>
        `).join("")
      : "<div>No items</div>";
  }

  if (kotNotesEl) kotNotesEl.textContent = "";
}

function fillBillPreview(order) {
  const restaurantName = restaurantFieldEl?.value.trim() || restaurantSettings.restaurantName || "Restaurant";
  const address = addressFieldEl?.value.trim() || restaurantSettings.address || "";
  const phone = phoneFieldEl?.value.trim() || restaurantSettings.phone || "";
  const upiId = upiFieldEl?.value.trim() || restaurantSettings.upiId || "";

  if (billRestaurantNameEl) billRestaurantNameEl.textContent = restaurantName;
  const gst = String(restaurantSettings.gstNumber || "").trim().toUpperCase();

if (billAddressEl) {
  billAddressEl.innerHTML = `
    ${escapeHtml(address)}
    ${gst ? `<br><strong>GST: ${escapeHtml(gst)}</strong>` : ""}
  `;
}
  if (billPhoneEl) billPhoneEl.textContent = phone;
  if (billNumberEl) billNumberEl.textContent = order.orderId || "";
  if (billTableEl) billTableEl.textContent = order.tableNo || "-";
  if (billDateEl) billDateEl.textContent = formatDateTime(order.createdAt);
  if (billCustomerEl) billCustomerEl.textContent = order.customerName || "Walk-in";

  if (billItemsEl) {
    billItemsEl.innerHTML = `<div class="thermal-bill-head"><span>Item</span><span>Qty</span><span>Amt</span></div>${thermalBillRows(order.items || []) || "<div class='thermal-item-row'><span>No items</span><span>0</span><span>₹0</span></div>"}`;
  }

  if (billSubtotalEl) billSubtotalEl.textContent = money(order.itemsTotal || 0);
  if (billTaxEl) billTaxEl.textContent = money(order.tax || 0);
  if (billTotalEl) billTotalEl.textContent = money(order.grandTotal || 0);

  if (billPaymentMethodEl) {
    const pm = String(order.paymentMethod || "cash").toLowerCase();
    const pmLabels = {
      cash: "Cash",
      upi: "UPI / Online",
      debit_card: "Debit Card",
      credit_card: "Credit Card"
    };
    const pmLabel = pmLabels[pm] || order.paymentMethod || "Cash";
    const psLabel = String(order.paymentStatus || "unpaid").toLowerCase() === "paid" ? "PAID" : "UNPAID";
    billPaymentMethodEl.innerHTML = `<span>${escapeHtml(pmLabel)}</span><span style="font-weight:800;">${escapeHtml(psLabel)}</span>`;
  }

  // A configured UPI ID always shows on final bills, including paid cash/card bills.
  const showQr = Boolean(upiId);

  if (billUpiQrSectionEl && billUpiQrImgEl) {
    if (showQr) {
      const grandTotal = Number(order.grandTotal || 0);
      const upiUrl = buildUpiUrl({
        upiId,
        name: restaurantName,
        amount: grandTotal,
        orderId: order.orderId || ""
      });

      billUpiQrImgEl.src = buildQrUrl(upiUrl);
      billUpiQrImgEl.dataset.upi = upiUrl;

      if (billQrUpiIdEl) billQrUpiIdEl.textContent = upiId;
      if (billQrAmountEl) billQrAmountEl.textContent = money(grandTotal);
      if (billQrRestaurantEl) billQrRestaurantEl.textContent = restaurantName;

      billUpiQrSectionEl.style.display = "block";
      if (billUpiMissingEl) billUpiMissingEl.style.display = "none";
      billUpiQrImgEl.style.display = "block";
      billUpiQrImgEl.onclick = () => {
        if (isMobileDevice()) window.location.href = upiUrl;
      };
      billUpiQrImgEl.style.cursor = isMobileDevice() ? "pointer" : "default";
    } else {
      billUpiQrSectionEl.style.display = "block";
      billUpiQrImgEl.style.display = "none";
      if (billUpiMissingEl) billUpiMissingEl.style.display = "block";
    }
  }

  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    console.log("[Bill UPI QR]", { restaurantId, upiId, billAmount: Number(order.grandTotal || 0), qrGenerated: showQr });
  }

  // Refresh a UPI ID saved elsewhere without changing the order document.
  getDoc(doc(db, "restaurants", restaurantId, "settings", "general")).then(snap => {
    const latest = snap.exists() ? String(snap.data().upiId || "").trim() : "";
    if (latest && latest !== upiId) {
      restaurantSettings = { ...restaurantSettings, upiId: latest };
      if (upiFieldEl) upiFieldEl.value = latest;
      fillBillPreview(order);
    }
  }).catch(() => {});
}

async function createManualBill() {
  if (!canUseOrdering) { alert("Your Basic plan supports digital menu only. Upgrade to Advance to enable ordering and billing."); return; }
  try {
    const customerName = manualCustomerNameEl?.value.trim() || "";
    const customerPhone = manualCustomerPhoneEl?.value.trim() || "";
    const tableNo = String(manualTableNoEl?.value || "01").trim().padStart(2, "0");
    const paymentMethod = manualPaymentMethodEl?.value || "cash";
    const paymentStatus = manualPaymentStatusEl?.value || "unpaid";

    if (!customerName) return alert("Enter customer name.");
    if (!customerPhone) return alert("Enter customer phone.");
    if (!manualCart.length) return alert("Select at least one menu item.");

    const { itemsTotal, tax, grandTotal } = renderManualTotals();

    if (editingOrderDocId) {
      const orderRef = doc(db, "orders", editingOrderDocId);
      const oldSnap = await getDoc(orderRef);
      if (!oldSnap.exists()) return alert("Original order not found.");

      const oldData = oldSnap.data();
      const oldStatus = String(oldData.status || "pending").toLowerCase();

      await updateDoc(orderRef, {
        customerName,
        customerPhone,
        tableNo,
        items: manualCart,
        itemsText: manualCart.map(i => `${i.name} x${i.qty}`).join(", "),
        note: "Bill updated by admin",
        paymentStatus,
        paymentMethod,
        grandTotal,
        tax,
        itemsTotal,
        paidAmount: paymentStatus === "paid" ? grandTotal : 0,
        remainingAmount: paymentStatus === "paid" ? 0 : grandTotal,
        billClosed: paymentStatus === "paid" && ["ready", "served", "completed"].includes(oldStatus),
        status: ["served", "completed", "cancelled", "rejected", "delivered"].includes(oldStatus) ? "pending" : oldStatus,
        etaMinutes: Number(oldData.etaMinutes || 10),
        etaStartedAt: oldData.etaStartedAt || null,
        hasNewItems: true,
        newlyAddedItems: manualCart,
        newlyAddedItemsText: manualCart.map(i => `${i.name} x${i.qty}`).join(", "),
        newlyAddedNote: "Updated from admin billing",
        kitchenAlertAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        isManualBill: true
      });

      fillKotPreviewFromCart(editingOrderPublicId || "");
      setNotice(`Order updated: ${editingOrderPublicId}`, "success");
    } else {
      const orderId = "ORD" + Date.now();

      await addDoc(collection(db, "orders"), {
        orderId,
        restaurantId,
        customerName,
        customerPhone,
        tableNo,
        items: manualCart,
        itemsText: manualCart.map(i => `${i.name} x${i.qty}`).join(", "),
        note: "Manual order from admin",
        status: "pending",
        paymentStatus,
        paymentMethod,
        grandTotal,
        tax,
        itemsTotal,
        paidAmount: paymentStatus === "paid" ? grandTotal : 0,
        remainingAmount: paymentStatus === "paid" ? 0 : grandTotal,
        billClosed: false,
        etaMinutes: 10,
        etaStartedAt: null,
        hasNewItems: false,
        newlyAddedItems: [],
        newlyAddedItemsText: "",
        newlyAddedNote: "",
        kitchenAlertAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        isManualBill: true
      });

      fillKotPreviewFromCart(orderId);
      setNotice(`Order created and sent to kitchen: ${orderId}`, "success");
    }

    await loadOrders();
    setTimeout(() => resetManualBillForm(), 700);
  } catch (err) {
    console.error("createManualBill error", err);
    alert("Failed to create/update bill: " + err.message);
  }
}

/* =========================================================
   ORDER ACTIONS
========================================================= */
async function handleAdminOrderAction(orderDocId, action) {
  if (!canUseOrdering) { alert("Your Basic plan supports digital menu only. Upgrade to Advance to manage orders."); return; }
  stopAdminAlert();

  try {
    const orderRef = doc(db, "orders", orderDocId);
    const snap = await getDoc(orderRef);
    if (!snap.exists()) {
      alert("Order not found.");
      return;
    }

    const order = snap.data();
    const currentEta = Number(order.etaMinutes || 10);
    const currentItems = order.items || [];

    if (action === "accept") {
      const payload = {
        status: "accepted",
        hasNewItems: false,
        newlyAddedItems: [],
        newlyAddedItemsText: "",
        newlyAddedNote: "",
        updatedAt: serverTimestamp()
      };

      if (!order.etaStartedAt) payload.etaStartedAt = serverTimestamp();

      await updateDoc(orderRef, payload);
      printKOTFromOrder(order, currentItems);
      adminAcceptedSnapshots.set(orderDocId, buildOrderItemSnapshot(currentItems));
      seenSnapshotMap.set(orderDocId, buildOrderItemSnapshot(currentItems));
      return;
    }

    if (action === "preparing") {
      await updateDoc(orderRef, {
        status: "preparing",
        updatedAt: serverTimestamp()
      });
      return;
    }

    if (action === "ready") {
      await updateDoc(orderRef, {
        status: "ready",
        updatedAt: serverTimestamp()
      });
      return;
    }

    if (action === "reject") {
      await updateDoc(orderRef, {
        status: "rejected",
        billClosed: true,
        updatedAt: serverTimestamp()
      });
      return;
    }

    if (action === "add10") {
      await updateDoc(orderRef, {
        etaMinutes: currentEta + 10,
        updatedAt: serverTimestamp()
      });
      return;
    }

    if (action === "printkot") {
      printKOTFromOrder(order, currentItems);
      return;
    }

    if (action === "seenupdate") {
      const oldSnapMap = seenSnapshotMap.get(orderDocId) || buildOrderItemSnapshot(currentItems);
      let deltaItems = [];

      currentItems.forEach(item => {
        const key = String(item.id || item.name || "");
        const oldQty = oldSnapMap.get(key) || 0;
        const newQty = Number(item.qty || 0);

        if (newQty > oldQty) {
          deltaItems.push({
            ...item,
            qty: newQty - oldQty
          });
        }
      });

      if (!deltaItems.length && Array.isArray(order.newlyAddedItems) && order.newlyAddedItems.length) {
        deltaItems = order.newlyAddedItems;
      }

      if (!deltaItems.length) {
        deltaItems = currentItems;
      }

      printKOTFromOrder(order, deltaItems, "NEW ITEMS ADDED");

      seenSnapshotMap.set(orderDocId, buildOrderItemSnapshot(currentItems));

      await updateDoc(orderRef, {
        hasNewItems: false,
        newlyAddedItems: [],
        newlyAddedItemsText: "",
        newlyAddedNote: "",
        updatedAt: serverTimestamp()
      });

      return;
    }
  } catch (err) {
    console.error("handleAdminOrderAction error", err);
    alert("Failed: " + err.message);
  }
}

async function updatePaymentStatus(orderDocId, status, selectedMethod = "cash") {
  if (!canUseOrdering) { alert("Your Basic plan supports digital menu only. Upgrade to Advance to manage payments."); return; }
  try {
    const orderRef = doc(db, "orders", orderDocId);
    const snap = await getDoc(orderRef);
    if (!snap.exists()) return alert("Order not found.");

    const data = snap.data();
    const grandTotal = Number(data.grandTotal || 0);
    const currentStatus = String(data.status || "").toLowerCase();

    const payload = {
      paymentStatus: status,
      paymentMethod: status === "paid" ? selectedMethod : (data.paymentMethod || "cash"),
      paidAmount: status === "paid" ? grandTotal : 0,
      remainingAmount: status === "paid" ? 0 : grandTotal,
      updatedAt: serverTimestamp()
    };

    if (status === "paid") {
      payload.billClosed = true;
      if (["pending", "accepted", "preparing", "ready"].includes(currentStatus)) {
        payload.status = "completed";
      } else if (!currentStatus) {
        payload.status = "completed";
      }
    } else {
      payload.billClosed = false;
      if (currentStatus === "completed") {
        payload.status = "ready";
      }
    }

    await updateDoc(orderRef, payload);
  } catch (err) {
    console.error("updatePaymentStatus error", err);
    alert("Failed to update payment: " + err.message);
  }
}

/* =========================================================
   PAYMENT METHOD PILL
========================================================= */
function getPaymentMethodPill(o) {
  const pm = String(o.paymentMethod || "cash").toLowerCase();

  const methods = {
    cash: { icon: "fa-money-bill-wave", label: "Cash", color: "#16a34a" },
    upi: { icon: "fa-qrcode", label: "UPI / Online", color: "#7c3aed" },
    debit_card: { icon: "fa-credit-card", label: "Debit Card", color: "#2563eb" },
    credit_card: { icon: "fa-credit-card", label: "Credit Card", color: "#dc2626" }
  };

  const m = methods[pm] || {
    icon: "fa-wallet",
    label: o.paymentMethod || "Cash",
    color: "#78716c"
  };

  const paid = String(o.paymentStatus || "").toLowerCase() === "paid";

  return (
    `<span style="display:inline-flex;align-items:center;gap:5px;background:${m.color}18;color:${m.color};padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid ${m.color}30;">` +
    `<i class="fas ${m.icon}" style="font-size:11px;"></i>${m.label}</span>` +
    `<span style="font-size:13px;font-weight:700;color:${paid ? "#16a34a" : "#ef4444"};">${paid ? "PAID" : "UNPAID"}</span>`
  );
}

/* =========================================================
   PRINT KOT DIRECT
========================================================= */
function printItemExtras(item = {}) {
  const groups = [item.addons, item.addOns, item.modifiers, item.customizations, item.variants, item.selectedAddons, item.options];
  return groups.flatMap(group => Array.isArray(group) ? group : []).map(extra => {
    if (typeof extra === "string") return { name: extra, qty: 1, price: 0 };
    return { name: extra?.name || extra?.title || extra?.label || "Customisation", qty: Number(extra?.qty || extra?.quantity || extra?.count || 1), price: Number(extra?.price || extra?.amount || 0) };
  });
}

function thermalKotRows(items = []) {
  return items.map(item => {
    const extras = printItemExtras(item);
    return `<div class="thermal-item-row"><div class="thermal-item-name"><strong>${escapeHtml(String(item.name || "Item"))}</strong>${extras.map(extra => `<div class="thermal-modifier">* ${escapeHtml(String(extra.name))}${extra.qty > 1 ? ` ×${extra.qty}` : ""}</div>`).join("")}</div><div class="thermal-item-qty">${Number(item.qty || 0)}</div></div>`;
  }).join("");
}

function thermalBillRows(items = []) {
  return items.map(item => {
    const qty = Number(item.qty || 0), price = Number(item.price || 0), extras = printItemExtras(item);
    const parent = `<div class="thermal-item-row"><div class="thermal-item-name">${escapeHtml(String(item.name || "Item"))}</div><div class="thermal-item-qty">${qty}</div><div class="thermal-item-amount">${money(price * qty)}</div></div>`;
    const modifierRows = extras.map(extra => `<div class="thermal-item-row thermal-modifier-row"><div class="thermal-item-name">↳ ${escapeHtml(String(extra.name))}</div><div class="thermal-item-qty">${extra.qty}</div><div class="thermal-item-amount">${extra.price ? money(extra.price * extra.qty) : ""}</div></div>`).join("");
    return parent + modifierRows;
  }).join("");
}

function printKOTFromOrder(order, itemsToPrint = null, label = "") {
  const items = itemsToPrint || order.items || [];
  const now = new Date();
  const restaurantName =
    restaurantFieldEl?.value.trim() ||
    restaurantSettings.restaurantName ||
    "Restaurant";

  const rows = thermalKotRows(items);

  const win = window.open("", "_blank", "width=400,height=650");
  if (!win) {
    alert("Allow popups to print KOT.");
    return;
  }

  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>KOT</title>
  <style>
    @page{margin:2mm} body{font-family:Arial,"Courier New",monospace;font-size:11px;font-weight:700;color:#000;padding:0;width:58mm;max-width:100%;margin:0 auto;line-height:1.25}
    h2{text-align:center;margin:0 0 2px;font-size:14px;font-weight:900;word-break:break-word}
    .center{text-align:center}
    hr{border:none;border-top:2px dashed #000;margin:5px 0}
    table{width:100%;border-collapse:collapse}
    .thermal-head{display:grid;grid-template-columns:minmax(0,1fr) 32px;gap:6px;font-size:10px;text-transform:uppercase;padding:4px 0;border-bottom:2px solid #000}
    thead th:nth-child(2){text-align:center}
    .label{background:#000;color:#fff;text-align:center;padding:6px;font-weight:900;font-size:14px;margin-bottom:5px}
    .meta td{padding:2px 0;font-size:10px}.meta td:first-child{width:62px;color:#000}
    .thermal-item-row{display:grid;grid-template-columns:minmax(0,1fr) 32px;gap:6px;padding:4px 0;border-bottom:1px dotted #777;break-inside:avoid}.thermal-item-name{min-width:0;white-space:normal;overflow-wrap:anywhere;word-break:break-word}.thermal-item-qty{text-align:center;font-weight:900}.thermal-modifier{padding:2px 0 0 8px;font-size:10px;font-weight:700;white-space:normal;overflow-wrap:anywhere}
    @media print and (min-width:70mm){body{width:80mm;font-size:13px}.thermal-head{grid-template-columns:minmax(0,1fr) 42px;font-size:12px}.thermal-item-row{grid-template-columns:minmax(0,1fr) 42px;padding:5px 0}.meta td{font-size:12px}.thermal-modifier{font-size:11px}h2{font-size:17px}}
  </style>
</head>
<body>
  <h2>${escapeHtml(restaurantName)}</h2>
  <div class="center" style="font-size:14px;font-weight:900;margin-bottom:3px;">KITCHEN ORDER TICKET</div>
  <hr>
  ${label ? `<div class="label">${escapeHtml(label)}</div>` : ""}
  <table class="meta">
    <tr><td>KOT #</td><td><strong>${escapeHtml(order.orderId || "")}</strong></td></tr>
    <tr><td>${order.businessMode === "vendor" || order.orderMode === "token" ? "Token" : "Table"}</td><td><strong>${escapeHtml(order.businessMode === "vendor" || order.orderMode === "token" ? (order.tokenNo || `T-${order.tokenNumber || "-"}`) : order.tableNo || "-")}</strong></td></tr>
    <tr><td>Customer</td><td>${escapeHtml(order.customerName || "Walk-in")}</td></tr>
    <tr><td>Date</td><td>${now.toLocaleDateString()}</td></tr>
    <tr><td>Time</td><td>${now.toLocaleTimeString()}</td></tr>
  </table>
  <hr>
  <div class="thermal-head"><strong>Item</strong><strong style="text-align:center">Qty</strong></div>
  <div>${rows || "<div class='thermal-item-row'><span>No items</span><span>0</span></div>"}</div>
  <hr>
  <div class="center" style="font-size:12px;">--- END OF KOT ---</div>
</body>
</html>`);

  win.document.close();
  win.focus();

  setTimeout(() => {
    win.print();
    win.close();
  }, 450);
}

/* =========================================================
   ORDER RENDER
========================================================= */
function getFilteredActiveOrders() {
  return allOrders.filter(o => {
    const status = String(o.status || "").toLowerCase();
    const payment = String(o.paymentStatus || "").toLowerCase();

    const isActive =
      ["pending", "accepted", "preparing", "ready"].includes(status) &&
      payment !== "paid" &&
      o.billClosed !== true;

    if (!isActive) return false;
    if (selectedOrderFilter === "all") return true;
    return status === selectedOrderFilter;
  });
}

function renderOrdersList(targetEl, orders) {
  if (!targetEl) return;

  if (!orders.length) {
    targetEl.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-inbox"></i>
        <h4>No orders found</h4>
        <p>Orders will appear here</p>
      </div>
    `;
    return;
  }

  targetEl.innerHTML = orders.map(o => {
    const remaining = getRemainingSeconds(o);
    const hasNewItems = o.hasNewItems === true;

    return `
      <div class="order-card">
        <div class="order-header">
          <div>
            <div class="order-id">${escapeHtml(o.orderId || o.id)}</div>
            <div class="order-time">${escapeHtml(formatDateTime(o.createdAt))}</div>
          </div>
          <div class="order-status ${getStatusClass(o.status)}">${escapeHtml(o.businessMode === "vendor" && String(o.status || "").toLowerCase() === "pending" ? "New" : o.status || "pending")}</div>
        </div>

        <div class="order-customer">
          <div class="customer-avatar">${escapeHtml(String(o.customerName || "C").charAt(0).toUpperCase())}</div>
          <div class="customer-details">
            <h4>${escapeHtml(o.customerName || "Customer")}</h4>
            <span>${escapeHtml(o.customerPhone || "-")}</span>
          </div>
          <div class="table-badge">${o.businessMode === "vendor" || o.orderMode === "token" ? `Token ${escapeHtml(o.tokenNo || `T-${o.tokenNumber || "-"}`)}` : `Table ${escapeHtml(o.tableNo || "-")}`}</div>
        </div>

        <div class="order-items">
          ${(o.items || []).map(item => `
            <div class="order-item">
              <span><span class="qty">${Number(item.qty || 0)}</span>${escapeHtml(item.name || "")}</span>
              <span>${money(Number(item.price || 0) * Number(item.qty || 0))}</span>
            </div>
          `).join("")}
        </div>

        ${o.note ? `<div style="margin-top:10px;font-size:13px;color:#555;"><strong>Note:</strong> ${escapeHtml(o.note)}</div>` : ""}

        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding-top:10px;border-top:1px solid var(--gray-200);margin-top:10px;flex-wrap:wrap;">
          <div style="font-size:13px;font-weight:700;">ETA: ${Number(o.etaMinutes || 10)} min</div>
          <div style="font-size:13px;font-weight:800;color:${remaining === null ? "#666" : remaining <= 0 ? "#dc2626" : "#16a34a"};">
            ${remaining === null ? "Not Started" : remaining > 0 ? formatRemaining(remaining) : "Time Over"}
          </div>
        </div>

        ${
          hasNewItems
            ? `
              <div style="margin-top:10px;padding:10px 12px;border-radius:12px;background:#fff7e6;border:1px solid #f4d9a6;">
                <div style="font-weight:800;color:#b96f09;font-size:13px;margin-bottom:6px;">🆕 New items added</div>
                ${o.newlyAddedItemsText ? `<div style="font-size:13px;">${escapeHtml(o.newlyAddedItemsText)}</div>` : ""}
                ${o.newlyAddedNote ? `<div style="font-size:12px;color:#666;margin-top:4px;"><strong>Note:</strong> ${escapeHtml(o.newlyAddedNote)}</div>` : ""}
              </div>
            `
            : ""
        }

        <div class="order-total" style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;">
          <span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${getPaymentMethodPill(o)}</span>
          <span style="font-size:18px;font-weight:800;">${money(o.grandTotal || 0)}</span>
        </div>

        <div class="order-actions">
          <button class="btn btn-outline admin-order-action" data-id="${o.id}" data-action="accept">Accept</button>
          <button class="btn btn-outline admin-order-action" data-id="${o.id}" data-action="preparing">Preparing</button>
          <button class="btn btn-outline admin-order-action" data-id="${o.id}" data-action="ready">Ready</button>
          <button class="btn btn-danger admin-order-action" data-id="${o.id}" data-action="reject">Reject</button>
          <button class="btn btn-outline admin-order-action" data-id="${o.id}" data-action="add10">+10 min</button>
          <button class="btn btn-outline admin-order-action" data-id="${o.id}" data-action="printkot">Print KOT</button>
          ${
            hasNewItems
              ? `<button class="btn btn-success admin-order-action" data-id="${o.id}" data-action="seenupdate">Seen Update</button>`
              : ""
          }
        </div>

        <div class="order-actions">
          <button class="btn ${String(o.paymentStatus || "").toLowerCase() === "paid" ? "btn-success" : "btn-outline"} payment-btn"
            data-id="${o.id}" data-status="paid"><i class="fas fa-check"></i> Paid</button>

          <button class="btn ${String(o.paymentStatus || "").toLowerCase() !== "paid" ? "btn-danger" : "btn-outline"} payment-btn"
            data-id="${o.id}" data-status="unpaid"><i class="fas fa-times"></i> Unpaid</button>

          <button class="btn btn-outline pay-bill-btn" data-id="${o.id}"><i class="fas fa-edit"></i> Edit Bill</button>
          <button class="btn btn-primary print-bill-btn" data-id="${o.id}"><i class="fas fa-print"></i> Print Bill</button>
        </div>
      </div>
    `;
  }).join("");

  targetEl.querySelectorAll(".payment-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const orderId = btn.dataset.id || "";
      const status = btn.dataset.status || "unpaid";

      if (status === "paid") {
        showPaymentMethodModal(orderId);
      } else {
        updatePaymentStatus(orderId, "unpaid");
      }
    });
  });

  targetEl.querySelectorAll(".pay-bill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      loadOrderIntoManualBill(btn.dataset.id || "");
    });
  });

  targetEl.querySelectorAll(".print-bill-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const snap = await getDoc(doc(db, "orders", btn.dataset.id || ""));
      if (!snap.exists()) return;
      fillBillPreview(snap.data());
      billModal?.classList.add("active");
    });
  });

  targetEl.querySelectorAll(".admin-order-action").forEach(btn => {
    btn.addEventListener("click", () => {
      handleAdminOrderAction(btn.dataset.id || "", btn.dataset.action || "");
    });
  });
}

/* =========================================================
   BEST SELLING
========================================================= */
function renderBestSelling(orders) {
  if (!bestSellingListEl) return;

  const counter = new Map();
  orders.forEach(order => {
    (order.items || []).forEach(item => {
      const key = item.name || "Item";
      counter.set(key, (counter.get(key) || 0) + Number(item.qty || 0));
    });
  });

  const arr = [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  if (!arr.length) {
    bestSellingListEl.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-chart-bar"></i>
        <h4>No sales data yet</h4>
        <p>Best selling items will appear here</p>
      </div>
    `;
    return;
  }

  bestSellingListEl.innerHTML = arr.map(([name, qty], index) => {
    const rankClass = index === 0 ? "gold" : index === 1 ? "silver" : index === 2 ? "bronze" : "";
    return `
      <div class="best-selling-item">
        <div class="best-selling-rank ${rankClass}">${index + 1}</div>
        <div class="best-selling-info">
          <div class="best-selling-name">${escapeHtml(name)}</div>
          <div class="best-selling-count">${qty} sold</div>
        </div>
      </div>
    `;
  }).join("");
}

/* =========================================================
   REPORTS
========================================================= */
function filterOrdersByReportType(type, date, month, year, startDate, endDate) {
  return allOrders.filter(order => {
    const orderDate = timestampToDate(order.createdAt);
    if (!orderDate) return false;
    const day = formatDateOnly(order.createdAt);
    const orderMonth = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, "0")}`;
    if (type === "daily") return !date || day === date;
    if (type === "monthly") return !month || orderMonth === month;
    if (type === "yearly") return !year || orderDate.getFullYear() === Number(year);
    if (type === "custom") return (!startDate || day >= startDate) && (!endDate || day <= endDate);
    return true;
  });
}

function getFilteredReportOrders() {
  return filterOrdersByReportType(selectedReportType, reportDateEl?.value, reportMonthEl?.value, reportYearEl?.value, reportStartDateEl?.value, reportEndDateEl?.value);
}

function renderReportSummary(filteredOrders) {
  const totalSales = filteredOrders.reduce((sum, order) => sum + Number(order.grandTotal || 0), 0);
  const paidOrders = filteredOrders.filter(order => String(order.paymentStatus || "").toLowerCase() === "paid");
  const paidSales = paidOrders.reduce((sum, order) => sum + Number(order.grandTotal || 0), 0);
  const unpaidOrders = filteredOrders.filter(order => String(order.paymentStatus || "").toLowerCase() !== "paid");
  const completed = filteredOrders.filter(order => ["completed", "served"].includes(String(order.status || "").toLowerCase())).length;
  const cancelled = filteredOrders.filter(order => ["cancelled", "rejected"].includes(String(order.status || "").toLowerCase())).length;
  const cards = [
    ["blue", "fa-receipt", "Total Orders", filteredOrders.length], ["green", "fa-indian-rupee-sign", "Total Sales", money(totalSales)],
    ["orange", "fa-wallet", "Paid Sales", money(paidSales)], ["purple", "fa-clock", "Unpaid Orders", unpaidOrders.length],
    ["green", "fa-check-circle", "Completed Orders", completed], ["red", "fa-ban", "Cancelled Orders", cancelled],
    ["blue", "fa-calculator", "Average Order Value", money(filteredOrders.length ? totalSales / filteredOrders.length : 0)]
  ];
  reportSummaryEl.innerHTML = cards.map(([tone, icon, label, value]) => `<div class="stat-card"><div class="stat-icon ${tone}"><i class="fas ${icon}"></i></div><div class="stat-info"><h3>${label}</h3><div class="value">${value}</div></div></div>`).join("");
}

function renderPaymentBreakdown(filteredOrders) {
  const paid = filteredOrders.filter(order => String(order.paymentStatus || "").toLowerCase() === "paid");
  const amountFor = test => paid.filter(order => test(String(order.paymentMethod || "cash").toLowerCase())).reduce((sum, order) => sum + Number(order.grandTotal || 0), 0);
  const unpaid = filteredOrders.filter(order => String(order.paymentStatus || "").toLowerCase() !== "paid").reduce((sum, order) => sum + Number(order.grandTotal || 0), 0);
  reportPaymentBreakdownEl.innerHTML = [["Cash Sales", amountFor(method => method === "cash")], ["UPI Sales", amountFor(method => method === "upi" || method.includes("upi"))], ["Card Sales", amountFor(method => method.includes("card"))], ["Unpaid Amount", unpaid]].map(([label, value]) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);"><span>${label}</span><strong>${money(value)}</strong></div>`).join("");
}

function renderBestSellingReport(filteredOrders) {
  const items = new Map();
  filteredOrders.forEach(order => (order.items || []).forEach(item => {
    const name = item.name || "Item";
    const current = items.get(name) || { quantity: 0, revenue: 0 };
    current.quantity += Number(item.qty || 0);
    current.revenue += Number(item.price || 0) * Number(item.qty || 0);
    items.set(name, current);
  }));
  const rows = [...items.entries()].sort((a, b) => b[1].quantity - a[1].quantity).slice(0, 8);
  reportBestSellingEl.innerHTML = rows.length ? rows.map(([name, values]) => `<div style="display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);"><span>${escapeHtml(name)} <small class="muted">${values.quantity} sold</small></span><strong>${money(values.revenue)}</strong></div>`).join("") : `<div class="empty-state" style="padding:12px;"><p>No items sold in this period.</p></div>`;
}

function renderTableWiseReport(filteredOrders) {
  const tables = new Map();
  filteredOrders.forEach(order => {
    const table = order.tableNo || "-";
    const current = tables.get(table) || { count: 0, sales: 0 };
    current.count += 1; current.sales += Number(order.grandTotal || 0); tables.set(table, current);
  });
  reportTableWiseEl.innerHTML = tables.size ? [...tables.entries()].sort((a,b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true })).map(([table, values]) => `<tr><td>${escapeHtml(table)}</td><td>${values.count}</td><td>${money(values.sales)}</td></tr>`).join("") : `<tr><td colspan="3" class="muted">No table orders found for this period.</td></tr>`;
}

function renderReportRows(filteredOrders = getFilteredReportOrders()) {
  if (!reportRowsEl || !reportSummaryEl) return;
  renderReportSummary(filteredOrders);
  renderPaymentBreakdown(filteredOrders);
  renderBestSellingReport(filteredOrders);
  renderTableWiseReport(filteredOrders);
  reportRowsEl.innerHTML = filteredOrders.length ? filteredOrders.map(order => `<tr><td>${escapeHtml(order.orderId || order.id)}</td><td>${escapeHtml(order.customerName || "-")}</td><td>${escapeHtml(order.tableNo || "-")}</td><td>${escapeHtml((order.items || []).map(item => `${item.name} x${item.qty}`).join(", "))}</td><td><span class="status-badge info">${escapeHtml(order.status || "pending")}</span></td><td><span class="status-badge ${String(order.paymentStatus || "").toLowerCase() === "paid" ? "success" : "warning"}">${escapeHtml(order.paymentStatus || "unpaid")}</span></td><td>${money(order.grandTotal || 0)}</td><td><button class="btn btn-sm btn-outline report-edit-btn" data-id="${order.id}">Edit</button></td></tr>`).join("") : `<tr><td colspan="8"><div class="empty-state" style="padding:22px;"><i class="fas fa-inbox"></i><h4>No orders found for selected report period.</h4></div></td></tr>`;
  reportRowsEl.querySelectorAll(".report-edit-btn").forEach(btn => btn.addEventListener("click", () => loadOrderIntoManualBill(btn.dataset.id || "")));
}

function reportLabel() {
  if (selectedReportType === "monthly") return reportMonthEl?.value || "All months";
  if (selectedReportType === "yearly") return reportYearEl?.value || "All years";
  if (selectedReportType === "custom") return `${reportStartDateEl?.value || "Start"} to ${reportEndDateEl?.value || "End"}`;
  return reportDateEl?.value || "All dates";
}

function exportReportCSV(filteredOrders = getFilteredReportOrders()) {
  const rows = [["Order ID", "Date", "Customer", "Table", "Items", "Status", "Payment", "Method", "Total"], ...filteredOrders.map(order => [order.orderId || order.id, formatDateOnly(order.createdAt), order.customerName || "", order.tableNo || "", (order.items || []).map(item => `${item.name} x${item.qty}`).join("; "), order.status || "pending", order.paymentStatus || "unpaid", order.paymentMethod || "", Number(order.grandTotal || 0)])];
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `scan2plate-report-${reportLabel().replaceAll(/[^a-z0-9]+/gi, "-")}.csv`;
  link.click(); URL.revokeObjectURL(link.href);
}

function printReport() {
  const report = document.getElementById("section-reports");
  if (!report) return;
  const win = window.open("", "_blank", "width=1100,height=800");
  if (!win) return alert("Allow popups to print the report.");
  win.document.write(`<html><head><title>Scan2Plate Report - ${escapeHtml(reportLabel())}</title><style>body{font-family:Arial;padding:24px;color:#111}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ddd;padding:8px;text-align:left}.btn,.tab-pills,#reportFilterInputs{display:none}.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.stat-card,.card{border:1px solid #ddd;padding:12px;margin-bottom:14px}h3{margin:0 0 10px}</style></head><body><h1>Scan2Plate Report</h1><p>${escapeHtml(reportLabel())}</p>${report.innerHTML}</body></html>`);
  win.document.close(); win.focus(); setTimeout(() => win.print(), 300);
}

/* =========================================================
   KOT SECTION
========================================================= */
function renderKotSections() {
  if (!pendingKotListEl || !kotHistoryListEl) return;

  const pendingOrders = allOrders.filter(o => {
    const status = String(o.status || "").toLowerCase();
    const payment = String(o.paymentStatus || "").toLowerCase();
    return ["pending", "accepted", "preparing", "ready"].includes(status) && payment !== "paid";
  });

  const selectedDate = kotHistoryDateEl?.value || "";
  const historyOrders = !selectedDate
    ? allOrders.slice(0, 20)
    : allOrders.filter(o => formatDateOnly(o.createdAt) === selectedDate);

  if (!pendingOrders.length) {
    pendingKotListEl.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-print"></i>
        <h4>No Pending KOTs</h4>
        <p>All kitchen orders are done</p>
      </div>
    `;
  } else {
    pendingKotListEl.innerHTML = pendingOrders.map(order => `
      <div class="order-card">
        <div class="order-header">
          <div>
            <div class="order-id">${escapeHtml(order.orderId || order.id)}</div>
            <div class="order-time">${order.businessMode === "vendor" ? `Token #${escapeHtml(order.tokenNumber || "-")}` : `Table ${escapeHtml(order.tableNo || "-")}`} • ${escapeHtml(order.customerName || "Customer")}</div>
          </div>
          <button class="btn btn-sm btn-primary kot-print-one" data-id="${order.id}">Print KOT</button>
        </div>

        <div class="order-items">
          ${(order.items || []).map(item => `
            <div class="order-item">
              <span><span class="qty">${Number(item.qty || 0)}</span>${escapeHtml(item.name || "")}</span>
              <span>${money(Number(item.price || 0) * Number(item.qty || 0))}</span>
            </div>
          `).join("")}
        </div>
      </div>
    `).join("");

    pendingKotListEl.querySelectorAll(".kot-print-one").forEach(btn => {
      btn.addEventListener("click", async () => {
        const snap = await getDoc(doc(db, "orders", btn.dataset.id || ""));
        if (!snap.exists()) return;
        const order = snap.data();
        printKOTFromOrder(order, order.items || []);
      });
    });
  }

  if (!historyOrders.length) {
    kotHistoryListEl.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-history"></i>
        <h4>No KOT history</h4>
        <p>No orders found for selected date</p>
      </div>
    `;
  } else {
    kotHistoryListEl.innerHTML = historyOrders.slice(0, 15).map(order => `
      <div class="order-card">
        <div class="order-header">
          <div>
            <div class="order-id">${escapeHtml(order.orderId || order.id)}</div>
            <div class="order-time">${escapeHtml(formatDateTime(order.createdAt))}</div>
          </div>
          <div class="order-status ${getStatusClass(order.status)}">${escapeHtml(order.status || "pending")}</div>
        </div>
      </div>
    `).join("");
  }
}

/* =========================================================
   SNAPSHOT PROCESSOR
========================================================= */
function processOrdersSnapshot(snap) {
  allOrders = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(o => String(o.restaurantId || "") === restaurantId)
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

  const today = todayDateStr();

  const todayOrders = allOrders.filter(o => formatDateOnly(o.createdAt) === today);

  const activeOrders = allOrders.filter(o => {
    const status = String(o.status || "").toLowerCase();
    const payment = String(o.paymentStatus || "").toLowerCase();
    return ["pending", "accepted", "preparing", "ready"].includes(status) &&
      payment !== "paid" &&
      o.billClosed !== true;
  });

  const completedOrders = allOrders.filter(o => {
    const status = String(o.status || "").toLowerCase();
    const payment = String(o.paymentStatus || "").toLowerCase();
    return ["served", "completed"].includes(status) || payment === "paid";
  });

  const todayRevenue = todayOrders
    .filter(o => String(o.paymentStatus || "").toLowerCase() === "paid")
    .reduce((sum, o) => sum + Number(o.grandTotal || 0), 0);

  if (todayOrdersEl) todayOrdersEl.textContent = String(todayOrders.length);
  if (pendingOrdersEl) pendingOrdersEl.textContent = String(activeOrders.length);
  if (todayRevenueEl) todayRevenueEl.textContent = money(todayRevenue);
  if (completedOrdersEl) completedOrdersEl.textContent = String(completedOrders.length);
  if (pendingOrdersBadgeEl) pendingOrdersBadgeEl.textContent = String(activeOrders.length);

  renderOrdersList(orderListEl, activeOrders.slice(0, 8));
  renderOrdersList(allOrdersListEl, getFilteredActiveOrders());
  renderBestSelling(allOrders);
  renderReportRows();
  renderKotSections();
  renderTablesSection();

  allOrders.filter(order => ["completed", "served"].includes(String(order.status || "").toLowerCase()) && !order.inventoryDeductedAt)
    .forEach(order => deductInventoryForCompletedOrder(order.id));

  handleRealtimeAdminAlerts(activeOrders);
}

/* =========================================================
   REALTIME LOADER
========================================================= */
async function loadOrders() {
  try {
    if (ordersUnsubscribe) {
      ordersUnsubscribe();
      ordersUnsubscribe = null;
    }

    ordersUnsubscribe = onSnapshot(collection(db, "orders"), snap => {
      processOrdersSnapshot(snap);
    });
  } catch (err) {
    console.error("loadOrders error", err);
  }
}

/* =========================================================
   FILTER BUTTONS
========================================================= */
function bindOrderFilterButtons() {
  document.querySelectorAll("[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedOrderFilter = btn.dataset.filter || "all";

      document.querySelectorAll("[data-filter]").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");

      renderOrdersList(allOrdersListEl, getFilteredActiveOrders());
    });
  });
}

/* =========================================================
   EVENTS
========================================================= */
logoutBtn?.addEventListener("click", async () => {
  try {
    await signOut(auth);
  } catch (e) {
    console.error(e);
  }

  localStorage.removeItem("scan2plate_user");
  localStorage.removeItem("scan2serve_user");
  localStorage.removeItem("scan2plate_last_restaurant_id");
  window.location.href = "./admin-login.html";
});

refreshBtn?.addEventListener("click", async () => {
  stopAdminAlert();
  await loadMenuData();
  renderMenuManagement();
  renderManualMenuPicker();
});

saveMenuBtn?.addEventListener("click", saveMenuItem);
deleteMenuBtn?.addEventListener("click", deleteMenuItem);
clearMenuFormBtn?.addEventListener("click", clearMenuForm);
menuSearchEl?.addEventListener("input", renderMenuManagement);
uploadMenuPdfBtn?.addEventListener("click", () => menuPdfInput?.click());
menuPdfInput?.addEventListener("change", async () => {
  const file = menuPdfInput.files?.[0];
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) { menuPdfInput.value = ""; return alert("Please upload a PDF menu file."); }
  try {
    if (menuImportStatusEl) menuImportStatusEl.textContent = "Reading menu PDF…";
    const extracted = await extractMenuPdf(file);
    if (!extracted.items.length) throw new Error("No menu items detected");
    menuImportItems = extracted.items;
    menuImportInvalidCount = extracted.invalid;
    menuImportWarning = extracted.headings ? "Some items may need review. Please check category, item name and price before import." : "Category headings were not confidently detected. Please review categories before import.";
    renderMenuImportReview();
  } catch (error) {
    console.error("Menu PDF extraction failed", error);
    menuImportItems = []; menuImportInvalidCount = 0; menuImportWarning = ""; renderMenuImportReview();
    alert("Could not read menu clearly. Please upload clear PDF or enter manually.");
  }
});
importMenuBtn?.addEventListener("click", importReviewedMenuItems);
cancelMenuImportBtn?.addEventListener("click", () => { menuImportItems = []; menuImportInvalidCount = 0; menuImportWarning = ""; if (menuPdfInput) menuPdfInput.value = ""; renderMenuImportReview(); });
downloadMenuPdfSampleBtn?.addEventListener("click", downloadSampleMenuPdf);
addInventoryUsageBtn?.addEventListener("click", () => renderInventoryUsageRows([
  ...(inventoryUsageRowsEl ? [...inventoryUsageRowsEl.querySelectorAll(".inventory-usage-row")].map(row => ({
    inventoryItemId: row.querySelector(".usage-item")?.value || "",
    quantity: row.querySelector(".usage-qty")?.value || "",
    unit: row.querySelector(".usage-unit")?.value || ""
  })) : []),
  {}
]));
saveInventoryBtn?.addEventListener("click", saveInventoryItem);
clearInventoryBtn?.addEventListener("click", clearInventoryForm);
saveAdjustmentBtn?.addEventListener("click", saveInventoryAdjustment);
addTablesBtn?.addEventListener("click", async () => {
  const addCount = Number(addTablesCountEl?.value || 0);
  if (!Number.isInteger(addCount) || addCount < 1) return alert("Enter the number of tables to add.");
  const currentCount = Math.max(Number(restaurantSettings.tableCount || 20), ...managedTables.map(t => Number(t.tableNo || t.id) || 0), ...getTableOptions().map(Number));
  const batch = [];
  for (let index = 1; index <= addCount; index++) {
    const tableNo = String(currentCount + index).padStart(2, "0");
    const qrUrl = `${location.origin}/index.html?restaurantId=${encodeURIComponent(restaurantId)}&table=${encodeURIComponent(tableNo)}`;
    batch.push(setDoc(doc(db, "restaurants", restaurantId, "tables", tableNo), { tableNo, active: true, disabled: false, qrUrl, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true }));
  }
  await Promise.all(batch);
  const nextCount = currentCount + addCount;
  await setDoc(doc(db, "restaurants", restaurantId, "settings", "general"), { tableCount: nextCount, updatedAt: serverTimestamp() }, { merge: true });
  await setDoc(doc(db, "restaurants", restaurantId), { tableCount: nextCount, updatedAt: serverTimestamp() }, { merge: true });
  restaurantSettings.tableCount = nextCount;
  if (addTablesCountEl) addTablesCountEl.value = "";
  renderTableNumberOptions(); renderTablesSection();
  alert(`${addCount} new table${addCount === 1 ? "" : "s"} added (Table ${String(currentCount + 1).padStart(2,"0")}–${String(nextCount).padStart(2,"0")}).`);
});
downloadAllTableQrsBtn?.addEventListener("click", () => {
  const rows = getTableOptions().map(tableNo => [`Table ${tableNo}`, `${location.origin}/index.html?restaurantId=${encodeURIComponent(restaurantId)}&table=${encodeURIComponent(tableNo)}`]);
  const csv = [["Table", "QR Link"], ...rows].map(row => row.map(value => `"${String(value).replaceAll('"','""')}"`).join(",")).join("\n");
  const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = `${restaurantId}-table-qr-links.csv`; link.click(); URL.revokeObjectURL(link.href);
});
purchaseBillFileEl?.addEventListener("change", previewPurchaseFile);
scanPurchaseBillBtn?.addEventListener("click", scanPurchaseBill);
rescanPurchaseBillBtn?.addEventListener("click", () => { purchaseReviewEl?.classList.add("hidden"); purchaseBillFileEl?.click(); });
addPurchaseReviewRowBtn?.addEventListener("click", () => { purchaseReviewRowsEl?.insertAdjacentHTML("beforeend", purchaseReviewRow()); bindPurchaseReviewRowActions(); });
savePurchaseBillBtn?.addEventListener("click", saveReviewedPurchase);

saveSettingsBtn?.addEventListener("click", saveSettings);
useCurrentLocationBtn?.addEventListener("click", useAdminCurrentLocation);

createManualBillBtn?.addEventListener("click", createManualBill);
manualUpiBtn?.addEventListener("click", openManualUpi);
clearCartBtn?.addEventListener("click", resetManualBillForm);

printKotFromBillingBtn?.addEventListener("click", () => {
  if (!manualCart.length) return alert("No items in current bill.");
  fillKotPreviewFromCart(editingOrderPublicId || "");
  kotModal?.classList.add("active");
});

printAllKotBtn?.addEventListener("click", () => {
  if (!canUseOrdering) { alert("Your Basic plan supports digital menu only. Upgrade to Advance to use KOT."); return; }
  const activeOrders = allOrders.filter(o => {
    const status = String(o.status || "").toLowerCase();
    const payment = String(o.paymentStatus || "").toLowerCase();
    return ["pending", "accepted", "preparing", "ready"].includes(status) && payment !== "paid";
  });

  activeOrders.forEach(order => {
    printKOTFromOrder(order, order.items || []);
  });
});

document.querySelectorAll("[data-report-type]").forEach(button => button.addEventListener("click", () => {
  selectedReportType = button.dataset.reportType || "daily";
  document.querySelectorAll("[data-report-type]").forEach(tab => tab.classList.toggle("active", tab === button));
  document.querySelectorAll("[data-report-input]").forEach(input => input.classList.toggle("hidden", input.dataset.reportInput !== selectedReportType));
  renderReportRows();
}));
reportDateEl?.addEventListener("change", renderReportRows);
reportMonthEl?.addEventListener("change", renderReportRows);
reportYearEl?.addEventListener("change", renderReportRows);
applyReportRangeBtn?.addEventListener("click", renderReportRows);
exportReportBtn?.addEventListener("click", () => exportReportCSV());
printReportBtn?.addEventListener("click", printReport);
kotHistoryDateEl?.addEventListener("change", renderKotSections);

itemCategoryEl?.addEventListener("input", () => {
  renderMenuCategoryHelpers();
  renderMenuSortSelectors();
});

itemInCategorySortEl?.addEventListener("change", () => {
  if (itemSortOrderEl) itemSortOrderEl.value = itemInCategorySortEl.value;
});

document.getElementById("printKotBtn")?.addEventListener("click", () => {
  const win = window.open("", "_blank", "width=380,height=600");
  if (!win) return alert("Allow popup to print.");
  const html = document.getElementById("kotPreview")?.innerHTML || "";
  win.document.write(`
    <html>
      <head>
        <title>KOT</title>
        <style>
          @page{margin:2mm} body{font-family:Arial,'Courier New',monospace;color:#000;font-size:11px;font-weight:700;padding:0;margin:0;width:58mm;max-width:100%;line-height:1.25}.kot-header{text-align:center;border-bottom:1px dashed #000;padding-bottom:4px;margin-bottom:5px}.kot-header h4{font-size:14px;margin:0 0 2px;font-weight:900;overflow-wrap:anywhere}.kot-details div{display:flex;justify-content:space-between;gap:8px;margin-bottom:3px}.thermal-item-row{display:grid;grid-template-columns:minmax(0,1fr) 32px;gap:6px;padding:4px 0;border-bottom:1px dotted #777;break-inside:avoid}.thermal-item-name{min-width:0;white-space:normal;overflow-wrap:anywhere;word-break:break-word}.thermal-item-qty{text-align:center;font-weight:900}.thermal-modifier{padding:2px 0 0 8px;font-size:10px;overflow-wrap:anywhere}.thermal-head{display:grid;grid-template-columns:minmax(0,1fr) 32px;gap:6px;padding:4px 0;border-bottom:2px solid #000;font-size:10px;text-transform:uppercase}.kot-item{display:flex;justify-content:space-between;gap:8px;overflow-wrap:anywhere}.kot-preview{padding:0!important;border:0!important}@media print and (min-width:70mm){body{width:80mm;font-size:13px}.thermal-item-row,.thermal-head{grid-template-columns:minmax(0,1fr) 42px}.thermal-modifier{font-size:11px}}
        </style>
      </head>
      <body>${html}</body>
    </html>
  `);
  win.document.close();
  setTimeout(() => {
    win.print();
    win.close();
  }, 350);
});

document.getElementById("printBillBtn")?.addEventListener("click", async () => {
  const win = window.open("", "_blank", "width=380,height=700");
  if (!win) return alert("Allow popup to print.");
  const printRoot = document.getElementById("billPreview")?.cloneNode(true);
  if (!printRoot) { win.close(); return alert("Bill preview is unavailable."); }
  const printQr = printRoot.querySelector("#billUpiQrImg");
  const unavailable = printRoot.querySelector("#billUpiMissing");
  try {
    // Embed the fully-loaded QR as PNG so print never depends on an external URL.
    const qrDataUrl = await billQrAsPngDataUrl();
    if (printQr) {
      printQr.src = qrDataUrl;
      printQr.style.display = "block";
      printQr.style.visibility = "visible";
      printQr.style.opacity = "1";
    }
    if (unavailable) unavailable.style.display = "none";
  } catch (error) {
    console.warn("Bill QR could not be embedded for printing", error);
    if (printQr) printQr.style.display = "none";
    if (unavailable) { unavailable.textContent = "UPI QR unavailable"; unavailable.style.display = "block"; }
  }
  const html = printRoot.outerHTML;
  win.document.write(`
    <html>
      <head>
        <title>Bill</title>
        <style>
          @page{margin:2mm} body{font-family:Arial,'Courier New',monospace;color:#000;font-size:11px;font-weight:700;padding:0;width:58mm;max-width:100%;margin:0 auto;line-height:1.25}.kot-header{text-align:center;border-bottom:1px dashed #000;padding-bottom:4px;margin-bottom:5px}.kot-header h4{font-size:14px;margin:0 0 3px;font-weight:900;overflow-wrap:anywhere}.kot-details div,.kot-item{display:flex;justify-content:space-between;gap:8px;margin-bottom:3px}.kot-footer{font-weight:800}.kot-preview{padding:0!important;border:0!important}.thermal-bill-head,.thermal-item-row{display:grid;grid-template-columns:minmax(0,1fr) 28px 45px;gap:5px;padding:4px 0;border-bottom:1px dotted #777;break-inside:avoid}.thermal-bill-head{font-size:10px;text-transform:uppercase;border-bottom:2px solid #000;font-weight:900}.thermal-bill-head span:nth-child(2),.thermal-item-qty{text-align:center}.thermal-bill-head span:last-child,.thermal-item-amount{text-align:right}.thermal-item-name{min-width:0;white-space:normal;overflow-wrap:anywhere;word-break:break-word}.thermal-modifier-row{font-size:10px;padding-top:2px;color:#222}.kot-preview img{max-width:118px!important;height:auto!important}#billUpiQrSection{background:#fff!important;padding-top:14px!important}#billUpiQrImg{width:42mm!important;height:42mm!important;max-width:42mm!important;max-height:42mm!important;aspect-ratio:1 / 1!important;object-fit:contain!important;padding:12px!important;box-sizing:border-box!important;margin:0 auto 14px!important;border:0!important;border-radius:0!important;display:block!important;visibility:visible!important;opacity:1!important;background:#fff!important;image-rendering:pixelated!important;print-color-adjust:exact!important;-webkit-print-color-adjust:exact!important}#billQrUpiId{display:inline-block;max-width:100%;font-size:9px;line-height:1.4;word-break:break-all;overflow-wrap:anywhere}@media print{#billUpiQrImg{width:42mm!important;height:42mm!important;max-width:42mm!important;max-height:42mm!important;object-fit:contain!important;aspect-ratio:1 / 1!important;display:block!important;visibility:visible!important;opacity:1!important}}@media print and (min-width:70mm){body{width:80mm;font-size:13px}.thermal-bill-head,.thermal-item-row{grid-template-columns:minmax(0,1fr) 38px 62px;padding:5px 0}.thermal-bill-head{font-size:12px}.thermal-modifier-row{font-size:11px}}
        </style>
      </head>
      <body>${html}</body>
    </html>
  `);
  win.document.close();
  setTimeout(() => {
    win.print();
    win.close();
  }, 500);
});

window.fillBillPreview = fillBillPreview;

/* =========================================================
   INIT
========================================================= */
updateUserCard();
renderTableNumberOptions("01");
bindOrderFilterButtons();
if (reportDateEl && !reportDateEl.value) reportDateEl.value = todayDateStr();
if (reportMonthEl && !reportMonthEl.value) reportMonthEl.value = todayDateStr().slice(0, 7);
if (reportYearEl && !reportYearEl.value) reportYearEl.value = String(new Date().getFullYear());

const subscriptionBlocked = await checkRestaurantSubscription();
setInterval(checkRestaurantSubscription, 5 * 60 * 1000);

if (!subscriptionBlocked) {
  await loadSettings();
  await loadMenuData();
  startInventoryListeners();
  onSnapshot(collection(db, "restaurants", restaurantId, "tables"), snap => {
    managedTables = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderTableNumberOptions();
    renderTablesSection();
  });
  renderMenuManagement();
  renderManualMenuPicker();
  renderManualCart();
  await loadOrders();
}
