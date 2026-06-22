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
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "application/pdf"]);
const twilioRequired = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"];
const missing = twilioRequired.filter(key => !process.env[key]);
const twilioEnabled = missing.length === 0;
const client = twilioEnabled ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

let adminReady = false;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) : null;
  if (serviceAccount) initializeApp(getApps().length ? undefined : { credential: cert(serviceAccount) });
  else if (getApps().length === 0 && process.env.GOOGLE_APPLICATION_CREDENTIALS) initializeApp();
  adminReady = getApps().length > 0;
} catch (error) { console.error("Firebase Admin setup failed:", error.message); }

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
  if (["l", "lt", "litre", "liter", "litres", "liters"].includes(unit)) return { quantity: qty, unit: "litre" };
  if (["packet", "packets", "pkt"].includes(unit)) return { quantity: qty, unit: "packet" };
  if (["box", "boxes"].includes(unit)) return { quantity: qty, unit: "box" };
  return { quantity: qty, unit: "pcs" };
}

// Conservative parser: it only suggests rows; the UI always requires human review before saving.
function parseBillText(text = "") {
  const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const supplierName = lines[0] || "";
  const billDate = (text.match(/\b(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/) || [])[1] || "";
  const grandTotalMatch = text.match(/(?:grand\s*total|net\s*amount|total)\D{0,12}(\d+(?:\.\d{1,2})?)/i);
  const items = lines.map(line => {
    const match = line.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(kg|kgs?|gm|g|ml|l|litre|litres|pcs?|piece|packet|pkt|box)?\s+(\d+(?:\.\d{1,2})?)\s+(\d+(?:\.\d{1,2})?)$/i);
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
  return { supplierName, billDate, grandTotal: Number(grandTotalMatch?.[1] || 0), items, rawText: text };
}
async function verifyAdmin(req, res, next) {
  if (!adminReady) return res.status(503).json({ error: "Inventory backend is not configured with Firebase Admin credentials." });
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
app.post("/notify-order", async (req, res) => {
  try {
    const { customerPhone, customerName, kitchenPhone, orderId, tableNo, tokenNumber, items, grandTotal, status, etaMinutes, restaurantName, billUrl } = req.body || {};
    const itemLine = Array.isArray(items) ? items.map(item => `${item.name} x ${item.qty}`).join(", ") : "";
    const location = tokenNumber ? `Token: #${tokenNumber}` : `Table: ${tableNo || "-"}`;
    const body = ["🍽️ Order Update", restaurantName && `Restaurant: ${restaurantName}`, `Order: ${orderId || "-"}`, location, `Customer: ${customerName || "Guest"}`, itemLine && `Items: ${itemLine}`, grandTotal != null && `Total: ₹${Number(grandTotal).toFixed(2)}`, etaMinutes != null && `ETA: ${etaMinutes} min`, billUrl && `Bill: ${billUrl}`].filter(Boolean).join("\n");
    res.json({ success: true, results: { kitchen: await sendMessage(kitchenPhone, body), customer: await sendMessage(customerPhone, body) } });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post("/api/inventory/upload-bill", verifyAdmin, upload.single("bill"), async (req, res) => {
  try {
    const { restaurantId, ocrText = "" } = req.body || {};
    if (!restaurantId || !req.file) return res.status(400).json({ error: "restaurantId and a bill image or PDF are required." });
    if (!allowedMimeTypes.has(req.file.mimetype)) return res.status(415).json({ error: "Use a JPG, PNG, JPEG, or PDF bill." });
    await assertRestaurantAccess(req.user.uid, restaurantId);
    let text = ocrText;
    if (!text && process.env.OCR_SPACE_API_KEY) {
      const form = new FormData();
      form.append("apikey", process.env.OCR_SPACE_API_KEY);
      form.append("language", "eng");
      form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
      const result = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: form }).then(response => response.json());
      text = (result.ParsedResults || []).map(row => row.ParsedText || "").join("\n");
    }
    let fileUrl = "";
    if (process.env.FIREBASE_STORAGE_BUCKET) {
      const objectName = `purchase-bills/${restaurantId}/${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const file = getStorage().bucket(process.env.FIREBASE_STORAGE_BUCKET).file(objectName);
      await file.save(req.file.buffer, { contentType: req.file.mimetype, metadata: { firebaseStorageDownloadTokens: crypto.randomUUID() } });
      const token = (await file.getMetadata())[0].metadata.firebaseStorageDownloadTokens;
      fileUrl = `https://firebasestorage.googleapis.com/v0/b/${process.env.FIREBASE_STORAGE_BUCKET}/o/${encodeURIComponent(objectName)}?alt=media&token=${token}`;
    }
    const parsed = parseBillText(text);
    res.json({ file: { name: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, fileUrl }, ...parsed, ocrConfigured: Boolean(process.env.OCR_SPACE_API_KEY) });
  } catch (error) { res.status(500).json({ error: error.message || "Could not read purchase bill." }); }
});

app.post("/api/inventory/save-purchase", verifyAdmin, async (req, res) => {
  try {
    const { restaurantId, supplierName = "", billDate = "", grandTotal = 0, fileUrl = "", items = [] } = req.body || {};
    if (!restaurantId || !Array.isArray(items) || !items.length) return res.status(400).json({ error: "restaurantId and reviewed purchase items are required." });
    await assertRestaurantAccess(req.user.uid, restaurantId);
    const db = getFirestore(); const billRef = db.collection(`restaurants/${restaurantId}/purchase_bills`).doc();
    await db.runTransaction(async transaction => {
      const prepared = items.map(item => ({ ...item, ...normalizeUnit(item.quantity, item.unit), itemName: String(item.itemName || "").trim(), normalizedName: normalizedName(item.itemName) })).filter(item => item.itemName && item.quantity > 0);
      if (!prepared.length) throw new Error("Add at least one valid reviewed item.");
      for (const item of prepared) {
        const existing = await db.collection(`restaurants/${restaurantId}/inventory`).where("normalizedName", "==", item.normalizedName).where("unit", "==", item.unit).limit(1).get();
        const inventoryRef = existing.empty ? db.collection(`restaurants/${restaurantId}/inventory`).doc() : existing.docs[0].ref;
        const old = existing.empty ? {} : existing.docs[0].data();
        transaction.set(inventoryRef, { restaurantId, itemName: item.itemName, normalizedName: item.normalizedName, currentStock: Number(old.currentStock || 0) + Number(item.quantity), unit: item.unit, category: item.category || old.category || "", lastPurchasePrice: Number(item.unitPrice || 0), purchasePrice: Number(item.unitPrice || 0), supplierName: item.supplierName || supplierName || old.supplierName || "", lowStockLimit: Number(old.lowStockLimit || old.minStockAlert || 0), minStockAlert: Number(old.minStockAlert || 0), updatedAt: FieldValue.serverTimestamp(), lastUpdated: FieldValue.serverTimestamp() }, { merge: true });
        transaction.set(db.collection(`restaurants/${restaurantId}/inventory_logs`).doc(), { inventoryItemId: inventoryRef.id, itemName: item.itemName, type: "stock_in", quantity: Number(item.quantity), unit: item.unit, reason: "Purchase bill", billId: billRef.id, createdAt: FieldValue.serverTimestamp(), createdBy: req.user.email || req.user.uid });
        transaction.set(billRef.collection("purchase_bill_items").doc(), { billId: billRef.id, inventoryItemId: inventoryRef.id, itemName: item.itemName, quantity: Number(item.quantity), unit: item.unit, unitPrice: Number(item.unitPrice || 0), totalPrice: Number(item.totalPrice || 0) });
      }
      transaction.set(billRef, { restaurantId, supplierName, billDate, grandTotal: Number(grandTotal || 0), fileUrl, uploadedAt: FieldValue.serverTimestamp(), uploadedBy: req.user.email || req.user.uid, status: "saved" });
    });
    res.json({ success: true, billId: billRef.id });
  } catch (error) { res.status(400).json({ error: error.message || "Could not save purchase." }); }
});

app.listen(process.env.PORT || 5000, () => console.log(`Scan2Plate backend running on port ${process.env.PORT || 5000}`));
