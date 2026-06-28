import { app, db, auth } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  onSnapshot,
  runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { mountSafeReset } from "./safe-reset.js";
import { extractTextFromPdf, parseSupplierBillText, renderPdfFirstPage } from "./bill-import-service.js";

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

const isDevHost = ["localhost", "127.0.0.1"].includes(location.hostname);
const devLog = (...args) => { if (isDevHost) console.log("[Scan2Plate Admin]", ...args); };
let adminInitialLoadDone = false;
let adminLoadTimeout = null;

function ensureLoadingNotice() {
  let notice = document.getElementById("adminLoadingNotice");
  if (notice) return notice;
  notice = document.createElement("div");
  notice.id = "adminLoadingNotice";
  notice.style.cssText = "position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:99999;display:none;max-width:min(92vw,520px);padding:14px 16px;border-radius:12px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;box-shadow:0 14px 45px rgba(0,0,0,.12);font-size:13px;font-weight:700;";
  notice.innerHTML = `<div id="adminLoadingNoticeText">Taking longer than expected. Please check internet and retry.</div><div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;"><button id="adminRetryLoadBtn" class="btn btn-sm btn-primary" type="button">Retry</button><button id="adminLoginAgainBtn" class="btn btn-sm btn-outline" type="button">Logout/Login Again</button></div><details style="margin-top:8px;font-weight:500;"><summary>Debug</summary><pre id="adminLoadingDebug" style="white-space:pre-wrap;font-size:11px;margin:6px 0 0;"></pre></details>`;
  document.body.appendChild(notice);
  document.getElementById("adminRetryLoadBtn")?.addEventListener("click", () => location.reload());
  document.getElementById("adminLoginAgainBtn")?.addEventListener("click", () => {
    localStorage.removeItem("scan2plate_user");
    localStorage.removeItem("scan2serve_user");
    location.href = "./admin-login.html";
  });
  return notice;
}

function showLoadingNotice(message = "Taking longer than expected. Please check internet and retry.", error = null) {
  const notice = ensureLoadingNotice();
  const text = document.getElementById("adminLoadingNoticeText");
  const debug = document.getElementById("adminLoadingDebug");
  if (text) text.textContent = message;
  if (debug) debug.textContent = error ? String(error?.message || error) : `restaurantId: ${restaurantId || "missing"}`;
  notice.style.display = "block";
}

function hideLoadingNotice() {
  const notice = document.getElementById("adminLoadingNotice");
  if (notice) notice.style.display = "none";
}

function startInitialLoadTimeout(pageName = "Admin Dashboard") {
  clearTimeout(adminLoadTimeout);
  safeSetLoading(true);
  adminLoadTimeout = setTimeout(() => {
    if (!adminInitialLoadDone) showLoadingNotice("Taking longer than expected. Please check internet and retry.", `${pageName} load exceeded 8 seconds. restaurantId=${restaurantId || "missing"}`);
  }, 8000);
}

function markInitialLoadDone() {
  adminInitialLoadDone = true;
  clearTimeout(adminLoadTimeout);
  safeSetLoading(false);
  hideLoadingNotice();
}

function safeSetLoading(isLoading, target = document.body) {
  if (!target?.classList) return;
  target.classList.toggle("is-loading", Boolean(isLoading));
}

function cleanupFirestoreListeners(...listeners) {
  listeners.forEach(unsubscribe => {
    try {
      if (typeof unsubscribe === "function") unsubscribe();
    } catch (error) {
      console.warn("Firestore listener cleanup failed", error);
    }
  });
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
const todayCashCollectionEl = document.getElementById("todayCashCollection");
const todayUpiCollectionEl = document.getElementById("todayUpiCollection");
const todayRazorpayCollectionEl = document.getElementById("todayRazorpayCollection");
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
const tableSearchEl = document.getElementById("tableSearch");
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
const itemHasVariantsEl = document.getElementById("itemHasVariants");
const itemVariantPriceFieldsEl = document.getElementById("itemVariantPriceFields");
const itemHalfPriceEl = document.getElementById("itemHalfPrice");
const itemFullPriceEl = document.getElementById("itemFullPrice");
const itemAvailableEl = document.getElementById("itemAvailable");
const itemFoodTypeEl = document.getElementById("itemFoodType");
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
const clearMenuSearchBtn = document.getElementById("clearMenuSearchBtn");
const downloadMenuExcelFormatBtn = document.getElementById("downloadMenuExcelFormatBtn");
const uploadMenuExcelBtn = document.getElementById("uploadMenuExcelBtn");
const menuExcelInput = document.getElementById("menuExcelInput");
const menuImportPreviewBtn = document.getElementById("menuImportPreviewBtn");
const menuFoodTypeFilterEl = document.getElementById("menuFoodTypeFilter");
const menuPriceFilterEl = document.getElementById("menuPriceFilter");
const menuMinPriceFilterEl = document.getElementById("menuMinPriceFilter");
const menuMaxPriceFilterEl = document.getElementById("menuMaxPriceFilter");
const menuSortFilterEl = document.getElementById("menuSortFilter");
const uploadMenuPdfBtn = document.getElementById("uploadMenuPdfBtn");
const menuPdfInput = document.getElementById("menuPdfInput");
const downloadMenuPdfSampleBtn = document.getElementById("downloadMenuPdfSampleBtn");
const menuImportCard = document.getElementById("menuImportCard");
const menuImportRowsEl = document.getElementById("menuImportRows");
const menuImportStatusEl = document.getElementById("menuImportStatus");
const menuImportUpdateDuplicatesEl = document.getElementById("menuImportUpdateDuplicates");
const menuImportModeEl = document.getElementById("menuImportMode");
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
const restaurantLogoUploadEl = document.getElementById("restaurantLogoUpload");
const restaurantLogoPreviewEl = document.getElementById("restaurantLogoPreview");
const removeRestaurantLogoBtn = document.getElementById("removeRestaurantLogoBtn");
const restaurantHelpNumberFieldEl = document.getElementById("restaurantHelpNumberField");
const restaurantSignatureMessageFieldEl = document.getElementById("restaurantSignatureMessageField");
const billFooterMessageFieldEl = document.getElementById("billFooterMessageField");
const dailyOrderResetTimeFieldEl = document.getElementById("dailyOrderResetTimeField");
const showQrOnPaidBillsFieldEl = document.getElementById("showQrOnPaidBillsField");
const kitchenWhatsAppFieldEl = document.getElementById("kitchenWhatsAppField");
const backendUrlFieldEl = document.getElementById("backendUrlField");
const gstFieldEl = document.getElementById("gstField");
const restaurantLatFieldEl = document.getElementById("restaurantLatField");
const restaurantLngFieldEl = document.getElementById("restaurantLngField");
const allowedOrderRadiusFieldEl = document.getElementById("allowedOrderRadiusField");
const printModeFieldEl = document.getElementById("printModeField");
const autoClosePrintWindowFieldEl = document.getElementById("autoClosePrintWindowField");
const useCurrentLocationBtn = document.getElementById("useCurrentLocationBtn");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");

const manualCustomerNameEl = document.getElementById("manualCustomerName");
const manualCustomerPhoneEl = document.getElementById("manualCustomerPhone");
const manualTableNoEl = document.getElementById("manualTableNo");
const manualPaymentMethodEl = document.getElementById("manualPaymentMethod");
const manualPaymentStatusEl = document.getElementById("manualPaymentStatus");
const createManualBillBtn = document.getElementById("createManualBillBtn");
const printKotFromBillingBtn = document.getElementById("printKotFromBilling");
const printKotNewItemsBtn = document.getElementById("printKotNewItemsBtn");
const printKotAllItemsBtn = document.getElementById("printKotAllItemsBtn");
const manualUpiBtn = document.getElementById("manualUpiBtn");
const clearCartBtn = document.getElementById("clearCartBtn");

const manualBillMsgEl = document.getElementById("manualBillMsg");
const manualUpiQrWrap = document.getElementById("manualUpiQrWrap");
const manualUpiQrImg = document.getElementById("manualUpiQrImg");
const manualMenuPickerEl = document.getElementById("manualMenuPicker");
const manualMenuSearchEl = document.getElementById("manualMenuSearch");
const clearManualMenuSearchBtn = document.getElementById("clearManualMenuSearchBtn");
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
const billLogoEl = document.getElementById("billLogo");
const billAddressEl = document.getElementById("billAddress");
const billPhoneEl = document.getElementById("billPhone");
const billNumberEl = document.getElementById("billNumber");
const billTableEl = document.getElementById("billTable");
const billDateEl = document.getElementById("billDate");
const billCustomerEl = document.getElementById("billCustomer");
const billContactEl = document.getElementById("billContact");
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
let restaurantLogoMarkedForRemoval = false;
let currentBillOrder = null;
let selectedRestaurantLogoFile = null;
let restaurantLogoPreviewObjectUrl = "";
window.scan2plateSelectedRestaurantLogoFile = null;

let editingOrderDocId = null;
let editingOrderPublicId = null;

let selectedManualCategory = "all";
let selectedMenuCategory = "all";
let selectedOrderFilter = "active";
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
const menuExcelColumns = ["Category", "Item Name", "Food Type", "Base Price", "Description", "Available", "Image URL", "Has Variants", "Variant 1 Name", "Variant 1 Price", "Variant 2 Name", "Variant 2 Price", "Variant 3 Name", "Variant 3 Price", "Variant 4 Name", "Variant 4 Price", "Sort Order", "Tags"];
const menuExcelInstructions = [
  "Do not change column names.",
  "Food Type must be Veg, Non Veg, Egg, or Other.",
  "For normal item, enter Base Price and set Has Variants to No.",
  "For Half Full item, set Has Variants to Yes and enter Variant names and prices.",
  "For Small Medium pizza, set Has Variants to Yes and enter Small and Medium prices.",
  "For Veg Paneer Chicken options, add variants or create separate item rows.",
  "Available must be Yes or No.",
  "Upload Excel and verify preview before confirming."
];

function normalizedFoodType(value = "") {
  const text = String(value || "veg").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["nonveg", "nonvegetarian", "chicken", "mutton", "meat"].includes(text)) return "nonveg";
  if (["egg", "eggs"].includes(text)) return "egg";
  if (["other", "na", "none"].includes(text)) return "other";
  return "veg";
}

function foodTypeFlags(foodType = "veg") {
  const normalized = normalizedFoodType(foodType);
  return { foodType: normalized, isVeg: normalized === "veg", isNonVeg: normalized === "nonveg", isEgg: normalized === "egg" };
}

function foodTypeLabel(foodType = "veg") {
  return ({ veg: "Veg", nonveg: "Non Veg", egg: "Egg", other: "Other" })[normalizedFoodType(foodType)] || "Veg";
}

function yesNo(value, fallback = true) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["yes", "y", "true", "1", "available", "on"].includes(text)) return true;
  if (["no", "n", "false", "0", "unavailable", "off"].includes(text)) return false;
  return fallback;
}

function tagsArray(value = "") {
  return String(value || "").split(",").map(tag => tag.trim()).filter(Boolean);
}

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

function normalizeImportedMenuItem(raw = {}) {
  const variants = (raw.variants || [])
    .map(variant => ({ name: String(variant.name || "").trim(), price: Number(variant.price || 0) }))
    .filter(variant => variant.name && Number.isFinite(variant.price) && variant.price > 0);
  const wantsVariants = yesNo(raw.hasVariants, false);
  let price = Number(raw.price || raw.basePrice || 0);
  if (wantsVariants && variants.length) {
    const prices = variants.map(variant => variant.price);
    price = Number.isFinite(price) && price > 0 ? Math.min(price, ...prices) : prices[0];
  }
  const flags = foodTypeFlags(raw.foodType || "veg");
  const item = {
    category: normalizeCategory(raw.category),
    name: cleanMenuName(raw.name),
    description: String(raw.description || "").trim(),
    foodType: flags.foodType,
    isVeg: flags.isVeg,
    isNonVeg: flags.isNonVeg,
    isEgg: flags.isEgg,
    price,
    basePrice: price,
    available: raw.available !== false,
    imageUrl: String(raw.imageUrl || "").trim(),
    hasVariants: wantsVariants && variants.length > 0,
    variants: wantsVariants ? variants : [],
    tags: Array.isArray(raw.tags) ? raw.tags : tagsArray(raw.tags),
    sortOrder: Number(raw.sortOrder || 0),
    errors: []
  };
  if (!item.category) item.errors.push("Category required");
  if (!isValidMenuName(item.name)) item.errors.push("Item Name required");
  if (!["veg", "nonveg", "egg", "other"].includes(item.foodType)) item.errors.push("Food Type required");
  if (wantsVariants && !variants.length) item.errors.push("At least one variant price required");
  if (!wantsVariants && (!Number.isFinite(item.price) || item.price <= 0)) item.errors.push("Base Price required");
  item.status = item.errors.length ? "invalid" : "valid";
  return item;
}

