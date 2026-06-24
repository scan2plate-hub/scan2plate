import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import twilio from "twilio";
import multer from "multer";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const twilioRequired = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"];
const missing = twilioRequired.filter(key => !process.env[key]);
const twilioEnabled = missing.length === 0;
const client = twilioEnabled ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

let adminReady = false;
let firebaseAdminError = "FIREBASE_SERVICE_ACCOUNT missing.";
try {
  // FIREBASE_SERVICE_ACCOUNT is the preferred name. Keep the old *_JSON name working for existing deployments.
  const serviceAccountValue = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  const serviceAccount = serviceAccountValue ? JSON.parse(serviceAccountValue) : null;
  if (serviceAccount) initializeApp(getApps().length ? undefined : { credential: cert(serviceAccount) });
  else if (getApps().length === 0 && (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_CLOUD_PROJECT || process.env.K_SERVICE || process.env.FUNCTION_TARGET)) initializeApp();
  adminReady = getApps().length > 0;
  if (!adminReady) firebaseAdminError = "FIREBASE_SERVICE_ACCOUNT missing.";
} catch (error) { console.error("Firebase Admin setup failed:", error.message); firebaseAdminError = "FIREBASE_SERVICE_ACCOUNT missing."; }

function sanitizePhone(phone) {
  if (!phone) return "";
  const raw = String(phone).trim();
  if (raw.startsWith("whatsapp:")) return raw;
  const clean = raw.replace(/[^\d+]/g, "");
  return clean ? `whatsapp:${clean}` : "";
}
async function sendMessage(to, body) {
  if (!twilioEnabled) return { skipped: true, reason: `Missing env: ${missing.join(", ")}` };
  if (!to) return { skipped: true, reason: "Missing recipient" };
  const message = await client.messages.create({ from: process.env.TWILIO_WHATSAPP_FROM, to: sanitizePhone(to), body });
  return { sid: message.sid };
}
function normalizedName(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function normalizeUnit(quantity, rawUnit) {
  const unit = String(rawUnit || "pcs").toLowerCase().replace(/\./g, "");
  const qty = Number(quantity || 0);
  if (["g", "gm", "gram", "grams"].includes(unit)) return { quantity: qty / 1000, unit: "kg" };
  if (["kg", "kgs", "kilogram", "kilograms"].includes(unit)) return { quantity: qty, unit: "kg" };
  if (["ml", "millilitre", "milliliter"].includes(unit)) return { quantity: qty / 1000, unit: "litre" };
  if (["l", "lt", "ltr", "litre", "liter", "litres", "liters"].includes(unit)) return { quantity: qty, unit: "litre" };
  if (["packet", "packets", "pkt"].includes(unit)) return { quantity: qty, unit: "packet" };
  if (["box", "boxes"].includes(unit)) return { quantity: qty, unit: "box" };
  if (["bottle", "bottles"].includes(unit)) return { quantity: qty, unit: "bottle" };
  return { quantity: qty, unit: "pcs" };
}

function ocrKey() { return String(process.env.OCR_SPACE_API_KEY || "").trim(); }
function missingOcrKeyMessage() { return "OCR_SPACE_API_KEY missing. Add it in backend environment variables."; }
function ocrFailure(response, result = {}) {
  const detail = Array.isArray(result.ErrorMessage) ? result.ErrorMessage.join(" ") : String(result.ErrorMessage || "");
  let message = detail || "OCR parse failed.";
  if (response.status === 429 || /limit|quota/i.test(detail)) message = "OCR API limit reached. Please try again later.";
  else if (response.status === 401 || /api.?key|invalid key|unauthor/i.test(detail)) message = "OCR API key was rejected by OCR.space.";
  else if (!response.ok) message = "OCR provider is unavailable. Please try again.";
  const error = new Error(message); error.status = response.status === 429 ? 429 : 422; return error;
}
function debugOcr(event, data) { if (process.env.NODE_ENV !== "production") console.info(`[OCR] ${event}`, data); }
async function requestOcrSpace(form) {
  let response;
  try { response = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: form }); }
  catch { const error = new Error("OCR provider is unreachable. Check backend internet connection."); error.status = 503; throw error; }
  const result = await response.json().catch(() => ({}));
  debugOcr("response", { status: response.status, parsedPages: result.ParsedResults?.length || 0 });
  if (!response.ok || result.IsErroredOnProcessing) throw ocrFailure(response, result);
  return result;
}
async function testOcrSpaceConnection() {
  // A tiny in-memory image checks both the configured key and the provider without exposing the key.
  const form = new FormData();
  form.append("apikey", ocrKey());
  form.append("language", "eng");
  form.append("base64Image", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9VwAAAABJRU5ErkJggg==");
  await requestOcrSpace(form);
}

function asIsoDate(value = "") {
  const match = String(value).match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (!match) return "";
  const [, day, month, year] = match;
  const fullYear = year.length === 2 ? `20${year}` : year;
  const date = new Date(`${fullYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : `${fullYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

// Conservative parser: it only suggests rows; the UI always requires human review before saving.
function parseBillText(text = "") {
  const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const supplierName = lines.find(line => !/^(tax invoice|invoice|bill|gstin|phone|mobile|address)/i.test(line)) || lines[0] || "";
  const billDate = asIsoDate((text.match(/\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/) || [])[1] || "");
  const billNumber = (text.match(/(?:invoice|bill)\s*(?:no\.?|number|#)\s*[:#-]?\s*([a-z0-9/-]+)/i) || [])[1] || "";
  const taxMatch = text.match(/(?:gst|tax|cgst|sgst|igst)\D{0,12}(\d+(?:\.\d{1,2})?)/i);
  const grandTotalMatch = text.match(/\b(?:grand\s*total|net\s*amount|total)\b\D{0,12}(\d+(?:\.\d{1,2})?)/i);
  const items = lines.map(rawLine => {
    const line = rawLine.replace(/[|]/g, " ").replace(/\s+/g, " ").replace(/^\d+\s+(?:[.)-]\s*)?(?=[A-Za-z])/, "").trim();
    const match = line.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(kg|kgs?|gm|g|ml|l|ltr|litre|litres|pcs?|piece|packet|pkt|box|bottles?)?\s+(?:@\s*)?(\d+(?:\.\d{1,2})?)\s+(\d+(?:\.\d{1,2})?)$/i);
    if (match) {
      const normalized = normalizeUnit(match[2], match[3]);
      return { itemName: match[1].trim(), quantity: normalized.quantity, unit: normalized.unit, unitPrice: Number(match[4]), totalPrice: Number(match[5]), category: "", supplierName, billDate };
    }
    // Handles bills that print pack size followed by a quantity, e.g. "Amul Ghee 500ml Qty 1".
    const pack = line.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(kg|kgs?|gm|g|ml|l|litre|litres)\s*(?:x|qty)?\s*(\d+(?:\.\d+)?)?$/i);
    if (!pack) return null;
    const normalized = normalizeUnit(Number(pack[2]) * Number(pack[4] || 1), pack[3]);
    return { itemName: pack[1].trim(), quantity: normalized.quantity, unit: normalized.unit, unitPrice: 0, totalPrice: 0, category: "", supplierName, billDate };
  }).filter(Boolean);
  const reviewItems = items.map(item => ({ ...item, rate: item.unitPrice, amount: item.totalPrice }));
  const parseWarnings = reviewItems.length ? [] : ["OCR text was received, but no item rows matched. Edit the raw text and try parsing again, or enter rows manually."];
  return { supplierName, billNumber, billDate, taxAmount: Number(taxMatch?.[1] || 0), grandTotal: Number(grandTotalMatch?.[1] || 0), items: reviewItems, rawText: text, parseWarnings };
}
async function verifyAdmin(req, res, next) {
  if (!adminReady) return res.status(503).json({ error: firebaseAdminError });
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) throw new Error("Missing bearer token");
    req.user = await getAuth().verifyIdToken(token);
    next();
  } catch { res.status(401).json({ error: "Admin authentication required." }); }
}
async function assertRestaurantAccess(uid, restaurantId) {
  const db = getFirestore();
  const restaurant = await db.doc(`restaurants/${restaurantId}`).get();
  if (!restaurant.exists || restaurant.data().adminUid !== uid) {
    const memberships = await db.collection(`restaurants/${restaurantId}/users`).where("uid", "==", uid).limit(1).get();
    if (memberships.empty || !["admin", "owner"].includes(String(memberships.docs[0].data().role || "").toLowerCase())) throw new Error("Not permitted for this restaurant.");
  }
}

app.get("/health", (_, res) => res.json({ ok: true, twilioEnabled, missing, inventoryBackendReady: adminReady }));
app.get("/api/ocr/status", (_, res) => {
  const ocrConfigured = Boolean(ocrKey());
  const ready = adminReady && ocrConfigured;
  res.status(ready ? 200 : 503).json({
    ok: ready,
    endpointReachable: true,
    validResponse: true,
    status: ready ? "ready" : "unavailable",
    ocrConfigured,
    reason: !adminReady
      ? firebaseAdminError
      : !ocrConfigured
        ? missingOcrKeyMessage()
        : ""
  });
});
app.get("/api/ocr/test", async (_, res) => {
  if (!ocrKey()) return res.status(503).json({ connected: false, error: missingOcrKeyMessage() });
  if (!adminReady) return res.status(503).json({ connected: false, error: firebaseAdminError });
  try {
    await testOcrSpaceConnection();
    res.json({ connected: true });
  } catch (error) {
    res.status(502).json({ connected: false, error: "OCR Space API could not be reached or rejected the configured key." });
  }
});
app.post("/api/ocr/parse", verifyAdmin, express.json({ limit: "1mb" }), async (req, res) => {
  const { restaurantId, rawText = "" } = req.body || {};
  try {
    if (!restaurantId) return res.status(400).json({ error: "restaurantId is required." });
    await assertRestaurantAccess(req.user.uid, restaurantId);
    if (!String(rawText).trim()) return res.status(422).json({ error: "Raw OCR text is empty." });
    const parsed = parseBillText(rawText);
    debugOcr("parse", { rawTextLength: rawText.length, parsedItemCount: parsed.items.length, parseWarnings: parsed.parseWarnings.length });
    res.json({ ...parsed, billNo: parsed.billNumber, date: parsed.billDate, total: parsed.grandTotal });
  } catch (error) { res.status(422).json({ error: error.message || "OCR parse failed." }); }
});
app.post("/notify-order", async (req, res) => {
  try {
    const { customerPhone, customerName, kitchenPhone, orderId, tableNo, tokenNumber, items, grandTotal, status, etaMinutes, restaurantName, billUrl } = req.body || {};
    const itemLine = Array.isArray(items) ? items.map(item => `${item.name} x ${item.qty}`).join(", ") : "";
    const location = tokenNumber ? `Token: #${tokenNumber}` : `Table: ${tableNo || "-"}`;
    const body = ["🍽️ Order Update", restaurantName && `Restaurant: ${restaurantName}`, `Order: ${orderId || "-"}`, location, `Customer: ${customerName || "Guest"}`, itemLine && `Items: ${itemLine}`, grandTotal != null && `Total: ₹${Number(grandTotal).toFixed(2)}`, etaMinutes != null && `ETA: ${etaMinutes} min`, billUrl && `Bill: ${billUrl}`].filter(Boolean).join("\n");
    res.json({ success: true, results: { kitchen: await sendMessage(kitchenPhone, body), customer: await sendMessage(customerPhone, body) } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

async function scanSupplierBill(req, res) {
  try {
    const { restaurantId, ocrText = "" } = req.body || {};
    if (!restaurantId || !req.file) return res.status(400).json({ error: "restaurantId and a bill image or PDF are required." });
    if (!allowedMimeTypes.has(req.file.mimetype)) return res.status(415).json({ error: "Use a JPG, PNG, WEBP, or PDF bill." });
    await assertRestaurantAccess(req.user.uid, restaurantId);
    let text = ocrText;
    if (!text && !ocrKey()) return res.status(503).json({ error: missingOcrKeyMessage() });
    if (!text) {
      debugOcr("scan", { endpoint: "https://api.ocr.space/parse/image", fileName: req.file.originalname, fileSize: req.file.size, mimeType: req.file.mimetype });
      const form = new FormData();
      form.append("apikey", ocrKey());
      form.append("language", "eng");
      form.append("isOverlayRequired", "false");
      form.append("detectOrientation", "true");
      form.append("scale", "true");
      form.append("OCREngine", "2");
      form.append("isTable", "true");
      if (req.file.mimetype === "application/pdf") form.append("filetype", "PDF");
      form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
      const result = await requestOcrSpace(form);
      text = (result.ParsedResults || []).map(row => row.ParsedText || "").join("\n");
    }
    if (!String(text).trim()) return res.status(422).json({ error: "OCR returned empty text. The bill may be too small, blurred, rotated, or unreadable." });
    let fileUrl = "";
    if (process.env.FIREBASE_STORAGE_BUCKET) {
      const objectName = `purchase-bills/${restaurantId}/${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const file = getStorage().bucket(process.env.FIREBASE_STORAGE_BUCKET).file(objectName);
      await file.save(req.file.buffer, { contentType: req.file.mimetype, metadata: { firebaseStorageDownloadTokens: crypto.randomUUID() } });
      const token = (await file.getMetadata())[0].metadata.firebaseStorageDownloadTokens;
      fileUrl = `https://firebasestorage.googleapis.com/v0/b/${process.env.FIREBASE_STORAGE_BUCKET}/o/${encodeURIComponent(objectName)}?alt=media&token=${token}`;
    }
    const parsed = parseBillText(text);
    debugOcr("parsed", { rawTextLength: text.length, parsedItemCount: parsed.items.length, parseWarnings: parsed.parseWarnings.length });
    res.json({ file: { name: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, fileUrl }, ...parsed, billNo: parsed.billNumber, date: parsed.billDate, total: parsed.grandTotal, ocrConfigured: true });
  } catch (error) { res.status(error.status || 422).json({ error: error.message || "OCR parse failed." }); }
}
app.post("/api/ocr/scan", verifyAdmin, upload.single("bill"), scanSupplierBill);
// Keep this endpoint for already-deployed panels while all current panels use /api/ocr/scan.
app.post("/api/inventory/upload-bill", verifyAdmin, upload.single("bill"), scanSupplierBill);

app.post("/api/inventory/save-purchase", verifyAdmin, async (req, res) => {
  try {
    const { restaurantId, supplierName = "", billNumber = "", billDate = "", taxAmount = 0, grandTotal = 0, fileUrl = "", inventoryCollection = "inventory", items = [] } = req.body || {};
    if (!restaurantId || !Array.isArray(items) || !items.length) return res.status(400).json({ error: "restaurantId and reviewed purchase items are required." });
    await assertRestaurantAccess(req.user.uid, restaurantId);
    const safeInventoryCollection = inventoryCollection === "inventory_items" ? "inventory_items" : "inventory";
    const db = getFirestore(); const billRef = db.collection(`restaurants/${restaurantId}/purchase_bills`).doc();
    await db.runTransaction(async transaction => {
      const prepared = items.map(item => ({ ...item, ...normalizeUnit(item.quantity, item.unit), itemName: String(item.itemName || "").trim(), normalizedName: normalizedName(item.itemName) })).filter(item => item.itemName && item.quantity > 0);
      if (!prepared.length) throw new Error("Add at least one valid reviewed item.");
      for (const item of prepared) {
        const inventoryPath = `restaurants/${restaurantId}/${safeInventoryCollection}`;
        let existing = await db.collection(inventoryPath).where("normalizedName", "==", item.normalizedName).where("unit", "==", item.unit).limit(1).get();
        // Older manually-created inventory rows did not have normalizedName.
        if (existing.empty) {
          const sameName = await db.collection(inventoryPath).where("itemName", "==", item.itemName).limit(10).get();
          const sameUnit = sameName.docs.find(candidate => normalizeUnit(1, candidate.data().unit).unit === item.unit);
          existing = sameUnit ? { empty: false, docs: [sameUnit] } : sameName;
          if (!sameUnit) existing = { empty: true, docs: [] };
        }
        const inventoryRef = existing.empty ? db.collection(inventoryPath).doc() : existing.docs[0].ref;
        const old = existing.empty ? {} : existing.docs[0].data();
        transaction.set(inventoryRef, { restaurantId, itemName: item.itemName, normalizedName: item.normalizedName, currentStock: Number(old.currentStock || 0) + Number(item.quantity), unit: item.unit, category: item.category || old.category || "", lastPurchasePrice: Number(item.unitPrice || 0), purchasePrice: Number(item.unitPrice || 0), supplierName: item.supplierName || supplierName || old.supplierName || "", lowStockLimit: Number(old.lowStockLimit || old.minStockAlert || 0), minStockAlert: Number(old.minStockAlert || 0), updatedAt: FieldValue.serverTimestamp(), lastUpdated: FieldValue.serverTimestamp() }, { merge: true });
        transaction.set(db.collection(`restaurants/${restaurantId}/inventory_logs`).doc(), { inventoryItemId: inventoryRef.id, itemName: item.itemName, type: "stock_in", quantity: Number(item.quantity), unit: item.unit, reason: "Purchase bill", billId: billRef.id, createdAt: FieldValue.serverTimestamp(), createdBy: req.user.email || req.user.uid });
        transaction.set(billRef.collection("purchase_bill_items").doc(), { billId: billRef.id, inventoryItemId: inventoryRef.id, itemName: item.itemName, quantity: Number(item.quantity), unit: item.unit, unitPrice: Number(item.unitPrice || 0), totalPrice: Number(item.totalPrice || 0) });
      }
      transaction.set(billRef, { restaurantId, supplierName, billNumber, billDate, taxAmount: Number(taxAmount || 0), grandTotal: Number(grandTotal || 0), fileUrl, uploadedAt: FieldValue.serverTimestamp(), uploadedBy: req.user.email || req.user.uid, status: "saved" });
    });
    res.json({ success: true, billId: billRef.id });
  } catch (error) { res.status(400).json({ error: error.message || "Could not save purchase." }); }
});

app.listen(process.env.PORT || 5000, () => console.log(`Scan2Plate backend running on port ${process.env.PORT || 5000}`));
