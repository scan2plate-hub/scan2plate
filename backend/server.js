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
const corsAllowedOrigins = new Set([
  "https://scan2plate.com",
  "http://localhost:5502",
  "http://127.0.0.1:5502"
]);
app.use(cors({
  origin(origin, callback) {
    if (!origin || corsAllowedOrigins.has(origin) || process.env.CORS_STRICT !== "true") return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  }
}));
app.use(express.json({ limit: "2mb" }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const twilioRequired = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"];
const missing = twilioRequired.filter(key => !process.env[key]);
const twilioEnabled = missing.length === 0;
const client = twilioEnabled ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;
const rawBucket = process.env.FIREBASE_STORAGE_BUCKET || "";
const storageBucketName = rawBucket.replace(/^gs:\/\//, "").trim();
console.log("Firebase Storage bucket:", storageBucketName);

let adminReady = false;
let firebaseAdminError = "FIREBASE_SERVICE_ACCOUNT missing.";
try {
  // FIREBASE_SERVICE_ACCOUNT is the preferred name. Keep the old *_JSON name working for existing deployments.
  const serviceAccountValue = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  const serviceAccount = serviceAccountValue ? JSON.parse(serviceAccountValue) : null;
  if (serviceAccount) initializeApp(getApps().length ? undefined : { credential: cert(serviceAccount), storageBucket: storageBucketName });
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
function ocrKeyDebug() {
  const key = ocrKey();
  return { keyExists: Boolean(key), keyLength: key.length, keyEnding: key ? key.slice(-4) : "" };
}
function ocrErrorPayload(response, result = {}, extra = {}) {
  return {
    error: extra.error || "OCR Space test failed",
    OCRExitCode: result.OCRExitCode,
    IsErroredOnProcessing: result.IsErroredOnProcessing,
    ErrorMessage: result.ErrorMessage,
    httpStatus: response?.status,
    ...extra
  };
}
function ocrFailure(response, result = {}, extra = {}) {
  const detail = Array.isArray(result.ErrorMessage) ? result.ErrorMessage.join(" ") : String(result.ErrorMessage || "");
  let message = detail || "OCR parse failed.";
  if (response.status === 429 || /limit|quota/i.test(detail)) message = "OCR API limit reached. Please try again later.";
  else if (response.status === 401 || /api.?key|invalid key|unauthor/i.test(detail)) message = "OCR API key was rejected by OCR.space.";
  else if (!response.ok) message = "OCR provider is unavailable. Please try again.";
  const error = new Error(message);
  error.status = response.status === 429 ? 429 : 422;
  error.ocr = ocrErrorPayload(response, result, extra);
  return error;
}
function debugOcr(event, data) { if (process.env.NODE_ENV !== "production") console.info(`[OCR] ${event}`, data); }
async function requestOcrSpace(form, endpoint = "https://api.ocr.space/parse/image", extra = {}) {
  let response;
  try { response = await fetch(endpoint, { method: "POST", body: form }); }
  catch { const error = new Error("OCR provider is unreachable. Check backend internet connection."); error.status = 503; throw error; }
  const result = await response.json().catch(() => ({}));
  debugOcr("response", { status: response.status, parsedPages: result.ParsedResults?.length || 0 });
  if (!response.ok || result.IsErroredOnProcessing) throw ocrFailure(response, result, extra);
  return result;
}
function getOcrFileType(file = {}) {
  const mime = String(file.mimetype || "").toLowerCase();
  const name = String(file.originalname || "").toLowerCase();
  if (mime.includes("pdf") || name.endsWith(".pdf")) return "PDF";
  if (mime.includes("png") || name.endsWith(".png")) return "PNG";
  if (mime.includes("webp") || name.endsWith(".webp")) return "WEBP";
  if (mime.includes("jpeg") || mime.includes("jpg") || name.endsWith(".jpg") || name.endsWith(".jpeg")) return "JPG";
  return "JPG";
}
async function testOcrSpaceConnection() {
  const form = new FormData();
  form.append("apikey", ocrKey());
  form.append("url", "https://ocr.space/Content/Images/receipt-ocr-original.jpg");
  form.append("language", "eng");
  form.append("OCREngine", "2");
  form.append("isOverlayRequired", "false");
  form.append("filetype", "JPG");
  await requestOcrSpace(form, "https://api.ocr.space/parse/imageurl");
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
async function findRestaurantDocByBusinessId(restaurantId) {
  const db = getFirestore();
  const directSnap = await db.doc(`restaurants/${restaurantId}`).get();
  if (directSnap.exists) return directSnap;

  const fields = ["restaurantId", "id", "businessId"];
  for (const field of fields) {
    const snap = await db.collection("restaurants").where(field, "==", restaurantId).limit(1).get();
    if (!snap.empty) return snap.docs[0];
  }

  return null;
}

app.get("/", (_, res) => res.send("Scan2Plate backend is running"));
app.get("/health", (_, res) => res.json({ ok: true, twilioEnabled, missing, inventoryBackendReady: adminReady }));
app.get("/api/health", (_, res) => res.json({
  ok: true,
  service: "scan2plate-backend",
  storageBucket: storageBucketName,
  firebaseAdminReady: adminReady,
  time: new Date().toISOString()
}));
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
  if (!ocrKey()) return res.json({ ready: false, connected: false, error: "OCR_SPACE_API_KEY missing", debug: ocrKeyDebug() });
  try {
    await testOcrSpaceConnection();
    res.json({ ready: true, connected: true, service: "OCR.space", message: "OCR Space connected successfully", debug: ocrKeyDebug() });
  } catch (error) {
    res.json({ ready: false, connected: false, ...(error.ocr || { error: "OCR Space test failed", httpStatus: error.status || 502 }), debug: ocrKeyDebug() });
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

app.post("/api/restaurants/:restaurantId/logo", verifyAdmin, (req, res, next) => {
  logoUpload.single("file")(req, res, error => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ ok: false, error: "Logo image must be 1MB or smaller after compression." });
    return res.status(400).json({ ok: false, error: error.message || "Logo upload failed." });
  });
}, async (req, res) => {
  try {
    const restaurantIdParam = String(req.params.restaurantId || "").trim();
    console.info("[Logo Upload]", {
      restaurantId: restaurantIdParam,
      fileMimetype: req.file?.mimetype || "",
      fileSize: req.file?.size || 0
    });
    if (!restaurantIdParam) return res.status(400).json({ ok: false, error: "restaurantId missing" });
    if (!req.file) return res.status(400).json({ ok: false, error: "Logo file is required." });
    if (!String(req.file.mimetype || "").startsWith("image/")) return res.status(415).json({ ok: false, error: "Use an image logo file." });
    if (req.file.size > 1024 * 1024) return res.status(413).json({ ok: false, error: "Logo image must be 1MB or smaller after compression." });
    if (!adminReady) return res.status(503).json({ ok: false, error: "FIREBASE_SERVICE_ACCOUNT missing on backend" });
    if (!storageBucketName) return res.status(503).json({ ok: false, error: "FIREBASE_STORAGE_BUCKET missing on backend" });

    const restaurantSnap = await findRestaurantDocByBusinessId(restaurantIdParam);
    if (!restaurantSnap) return res.status(404).json({ ok: false, error: "Restaurant not found", restaurantId: restaurantIdParam });
    console.info("[Logo Upload] restaurant found", { restaurantId: restaurantIdParam, documentId: restaurantSnap.id });

    const extension = req.file.mimetype === "image/webp" ? "webp" : req.file.mimetype === "image/png" ? "png" : "jpg";
    const storagePath = `restaurants/${restaurantIdParam}/logo/logo-${Date.now()}.${extension}`;
    const bucket = getStorage().bucket(storageBucketName);
    const file = bucket.file(storagePath);
    let token = "";
    try {
      token = crypto.randomUUID();
      await file.save(req.file.buffer, {
        contentType: req.file.mimetype || "image/png",
        metadata: { firebaseStorageDownloadTokens: token }
      });
      token = (await file.getMetadata())[0].metadata.firebaseStorageDownloadTokens || token;
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: "Firebase Storage bucket upload failed",
        bucket: storageBucketName,
        details: error.message || "Storage upload failed"
      });
    }
    const logoUrl = `https://firebasestorage.googleapis.com/v0/b/${storageBucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
    await restaurantSnap.ref.set({
      restaurantLogoUrl: logoUrl,
      restaurantLogoStoragePath: storagePath,
      logoUrl,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ ok: true, restaurantId: restaurantIdParam, logoUrl, storagePath });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Logo upload failed." });
  }
});

async function scanSupplierBill(req, res) {
  try {
    const { restaurantId, ocrText = "" } = req.body || {};
    const uploadedFile = req.file || req.files?.file?.[0] || req.files?.bill?.[0];
    if (!restaurantId || !uploadedFile) return res.status(400).json({ error: "restaurantId and a bill image or PDF are required." });
    if (!allowedMimeTypes.has(uploadedFile.mimetype)) return res.status(415).json({ error: "Use a JPG, PNG, WEBP, or PDF bill." });
    await assertRestaurantAccess(req.user.uid, restaurantId);
    let text = ocrText;
    if (!text && !ocrKey()) return res.status(503).json({ error: missingOcrKeyMessage() });
    if (!text) {
      const filetype = getOcrFileType(uploadedFile);
      debugOcr("scan", { endpoint: "https://api.ocr.space/parse/image", fileName: uploadedFile.originalname, fileSize: uploadedFile.size, mimeType: uploadedFile.mimetype, filetype });
      const form = new FormData();
      form.append("apikey", ocrKey());
      form.append("language", "eng");
      form.append("isOverlayRequired", "false");
      form.append("detectOrientation", "true");
      form.append("scale", "true");
      form.append("OCREngine", "2");
      form.append("isTable", "true");
      form.append("filetype", filetype);
      form.append("file", new Blob([uploadedFile.buffer], { type: uploadedFile.mimetype || "image/jpeg" }), uploadedFile.originalname || "supplier_bill.jpg");
      const result = await requestOcrSpace(form, "https://api.ocr.space/parse/image", { filetype, filename: uploadedFile.originalname, mimetype: uploadedFile.mimetype });
      text = (result.ParsedResults || []).map(row => row.ParsedText || "").join("\n");
    }
    if (!String(text).trim()) return res.status(422).json({ error: "OCR returned empty text. The bill may be too small, blurred, rotated, or unreadable." });
    let fileUrl = "";
    if (process.env.FIREBASE_STORAGE_BUCKET) {
      const objectName = `purchase-bills/${restaurantId}/${Date.now()}-${uploadedFile.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const file = getStorage().bucket(process.env.FIREBASE_STORAGE_BUCKET).file(objectName);
      await file.save(uploadedFile.buffer, { contentType: uploadedFile.mimetype, metadata: { firebaseStorageDownloadTokens: crypto.randomUUID() } });
      const token = (await file.getMetadata())[0].metadata.firebaseStorageDownloadTokens;
      fileUrl = `https://firebasestorage.googleapis.com/v0/b/${process.env.FIREBASE_STORAGE_BUCKET}/o/${encodeURIComponent(objectName)}?alt=media&token=${token}`;
    }
    const parsed = parseBillText(text);
    debugOcr("parsed", { rawTextLength: text.length, parsedItemCount: parsed.items.length, parseWarnings: parsed.parseWarnings.length });
    res.json({ file: { name: uploadedFile.originalname, mimeType: uploadedFile.mimetype, size: uploadedFile.size, fileUrl }, ...parsed, billNo: parsed.billNumber, date: parsed.billDate, total: parsed.grandTotal, ocrConfigured: true });
  } catch (error) { res.status(error.status || 422).json({ ...(error.ocr || {}), error: error.message || error.ocr?.error || "OCR parse failed." }); }
}
const uploadPurchaseBill = upload.fields([{ name: "file", maxCount: 1 }, { name: "bill", maxCount: 1 }]);
app.post("/api/ocr/scan", verifyAdmin, uploadPurchaseBill, scanSupplierBill);
// Keep this endpoint for already-deployed panels while all current panels use /api/ocr/scan.
app.post("/api/inventory/upload-bill", verifyAdmin, uploadPurchaseBill, scanSupplierBill);

async function saveReviewedPurchase(req, res) {
  try {
    const { restaurantId, supplierName = "", billNumber = "", billDate = "", taxAmount, gstTax, grandTotal, total, fileUrl = "", inventoryCollection = "inventory", items = [] } = req.body || {};
    if (!restaurantId) return res.status(400).json({ ok: false, error: "restaurantId is required." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: "items must have at least 1 valid item." });
    await assertRestaurantAccess(req.user.uid, restaurantId);
    const safeInventoryCollection = inventoryCollection === "inventory_items" ? "inventory_items" : "inventory";
    const db = getFirestore();
    const preparedMap = new Map();

    for (const raw of items) {
      const itemName = String(raw.itemName || "").trim();
      const quantityRaw = Number(raw.quantity || 0);
      if (!itemName) throw new Error("itemName required for every reviewed item.");
      if (!Number.isFinite(quantityRaw) || quantityRaw <= 0) throw new Error(`quantity must be number > 0 for ${itemName}.`);
      const normalized = normalizeUnit(quantityRaw, raw.unit);
      const rate = Number(raw.rate ?? raw.unitPrice ?? 0);
      const amountRaw = Number(raw.amount ?? raw.totalPrice ?? 0);
      const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : Number(normalized.quantity) * (Number.isFinite(rate) ? rate : 0);
      const key = `${normalizedName(itemName)}__${normalized.unit}`;
      const existing = preparedMap.get(key);
      const item = {
        itemName,
        normalizedName: normalizedName(itemName),
        quantity: Number(normalized.quantity),
        unit: normalized.unit,
        rate: Number.isFinite(rate) ? rate : 0,
        amount: Number.isFinite(amount) ? amount : 0,
        category: String(raw.category || "").trim(),
        supplierName: String(raw.supplierName || supplierName || "").trim()
      };
      if (existing) {
        existing.quantity += item.quantity;
        existing.amount += item.amount;
        existing.rate = item.rate || existing.rate;
      } else {
        preparedMap.set(key, item);
      }
    }

    const prepared = [...preparedMap.values()].filter(item => item.itemName && item.quantity > 0);
    if (!prepared.length) return res.status(400).json({ ok: false, error: "items must have at least 1 valid item." });

    const inventoryPath = `restaurants/${restaurantId}/${safeInventoryCollection}`;
    const matches = await Promise.all(prepared.map(async item => {
      let existing = await db.collection(inventoryPath).where("normalizedName", "==", item.normalizedName).where("unit", "==", item.unit).limit(1).get();
      if (existing.empty) {
        const sameName = await db.collection(inventoryPath).where("itemName", "==", item.itemName).limit(10).get();
        const sameUnit = sameName.docs.find(candidate => normalizeUnit(1, candidate.data().unit).unit === item.unit);
        existing = sameUnit ? { empty: false, docs: [sameUnit] } : { empty: true, docs: [] };
      }
      return { item, inventoryRef: existing.empty ? db.collection(inventoryPath).doc() : existing.docs[0].ref };
    }));

    const billRef = db.collection(`restaurants/${restaurantId}/purchase_bills`).doc();
    const publicBillRef = db.collection("inventoryPurchases").doc(billRef.id);
    const subtotal = prepared.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const taxValue = Number(gstTax ?? taxAmount ?? 0);
    const totalValue = Number(grandTotal ?? total ?? (subtotal + taxValue));

    await db.runTransaction(async transaction => {
      const freshSnaps = await Promise.all(matches.map(({ inventoryRef }) => transaction.get(inventoryRef)));
      for (let index = 0; index < matches.length; index++) {
        const { item, inventoryRef } = matches[index];
        const old = freshSnaps[index].exists ? freshSnaps[index].data() : {};
        const movement = {
          restaurantId,
          inventoryItemId: inventoryRef.id,
          itemName: item.itemName,
          type: "stock_in",
          quantity: Number(item.quantity),
          unit: item.unit,
          rate: Number(item.rate || 0),
          amount: Number(item.amount || 0),
          source: "purchase_bill_ocr",
          purchaseBillId: billRef.id,
          reason: "Purchase bill",
          createdAt: FieldValue.serverTimestamp(),
          createdBy: req.user.email || req.user.uid
        };
        transaction.set(inventoryRef, { restaurantId, itemName: item.itemName, normalizedName: item.normalizedName, currentStock: Number(old.currentStock || 0) + Number(item.quantity), unit: item.unit, category: item.category || old.category || "", lastPurchaseRate: Number(item.rate || 0), lastPurchasePrice: Number(item.rate || 0), purchasePrice: Number(item.rate || 0), supplierName: item.supplierName || supplierName || old.supplierName || "", lowStockLimit: Number(old.lowStockLimit || old.minStockAlert || 0), minStockAlert: Number(old.minStockAlert || 0), updatedAt: FieldValue.serverTimestamp(), lastUpdated: FieldValue.serverTimestamp() }, { merge: true });
        transaction.set(db.collection(`restaurants/${restaurantId}/inventory_logs`).doc(), movement);
        transaction.set(db.collection("stockMovements").doc(), movement);
        transaction.set(billRef.collection("purchase_bill_items").doc(), { billId: billRef.id, inventoryItemId: inventoryRef.id, itemName: item.itemName, quantity: Number(item.quantity), unit: item.unit, rate: Number(item.rate || 0), amount: Number(item.amount || 0), unitPrice: Number(item.rate || 0), totalPrice: Number(item.amount || 0) });
      }
      const billPayload = { restaurantId, supplierName, billNumber, billDate, gstTax: taxValue, taxAmount: taxValue, items: prepared, subtotal, total: totalValue, grandTotal: totalValue, source: "ocr", fileUrl, uploadedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), uploadedBy: req.user.email || req.user.uid, status: "saved" };
      transaction.set(billRef, billPayload);
      transaction.set(publicBillRef, billPayload);
    });
    res.json({ ok: true, success: true, message: "Purchase saved and inventory updated", purchaseBillId: billRef.id, billId: billRef.id, itemsSaved: prepared.length });
  } catch (error) { res.status(400).json({ ok: false, error: error.message || "Could not save purchase." }); }
}

app.post("/api/inventory/save-purchase", verifyAdmin, saveReviewedPurchase);
app.post("/api/inventory/purchase-review/save", verifyAdmin, saveReviewedPurchase);

app.listen(process.env.PORT || 5000, () => console.log(`Scan2Plate backend running on port ${process.env.PORT || 5000}`));