function parseCsvMenu(text = "") {
  const lines = String(text || "").split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const parseLine = line => {
    const values = [];
    let current = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"') { current += '"'; i++; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (char === "," && !quoted) { values.push(current); current = ""; continue; }
      current += char;
    }
    values.push(current);
    return values;
  };
  const headers = parseLine(lines[0]).map(header => header.trim());
  return lines.slice(1).map(line => {
    const values = parseLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function parseMenuExcelRows(rows = []) {
  return rows.map(row => {
    const variants = [];
    for (let index = 1; index <= 4; index++) {
      if (String(row[`Variant ${index} Name`] || "").trim() || String(row[`Variant ${index} Price`] || "").trim()) {
        variants.push({ name: row[`Variant ${index} Name`], price: row[`Variant ${index} Price`] });
      }
    }
    return normalizeImportedMenuItem({
      category: row.Category,
      name: row["Item Name"],
      foodType: row["Food Type"],
      price: row["Base Price"],
      description: row.Description,
      available: yesNo(row.Available, true),
      imageUrl: row["Image URL"],
      hasVariants: yesNo(row["Has Variants"], false),
      variants,
      sortOrder: row["Sort Order"],
      tags: row.Tags
    });
  }).filter(item => item.name || item.category);
}

async function readMenuExcelFile(file) {
  if (!file) throw new Error("Choose Excel or CSV file first.");
  const name = String(file.name || "").toLowerCase();
  if (name.endsWith(".csv") || file.type === "text/csv") return parseMenuExcelRows(parseCsvMenu(await file.text()));
  if (!window.XLSX) throw new Error("Excel reader is unavailable. Please check internet and try CSV format.");
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return parseMenuExcelRows(window.XLSX.utils.sheet_to_json(sheet, { defval: "" }));
}

function renderMenuImportReview() {
  if (!menuImportRowsEl) return;
  menuImportCard.style.display = menuImportItems.length ? "block" : "none";
  if (!menuImportItems.length) return;
  menuImportRowsEl.innerHTML = menuImportItems.map((item, index) => {
    const duplicate = menuDuplicateFor(item);
    const variantsText = validMenuVariants(item).map(variant => `${variant.name} ${variant.price}`).join(", ");
    const status = item.status === "invalid"
      ? `<span class="status-badge danger">Invalid: ${escapeHtml(item.errors.join(", "))}</span>`
      : duplicate ? `<span class="status-badge warning">Already exists</span>` : `<span class="status-badge success">Valid</span>`;
    return `<tr data-import-index="${index}" style="${item.status === "invalid" ? "background:#fff1f2;" : "background:#f0fdf4;"}"><td><input class="form-input import-category" value="${escapeHtml(item.category)}" /></td><td><input class="form-input import-name" value="${escapeHtml(item.name)}" /></td><td><select class="form-select import-food-type"><option value="veg">Veg</option><option value="nonveg">Non Veg</option><option value="egg">Egg</option><option value="other">Other</option></select></td><td><input class="form-input import-price" type="number" min="1" value="${Number(item.price || 0)}" /></td><td><input class="form-input import-variants" value="${escapeHtml(variantsText)}" placeholder="Half 120, Full 220" /></td><td><select class="form-select import-available"><option value="true">Yes</option><option value="false">No</option></select></td><td>${status}</td><td><button class="btn btn-outline btn-sm import-edit" type="button">Edit</button></td><td><button class="btn btn-danger btn-sm import-remove" type="button">Remove</button></td></tr>`;
  }).join("");
  menuImportRowsEl.querySelectorAll("tr[data-import-index]").forEach(row => {
    const item = menuImportItems[Number(row.dataset.importIndex)] || {};
    row.querySelector(".import-food-type").value = item.foodType || "veg";
    row.querySelector(".import-available").value = String(item.available !== false);
  });
  menuImportRowsEl.querySelectorAll(".import-edit").forEach(button => button.onclick = () => button.closest("tr")?.querySelector(".import-name")?.focus());
  menuImportRowsEl.querySelectorAll(".import-remove").forEach(button => button.onclick = () => { menuImportItems.splice(Number(button.closest("tr")?.dataset.importIndex), 1); renderMenuImportReview(); });
  const invalid = menuImportItems.filter(item => item.status === "invalid").length;
  if (menuImportStatusEl) menuImportStatusEl.textContent = `${menuImportItems.length} row${menuImportItems.length === 1 ? "" : "s"} in preview · ${invalid} invalid${menuImportInvalidCount ? ` · ${menuImportInvalidCount} skipped` : ""}${menuImportWarning ? ` · ${menuImportWarning}` : ""}`;
}

async function importReviewedMenuItems() {
  const rows = [...(menuImportRowsEl?.querySelectorAll("tr[data-import-index]") || [])];
  const allReviewed = rows.map(row => {
    const original = menuImportItems[Number(row.dataset.importIndex)] || {};
    const variants = String(row.querySelector(".import-variants")?.value || "").split(",").map(part => {
      const match = part.trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)$/);
      return match ? { name: match[1].trim(), price: Number(match[2]) } : null;
    }).filter(Boolean);
    return normalizeImportedMenuItem({ ...original, category: row.querySelector(".import-category")?.value, name: row.querySelector(".import-name")?.value, foodType: row.querySelector(".import-food-type")?.value, price: row.querySelector(".import-price")?.value, available: row.querySelector(".import-available")?.value === "true", hasVariants: variants.length > 0, variants });
  });
  const invalidRows = allReviewed.filter(item => item.status === "invalid").length;
  const reviewed = allReviewed.filter(item => item.status !== "invalid");
  if (!reviewed.length) return alert("Add at least one valid item before importing.");
  if (invalidRows && !confirm(`${invalidRows} invalid row(s) will be skipped. Import only valid rows?`)) return;
  const importMode = menuImportModeEl?.value || "add";
  const updateDuplicates = importMode === "update" || Boolean(menuImportUpdateDuplicatesEl?.checked);
  if (importMode === "replace" && !confirm("Replace existing menu? This deletes current menu items before importing valid rows.")) return;
  importMenuBtn.disabled = true; importMenuBtn.textContent = "Importing…";
  try {
    if (importMode === "replace") {
      const existing = await getDocs(collection(db, "restaurants", restaurantId, "menu"));
      for (const row of existing.docs) await deleteDoc(row.ref);
      allMenuItems = [];
    }
    const nextSortByCategory = new Map();
    reviewed.forEach(item => { const key = normalizedMenuName(item.category); if (!nextSortByCategory.has(key)) nextSortByCategory.set(key, allMenuItems.filter(existing => normalizedMenuName(existing.category) === key).length + 1); });
    let added = 0, updated = 0, skipped = 0;
    for (const item of reviewed) {
      const duplicate = menuDuplicateFor(item);
      if (duplicate && !updateDuplicates) { skipped++; continue; }
      const categoryKey = normalizedMenuName(item.category);
      const sortOrder = nextSortByCategory.get(categoryKey) || 1;
      nextSortByCategory.set(categoryKey, sortOrder + 1);
      const flags = foodTypeFlags(item.foodType);
      const payload = { restaurantId, name:item.name, category:item.category, description:item.description || "", foodType:flags.foodType, isVeg:flags.isVeg, isNonVeg:flags.isNonVeg, isEgg:flags.isEgg, price:item.price, basePrice:item.basePrice || item.price, hasVariants:item.hasVariants, variants:item.variants || [], tags:item.tags || [], imageUrl:item.imageUrl || "", image:item.imageUrl || "", available:item.available !== false, sortOrder:item.sortOrder || sortOrder, updatedAt:serverTimestamp() };
      if (duplicate) { await setDoc(doc(db, "restaurants", restaurantId, "menu", duplicate.id), payload, { merge:true }); updated++; }
      else { await addDoc(collection(db, "restaurants", restaurantId, "menu"), { ...payload, createdAt:serverTimestamp() }); added++; }
    }
    alert(`Menu import complete: Imported: ${added + updated}, Skipped duplicates: ${skipped}, Invalid rows: ${invalidRows}.`);
    menuImportItems = []; menuImportInvalidCount = 0; menuImportWarning = ""; if (menuPdfInput) menuPdfInput.value = ""; if (menuExcelInput) menuExcelInput.value = ""; if (menuImportUpdateDuplicatesEl) menuImportUpdateDuplicatesEl.checked = false;
    await loadMenuData(); renderMenuManagement(); renderManualMenuPicker(); renderMenuImportReview();
  } catch (error) { console.error("Menu import failed", error); alert("Menu import failed. Please check Excel format and try again."); }
  finally { importMenuBtn.disabled = false; importMenuBtn.innerHTML = '<i class="fas fa-file-import"></i> Import Menu'; }
}

function downloadSampleMenuPdf() {
  const lines = ["SCAN2PLATE MENU IMPORT SAMPLE", "", "BURGERS", "Aloo Burger 79", "Cheese Burger 99", "", "DRINKS", "Cold Coffee 89", "Lemon Tea 30"];
  const stream = `BT /F1 15 Tf 50 780 Td ${lines.map((line, index) => `${index ? "0 -22 Td " : ""}(${line.replace(/[()\\]/g, "\\$&")}) Tj`).join(" ")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n", offsets = [0]; objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }); const xref = pdf.length; pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([pdf], { type:"application/pdf" })); link.download = "scan2plate-menu-import-sample.pdf"; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function downloadMenuExcelFormat() {
  const sampleRows = [
    ["Pizza", "Margherita", "Veg", 89, "Cheesy classic pizza", "Yes", "", "Yes", "Small", 89, "Medium", 129, "", "", "", "", 1, "pizza,veg"],
    ["Pizza", "Chicken Tikka Pizza", "Non Veg", 139, "Chicken tikka pizza", "Yes", "", "Yes", "Small", 139, "Medium", 199, "", "", "", "", 2, "pizza,nonveg"],
    ["Burger", "Aloo Tikki Burger", "Veg", 60, "", "Yes", "", "No", "", "", "", "", "", "", "", "", 1, "burger,veg"],
    ["Main Course", "Paneer Masala", "Veg", 120, "", "Yes", "", "Yes", "Half", 120, "Full", 220, "", "", "", "", 1, "paneer"],
    ["Momos", "Crispy Momo", "Veg", 90, "", "Yes", "", "Yes", "Veg", 90, "Paneer", 100, "", "", "", "", 1, "momo"],
    ["Momos", "Crispy Momo Chicken", "Non Veg", 130, "", "Yes", "", "No", "", "", "", "", "", "", "", "", 2, "momo,nonveg"]
  ];
  if (window.XLSX) {
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.aoa_to_sheet([menuExcelColumns, ...sampleRows]), "Menu Format");
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.aoa_to_sheet([["Instructions"], ...menuExcelInstructions.map(text => [text])]), "Instructions");
    window.XLSX.writeFile(workbook, "scan2plate-menu-format.xlsx");
    return;
  }
  const csv = [menuExcelColumns, ...sampleRows].map(row => row.map(value => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = "scan2plate-menu-format.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function getTaxPercent() {
  return Number(restaurantSettings.taxPercent || 0);
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function normalizedResetTime(value = "04:00") {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : "04:00";
}

function businessDateFor(date = new Date(), resetTime = "04:00") {
  const [hours, minutes] = normalizedResetTime(resetTime).split(":").map(Number);
  const businessDate = new Date(date);
  const resetToday = new Date(date);
  resetToday.setHours(hours, minutes, 0, 0);
  if (date < resetToday) businessDate.setDate(businessDate.getDate() - 1);
  return `${businessDate.getFullYear()}-${String(businessDate.getMonth() + 1).padStart(2, "0")}-${String(businessDate.getDate()).padStart(2, "0")}`;
}

async function nextDailyOrderMeta() {
  const dailyResetTime = normalizedResetTime(restaurantSettings.dailyOrderResetTime || dailyOrderResetTimeFieldEl?.value || "04:00");
  const businessDate = businessDateFor(new Date(), dailyResetTime);
  const counterRef = doc(db, "restaurants", restaurantId, "counters", businessDate);
  const dailyOrderNo = await runTransaction(db, async transaction => {
    const snap = await transaction.get(counterRef);
    const next = Number(snap.exists() ? snap.data().lastDailyOrderNo || 0 : 0) + 1;
    transaction.set(counterRef, { businessDate, dailyOrderDate: businessDate, dailyResetTime, lastDailyOrderNo: next, updatedAt: serverTimestamp() }, { merge: true });
    return next;
  });
  return { dailyOrderNo, businessDate, orderNumberLabel: `Order No ${dailyOrderNo}`, dailyResetTime, dailyOrderDate: businessDate, displayOrderNo: String(dailyOrderNo) };
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

function getTodayRange() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setHours(23, 59, 59, 999);
  return { startOfDay, endOfDay };
}

function orderCreatedDate(order = {}) {
  return timestampToDate(order.createdAt) ||
    timestampToDate(order.orderTime) ||
    timestampToDate(order.timestamp) ||
    timestampToDate(order.date) ||
    timestampToDate(order.updatedAt);
}

function normalizeOrderDate(value = {}) {
  if (value instanceof Date) return timestampToDate(value);
  if (value && typeof value === "object" && !value.toDate && typeof value.seconds !== "number") {
    return orderCreatedDate(value);
  }
  return timestampToDate(value);
}

function filterOrdersByDateRange(orders = [], startDate = null, endDate = null) {
  const start = normalizeOrderDate(startDate);
  const end = normalizeOrderDate(endDate);
  if (start) start.setHours(0, 0, 0, 0);
  if (end) end.setHours(23, 59, 59, 999);
  return orders.filter(order => {
    const date = normalizeOrderDate(order);
    if (!date) return false;
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  });
}

function isOrderToday(order = {}) {
  const date = orderCreatedDate(order);
  if (!date) return false;
  const { startOfDay, endOfDay } = getTodayRange();
  return date >= startOfDay && date <= endOfDay;
}

function isOrderActive(order = {}) {
  const status = String(order.status || "pending").toLowerCase();
  const payment = String(order.paymentStatus || "unpaid").toLowerCase();
  return ["pending", "accepted", "preparing", "ready"].includes(status) &&
    payment !== "paid" &&
    order.billClosed !== true;
}

const isActiveOrder = isOrderActive;

function isOrderCompleted(order = {}) {
  const status = String(order.status || "").toLowerCase();
  const payment = String(order.paymentStatus || "").toLowerCase();
  return ["served", "completed"].includes(status) || payment === "paid";
}

function orderAmount(order = {}) {
  return Number(order.grandTotal ?? order.totalAmount ?? order.total ?? order.amount ?? 0);
}

function normalizedPaymentMethod(order = {}) {
  return String(order.paymentMethod || order.payMode || order.paymentType || "cash").toLowerCase();
}

function formatBillDate(ts) {
  const d = timestampToDate(ts) || new Date();
  return d.toLocaleDateString("en-IN");
}

function formatBillTime(ts) {
  const d = timestampToDate(ts) || new Date();
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
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

function waitForImageLoad(image, timeoutMs = 8000) {
  if (!image) return Promise.reject(new Error("Image is missing"));
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Image load timed out")), timeoutMs);
    image.addEventListener("load", () => { clearTimeout(timeout); resolve(); }, { once: true });
    image.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Image failed to load")); }, { once: true });
  });
}

function waitForLogoLoad(image) {
  return waitForImageLoad(image, 2000);
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

function getRestaurantLogoUrl() {
  return String(restaurantSettings.restaurantLogoUrl || restaurantSettings.logoUrl || "").trim();
}

function setLogoPreview(url = "") {
  if (!restaurantLogoPreviewEl) return;
  if (url) {
    restaurantLogoPreviewEl.src = url;
    restaurantLogoPreviewEl.style.display = "block";
  } else {
    restaurantLogoPreviewEl.removeAttribute("src");
    restaurantLogoPreviewEl.style.display = "none";
  }
}

function markRestaurantLogoRemoved() {
  restaurantLogoMarkedForRemoval = true;
  selectedRestaurantLogoFile = null;
  window.scan2plateSelectedRestaurantLogoFile = null;
  restaurantSettings.restaurantLogoUrl = "";
  restaurantSettings.restaurantLogoStoragePath = "";
  restaurantSettings.logoUrl = "";
  if (restaurantLogoUploadEl) restaurantLogoUploadEl.value = "";
  if (logoFieldEl) logoFieldEl.value = "";
  if (restaurantLogoPreviewObjectUrl) {
    URL.revokeObjectURL(restaurantLogoPreviewObjectUrl);
    restaurantLogoPreviewObjectUrl = "";
  }
  setLogoPreview("");
}

function logoUploadErrorMessage(error = {}) {
  const code = error.code || "";
  const message = error.message || String(error || "Unknown error");
  if (code === "logo-upload-timeout" || /timed out/i.test(message)) {
    return "Logo upload timed out. Please try a smaller image or check Firebase Storage/backend.";
  }
  if (code === "storage/unauthorized" || code === "storage/unauthenticated" || /permission|unauthorized/i.test(message)) {
    return "Firebase Storage permission denied. Use backend upload or update Storage rules.";
  }
  if (/cors|cross-origin/i.test(message)) {
    return "Storage CORS issue.";
  }
  return `${code ? `${code}: ` : ""}${message}`;
}

function detailedErrorMessage(error = {}) {
  if (error?.code || error?.message) return `${error.code ? `${error.code}: ` : ""}${error.message || "Unknown error"}`;
  return String(error || "Unknown error");
}

function withTimeout(promise, ms, message, code = "timeout") {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(message);
      error.code = code;
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function setSaveSettingsProgress(text = "Save Settings", saving = false) {
  if (!saveSettingsBtn) return;
  saveSettingsBtn.disabled = Boolean(saving);
  const icon = saving ? `<i class="fas fa-spinner fa-spin"></i>` : `<i class="fas fa-save"></i>`;
  saveSettingsBtn.innerHTML = `${icon} ${text}`;
}

function validateLogoFile(file) {
  if (!file) return;
  const acceptedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
  const nameOk = /\.(jpe?g|png|webp)$/i.test(file.name || "");
  if (!acceptedTypes.has(file.type) && !nameOk) throw new Error("Use JPG, JPEG, PNG, or WEBP logo image.");
}

function loadLogoImage(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    try { validateLogoFile(file); } catch (error) { return reject(error); }
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Logo image could not be read"));
    };
    image.src = objectUrl;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Logo could not be processed")), type, quality);
  });
}

async function compressLogoFile(file) {
  if (!file) return null;
  validateLogoFile(file);
  const image = await loadLogoImage(file);
  if (!image) return null;
  const maxSize = 300;
  const scale = Math.min(1, maxSize / Math.max(1, image.naturalWidth || image.width), maxSize / Math.max(1, image.naturalHeight || image.height));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const targetBytes = 250 * 1024;
  const qualities = [0.75, 0.68, 0.6, 0.52, 0.45];
  let blob = null;
  for (const quality of qualities) {
    blob = await canvasToBlob(canvas, "image/jpeg", quality);
    if (blob.size <= targetBytes) break;
  }
  if (!blob) throw new Error("Logo could not be processed");
  if (blob.size > 1024 * 1024) throw new Error("Logo image must be 1MB or smaller after compression.");
  const baseName = String(file.name || "logo").replace(/\.[^.]+$/, "") || "logo";
  return new File([blob], `${baseName}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}

function logoBackendUrl() {
  const configuredOverride = backendUrlFieldEl ? backendUrlFieldEl.value.trim() : (restaurantSettings.backendUrl || "");
  const savedUrl = String(configuredOverride || restaurantSettings.backendUrl || "").trim();
  if (savedUrl) {
    const normalized = savedUrl.replace(/\/+$/, "");
    if (!/^https:\/\/scan2plate\.com$/i.test(normalized) && normalized !== window.location.origin) return normalized;
  }
  if (!["localhost", "127.0.0.1"].includes(window.location.hostname)) return "https://scan2plate.onrender.com";
  throw new Error("Backend URL missing. Please set Backend URL in Payment Settings.");
}

async function uploadRestaurantLogoWithFirebase(file) {
  if (!restaurantId) throw new Error("restaurantId missing");
  const path = `restaurants/${restaurantId}/logo/logo-${Date.now()}.jpg`;
  const logoRef = storageRef(getStorage(app), path);
  try {
    await uploadBytes(logoRef, file, { contentType: file.type || "image/jpeg" });
    return { url: await getDownloadURL(logoRef), path };
  } catch (error) {
    throw new Error(logoUploadErrorMessage(error));
  }
}

async function uploadRestaurantLogoWithBackend(file) {
  if (!file) return null;
  if (!restaurantId) throw new Error("restaurantId missing");
  const backendUrl = logoBackendUrl();
  const form = new FormData();
  form.append("logo", file, file.name || `logo-${Date.now()}.jpg`);
  const response = await fetch(`${backendUrl}/api/restaurants/${encodeURIComponent(restaurantId)}/logo`, {
    method: "POST",
    headers: await purchaseAuthHeaders(),
    body: form
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok || data.ok === false) {
    const detail = data.error || text || response.statusText;
    throw new Error(`Logo upload failed. Backend URL: ${backendUrl}; restaurantId: ${restaurantId}; HTTP ${response.status}; ${detail}`);
  }
  if (!data.logoUrl) throw new Error("Backend upload did not return logoUrl.");
  return { url: data.logoUrl, path: data.storagePath || "" };
}

async function uploadRestaurantLogo(file) {
  console.log("[Settings Save] Logo upload start", {
    restaurantId,
    hasSelectedLogoFile: Boolean(file),
    fileName: file?.name || "",
    fileType: file?.type || "",
    fileSize: file?.size || 0
  });
  try {
    console.log("[Settings Save] upload method: backend");
    const uploaded = await withTimeout(
      uploadRestaurantLogoWithBackend(file),
      45000,
      "Logo upload timed out. Please try a smaller image or check Firebase Storage/backend.",
      "logo-upload-timeout"
    );
    console.log("[Settings Save] upload success URL", uploaded?.url || "");
    return uploaded;
  } catch (backendError) {
    console.warn("[Settings Save] backend logo upload failed", detailedErrorMessage(backendError));
    throw backendError;
  }
}

function isManualOrder(order = {}) {
  const source = String(order.source || "").toLowerCase();
  return order.isManualOrder === true || order.isManualBill === true || source === "manual_admin" || source === "quick_billing" || source === "manual";
}

function shouldRingForOrder(order = {}) {
  const source = String(order.source || "").toLowerCase();
  if (isManualOrder(order)) return false;
  if (source && !["customer_qr", "qr_order", "qr-order", "online_customer", "customer"].includes(source)) return false;
  return true;
}

function displayCustomerName(order = {}) {
  return order.customerName || (isManualOrder(order) ? "-" : "Walk-in");
}

function displayCustomerPhone(order = {}) {
  return order.customerPhone || (isManualOrder(order) ? "-" : "");
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

    const canAlert = shouldRingForOrder(order);

    if (!adminFirstRealtimeLoad && canAlert) {
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
  adminPendingAlarmIds = new Set(orders.filter(order => String(order.status || "").toLowerCase() === "pending" && shouldRingForOrder(order)).map(order => order.id));
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
    selectedRestaurantLogoFile = null;
    window.scan2plateSelectedRestaurantLogoFile = null;
    restaurantLogoMarkedForRemoval = false;
    if (restaurantLogoPreviewObjectUrl) {
      URL.revokeObjectURL(restaurantLogoPreviewObjectUrl);
      restaurantLogoPreviewObjectUrl = "";
    }
    if (restaurantLogoUploadEl) restaurantLogoUploadEl.value = "";
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
    if (restaurantHelpNumberFieldEl) restaurantHelpNumberFieldEl.value = restaurantSettings.restaurantHelpNumber || "";
    if (restaurantSignatureMessageFieldEl) restaurantSignatureMessageFieldEl.value = restaurantSettings.restaurantSignatureMessage || "";
    if (billFooterMessageFieldEl) billFooterMessageFieldEl.value = restaurantSettings.billFooterMessage || "";
    if (dailyOrderResetTimeFieldEl) dailyOrderResetTimeFieldEl.value = normalizedResetTime(restaurantSettings.dailyOrderResetTime || "04:00");
    if (showQrOnPaidBillsFieldEl) showQrOnPaidBillsFieldEl.checked = restaurantSettings.showQrOnPaidBills !== false;
    setLogoPreview(getRestaurantLogoUrl());
    if (kitchenWhatsAppFieldEl) kitchenWhatsAppFieldEl.value = restaurantSettings.kitchenWhatsApp || "";
    if (backendUrlFieldEl) backendUrlFieldEl.value = restaurantSettings.backendUrl || "";
    if (gstFieldEl) gstFieldEl.value = restaurantSettings.gstNumber || "";
    if (restaurantLatFieldEl) restaurantLatFieldEl.value = restaurantSettings.restaurantLat ?? "";
    if (restaurantLngFieldEl) restaurantLngFieldEl.value = restaurantSettings.restaurantLng ?? "";
    if (allowedOrderRadiusFieldEl) allowedOrderRadiusFieldEl.value = restaurantSettings.allowedOrderRadiusMeters ?? 150;
    if (printModeFieldEl) printModeFieldEl.value = restaurantSettings.printMode === "kiosk" ? "kiosk" : "browser";
    if (autoClosePrintWindowFieldEl) autoClosePrintWindowFieldEl.checked = restaurantSettings.autoClosePrintWindow !== false;
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
    if (!restaurantId) throw new Error("restaurantId missing");
    setSaveSettingsProgress("Saving...", true);
    const restaurantLatRaw = restaurantLatFieldEl?.value.trim() || "";
    const restaurantLngRaw = restaurantLngFieldEl?.value.trim() || "";
    const radiusRaw = allowedOrderRadiusFieldEl?.value || "150";
    const restaurantLat = restaurantLatRaw === "" ? null : Number(restaurantLatRaw);
    const restaurantLng = restaurantLngRaw === "" ? null : Number(restaurantLngRaw);
    const allowedOrderRadiusMeters = Number(radiusRaw) > 0 ? Number(radiusRaw) : 150;
    let uploadedLogo = null;

    if (
      (restaurantLatRaw !== "" && !Number.isFinite(restaurantLat)) ||
      (restaurantLngRaw !== "" && !Number.isFinite(restaurantLng))
    ) {
      alert("Enter valid restaurant latitude and longitude.");
      return;
    }

    let logoFile = selectedRestaurantLogoFile || window.scan2plateSelectedRestaurantLogoFile || null;
    if (!logoFile && restaurantLogoUploadEl?.files?.[0]) {
      setSaveSettingsProgress("Compressing logo...", true);
      logoFile = await compressLogoFile(restaurantLogoUploadEl.files[0]);
      selectedRestaurantLogoFile = logoFile;
      window.scan2plateSelectedRestaurantLogoFile = logoFile;
      if (restaurantLogoPreviewObjectUrl) URL.revokeObjectURL(restaurantLogoPreviewObjectUrl);
      restaurantLogoPreviewObjectUrl = URL.createObjectURL(logoFile);
      setLogoPreview(restaurantLogoPreviewObjectUrl);
    }
    console.log("[Settings Save] start", {
      restaurantId,
      hasSelectedLogoFile: Boolean(logoFile),
      fileName: logoFile?.name || "",
      fileType: logoFile?.type || "",
      fileSize: logoFile?.size || 0
    });
    if (logoFile) {
      try {
        setSaveSettingsProgress("Uploading logo...", true);
        uploadedLogo = await uploadRestaurantLogo(logoFile);
      } catch (error) {
        console.error("[Settings Save] logo upload failed", error);
        alert("Logo upload failed: " + logoUploadErrorMessage(error));
        return;
      }
    }

    const logoUrlValue = logoFieldEl?.value.trim() || "";
    const existingUploadedLogo = restaurantSettings.restaurantLogoUrl || "";
    const existingLogoUrl = restaurantSettings.logoUrl || "";
    const finalUploadedLogoUrl = restaurantLogoMarkedForRemoval ? "" : (uploadedLogo?.url || existingUploadedLogo);
    const finalStoragePath = restaurantLogoMarkedForRemoval ? "" : (uploadedLogo?.path || restaurantSettings.restaurantLogoStoragePath || "");
    const finalLogoUrl = restaurantLogoMarkedForRemoval
      ? ""
      : (uploadedLogo?.url || logoUrlValue || existingLogoUrl || finalUploadedLogoUrl);

    const payload = {
      restaurantName: restaurantFieldEl?.value.trim() || "",
      businessMode: businessModeFieldEl?.value === "vendor" ? "vendor" : "restaurant",
      orderMode: ["table", "token", "hybrid"].includes(orderModeFieldEl?.value) ? orderModeFieldEl.value : "table",
      upiId: upiFieldEl?.value.trim() || "",
      taxPercent: Number(taxFieldEl?.value || 0),
      phone: phoneFieldEl?.value.trim() || "",
      address: addressFieldEl?.value.trim() || "",
      logoUrl: finalLogoUrl,
      restaurantLogoUrl: finalUploadedLogoUrl,
      restaurantLogoStoragePath: finalStoragePath,
      restaurantHelpNumber: restaurantHelpNumberFieldEl?.value.trim() || "",
      restaurantSignatureMessage: restaurantSignatureMessageFieldEl?.value.trim() || "",
      billFooterMessage: billFooterMessageFieldEl?.value.trim() || "",
      dailyOrderResetTime: normalizedResetTime(dailyOrderResetTimeFieldEl?.value || "04:00"),
      showQrOnPaidBills: showQrOnPaidBillsFieldEl?.checked !== false,
      kitchenWhatsApp: kitchenWhatsAppFieldEl?.value.trim() || "",
      backendUrl: backendUrlFieldEl?.value.trim() || "",
      gstNumber: gstFieldEl?.value.trim() || "",
      restaurantLat,
      restaurantLng,
      allowedOrderRadiusMeters,
      printMode: printModeFieldEl?.value === "kiosk" ? "kiosk" : "browser",
      autoClosePrintWindow: autoClosePrintWindowFieldEl?.checked !== false,
      locationProtectionEnabled: document.getElementById("locationProtectionEnabled")?.checked === true,
      tableCount: Math.max(1, Number(document.getElementById("tableCountField")?.value || restaurantSettings.tableCount || 20)),
      updatedAt: serverTimestamp()
    };

    console.log("[Settings Save] saving Firestore settings", { restaurantId, logoUrl: payload.logoUrl || "", restaurantLogoUrl: payload.restaurantLogoUrl || "" });
    setSaveSettingsProgress("Saving settings...", true);
    await withTimeout(
      Promise.all([
        setDoc(doc(db, "restaurants", restaurantId, "settings", "general"), payload, { merge: true }),
        setDoc(doc(db, "restaurants", restaurantId), {
          businessMode: payload.businessMode,
          orderMode: payload.orderMode,
          tableCount: payload.tableCount,
          dailyOrderResetTime: payload.dailyOrderResetTime,
          restaurantLogoUrl: payload.restaurantLogoUrl,
          restaurantLogoStoragePath: payload.restaurantLogoStoragePath,
          logoUrl: payload.logoUrl,
          updatedAt: serverTimestamp()
        }, { merge: true })
      ]),
      15000,
      "Settings save timed out. Please check your network and try again.",
      "settings-save-timeout"
    );
    console.log("[Settings Save] settings save success", { restaurantId });
    restaurantSettings = { ...restaurantSettings, ...payload };
    if (restaurantLogoUploadEl) restaurantLogoUploadEl.value = "";
    selectedRestaurantLogoFile = null;
    window.scan2plateSelectedRestaurantLogoFile = null;
    restaurantLogoMarkedForRemoval = false;
    if (logoFieldEl) logoFieldEl.value = payload.logoUrl || "";
    await loadSettings();
    if (payload.logoUrl) {
      document.querySelectorAll(".app-logo").forEach(img => {
        img.src = payload.logoUrl;
        img.style.display = "";
      });
    }
    alert("Settings saved successfully.");
  } catch (err) {
    console.error("saveSettings error", err);
    console.error("[Settings Save] settings save failed", err);
    alert("Failed to save settings: " + detailedErrorMessage(err));
  } finally {
    setSaveSettingsProgress("Save Settings", false);
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

function validMenuVariants(item = {}) {
  return item.hasVariants === true && Array.isArray(item.variants)
    ? item.variants
        .map(variant => ({ name: String(variant.name || "").trim(), price: Number(variant.price || 0) }))
        .filter(variant => variant.name && variant.price > 0)
    : [];
}

function menuDisplayPrice(item = {}) {
  const variants = validMenuVariants(item);
  if (variants.length) return Math.min(...variants.map(variant => variant.price));
  return Number(item.basePrice || item.price || 0);
}

function hasMenuVariants(item = {}) {
  return validMenuVariants(item).length > 0;
}

function itemDisplayName(item = {}) {
  const baseName = String(item.name || item.itemName || "Item").trim() || "Item";
  const variantName = String(item.variantName || "").trim();
  return variantName && !baseName.toLowerCase().endsWith(` ${variantName.toLowerCase()}`)
    ? `${baseName} ${variantName}`
    : baseName;
}

function menuPriceLabel(item = {}) {
  const variants = validMenuVariants(item);
  if (!variants.length) return money(item.price || 0);
  return `Starting ${money(menuDisplayPrice(item))}<br><small>${variants.map(variant => `${escapeHtml(variant.name)} ${money(variant.price)}`).join(" · ")}</small>`;
}

function foodTypeBadge(item = {}) {
  const type = normalizedFoodType(item.foodType || (item.isNonVeg ? "nonveg" : item.isEgg ? "egg" : item.isVeg === false ? "other" : "veg"));
  return `<span class="food-type-badge ${type}" style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:800;text-transform:uppercase;color:${type === "nonveg" ? "#dc2626" : type === "egg" ? "#d97706" : type === "veg" ? "#16a34a" : "#64748b"};"><span class="food-type-icon ${type}" style="display:inline-grid;place-items:center;width:13px;height:13px;border:1.5px solid currentColor;border-radius:2px;"><span style="width:6px;height:6px;border-radius:50%;background:currentColor;display:block;"></span></span>${escapeHtml(foodTypeLabel(type))}</span>`;
}

function priceFilterMatches(price, filterValue) {
  if (filterValue === "under50") return price < 50;
  if (filterValue === "50-100") return price >= 50 && price <= 100;
  if (filterValue === "100-200") return price >= 100 && price <= 200;
  if (filterValue === "200-500") return price >= 200 && price <= 500;
  if (filterValue === "above500") return price > 500;
  return true;
}

function setVariantFieldsEnabled(enabled) {
  if (itemVariantPriceFieldsEl) itemVariantPriceFieldsEl.style.display = enabled ? "" : "none";
  if (itemPriceEl) {
    itemPriceEl.disabled = enabled;
    itemPriceEl.closest(".form-group")?.querySelector(".form-label")?.classList.toggle("muted", enabled);
  }
}

function cartKeyForItem(item = {}) {
  return `${item.menuItemId || item.id || ""}::${String(item.variantName || "")}`;
}

function makeOrderItemFromMenu(item = {}, variant = null) {
  const variantName = variant?.name || "";
  const price = Number(variant ? variant.price : item.price || 0);
  return {
    id: item.id,
    menuItemId: item.id,
    itemId: item.id,
    itemLineId: manualItemLineId(),
    name: item.name || "",
    itemName: item.itemName || item.name || "",
    price,
    unitPrice: price,
    qty: 1,
    variantName,
    variantPrice: variantName ? price : null,
    hasVariants: Boolean(variantName),
    addedAt: nowIso(),
    kotPrinted: false,
    kotPrintedAt: null
  };
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
  if (itemHasVariantsEl) itemHasVariantsEl.checked = false;
  if (itemHalfPriceEl) itemHalfPriceEl.value = "";
  if (itemFullPriceEl) itemFullPriceEl.value = "";
  setVariantFieldsEnabled(false);
  if (itemAvailableEl) itemAvailableEl.value = "true";
  if (itemFoodTypeEl) itemFoodTypeEl.value = "veg";
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
    const hasVariants = itemHasVariantsEl?.checked === true;
    const halfPrice = Number(itemHalfPriceEl?.value || 0);
    const fullPrice = Number(itemFullPriceEl?.value || 0);
    const price = hasVariants ? fullPrice : Number(itemPriceEl?.value || 0);
    const available = itemAvailableEl?.value === "true";
    const foodType = normalizedFoodType(itemFoodTypeEl?.value || "veg");
    const imageUrl = itemImageEl?.value.trim() || "";
    const sortOrder = Number(itemInCategorySortEl?.value || itemSortOrderEl?.value || 0);
    const description = itemDescriptionEl?.value.trim() || "";
    const customDocId = menuDocIdEl?.value.trim() || "";
    const inventoryUsage = getInventoryUsageFromForm();

    if (!name) return alert("Enter item name.");
    if (!category) return alert("Enter category.");
    if (hasVariants && (!halfPrice || !fullPrice || halfPrice <= 0 || fullPrice <= 0)) return alert("Please enter both Half and Full prices.");
    if (!price || price <= 0) return alert("Enter valid price.");

    const flags = foodTypeFlags(foodType);
    const payload = {
      restaurantId,
      name,
      category,
      price,
      basePrice: price,
      foodType: flags.foodType,
      isVeg: flags.isVeg,
      isNonVeg: flags.isNonVeg,
      isEgg: flags.isEgg,
      hasVariants,
      variants: hasVariants ? [
        { name: "Half", price: halfPrice },
        { name: "Full", price: fullPrice }
      ] : [],
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
  const foodFilter = menuFoodTypeFilterEl?.value || "all";
  const priceFilter = menuPriceFilterEl?.value || "all";
  const minRaw = String(menuMinPriceFilterEl?.value || "").trim();
  const maxRaw = String(menuMaxPriceFilterEl?.value || "").trim();
  const minPrice = minRaw === "" ? null : Number(minRaw);
  const maxPrice = maxRaw === "" ? null : Number(maxRaw);
  const sortMode = menuSortFilterEl?.value || "default";

  const filteredItems = allMenuItems.filter(item => {
    const categoryOk = selectedMenuCategory === "all" || normalizeCategory(item.category) === selectedMenuCategory;
    const itemFoodType = normalizedFoodType(item.foodType || (item.isNonVeg ? "nonveg" : item.isEgg ? "egg" : item.isVeg === false ? "other" : "veg"));
    const foodOk = foodFilter === "all" || itemFoodType === foodFilter;
    const displayPrice = menuDisplayPrice(item);
    const priceOk = priceFilterMatches(displayPrice, priceFilter) &&
      (minPrice === null || displayPrice >= minPrice) &&
      (maxPrice === null || displayPrice <= maxPrice);
    const text = `${item.name || ""} ${item.category || ""} ${item.description || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
    return categoryOk && foodOk && priceOk && (!search || text.includes(search));
  }).sort((a, b) => {
    if (sortMode === "price-asc") return menuDisplayPrice(a) - menuDisplayPrice(b);
    if (sortMode === "price-desc") return menuDisplayPrice(b) - menuDisplayPrice(a);
    if (sortMode === "name-asc") return String(a.name || "").localeCompare(String(b.name || ""));
    if (sortMode === "category") return normalizeCategory(a.category).localeCompare(normalizeCategory(b.category)) || String(a.name || "").localeCompare(String(b.name || ""));
    return 0;
  });

  if (!menuListEl) return;

  if (!filteredItems.length) {
    menuListEl.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-utensils"></i>
        <h4>${search ? "No matching menu items found." : "No menu items found"}</h4>
        <p>${search ? "Clear search or change category filter." : "Add menu items or change filter"}</p>
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
        <div style="margin-bottom:8px;">${foodTypeBadge(item)}</div>
        <div class="menu-item-footer">
          <div class="menu-item-price">${menuPriceLabel(item)}</div>
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
      const variants = validMenuVariants(item);
      const half = variants.find(variant => variant.name.toLowerCase() === "half");
      const full = variants.find(variant => variant.name.toLowerCase() === "full");
      if (itemPriceEl) itemPriceEl.value = item.price || "";
      if (itemHasVariantsEl) itemHasVariantsEl.checked = variants.length > 0;
      if (itemHalfPriceEl) itemHalfPriceEl.value = half?.price || "";
      if (itemFullPriceEl) itemFullPriceEl.value = full?.price || item.price || "";
      setVariantFieldsEnabled(variants.length > 0);
      if (itemAvailableEl) itemAvailableEl.value = String(item.available !== false);
      if (itemFoodTypeEl) itemFoodTypeEl.value = normalizedFoodType(item.foodType || (item.isNonVeg ? "nonveg" : item.isEgg ? "egg" : "veg"));
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
  // A saved override is useful for separate backends. Hosted static pages use the Render backend by default.
  const configuredOverride = backendUrlFieldEl ? backendUrlFieldEl.value.trim() : (restaurantSettings.backendUrl || "");
  const fallback = ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? window.location.origin
    : "https://scan2serve-backend.onrender.com";
  return String(configuredOverride || restaurantSettings.backendUrl || fallback).replace(/\/+$/, "");
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
    const backendUrl = purchaseBackendUrl();
    const healthResponse = await fetch(`${backendUrl}/api/health`, { cache: "no-store" });
    const health = await healthResponse.json().catch(() => ({}));
    if (!healthResponse.ok || health.ok !== true) throw new Error(health.error || "Backend health check failed.");
    const response = await fetch(`${backendUrl}/api/ocr/test`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.connected !== true) {
      const detail = Array.isArray(data.errorMessage) ? data.errorMessage.join(" ") : (data.errorMessage || data.error || JSON.stringify(data) || "The OCR endpoint did not return a ready status.");
      throw new Error(detail);
    }
    if (statusEl) { statusEl.textContent = "Connected - OCR Space connected"; statusEl.title = data.message || "OCR endpoint is reachable and ready."; statusEl.style.color = "#18794e"; }
  } catch (error) {
    const reason = error.message === "Failed to fetch" || /Unexpected token|not valid JSON/i.test(error.message) ? "OCR needs backend deployment. Add backend URL in Settings." : error.message;
    if (statusEl) { statusEl.textContent = `Disconnected - ${reason}`; statusEl.title = reason; statusEl.style.color = "#b43731"; }
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
    <td><select class="form-select purchase-unit"><option value="kg" ${item.unit === "kg" ? "selected" : ""}>kg</option><option value="gm" ${item.unit === "gm" ? "selected" : ""}>gm</option><option value="litre" ${item.unit === "litre" ? "selected" : ""}>litre</option><option value="ml" ${item.unit === "ml" ? "selected" : ""}>ml</option><option value="pcs" ${!item.unit || item.unit === "pcs" ? "selected" : ""}>pcs</option><option value="packet" ${item.unit === "packet" ? "selected" : ""}>packet</option><option value="box" ${item.unit === "box" ? "selected" : ""}>box</option><option value="bottle" ${item.unit === "bottle" ? "selected" : ""}>bottle</option></select></td>
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

function ensureRawOcrReview() {
  if (document.getElementById("purchaseRawOcrReview") || !purchaseReviewEl) return;
  purchaseReviewEl.insertAdjacentHTML("afterend", `<details id="purchaseRawOcrReview" class="hidden" style="margin-top:14px"><summary style="cursor:pointer;font-weight:700">Raw OCR Text</summary><p id="purchaseRawOcrWarning" class="muted" style="margin:8px 0"></p><textarea id="purchaseRawOcrText" class="form-input" rows="9" style="width:100%;font-family:monospace"></textarea><div class="btn-group" style="margin-top:8px"><button id="tryParsePurchaseOcrBtn" class="btn btn-outline" type="button">Try Parse Again</button><button id="enterPurchaseBillManuallyBtn" class="btn btn-outline" type="button">Enter Bill Manually</button></div></details>`);
  document.getElementById("enterPurchaseBillManuallyBtn")?.addEventListener("click", () => { renderPurchaseReview([]); purchaseReviewEl?.classList.remove("hidden"); });
  document.getElementById("tryParsePurchaseOcrBtn")?.addEventListener("click", async () => {
    const rawText = document.getElementById("purchaseRawOcrText")?.value || "";
    if (!rawText.trim()) return showPurchaseOcrMessage("Raw OCR text is empty.");
    try {
      const response = await fetch(`${purchaseBackendUrl()}/api/ocr/parse`, { method: "POST", headers: { ...(await purchaseAuthHeaders()), "Content-Type": "application/json" }, body: JSON.stringify({ restaurantId, rawText }) });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "OCR parse failed.");
      applyPurchaseOcrResult(data); showPurchaseOcrMessage(data.items?.length ? "Parsed the raw OCR text for review." : "No rows matched yet. Edit the text or enter rows manually.", Boolean(data.items?.length));
    } catch (error) { showPurchaseOcrMessage(error.message || "OCR parse failed."); }
  });
}

function applyPurchaseOcrResult(data = {}) {
  if (purchaseSupplierNameEl && !purchaseSupplierNameEl.value.trim()) purchaseSupplierNameEl.value = data.supplierName || "";
  if (purchaseBillNumberEl) purchaseBillNumberEl.value = data.billNo || data.billNumber || "";
  if (purchaseBillDateEl) purchaseBillDateEl.value = /^\d{4}-\d{2}-\d{2}$/.test(data.date || data.billDate || "") ? (data.date || data.billDate) : "";
  if (purchaseTaxAmountEl) purchaseTaxAmountEl.value = data.taxAmount || "";
  if (purchaseGrandTotalEl) purchaseGrandTotalEl.value = data.total || data.grandTotal || "";
  renderPurchaseReview(data.items || []); purchaseReviewEl?.classList.remove("hidden");
  ensureRawOcrReview(); const raw = document.getElementById("purchaseRawOcrReview"), rawText = document.getElementById("purchaseRawOcrText"), warning = document.getElementById("purchaseRawOcrWarning");
  if (raw) raw.classList.toggle("hidden", !data.rawText); if (rawText && data.rawText != null) rawText.value = data.rawText; if (warning) warning.textContent = (data.parseWarnings || []).join(" ");
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
  if (!file?.type.startsWith("image/")) return file;
  const source = await createImageBitmap(file, { imageOrientation: "from-image" });
  const longest = Math.max(source.width, source.height), scale = Math.min(2.5, Math.max(1, 2200 / longest));
  const canvas = document.createElement("canvas"); canvas.width = Math.round(source.width * scale); canvas.height = Math.round(source.height * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(source, 0, 0, canvas.width, canvas.height); source.close?.();
  const image = context.getImageData(0, 0, canvas.width, canvas.height), pixels = image.data;
  for (let index = 0; index < pixels.length; index += 4) { const gray = Math.max(0, Math.min(255, ((pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114) - 128) * 1.7 + 128)); pixels[index] = pixels[index + 1] = pixels[index + 2] = gray; }
  context.putImageData(image, 0, 0);
  const compressed = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.92));
  return compressed ? new File([compressed], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" }) : file;
}

async function scanPurchaseBill() {
  const file = purchaseBillFileEl?.files?.[0];
  if (!file) return alert("Choose a JPG, PNG, WEBP, or PDF purchase bill first.");
  const backendUrl = purchaseBackendUrl();
  showPurchaseOcrMessage("");
  scanPurchaseBillBtn.disabled = true; scanPurchaseBillBtn.textContent = "Scanning…";
  try {
    let scanFile = file;
    if (file.type === "application/pdf") {
      let pdfText = "";
      try { pdfText = await extractTextFromPdf(file); }
      catch (error) { console.warn("PDF text extraction failed; trying scanned-PDF OCR fallback.", error); }
      if (pdfText) {
        const parsed = parseSupplierBillText(pdfText); reviewedPurchaseFileUrl = ""; applyPurchaseOcrResult(parsed); rescanPurchaseBillBtn?.classList.remove("hidden");
        showPurchaseOcrMessage(parsed.items.length ? "Bill text extracted directly from PDF. Review before adding inventory." : "PDF has readable text, but the parser found no items. Review raw text or enter the bill manually.", Boolean(parsed.items.length));
        return;
      }
      try { scanFile = await renderPdfFirstPage(file); }
      catch (error) { throw new Error(error.message || "PDF has no readable text and first-page conversion is unavailable."); }
    }
    const uploadFile = await preparePurchaseBillForUpload(scanFile);
    const form = new FormData(); form.append("file", uploadFile, uploadFile.name || file.name || "supplier_bill.jpg"); form.append("restaurantId", restaurantId);
    const response = await fetch(`${backendUrl}/api/ocr/scan`, { method: "POST", headers: await purchaseAuthHeaders(), body: form });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || JSON.stringify(data) || "Could not read bill clearly. Please upload a clearer image or enter manually.");
    reviewedPurchaseFileUrl = data.file?.fileUrl || "";
    applyPurchaseOcrResult(data); rescanPurchaseBillBtn?.classList.remove("hidden");
    if (!data.items?.length) showPurchaseOcrMessage("OCR text was received but no item rows matched. Review the raw text, try parsing again, or enter the bill manually.");
  } catch (error) { const message = error.message === "Failed to fetch" || /Unexpected token|not valid JSON/i.test(error.message) ? "OCR needs backend deployment. Add backend URL in Settings." : (error.message || "OCR scan failed."); showPurchaseOcrMessage(message); ensureRawOcrReview(); document.getElementById("purchaseRawOcrReview")?.classList.remove("hidden"); }
  finally { scanPurchaseBillBtn.disabled = false; scanPurchaseBillBtn.textContent = "Scan Bill for Review"; }
}

async function saveReviewedPurchase() {
  const items = reviewedPurchaseItems(); if (!items.length) return alert("Review the bill and provide at least one valid item.");
  const backendUrl = purchaseBackendUrl(); showPurchaseOcrMessage("");
  savePurchaseBillBtn.disabled = true; savePurchaseBillBtn.textContent = "Saving…";
  try {
    const response = await fetch(`${backendUrl}/api/inventory/purchase-review/save`, { method: "POST", headers: { ...(await purchaseAuthHeaders()), "Content-Type": "application/json" }, body: JSON.stringify({ restaurantId, supplierName: purchaseSupplierNameEl?.value.trim() || "", billNumber: purchaseBillNumberEl?.value.trim() || "", billDate: purchaseBillDateEl?.value || "", gstTax: Number(purchaseTaxAmountEl?.value || 0), total: Number(purchaseGrandTotalEl?.value || 0), fileUrl: reviewedPurchaseFileUrl, items }) });
    const data = await response.json().catch(() => ({})); if (!response.ok || data.ok === false) throw new Error(data.error || JSON.stringify(data) || "Could not save the reviewed purchase.");
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
        const menuItemId = orderedItem.menuItemId || orderedItem.itemId || orderedItem.id;
        if (!menuItemId) continue;
        const menuSnap = await transaction.get(doc(db, "restaurants", restaurantId, "menu", menuItemId));
        if (!menuSnap.exists()) continue;
        const variantFactor = String(orderedItem.variantName || "").toLowerCase() === "half" ? 0.5 : 1;
        (menuSnap.data().inventoryUsage || []).forEach(usage => usages.push({ ...usage, orderedQty: Number(orderedItem.qty || 0) * variantFactor }));
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
  cleanupFirestoreListeners(inventoryUnsubscribe, inventoryLogsUnsubscribe);
  inventoryUnsubscribe = null;
  inventoryLogsUnsubscribe = null;
  inventoryUnsubscribe = onSnapshot(collection(db, "restaurants", restaurantId, "inventory"), snap => {
    allInventoryItems = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => String(a.itemName).localeCompare(String(b.itemName)));
    renderInventory();
  }, error => showLoadingNotice("Unable to load data. Please retry.", error));
  inventoryLogsUnsubscribe = onSnapshot(collection(db, "restaurants", restaurantId, "inventory_logs"), snap => {
    inventoryLogs = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderInventoryHistory();
    renderInventoryReports(allInventoryItems.filter(inventoryStatus));
  }, error => showLoadingNotice("Unable to load data. Please retry.", error));
  onSnapshot(collection(db, "restaurants", restaurantId, "purchase_bills"), snap => {
    purchaseBills = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => (b.uploadedAt?.seconds || 0) - (a.uploadedAt?.seconds || 0));
    renderPurchaseHistory();
  }, error => showLoadingNotice("Unable to load data. Please retry.", error));
}

/* =========================================================
   TABLES
========================================================= */
function tableBusinessDayRange(now = new Date()) {
  const resetTime = normalizedResetTime(restaurantSettings.businessDayStartTime || restaurantSettings.dailyOrderResetTime || "04:00");
  const [hours, minutes] = resetTime.split(":").map(Number);
  const start = new Date(now);
  start.setHours(hours, minutes, 0, 0);
  if (now < start) start.setDate(start.getDate() - 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { start, end };
}

function orderInRange(order = {}, range = tableBusinessDayRange()) {
  const date = orderCreatedDate(order);
  return Boolean(date && date >= range.start && date <= range.end);
}

function isTableOccupyingOrder(order = {}, range = tableBusinessDayRange()) {
  if (!order) return false;
  const status = String(order.status || "pending").toLowerCase();
  const payment = String(order.paymentStatus || "unpaid").toLowerCase();
  const closedStatuses = new Set(["paid", "completed", "closed", "cancelled", "rejected", "bill_closed"]);
  if (order.billClosed === true || closedStatuses.has(payment) || closedStatuses.has(status)) return false;
  const occupyingStatuses = new Set(["new", "pending", "accepted", "preparing", "ready", "served", "unpaid", "customer_sitting"]);
  const activeUnpaid = occupyingStatuses.has(status) || payment === "unpaid";
  return activeUnpaid && (orderInRange(order, range) || payment !== "paid");
}

function getTableStatus(tableNo, tableOrders = [], managedTable = {}, range = tableBusinessDayRange()) {
  const disabled = managedTable.disabled === true || managedTable.active === false;
  const sorted = [...tableOrders].sort((a, b) => tsToMs(orderCreatedDate(b)) - tsToMs(orderCreatedDate(a)));
  const activeOrder = sorted.find(order => isTableOccupyingOrder(order, range));
  const recentOrder = sorted.find(order => orderInRange(order, range));
  if (disabled) return { state: "disabled", disabled: true, occupied: false, label: "Disabled", order: recentOrder || activeOrder || null };
  if (activeOrder) return { state: "occupied", disabled: false, occupied: true, label: "Customer Sitting", order: activeOrder };
  if (recentOrder && (recentOrder.billClosed === true || ["paid", "completed", "closed", "bill_closed"].includes(String(recentOrder.status || "").toLowerCase()) || String(recentOrder.paymentStatus || "").toLowerCase() === "paid")) {
    return { state: "available", disabled: false, occupied: false, label: "Bill Closed", order: recentOrder };
  }
  return { state: "available", disabled: false, occupied: false, label: "Available", order: null };
}

function renderTablesSection() {
  if (!tablesGridEl || !tableSummaryEl) return;

  const tableOrdersByNo = new Map();
  const businessRange = tableBusinessDayRange();

  allOrders.forEach(order => {
    const tableNo = String(order.tableNo || "").trim().padStart(2, "0");
    if (!tableNo) return;
    const orders = tableOrdersByNo.get(tableNo) || [];
    orders.push(order);
    tableOrdersByNo.set(tableNo, orders);
  });

  const tableOptions = getTableOptions();
  const managedTableByNo = new Map(managedTables.map(table => [String(table.tableNo || table.id).padStart(2, "0"), table]));
  const tableStatuses = tableOptions.map(tableNo => ({
    tableNo,
    ...getTableStatus(tableNo, tableOrdersByNo.get(tableNo) || [], managedTableByNo.get(tableNo) || {}, businessRange)
  }));

  const openCount = tableStatuses.filter(table => table.occupied).length;
  const disabledCount = tableStatuses.filter(table => table.disabled).length;
  const availableCount = tableStatuses.length - openCount - disabledCount;

  tableSummaryEl.innerHTML = `
    <div class="stat-card">
      <div class="stat-icon orange"><i class="fas fa-chair"></i></div>
      <div class="stat-info"><h3>Occupied Tables</h3><div class="value">${openCount}</div></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon green"><i class="fas fa-check-circle"></i></div>
      <div class="stat-info"><h3>Available Tables</h3><div class="value">${availableCount}</div></div>
    </div>
    <div class="stat-card"><div class="stat-icon blue"><i class="fas fa-table"></i></div><div class="stat-info"><h3>Total Tables</h3><div class="value">${tableOptions.length}</div></div></div>
    <div class="stat-card"><div class="stat-icon danger"><i class="fas fa-ban"></i></div><div class="stat-info"><h3>Disabled Tables</h3><div class="value">${disabledCount}</div></div></div>
  `;

  const tableSearch = String(tableSearchEl?.value || "").trim().toLowerCase();
  const visibleTableStatuses = tableStatuses.filter(table => {
    const managedTable = managedTableByNo.get(table.tableNo) || {};
    const order = table.order;
    const searchText = `table ${table.tableNo} ${managedTable.name || managedTable.tableName || ""} ${table.label} ${order?.customerName || ""} ${order?.orderId || ""}`.toLowerCase();
    return !tableSearch || searchText.includes(tableSearch);
  });

  if (!visibleTableStatuses.length) {
    tablesGridEl.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1;">
        <i class="fas fa-table"></i>
        <h4>No matching tables found.</h4>
      </div>
    `;
    return;
  }

  tablesGridEl.innerHTML = visibleTableStatuses.map(table => {
    const { tableNo, order, occupied, disabled } = table;
    const cardClass = table.state;
    const statusText = table.label;
    const orderText = occupied && order?.orderId ? `Order: ${order.orderId}` : (statusText === "Bill Closed" ? "Bill closed" : "No active bill");
    const customerText = occupied
      ? order.customerName || "Walk-in"
      : "Ready for next customer";

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

function manualItemLineId() {
  return `MIL${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeManualCartItem(item = {}) {
  const variantName = String(item.variantName || "").trim();
  const price = Number(item.price || item.variantPrice || item.unitPrice || 0);
  return {
    id: item.id || item.menuItemId || "",
    menuItemId: item.menuItemId || item.id || "",
    itemId: item.itemId || item.menuItemId || item.id || "",
    itemLineId: item.itemLineId || manualItemLineId(),
    name: item.name || "",
    itemName: item.itemName || item.name || "",
    price,
    unitPrice: Number(item.unitPrice || price),
    qty: Number(item.qty || 1),
    variantName,
    variantPrice: variantName ? Number(item.variantPrice || price) : null,
    hasVariants: item.hasVariants === true || Boolean(variantName),
    addedAt: item.addedAt || nowIso(),
    kotPrinted: item.kotPrinted === true,
    kotPrintedAt: item.kotPrintedAt || null
  };
}

function manualCartPayload(items = manualCart) {
  return items.map(normalizeManualCartItem);
}

function updateManualQty(lineId, delta) {
  const found = manualCart.find(x => x.itemLineId === lineId);
  if (!found) return;
  if (found.kotPrinted === true && delta > 0) {
    manualCart.push({
      ...found,
      itemLineId: manualItemLineId(),
      qty: 1,
      addedAt: nowIso(),
      kotPrinted: false,
      kotPrintedAt: null
    });
    renderManualCart();
    return;
  }
  found.qty += delta;
  if (found.qty <= 0) manualCart = manualCart.filter(x => x.itemLineId !== lineId);
  renderManualCart();
}

function addManualItem(id, variantName = "") {
  const item = manualMenuItems.find(x => x.id === id);
  if (!item) return;
  const variant = validMenuVariants(item).find(v => v.name === variantName) || null;
  if (hasMenuVariants(item) && !variant) return;

  const key = `${id}::${variant?.name || ""}`;
  const found = manualCart.find(x => cartKeyForItem(x) === key && x.kotPrinted !== true);
  if (found) found.qty += 1;
  else {
    manualCart.push(makeOrderItemFromMenu(item, variant));
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
        <div class="cart-item-name">${escapeHtml(itemDisplayName(item))}</div>
        <div class="cart-item-price">${money(item.price)} each</div>
      </div>

      <div class="cart-qty-control">
        <button class="cart-qty-btn manual-minus" data-line-id="${escapeHtml(item.itemLineId)}">-</button>
        <div class="cart-qty-value">${item.qty}</div>
        <button class="cart-qty-btn manual-plus" data-line-id="${escapeHtml(item.itemLineId)}">+</button>
      </div>

      <div class="cart-item-total">${money(item.price * item.qty)}</div>

      <button class="cart-item-remove manual-remove" data-line-id="${escapeHtml(item.itemLineId)}">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `).join("");

  manualCartListEl.querySelectorAll(".manual-minus").forEach(btn => {
    btn.addEventListener("click", () => updateManualQty(btn.dataset.lineId || "", -1));
  });

  manualCartListEl.querySelectorAll(".manual-plus").forEach(btn => {
    btn.addEventListener("click", () => updateManualQty(btn.dataset.lineId || "", 1));
  });

  manualCartListEl.querySelectorAll(".manual-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      manualCart = manualCart.filter(item => item.itemLineId !== (btn.dataset.lineId || ""));
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

  const search = String(manualMenuSearchEl?.value || "").trim().toLowerCase();
  const filteredItems = manualMenuItems.filter(item => {
    const categoryOk = selectedManualCategory === "all" || normalizeCategory(item.category) === selectedManualCategory;
    const text = `${item.name || ""} ${item.category || ""} ${item.description || ""}`.toLowerCase();
    return categoryOk && (!search || text.includes(search));
  });

  if (!filteredItems.length) {
    manualMenuPickerEl.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-filter"></i>
        <h4>${search ? "No matching menu items found" : "No items in this category"}</h4>
        <p>${search ? "Clear search or choose another category" : "Choose another category"}</p>
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
          <div class="menu-item-price">${menuPriceLabel(item)}</div>
          ${hasMenuVariants(item)
            ? `<div class="btn-group">${validMenuVariants(item).map(variant => `<button class="btn btn-sm btn-primary manual-add-btn" data-id="${item.id}" data-variant="${escapeHtml(variant.name)}">${escapeHtml(variant.name)}</button>`).join("")}</div>`
            : `<button class="btn btn-sm btn-primary manual-add-btn" data-id="${item.id}">Add</button>`}
        </div>
      </div>
    </div>
  `).join("");

  manualMenuPickerEl.querySelectorAll(".manual-add-btn").forEach(btn => {
    btn.addEventListener("click", () => addManualItem(btn.dataset.id || "", btn.dataset.variant || ""));
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
      ? order.items.map(normalizeManualCartItem)
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
  if (kotNotesEl) kotNotesEl.textContent = "Source: Manual Order";

  if (kotItemsEl) {
    kotItemsEl.innerHTML = manualCart.length
      ? manualCart.map(item => `
          <div class="kot-item">
            <span><strong>${item.qty}x</strong> ${escapeHtml(itemDisplayName(item))}</span>
          </div>
        `).join("")
      : "<div>No items</div>";
  }

}

function fillBillPreview(order) {
  currentBillOrder = order;
  const restaurantName = restaurantFieldEl?.value.trim() || restaurantSettings.restaurantName || "Restaurant";
  const address = addressFieldEl?.value.trim() || restaurantSettings.address || "";
  const phone = phoneFieldEl?.value.trim() || restaurantSettings.phone || "";
  const upiId = upiFieldEl?.value.trim() || restaurantSettings.upiId || "";

  if (billRestaurantNameEl) billRestaurantNameEl.textContent = restaurantName;
  if (billLogoEl) {
    const logoUrl = getRestaurantLogoUrl();
    if (logoUrl) {
      billLogoEl.src = logoUrl;
      billLogoEl.style.display = "block";
      billLogoEl.onerror = () => {
        billLogoEl.style.display = "none";
        billLogoEl.removeAttribute("src");
      };
    } else {
      billLogoEl.style.display = "none";
      billLogoEl.removeAttribute("src");
    }
  }
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
  if (billCustomerEl) billCustomerEl.textContent = displayCustomerName(order);
  if (billContactEl) billContactEl.textContent = displayCustomerPhone(order) || "-";

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

  const isPaid = String(order.paymentStatus || "").toLowerCase() === "paid";
  const showQr = Boolean(upiId) && (!isPaid || restaurantSettings.showQrOnPaidBills !== false);

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
      billUpiQrSectionEl.style.display = upiId ? "none" : "block";
      billUpiQrImgEl.style.display = "none";
      if (billUpiMissingEl) billUpiMissingEl.style.display = upiId ? "none" : "block";
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

function billDisplayOrderNo(order = {}) {
  return order.displayOrderNo || order.dailyOrderNo || "-";
}

function thermalBillItemRows(items = []) {
  return (items || []).map(item => {
    const qty = Number(item.qty || 0);
    const amount = Number(item.price || 0) * qty;
    return `<div class="item-row"><div class="item-name">${escapeHtml(itemDisplayName(item))}</div><div class="item-qty">${qty}</div><div class="item-amt">${money(amount)}</div></div>`;
  }).join("");
}

function buildThermalBillHtml(order, qrDataUrl = "") {
  const restaurantName = restaurantFieldEl?.value.trim() || restaurantSettings.restaurantName || "Restaurant";
  const address = addressFieldEl?.value.trim() || restaurantSettings.address || "";
  const phone = phoneFieldEl?.value.trim() || restaurantSettings.phone || "";
  const gst = String(restaurantSettings.gstNumber || "").trim().toUpperCase();
  const signature = String(restaurantSettings.restaurantSignatureMessage || "").trim();
  const footer = String(restaurantSettings.billFooterMessage || "Thank you for dining with us!").trim();
  const logoUrl = getRestaurantLogoUrl();
  const isPaid = String(order.paymentStatus || "unpaid").toLowerCase() === "paid";
  const pm = String(order.paymentMethod || "cash").toLowerCase();
  const pmLabels = { cash: "Cash", upi: "UPI", debit_card: "Debit Card", credit_card: "Credit Card" };
  const upiId = upiFieldEl?.value.trim() || restaurantSettings.upiId || "";
  const showQr = Boolean(qrDataUrl && upiId);
  const totalQty = (order.items || []).reduce((sum, item) => sum + Number(item.qty || 0), 0);

  return `<!DOCTYPE html>
<html>
<head>
  <title>Bill</title>
  <style>
    @page{size:80mm auto;margin:0}
    *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    body{margin:0;padding:0;background:#fff;color:#000}
    .thermal-bill{width:72mm;margin:0 auto;padding:2mm;font-family:"Courier New",monospace,Arial,sans-serif;color:#000;background:#fff;font-size:12px;line-height:1.35;font-weight:600}
    .center{text-align:center}.right{text-align:right}.strong{font-weight:900}.muted{font-size:10.5px}
    .bill-logo{width:18mm;max-height:15mm;object-fit:contain;display:block;margin:0 auto 1mm auto;image-rendering:crisp-edges;filter:grayscale(1) contrast(1.35)}
    .bill-title{font-size:18px;font-weight:900;text-align:center;line-height:1.1;margin:1mm 0 0}
    .bill-signature{font-size:11px;text-align:center;font-style:italic;margin-top:1mm}
    .bill-meta-small{font-size:10.5px;text-align:center;overflow-wrap:anywhere}
    .bill-divider{border-top:1px dashed #000;margin:2mm 0}
    .invoice-title{font-size:13px;font-weight:900;letter-spacing:.08em;text-align:center}
    .detail-row,.sum-row,.pay-row{display:grid;grid-template-columns:22mm 1fr;gap:2mm;margin:.6mm 0}
    .detail-row span:last-child,.sum-row span:last-child,.pay-row span:last-child{text-align:right;overflow-wrap:anywhere}
    .order-no{font-size:16px;font-weight:900;text-align:center;letter-spacing:.08em;margin:1mm 0}
    .item-head,.item-row{display:grid;grid-template-columns:minmax(0,1fr) 11mm 19mm;gap:2mm;align-items:start}
    .item-head{font-weight:900;border-bottom:1px solid #000;padding-bottom:1mm;margin-bottom:1mm}
    .item-row{padding:1mm 0;border-bottom:1px dotted #777;break-inside:avoid}
    .item-name{min-width:0;white-space:normal;overflow-wrap:anywhere;word-break:break-word}
    .item-qty{text-align:center}.item-amt{text-align:right}
    .total-row{font-size:16px;font-weight:900;letter-spacing:.08em}
    .upi-title{font-size:15px;font-weight:900;text-align:center;letter-spacing:.08em;margin:2mm 0 1mm}
    .upi-qr{width:42mm!important;height:42mm!important;padding:4mm!important;background:#fff!important;display:block;margin:2mm auto 1mm!important;object-fit:contain!important;image-rendering:pixelated;image-rendering:crisp-edges}
    .upi-details{font-size:9px;line-height:1.2;text-align:center;word-break:break-all;overflow-wrap:anywhere}
    .footer{font-size:12px;text-align:center;font-weight:800;margin-top:2mm}
    @media print{body{margin:0;padding:0;background:#fff}.thermal-bill{width:72mm;margin:0 auto;padding:2mm}.bill-logo{width:18mm;max-height:15mm}.upi-qr{width:42mm!important;height:42mm!important;padding:4mm!important}}
  </style>
</head>
<body>
  <main class="thermal-bill">
    <header class="center">
      ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" class="bill-logo" alt="">` : ""}
      <div class="bill-title">${escapeHtml(restaurantName)}</div>
      ${signature ? `<div class="bill-signature">${escapeHtml(signature)}</div>` : ""}
      ${address ? `<div class="bill-meta-small">${escapeHtml(address)}</div>` : ""}
      ${gst ? `<div class="bill-meta-small"><span class="strong">GSTIN:</span> ${escapeHtml(gst)}</div>` : ""}
      ${phone ? `<div class="bill-meta-small"><span class="strong">Phone:</span> ${escapeHtml(phone)}</div>` : ""}
      <div class="bill-divider"></div>
      <div class="invoice-title">TAX INVOICE</div>
      <div class="bill-divider"></div>
    </header>

    <section>
      <div class="detail-row"><span>Bill #:</span><span>${escapeHtml(order.orderId || "-")}</span></div>
      <div class="detail-row"><span>Order No:</span><span>${escapeHtml(billDisplayOrderNo(order))}</span></div>
      <div class="detail-row"><span>Table:</span><span>${escapeHtml(order.tableNo || order.tokenNo || "-")}</span></div>
      <div class="detail-row"><span>Date:</span><span>${escapeHtml(formatBillDate(order.createdAt))}</span></div>
      <div class="detail-row"><span>Time:</span><span>${escapeHtml(formatBillTime(order.createdAt))}</span></div>
      <div class="detail-row"><span>Customer:</span><span>${escapeHtml(displayCustomerName(order))}</span></div>
      <div class="detail-row"><span>Contact:</span><span>${escapeHtml(displayCustomerPhone(order) || "-")}</span></div>
      <div class="order-no">Order# ${escapeHtml(billDisplayOrderNo(order))}</div>
    </section>

    <div class="bill-divider"></div>
    <section>
      <div class="item-head"><span>ITEM</span><span class="center">QTY</span><span class="right">AMT</span></div>
      ${thermalBillItemRows(order.items || []) || `<div class="item-row"><div class="item-name">No items</div><div class="item-qty">0</div><div class="item-amt">${money(0)}</div></div>`}
    </section>
    <div class="bill-divider"></div>

    <section>
      <div class="sum-row"><span>Subtotal:</span><span>${money(order.itemsTotal || 0)}</span></div>
      <div class="sum-row"><span>Tax:</span><span>${money(order.tax || 0)}</span></div>
      <div class="sum-row total-row"><span>TOTAL:</span><span>${money(order.grandTotal || 0)}</span></div>
      <div class="muted">Total Qty: ${Number(totalQty || 0)}</div>
    </section>
    <div class="bill-divider"></div>

    <section>
      <div class="pay-row"><span>${escapeHtml(pmLabels[pm] || order.paymentMethod || "Cash")}</span><span class="strong">${isPaid ? "PAID" : "UNPAID"}</span></div>
    </section>

    ${showQr ? `<section>
      <div class="upi-title">Scan &amp; Pay</div>
      <img class="upi-qr" src="${qrDataUrl}" alt="UPI QR">
      <div class="upi-details">UPI ID: <strong>${escapeHtml(upiId)}</strong></div>
      <div class="upi-details">Amount: <strong>${money(order.grandTotal || 0)}</strong></div>
      <div class="upi-details">Restaurant: <strong>${escapeHtml(restaurantName)}</strong></div>
    </section>` : ""}

    <div class="bill-divider"></div>
    <footer class="footer">
      <div>${escapeHtml(footer)}</div>
      <div>Visit Again</div>
    </footer>
  </main>
</body>
</html>`;
}

async function createManualBill() {
  if (!canUseOrdering) { alert("Your Basic plan supports digital menu only. Upgrade to Advance to enable ordering and billing."); return; }
  try {
    const customerName = manualCustomerNameEl?.value.trim() || "";
    const customerPhone = manualCustomerPhoneEl?.value.trim() || "";
    const tableNo = String(manualTableNoEl?.value || "01").trim().padStart(2, "0");
    const paymentMethod = manualPaymentMethodEl?.value || "cash";
    const paymentStatus = manualPaymentStatusEl?.value || "unpaid";

    if (!manualCart.length) return alert("Select at least one menu item.");

    const { itemsTotal, tax, grandTotal } = renderManualTotals();
    const cartItems = manualCartPayload();
    manualCart = cartItems;
    const newKotItems = cartItems.filter(item => item.kotPrinted !== true);
    const wasEditingOrder = Boolean(editingOrderDocId);

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
        items: cartItems,
        itemsText: cartItems.map(i => `${itemDisplayName(i)} x${i.qty}`).join(", "),
        note: "Bill updated by admin",
        paymentStatus,
        paymentMethod,
        grandTotal,
        tax,
        itemsTotal,
        paidAmount: paymentStatus === "paid" ? grandTotal : 0,
        remainingAmount: paymentStatus === "paid" ? 0 : grandTotal,
        billClosed: paymentStatus === "paid" && ["ready", "served", "completed"].includes(oldStatus),
        status: oldData.status || "pending",
        etaMinutes: Number(oldData.etaMinutes || 10),
        etaStartedAt: oldData.etaStartedAt || null,
        hasNewItems: newKotItems.length > 0,
        newlyAddedItems: newKotItems,
        newlyAddedItemsText: newKotItems.map(i => `${itemDisplayName(i)} x${i.qty}`).join(", "),
        newlyAddedNote: "Updated from admin billing",
        kitchenAlertAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        isManualBill: true,
        isManualOrder: oldData.isManualOrder === true,
        source: oldData.source || "manual_admin"
      });

      fillKotPreviewFromCart(editingOrderPublicId || "");
      setNotice(`Order updated: ${editingOrderPublicId}`, "success");
    } else {
      const orderId = "ORD" + Date.now();
      const dailyOrder = await nextDailyOrderMeta();

      await addDoc(collection(db, "orders"), {
        orderId,
        ...dailyOrder,
        restaurantId,
        customerName,
        customerPhone,
        tableNo,
        items: cartItems,
        itemsText: cartItems.map(i => `${itemDisplayName(i)} x${i.qty}`).join(", "),
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
        isManualBill: true,
        isManualOrder: true,
        source: "manual_admin"
      });

      fillKotPreviewFromCart(orderId);
      setNotice(`Order created and sent to kitchen: ${orderId}`, "success");
    }

    await loadOrders();
    if (!wasEditingOrder) setTimeout(() => resetManualBillForm(), 700);
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
    return `<div class="kot-item-row"><div class="kot-item-name">${escapeHtml(itemDisplayName(item))}${extras.map(extra => `<div class="kot-modifier">* ${escapeHtml(String(extra.name))}${extra.qty > 1 ? ` x${extra.qty}` : ""}</div>`).join("")}</div><div class="kot-item-qty">${Number(item.qty || 0)}</div></div>`;
  }).join("");
}

function kotSourceLabel(order = {}) {
  if (isManualOrder(order)) return "Manual Order";
  const source = String(order.source || "").toLowerCase();
  if (["customer_qr", "qr_order", "qr-order", "online_customer", "customer"].includes(source)) return "QR Order";
  return "QR Order";
}

function kotLocationLabel(order = {}) {
  return order.businessMode === "vendor" || order.orderMode === "token" ? "Token" : "Table";
}

function kotLocationValue(order = {}) {
  return order.businessMode === "vendor" || order.orderMode === "token"
    ? (order.tokenNo || `T-${order.tokenNumber || "-"}`)
    : (order.tableNo || "-");
}

function kotPrintCss() {
  return `
    body{margin:0;padding:0;background:#fff;}
    .kot-ticket{width:72mm;margin:0 auto;padding:3mm 2mm;box-sizing:border-box;font-family:"Courier New",monospace;color:#000;background:#fff;font-size:13px;line-height:1.35;font-weight:600;}
    .kot-center{text-align:center;}
    .kot-restaurant{font-size:17px;font-weight:800;text-align:center;word-break:break-word;}
    .kot-title{font-size:15px;font-weight:800;text-align:center;letter-spacing:0.5px;}
    .kot-divider{border-top:1px dashed #000;margin:2mm 0;}
    .kot-label-banner{background:#000;color:#fff;text-align:center;padding:2mm;font-weight:800;margin-bottom:2mm;}
    .kot-row{display:flex;justify-content:space-between;gap:2mm;margin:1mm 0;}
    .kot-label{min-width:20mm;}
    .kot-value{text-align:right;flex:1;word-break:break-word;}
    .kot-items-header,.kot-item-row{display:grid;grid-template-columns:1fr 12mm;column-gap:2mm;align-items:start;}
    .kot-items-header{font-weight:800;text-transform:uppercase;}
    .kot-item-row{padding:1mm 0;break-inside:avoid;}
    .kot-item-name{word-break:break-word;overflow-wrap:anywhere;}
    .kot-modifier{padding-top:1mm;padding-left:3mm;font-size:12px;font-weight:600;}
    .kot-item-qty{text-align:right;font-weight:800;}
    .kot-end{text-align:center;font-size:14px;font-weight:800;margin-top:2mm;}
    @media print{
      @page{size:80mm auto;margin:0;}
      html,body{width:80mm;margin:0!important;padding:0!important;background:#fff!important;}
      .kot-ticket{width:72mm;margin:0 auto;padding:3mm 2mm;box-sizing:border-box;font-family:"Courier New",monospace;color:#000;background:#fff;font-size:13px;line-height:1.35;font-weight:600;}
      .kot-center{text-align:center;}
      .kot-restaurant{font-size:17px;font-weight:800;text-align:center;}
      .kot-title{font-size:15px;font-weight:800;text-align:center;letter-spacing:0.5px;}
      .kot-divider{border-top:1px dashed #000;margin:2mm 0;}
      .kot-row{display:flex;justify-content:space-between;gap:2mm;margin:1mm 0;}
      .kot-label{min-width:20mm;}
      .kot-value{text-align:right;flex:1;word-break:break-word;}
      .kot-items-header,.kot-item-row{display:grid;grid-template-columns:1fr 12mm;column-gap:2mm;align-items:start;}
      .kot-item-name{word-break:break-word;overflow-wrap:anywhere;}
      .kot-item-qty{text-align:right;font-weight:800;}
      .kot-end{text-align:center;font-size:14px;font-weight:800;margin-top:2mm;}
      *{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    }
  `;
}

function buildKotPrintHtml(order = {}, items = [], label = "") {
  const now = new Date();
  const restaurantName = restaurantFieldEl?.value.trim() || restaurantSettings.restaurantName || "Restaurant";
  const kotNumber = order.kotNo || order.kotNumber || order.orderId || `KOT${Date.now()}`;
  const rows = thermalKotRows(items);
  const kotType = String(label || "").toUpperCase();
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>KOT</title>
  <style>${kotPrintCss()}</style>
</head>
<body>
  <div class="kot-ticket">
    <div class="kot-restaurant">${escapeHtml(restaurantName)}</div>
    <div class="kot-title">KITCHEN ORDER TICKET</div>
    <div class="kot-divider"></div>
    ${label ? `<div class="kot-label-banner">${escapeHtml(label)}</div><div class="kot-row"><span class="kot-label">KOT Type:</span><span class="kot-value">${escapeHtml(kotType)}</span></div>${kotType.includes("NEW") ? `<div class="kot-center" style="font-weight:800;">Add-on KOT</div>` : ""}<div class="kot-divider"></div>` : ""}
    <div class="kot-row"><span class="kot-label">Order No:</span><span class="kot-value">${escapeHtml(billDisplayOrderNo(order))}</span></div>
    <div class="kot-row"><span class="kot-label">KOT #:</span><span class="kot-value">${escapeHtml(kotNumber)}</span></div>
    <div class="kot-row"><span class="kot-label">${escapeHtml(kotLocationLabel(order))}:</span><span class="kot-value">${escapeHtml(kotLocationValue(order))}</span></div>
    <div class="kot-row"><span class="kot-label">Customer:</span><span class="kot-value">${escapeHtml(order.customerName || "-")}</span></div>
    <div class="kot-row"><span class="kot-label">Source:</span><span class="kot-value">${escapeHtml(kotSourceLabel(order))}</span></div>
    <div class="kot-row"><span class="kot-label">Date:</span><span class="kot-value">${escapeHtml(now.toLocaleDateString())}</span></div>
    <div class="kot-row"><span class="kot-label">Time:</span><span class="kot-value">${escapeHtml(now.toLocaleTimeString())}</span></div>
    <div class="kot-divider"></div>
    <div class="kot-items-header"><span>ITEM</span><span class="kot-item-qty">QTY</span></div>
    <div class="kot-divider"></div>
    ${rows || `<div class="kot-item-row"><span class="kot-item-name">No items</span><span class="kot-item-qty">0</span></div>`}
    <div class="kot-divider"></div>
    <div class="kot-end">--- END OF KOT ---</div>
  </div>
</body>
</html>`;
}

function thermalBillRows(items = []) {
  return items.map(item => {
    const qty = Number(item.qty || 0), price = Number(item.price || 0), extras = printItemExtras(item);
    const parent = `<div class="thermal-item-row"><div class="thermal-item-name">${escapeHtml(itemDisplayName(item))}</div><div class="thermal-item-qty">${qty}</div><div class="thermal-item-amount">${money(price * qty)}</div></div>`;
    const modifierRows = extras.map(extra => `<div class="thermal-item-row thermal-modifier-row"><div class="thermal-item-name">↳ ${escapeHtml(String(extra.name))}</div><div class="thermal-item-qty">${extra.qty}</div><div class="thermal-item-amount">${extra.price ? money(extra.price * extra.qty) : ""}</div></div>`).join("");
    return parent + modifierRows;
  }).join("");
}

function printKOTFromOrder(order, itemsToPrint = null, label = "") {
  const items = itemsToPrint || order.items || [];
  const kotHtml = buildKotPrintHtml(order, items, label);
  const autoClose = restaurantSettings.autoClosePrintWindow !== false;

  const win = window.open("", "_blank", "width=360,height=600");
  if (!win) {
    alert("Allow popups to print KOT.");
    return false;
  }

  win.document.open();
  win.document.write(kotHtml);
  win.document.close();
  win.onafterprint = () => { if (autoClose) win.close(); };
  let printStarted = false;
  const startPrint = () => {
    if (printStarted) return;
    printStarted = true;
    win.focus();
    win.print();
    if (autoClose) setTimeout(() => win.close(), 500);
  };

  win.onload = () => {
    setTimeout(startPrint, 300);
  };

  setTimeout(startPrint, 900);
  return true;
}

async function markManualKotItemsPrinted(itemsToMark = []) {
  const printedLineIds = new Set(itemsToMark.map(item => item.itemLineId).filter(Boolean));
  const printedAt = nowIso();
  manualCart = manualCart.map(item => printedLineIds.has(item.itemLineId)
    ? { ...item, kotPrinted: true, kotPrintedAt: printedAt }
    : item);
  renderManualCart();
  if (!editingOrderDocId) return;
  await updateDoc(doc(db, "orders", editingOrderDocId), {
    items: manualCartPayload(),
    hasNewItems: manualCart.some(item => item.kotPrinted !== true),
    newlyAddedItems: manualCart.filter(item => item.kotPrinted !== true),
    newlyAddedItemsText: manualCart.filter(item => item.kotPrinted !== true).map(i => `${itemDisplayName(i)} x${i.qty}`).join(", "),
    updatedAt: serverTimestamp()
  });
}

async function printManualKotItems(mode = "all") {
  if (!manualCart.length) return alert("No items in current bill.");
  if (!editingOrderDocId) {
    const kotOrder = {
      orderId: editingOrderPublicId || `KOT${Date.now()}`,
      tableNo: manualTableNoEl?.value || "01",
      customerName: manualCustomerNameEl?.value.trim() || "",
      source: "manual_admin",
      isManualOrder: true,
      items: manualCart
    };
    printKOTFromOrder(kotOrder, manualCartPayload(), mode === "new" ? "NEW ITEMS ONLY" : "ALL ITEMS");
    return;
  }

  const itemsToPrint = mode === "new"
    ? manualCart.filter(item => item.kotPrinted !== true)
    : manualCart;
  if (!itemsToPrint.length) return alert("No new items to print for KOT. Use Print All Items if needed.");

  const kotOrder = {
    orderId: editingOrderPublicId || `KOT${Date.now()}`,
    tableNo: manualTableNoEl?.value || "01",
    customerName: manualCustomerNameEl?.value.trim() || "",
    source: "manual_admin",
    isManualOrder: true,
    items: manualCart
  };
  const printed = printKOTFromOrder(kotOrder, itemsToPrint, mode === "new" ? "NEW ITEMS ONLY" : "ALL ITEMS");
  if (!printed) return;
  try {
    await markManualKotItemsPrinted(itemsToPrint);
    setNotice(mode === "new" ? "New item KOT printed." : "All item KOT printed.", "success");
  } catch (error) {
    console.error("markManualKotItemsPrinted error", error);
    alert("KOT printed, but item print status could not be saved: " + error.message);
  }
}

/* =========================================================
   ORDER RENDER
========================================================= */
function getFilteredActiveOrders() {
  return allOrders.filter(o => {
    if (selectedOrderFilter === "all") return true;
    if (selectedOrderFilter === "today") return isOrderToday(o);
    if (selectedOrderFilter === "completed") return isOrderCompleted(o);
    return isOrderActive(o);
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
            <div class="order-id">Order No: ${escapeHtml(billDisplayOrderNo(o))}</div>
            <div class="order-time">Order ID: ${escapeHtml(o.orderId || o.id)}</div>
            <div class="order-time">${escapeHtml(formatDateTime(o.createdAt))}</div>
          </div>
          <div class="order-status ${getStatusClass(o.status)}">${escapeHtml(o.businessMode === "vendor" && String(o.status || "").toLowerCase() === "pending" ? "New" : o.status || "pending")}</div>
        </div>

        <div class="order-customer">
          <div class="customer-avatar">${escapeHtml(String(displayCustomerName(o) || "C").charAt(0).toUpperCase())}</div>
          <div class="customer-details">
            <h4>${escapeHtml(displayCustomerName(o))}</h4>
            <span>${escapeHtml(displayCustomerPhone(o) || "-")}</span>
          </div>
          <div class="table-badge">${o.businessMode === "vendor" || o.orderMode === "token" ? `Token ${escapeHtml(o.tokenNo || `T-${o.tokenNumber || "-"}`)}` : `Table ${escapeHtml(o.tableNo || "-")}`}</div>
        </div>

        <div class="order-items">
          ${(o.items || []).map(item => `
            <div class="order-item">
              <span><span class="qty">${Number(item.qty || 0)}</span>${escapeHtml(itemDisplayName(item))}</span>
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
      const key = itemDisplayName(item);
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
    const orderDate = orderCreatedDate(order);
    if (!orderDate) return false;
    const day = formatDateOnly(orderDate);
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
    const name = itemDisplayName(item);
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
  reportRowsEl.innerHTML = filteredOrders.length ? filteredOrders.map(order => `<tr><td>${escapeHtml(billDisplayOrderNo(order))}</td><td>${escapeHtml(order.orderId || order.id)}</td><td>${escapeHtml(order.businessDate || order.dailyOrderDate || "-")}</td><td>${escapeHtml(order.customerName || "-")}</td><td>${escapeHtml(order.tableNo || "-")}</td><td>${escapeHtml((order.items || []).map(item => `${itemDisplayName(item)} x${item.qty}`).join(", "))}</td><td><span class="status-badge info">${escapeHtml(order.status || "pending")}</span></td><td><span class="status-badge ${String(order.paymentStatus || "").toLowerCase() === "paid" ? "success" : "warning"}">${escapeHtml(order.paymentStatus || "unpaid")}</span></td><td>${money(order.grandTotal || 0)}</td><td><button class="btn btn-sm btn-outline report-edit-btn" data-id="${order.id}">Edit</button></td></tr>`).join("") : `<tr><td colspan="10"><div class="empty-state" style="padding:22px;"><i class="fas fa-inbox"></i><h4>No orders found for selected report period.</h4></div></td></tr>`;
  reportRowsEl.querySelectorAll(".report-edit-btn").forEach(btn => btn.addEventListener("click", () => loadOrderIntoManualBill(btn.dataset.id || "")));
}

function reportLabel() {
  if (selectedReportType === "monthly") return reportMonthEl?.value || "All months";
  if (selectedReportType === "yearly") return reportYearEl?.value || "All years";
  if (selectedReportType === "custom") return `${reportStartDateEl?.value || "Start"} to ${reportEndDateEl?.value || "End"}`;
  return reportDateEl?.value || "All dates";
}

function exportReportCSV(filteredOrders = getFilteredReportOrders()) {
  const rows = [["Order No", "Order ID", "Business Date", "Date", "Customer", "Table", "Items", "Status", "Payment", "Method", "Total"], ...filteredOrders.map(order => [billDisplayOrderNo(order), order.orderId || order.id, order.businessDate || order.dailyOrderDate || "", formatDateOnly(order.createdAt), order.customerName || "", order.tableNo || "", (order.items || []).map(item => `${itemDisplayName(item)} x${item.qty}`).join("; "), order.status || "pending", order.paymentStatus || "unpaid", order.paymentMethod || "", Number(order.grandTotal || 0)])];
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
              <span><span class="qty">${Number(item.qty || 0)}</span>${escapeHtml(itemDisplayName(item))}</span>
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
    .sort((a, b) => tsToMs(orderCreatedDate(b)) - tsToMs(orderCreatedDate(a)));

  const todayOrders = allOrders.filter(isOrderToday);
  const activeOrders = allOrders.filter(isOrderActive);
  const todayActiveOrders = todayOrders.filter(isOrderActive);
  const completedOrders = todayOrders.filter(isOrderCompleted);
  const paidTodayOrders = todayOrders.filter(isOrderCompleted);

  const amountForMethod = matcher => paidTodayOrders
    .filter(order => matcher(normalizedPaymentMethod(order)))
    .reduce((sum, order) => sum + orderAmount(order), 0);
  const todayRevenue = paidTodayOrders.reduce((sum, o) => sum + orderAmount(o), 0);
  const todayCashCollection = amountForMethod(method => method === "cash" || method.includes("cash"));
  const todayUpiCollection = amountForMethod(method => method === "upi" || method.includes("upi"));
  const todayRazorpayCollection = amountForMethod(method => method.includes("razorpay") || method.includes("online") || method.includes("card"));
  const dashboardOrders = todayOrders.length ? todayOrders.slice(0, 5) : activeOrders.slice(0, 5);

  if (todayOrdersEl) todayOrdersEl.textContent = String(todayOrders.length);
  if (pendingOrdersEl) pendingOrdersEl.textContent = String(todayActiveOrders.length);
  if (todayRevenueEl) todayRevenueEl.textContent = money(todayRevenue);
  if (completedOrdersEl) completedOrdersEl.textContent = String(completedOrders.length);
  if (todayCashCollectionEl) todayCashCollectionEl.textContent = money(todayCashCollection);
  if (todayUpiCollectionEl) todayUpiCollectionEl.textContent = money(todayUpiCollection);
  if (todayRazorpayCollectionEl) todayRazorpayCollectionEl.textContent = money(todayRazorpayCollection);
  if (pendingOrdersBadgeEl) pendingOrdersBadgeEl.textContent = String(activeOrders.length);

  renderOrdersList(orderListEl, dashboardOrders);
  if (!dashboardOrders.length && orderListEl) {
    orderListEl.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-inbox"></i>
        <h4>No orders today yet</h4>
        <p>New orders appear here automatically</p>
      </div>
    `;
  }
  renderOrdersList(allOrdersListEl, getFilteredActiveOrders());
  renderBestSelling(todayOrders);
  renderReportRows();
  renderKotSections();
  renderTablesSection();
  markInitialLoadDone();
  devLog("orders snapshot loaded", { restaurantId, count: allOrders.length, today: todayOrders.length, active: activeOrders.length });

  allOrders.filter(order => ["completed", "served"].includes(String(order.status || "").toLowerCase()) && !order.inventoryDeductedAt)
    .forEach(order => deductInventoryForCompletedOrder(order.id));

  handleRealtimeAdminAlerts(activeOrders);
}

/* =========================================================
   REALTIME LOADER
========================================================= */
async function loadOrders() {
  try {
    cleanupFirestoreListeners(ordersUnsubscribe);
    ordersUnsubscribe = null;

    devLog("orders query started", { restaurantId });
    ordersUnsubscribe = onSnapshot(
      query(collection(db, "orders"), where("restaurantId", "==", restaurantId)),
      snap => processOrdersSnapshot(snap),
      err => {
        console.error("orders listener error", err);
        showLoadingNotice("Unable to load data. Please retry.", err);
      }
    );
  } catch (err) {
    console.error("loadOrders error", err);
    showLoadingNotice("Unable to load data. Please retry.", err);
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
itemHasVariantsEl?.addEventListener("change", () => setVariantFieldsEnabled(itemHasVariantsEl.checked === true));
menuSearchEl?.addEventListener("input", renderMenuManagement);
menuFoodTypeFilterEl?.addEventListener("change", renderMenuManagement);
menuPriceFilterEl?.addEventListener("change", renderMenuManagement);
menuMinPriceFilterEl?.addEventListener("input", renderMenuManagement);
menuMaxPriceFilterEl?.addEventListener("input", renderMenuManagement);
menuSortFilterEl?.addEventListener("change", renderMenuManagement);
clearMenuSearchBtn?.addEventListener("click", () => {
  if (menuSearchEl) menuSearchEl.value = "";
  if (menuFoodTypeFilterEl) menuFoodTypeFilterEl.value = "all";
  if (menuPriceFilterEl) menuPriceFilterEl.value = "all";
  if (menuMinPriceFilterEl) menuMinPriceFilterEl.value = "";
  if (menuMaxPriceFilterEl) menuMaxPriceFilterEl.value = "";
  if (menuSortFilterEl) menuSortFilterEl.value = "default";
  renderMenuManagement();
});
tableSearchEl?.addEventListener("input", renderTablesSection);
manualMenuSearchEl?.addEventListener("input", renderManualMenuPicker);
clearManualMenuSearchBtn?.addEventListener("click", () => {
  if (manualMenuSearchEl) manualMenuSearchEl.value = "";
  renderManualMenuPicker();
});
uploadMenuPdfBtn?.addEventListener("click", () => menuPdfInput?.click());
downloadMenuExcelFormatBtn?.addEventListener("click", downloadMenuExcelFormat);
uploadMenuExcelBtn?.addEventListener("click", () => menuExcelInput?.click());
menuImportPreviewBtn?.addEventListener("click", () => {
  if (menuImportItems.length) renderMenuImportReview();
  else if (menuExcelInput?.files?.[0]) menuExcelInput.dispatchEvent(new Event("change"));
  else alert("Upload Excel menu first.");
});
menuExcelInput?.addEventListener("change", async () => {
  const file = menuExcelInput.files?.[0];
  if (!file) return;
  try {
    if (menuImportStatusEl) menuImportStatusEl.textContent = "Reading Excel menu...";
    menuImportItems = await readMenuExcelFile(file);
    menuImportInvalidCount = 0;
    menuImportWarning = "Review valid/invalid rows before confirming import.";
    renderMenuImportReview();
  } catch (error) {
    console.error("Menu Excel import failed", error);
    menuImportItems = []; menuImportInvalidCount = 0; menuImportWarning = ""; renderMenuImportReview();
    alert("Menu import failed. Please check Excel format and try again.");
  }
});
menuPdfInput?.addEventListener("change", async () => {
  const file = menuPdfInput.files?.[0];
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) { menuPdfInput.value = ""; return alert("Please upload a PDF menu file."); }
  try {
    if (menuImportStatusEl) menuImportStatusEl.textContent = "Reading menu PDF…";
    const extracted = await extractMenuPdf(file);
    if (!extracted.items.length) throw new Error("No menu items detected");
    menuImportItems = extracted.items.map(item => normalizeImportedMenuItem({ ...item, foodType: "veg", available: true, hasVariants: false }));
    menuImportInvalidCount = extracted.invalid;
    menuImportWarning = extracted.headings ? "Some items may need review. Please check category, item name and price before import." : "Category headings were not confidently detected. Please review categories before import.";
    renderMenuImportReview();
  } catch (error) {
    console.error("Menu PDF extraction failed", error);
    menuImportItems = []; menuImportInvalidCount = 0; menuImportWarning = ""; renderMenuImportReview();
    alert("PDF is image based and could not be read accurately. Please use Excel menu upload format.");
  }
});
importMenuBtn?.addEventListener("click", importReviewedMenuItems);
cancelMenuImportBtn?.addEventListener("click", () => { menuImportItems = []; menuImportInvalidCount = 0; menuImportWarning = ""; if (menuPdfInput) menuPdfInput.value = ""; if (menuExcelInput) menuExcelInput.value = ""; renderMenuImportReview(); });
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
restaurantLogoUploadEl?.addEventListener("change", async () => {
  restaurantLogoMarkedForRemoval = false;
  const file = restaurantLogoUploadEl.files?.[0];
  if (!file) return;
  try {
    validateLogoFile(file);
    setSaveSettingsProgress("Compressing logo...", true);
    const compressedFile = await compressLogoFile(file);
    selectedRestaurantLogoFile = compressedFile;
    window.scan2plateSelectedRestaurantLogoFile = compressedFile;
    if (restaurantLogoPreviewObjectUrl) URL.revokeObjectURL(restaurantLogoPreviewObjectUrl);
    restaurantLogoPreviewObjectUrl = URL.createObjectURL(compressedFile);
    setLogoPreview(restaurantLogoPreviewObjectUrl);
    console.log("[Settings Save] logo compressed", {
      originalName: file.name || "",
      originalType: file.type || "",
      originalSize: file.size || 0,
      fileName: compressedFile?.name || "",
      fileType: compressedFile?.type || "",
      fileSize: compressedFile?.size || 0
    });
  } catch (error) {
    selectedRestaurantLogoFile = null;
    window.scan2plateSelectedRestaurantLogoFile = null;
    restaurantLogoUploadEl.value = "";
    alert("Logo upload failed: " + (error.message || String(error)));
  } finally {
    setSaveSettingsProgress("Save Settings", false);
  }
});
removeRestaurantLogoBtn?.addEventListener("click", markRestaurantLogoRemoved);

createManualBillBtn?.addEventListener("click", createManualBill);
manualUpiBtn?.addEventListener("click", openManualUpi);
clearCartBtn?.addEventListener("click", resetManualBillForm);

printKotFromBillingBtn?.addEventListener("click", () => {
  if (!manualCart.length) return alert("No items in current bill.");
  fillKotPreviewFromCart(editingOrderPublicId || "");
  kotModal?.classList.add("active");
});
printKotNewItemsBtn?.addEventListener("click", () => printManualKotItems("new"));
printKotAllItemsBtn?.addEventListener("click", () => printManualKotItems("all"));

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
  const kotOrder = {
    orderId: kotNumberEl?.textContent || editingOrderPublicId || `KOT${Date.now()}`,
    tableNo: kotTableEl?.textContent || manualTableNoEl?.value || "01",
    customerName: manualCustomerNameEl?.value.trim() || "",
    source: "manual_admin",
    isManualOrder: true,
    items: manualCart
  };
  printKOTFromOrder(kotOrder, manualCartPayload(), "ALL ITEMS");
});

document.getElementById("printBillBtn")?.addEventListener("click", async () => {
  const win = window.open("", "_blank", "width=380,height=700");
  if (!win) return alert("Allow popup to print.");
  const order = currentBillOrder;
  if (!order) { win.close(); return alert("Bill order is unavailable."); }
  const liveLogo = document.getElementById("billLogo");
  if (liveLogo && liveLogo.style.display !== "none" && liveLogo.src) {
    try {
      await waitForLogoLoad(liveLogo);
    } catch (error) {
      liveLogo.style.display = "none";
      liveLogo.removeAttribute("src");
    }
  }
  const needsQr = Boolean((upiFieldEl?.value.trim() || restaurantSettings.upiId || "").trim()) &&
    (String(order.paymentStatus || "unpaid").toLowerCase() !== "paid" || restaurantSettings.showQrOnPaidBills !== false);
  let qrDataUrl = "";
  try {
    if (needsQr) qrDataUrl = await billQrAsPngDataUrl();
  } catch (error) {
    console.warn("Bill QR could not be embedded for printing", error);
    if (needsQr) {
      win.close();
      alert("UPI QR could not be generated. Bill was not printed with a blank QR. Check internet connection or UPI settings and try again.");
      return;
    }
  }
  win.document.write(buildThermalBillHtml(order, qrDataUrl));
  win.document.close();
  const images = [...win.document.images].filter(img => img.src);
  let imagesReady = true;
  await Promise.all(images.map(img => waitForImageLoad(img, img.classList.contains("bill-logo") ? 2000 : 8000).catch(error => {
    if (img.classList.contains("bill-logo")) img.remove();
    else throw error;
  }))).catch(error => {
    console.warn("Bill print image was not ready", error);
    imagesReady = false;
    win.close();
    alert("Bill image/QR was not ready for printing. Please try again.");
  });
  if (!imagesReady) return;
  setTimeout(() => {
    win.print();
    win.close();
  }, 500);
});

window.fillBillPreview = fillBillPreview;

/* =========================================================
   AI HELP ASSISTANT
========================================================= */
const aiHelpQuickIssues = [
  "QR not opening",
  "Order not showing",
  "KOT print issue",
  "Bill print issue",
  "Logo upload issue",
  "OCR bill scan issue",
  "Dashboard showing zero",
  "WhatsApp message issue",
  "Payment issue",
  "Menu item issue",
  "Table status issue"
];
let aiHelpMessages = [];
let aiHelpDiagnostics = {};
let aiHelpLastAnswer = "";
let aiHelpChatDocId = "";

function injectAiHelpStyles() {
  if (document.getElementById("aiHelpAssistantStyles")) return;
  const style = document.createElement("style");
  style.id = "aiHelpAssistantStyles";
  style.textContent = `
    .ai-help-button{position:fixed;right:22px;bottom:22px;z-index:8000;display:inline-flex;align-items:center;gap:8px;min-height:46px;padding:0 16px;border:0;border-radius:999px;background:#e07c1a;color:#fff;font-weight:900;box-shadow:0 16px 40px rgba(224,124,26,.34);cursor:pointer}
    .ai-help-panel{position:fixed;right:22px;bottom:82px;z-index:8001;display:none;width:380px;height:560px;max-height:calc(100vh - 104px);border:1px solid #eadccf;border-radius:18px;background:#fff;box-shadow:0 28px 80px rgba(15,23,42,.24);overflow:hidden}
    .ai-help-panel.open{display:flex;flex-direction:column}.ai-help-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 15px;background:#fff7ed;border-bottom:1px solid #f2dfca}.ai-help-title{font-weight:900;color:#25170d}.ai-help-close{border:0;background:transparent;font-size:20px;cursor:pointer;color:#7c5b42}.ai-help-diagnostics{padding:9px 14px;border-bottom:1px solid #f2eee8;background:#fffbf7;color:#6b5848;font-size:11px;line-height:1.45}
    .ai-help-messages{flex:1;overflow:auto;padding:14px;background:#f8fafc}.ai-help-bubble{max-width:86%;margin:0 0 10px;padding:10px 12px;border-radius:14px;font-size:13px;line-height:1.45;white-space:pre-wrap}.ai-help-bubble.owner{margin-left:auto;background:#e07c1a;color:#fff;border-bottom-right-radius:4px}.ai-help-bubble.ai{margin-right:auto;background:#fff;color:#1f2937;border:1px solid #e5e7eb;border-bottom-left-radius:4px}.ai-help-quick{display:flex;gap:7px;overflow:auto;padding:9px 12px;border-top:1px solid #eee;background:#fff}.ai-help-quick button{white-space:nowrap;border:1px solid #eadccf;border-radius:999px;background:#fff;padding:7px 10px;color:#604733;font-size:11px;font-weight:800;cursor:pointer}.ai-help-form{display:flex;gap:8px;padding:12px;border-top:1px solid #eee;background:#fff}.ai-help-form input{flex:1;min-width:0;border:1px solid #e3d6ca;border-radius:11px;padding:0 11px;font:inherit}.ai-help-form button,.ai-help-ticket{border:0;border-radius:11px;background:#111827;color:#fff;padding:0 13px;font-weight:900;cursor:pointer}.ai-help-ticket{min-height:38px;margin:0 12px 12px;background:#16a34a}.ai-help-ticket:disabled,.ai-help-form button:disabled{opacity:.6;cursor:not-allowed}
    @media(max-width:640px){.ai-help-button{right:14px;bottom:14px}.ai-help-panel{inset:0;width:auto;height:auto;max-height:none;border-radius:0}.ai-help-panel.open{display:flex}}
  `;
  document.head.appendChild(style);
}

function currentAiPageName() {
  return document.getElementById("pageTitle")?.textContent?.trim() || "Admin Dashboard";
}

function aiDiagnosticText(diag = aiHelpDiagnostics) {
  const backend = diag.backendHealth?.ok ? "Yes" : diag.backendHealth?.ok === false ? "No" : "Not checked";
  const ocr = diag.backendHealth?.ocrKeyConfigured ? "Yes" : diag.backendHealth?.ocrKeyConfigured === false ? "No" : "Not checked";
  return `Backend connected: ${backend}\nRestaurant ID found: ${diag.currentRestaurantIdFound ? "Yes" : "No"}\nInternet: ${diag.browserOnline ? "Online" : "Offline"}\nOCR key configured: ${ocr}`;
}

function localAiHelpFallback(message = "") {
  const text = String(message || "").toLowerCase();
  if (text.includes("kot") || text.includes("print")) return "1. Check printer is connected and selected as default.\n2. Allow browser popups.\n3. Use Browser Print Mode in Settings.\n4. Set 80mm paper and scale 100%.\n5. Try again, then create a support ticket if it still fails.";
  if (text.includes("ocr") || text.includes("scan")) return "1. Test OCR Connection in Settings.\n2. Check Backend URL.\n3. Use a clear bill image/PDF.\n4. If OCR key is missing, add OCR_SPACE_API_KEY on backend.\n5. Create a support ticket with the exact OCR error.";
  if (text.includes("dashboard") || text.includes("zero")) return "1. Dashboard shows today's business data.\n2. Check Daily Order Number Reset Time.\n3. Open Live Orders > All for older orders.\n4. Refresh once.\n5. Create a support ticket if counts remain wrong.";
  if (text.includes("qr")) return "1. Confirm QR has correct restaurantId and table number.\n2. Open link in incognito.\n3. Check restaurant plan/status is active.\n4. Confirm menu items are active.\n5. Create a support ticket with the QR link.";
  return "1. Refresh the page and check internet.\n2. Confirm you are logged in to the correct restaurant.\n3. Check Backend URL in Settings if this uses OCR, WhatsApp, or logo upload.\n4. Try the action again and note the exact error.\n5. Create a support ticket if it continues.";
}

async function collectAiDiagnostics() {
  const diagnostics = {
    backendUrlConfigured: Boolean((backendUrlFieldEl?.value || restaurantSettings.backendUrl || "").trim()),
    currentRestaurantIdFound: Boolean(restaurantId),
    firebaseConnected: Boolean(db),
    browserOnline: navigator.onLine,
    currentPage: currentAiPageName(),
    popupAllowedMaybe: "Unknown",
    localStorageRestaurantId: localStorage.getItem("scan2plate_last_restaurant_id") || "",
    planStatus: restaurantSettings.subscriptionStatus || restaurantSettings.status || currentRestaurantPlan || "",
    timestamp: new Date().toISOString()
  };
  try {
    const backendUrl = purchaseBackendUrl();
    diagnostics.backendHealth = await withTimeout(
      fetch(`${backendUrl}/api/health`, { cache: "no-store" }).then(response => response.json()),
      6000,
      "Backend health check timed out"
    );
  } catch (error) {
    diagnostics.backendHealth = { ok: false, error: error.message || String(error) };
  }
  aiHelpDiagnostics = diagnostics;
  return diagnostics;
}

function renderAiHelpMessages() {
  const list = document.getElementById("aiHelpMessages");
  const diagnosticBox = document.getElementById("aiHelpDiagnostics");
  if (diagnosticBox) diagnosticBox.textContent = aiDiagnosticText();
  if (!list) return;
  list.innerHTML = aiHelpMessages.map(message => `<div class="ai-help-bubble ${message.role === "owner" ? "owner" : "ai"}">${escapeHtml(message.text)}</div>`).join("");
  list.scrollTop = list.scrollHeight;
}

async function saveAiHelpChatHistory() {
  const payload = {
    restaurantId,
    messages: aiHelpMessages.slice(-20),
    updatedAt: serverTimestamp()
  };
  try {
    if (aiHelpChatDocId) await updateDoc(doc(db, "aiHelpChats", aiHelpChatDocId), payload);
    else {
      const created = await addDoc(collection(db, "aiHelpChats"), { ...payload, createdAt: serverTimestamp() });
      aiHelpChatDocId = created.id;
    }
  } catch (error) {
    console.warn("AI help chat history save failed", error);
  }
}

async function askAiHelp(messageText) {
  const text = String(messageText || "").trim();
  if (!text) return;
  const sendBtn = document.getElementById("aiHelpSendBtn");
  const input = document.getElementById("aiHelpInput");
  aiHelpMessages.push({ role: "owner", text, at: new Date().toISOString() });
  aiHelpMessages.push({ role: "ai", text: "AI is checking...", at: new Date().toISOString(), loading: true });
  renderAiHelpMessages();
  if (input) input.value = "";
  if (sendBtn) sendBtn.disabled = true;
  const diagnostics = await collectAiDiagnostics();
  try {
    const backendUrl = purchaseBackendUrl();
    const response = await withTimeout(fetch(`${backendUrl}/api/ai/help`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        restaurantId,
        pageName: currentAiPageName(),
        userMessage: text,
        recentError: diagnostics.backendHealth?.error || "",
        appContext: {
          restaurantId,
          restaurantName: restaurantSettings.restaurantName || restaurantFieldEl?.value || "",
          pageName: currentAiPageName(),
          planType: currentRestaurantPlan,
          backendHealthStatus: diagnostics.backendHealth?.ok === true,
          storageBucketStatus: diagnostics.backendHealth?.storageBucket || "",
          ocrConnected: diagnostics.backendHealth?.ocrKeyConfigured === true,
          lastActionName: "AI Help Assistant"
        },
        diagnostics
      })
    }), 15000, "AI Help request timed out");
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) {
      const error = new Error(result.error || `HTTP ${response.status}`);
      error.dailyLimit = response.status === 429;
      throw error;
    }
    aiHelpMessages = aiHelpMessages.filter(message => !message.loading);
    aiHelpLastAnswer = result.answer || "I could not generate an answer. Please create a support ticket.";
    aiHelpMessages.push({ role: "ai", text: `${aiDiagnosticText(diagnostics)}\n\n${aiHelpLastAnswer}`, at: new Date().toISOString() });
  } catch (error) {
    aiHelpMessages = aiHelpMessages.filter(message => !message.loading);
    aiHelpLastAnswer = error.dailyLimit
      ? "Daily AI help limit reached. Please create support ticket."
      : `AI service is temporarily unavailable. Here is a standard troubleshooting guide.\n\n${localAiHelpFallback(text)}`;
    aiHelpMessages.push({ role: "ai", text: `${aiDiagnosticText(diagnostics)}\n\n${aiHelpLastAnswer}`, at: new Date().toISOString() });
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    renderAiHelpMessages();
    saveAiHelpChatHistory();
  }
}

async function createAiSupportTicket() {
  const button = document.getElementById("aiHelpTicketBtn");
  const problemText = [...aiHelpMessages].reverse().find(message => message.role === "owner")?.text || document.getElementById("aiHelpInput")?.value || "";
  if (!String(problemText).trim()) return alert("Please type the problem first.");
  try {
    if (button) { button.disabled = true; button.textContent = "Creating ticket..."; }
    const diagnostics = Object.keys(aiHelpDiagnostics).length ? aiHelpDiagnostics : await collectAiDiagnostics();
    await addDoc(collection(db, "supportTickets"), {
      restaurantId,
      restaurantName: restaurantSettings.restaurantName || restaurantFieldEl?.value || restaurantId,
      ownerEmail: currentUser.email || currentUser.adminEmail || restaurantSettings.adminEmail || "",
      ownerPhone: restaurantSettings.phone || phoneFieldEl?.value || currentUser.phone || "",
      pageName: currentAiPageName(),
      problemText: String(problemText).trim(),
      aiAnswer: aiHelpLastAnswer || "",
      diagnostics,
      status: "open",
      priority: "normal",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    aiHelpMessages.push({ role: "ai", text: "Support ticket created. Our team will contact you soon.", at: new Date().toISOString() });
    renderAiHelpMessages();
    saveAiHelpChatHistory();
  } catch (error) {
    alert("Could not create support ticket: " + (error.message || error));
  } finally {
    if (button) { button.disabled = false; button.textContent = "Create Support Ticket"; }
  }
}

function mountAiHelpAssistant() {
  if (document.getElementById("aiHelpButton")) return;
  injectAiHelpStyles();
  const root = document.createElement("div");
  root.innerHTML = `
    <button class="ai-help-button" id="aiHelpButton" type="button"><i class="fas fa-comments"></i> AI Help</button>
    <section class="ai-help-panel" id="aiHelpPanel" aria-label="Scan2Plate AI Help Assistant">
      <div class="ai-help-head"><div class="ai-help-title">Scan2Plate AI Help Assistant</div><button class="ai-help-close" id="aiHelpCloseBtn" type="button">×</button></div>
      <div class="ai-help-diagnostics" id="aiHelpDiagnostics">Diagnostics will appear after first question.</div>
      <div class="ai-help-messages" id="aiHelpMessages"></div>
      <div class="ai-help-quick">${aiHelpQuickIssues.map(issue => `<button type="button" data-ai-issue="${escapeHtml(issue)}">${escapeHtml(issue)}</button>`).join("")}</div>
      <form class="ai-help-form" id="aiHelpForm"><input id="aiHelpInput" placeholder="Type your problem..." autocomplete="off" /><button id="aiHelpSendBtn" type="submit">Send</button></form>
      <button class="ai-help-ticket" id="aiHelpTicketBtn" type="button">Create Support Ticket</button>
    </section>
  `;
  document.body.appendChild(root);
  aiHelpMessages = [{ role: "ai", text: "Namaste! Tell me what is not working in Scan2Plate, or choose a quick issue below.", at: new Date().toISOString() }];
  renderAiHelpMessages();
  document.getElementById("aiHelpButton")?.addEventListener("click", async () => {
    document.getElementById("aiHelpPanel")?.classList.toggle("open");
    if (!Object.keys(aiHelpDiagnostics).length) {
      await collectAiDiagnostics();
      renderAiHelpMessages();
    }
  });
  document.getElementById("aiHelpCloseBtn")?.addEventListener("click", () => document.getElementById("aiHelpPanel")?.classList.remove("open"));
  document.getElementById("aiHelpForm")?.addEventListener("submit", event => {
    event.preventDefault();
    askAiHelp(document.getElementById("aiHelpInput")?.value || "");
  });
  document.querySelectorAll("[data-ai-issue]").forEach(button => button.addEventListener("click", () => askAiHelp(button.dataset.aiIssue || "")));
  document.getElementById("aiHelpTicketBtn")?.addEventListener("click", createAiSupportTicket);
}

/* =========================================================
   INIT
========================================================= */
updateUserCard();
mountAiHelpAssistant();
renderTableNumberOptions("01");
bindOrderFilterButtons();
if (reportDateEl && !reportDateEl.value) reportDateEl.value = todayDateStr();
if (reportMonthEl && !reportMonthEl.value) reportMonthEl.value = todayDateStr().slice(0, 7);
if (reportYearEl && !reportYearEl.value) reportYearEl.value = String(new Date().getFullYear());

startInitialLoadTimeout("Admin Dashboard");
try {
  const subscriptionBlocked = await checkRestaurantSubscription();
  setInterval(checkRestaurantSubscription, 5 * 60 * 1000);

  if (!subscriptionBlocked) {
    await loadSettings();
    mountSafeReset({ restaurantId, role: currentUser.role, host: document.getElementById("section-settings"), panelName: "Restaurant Admin", defaultTableReset: true });
    if (["admin", "owner"].includes(String(currentUser.role || "").toLowerCase())) {
      const quickActions = document.querySelector(".quick-actions");
      if (quickActions && !document.getElementById("quickResetDataBtn")) { const button=document.createElement("div"); button.id="quickResetDataBtn"; button.className="quick-action"; button.innerHTML="<i class=\"fas fa-triangle-exclamation\"></i>Reset Data"; button.addEventListener("click",()=>{document.querySelector('.nav-item[data-section="settings"]')?.click(); document.getElementById("safeResetZone")?.scrollIntoView({behavior:"smooth"});}); quickActions.append(button); }
    }
    await loadMenuData();
    startInventoryListeners();
    onSnapshot(
      collection(db, "restaurants", restaurantId, "tables"),
      snap => {
        managedTables = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderTableNumberOptions();
        renderTablesSection();
      },
      error => {
        console.error("tables listener error", error);
        showLoadingNotice("Unable to load data. Please retry.", error);
      }
    );
    renderMenuManagement();
    renderManualMenuPicker();
    renderManualCart();
    await loadOrders();
  } else {
    markInitialLoadDone();
  }
} catch (error) {
  console.error("Admin startup failed", error);
  showLoadingNotice("Unable to load data. Please retry.", error);
}
