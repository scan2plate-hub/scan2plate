import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import twilio from "twilio";
import multer from "multer";
import crypto from "crypto";
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
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const twilioRequired = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"];
const missing = twilioRequired.filter(key => !process.env[key]);
const twilioEnabled = missing.length === 0;
const client = twilioEnabled ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;
const rawBucket = process.env.FIREBASE_STORAGE_BUCKET || "";
const storageBucketName = rawBucket.replace(/^gs:\/\//, "").trim();
console.log("Firebase Storage bucket:", storageBucketName);
const aiHelpDailyUsage = new Map();

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
function safeString(value, max = 1200) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
const helpKnowledgeBase = [
  {
    keys: ["qr", "not opening", "customer page", "loading stuck", "scan"],
    answer: "1. Check the QR URL has the correct restaurantId and table number.\n2. Open the same link in an incognito browser.\n3. Confirm the restaurant is active in Super Admin.\n4. Check internet connection on the customer phone.\n5. If the customer page keeps loading, open Admin Settings and confirm the menu has active items.\n6. If still failing, create a support ticket with the QR link."
  },
  {
    keys: ["order", "not showing", "visible", "live order"],
    answer: "1. Refresh Admin Dashboard and check Live Orders > Active.\n2. Confirm the customer used the correct restaurant QR.\n3. Check the order was not already marked paid/completed.\n4. Confirm Firebase internet access is working.\n5. Check Super Admin plan status is active.\n6. If the order is still missing, create a support ticket."
  },
  {
    keys: ["kot", "print", "kitchen"],
    answer: "1. Check printer is connected and selected as the default printer.\n2. Open Settings > Print Settings.\n3. Use Browser Print Mode.\n4. Allow popup permission in the browser.\n5. Set paper size to 80mm and scale to 100%.\n6. Try Print KOT again.\n7. If still not working, create a support ticket."
  },
  {
    keys: ["bill", "print", "small", "blur", "thermal"],
    answer: "1. Use Chrome browser for thermal bill printing.\n2. In print dialog choose the 80mm thermal printer.\n3. Set margins to none/default and scale to 100%.\n4. Disable headers and footers.\n5. If logo or QR is blurry, upload a smaller clear logo and retry.\n6. If still unclear, create a support ticket with a bill photo."
  },
  {
    keys: ["logo", "upload", "storage", "bucket"],
    answer: "1. Use JPG, PNG, or WEBP logo under 1MB after compression.\n2. Check Backend URL in Settings is correct.\n3. Confirm Firebase Storage bucket is configured on backend.\n4. Save Settings again and wait for success.\n5. Refresh the page and check logo preview.\n6. If upload fails again, create a support ticket with the exact error."
  },
  {
    keys: ["ocr", "scan", "supplier", "bill", "apikey"],
    answer: "1. Open Settings and click Test OCR Connection.\n2. Confirm Backend URL is correct.\n3. Use a clear JPG/PNG/PDF bill image.\n4. Keep the bill flat, bright, and readable.\n5. If OCR key is missing, backend env OCR_SPACE_API_KEY must be added.\n6. If scan still fails, create a support ticket with the error shown."
  },
  {
    keys: ["dashboard", "zero", "today", "reset"],
    answer: "1. Dashboard counts only today's business data.\n2. Check Restaurant Settings > Daily Order Number Reset Time.\n3. Orders before reset time may count in the previous business day.\n4. Check Live Orders > All to see older orders.\n5. Refresh once after internet reconnects.\n6. If counts are still wrong, create a support ticket."
  },
  {
    keys: ["whatsapp", "message", "twilio"],
    answer: "1. Confirm kitchen/customer phone numbers include country code.\n2. Check backend Twilio environment variables are configured.\n3. Confirm Backend URL in Settings is correct.\n4. Try a new test order.\n5. WhatsApp sandbox numbers may require joining the sandbox first.\n6. If messages still do not arrive, create a support ticket."
  },
  {
    keys: ["payment", "upi", "razorpay", "paid"],
    answer: "1. Confirm UPI ID or payment settings are saved.\n2. Refresh Settings and verify the value remains.\n3. For bill QR, check Show QR on Paid Bills if needed.\n4. Mark payment status carefully from the order card.\n5. Check Reports payment breakdown after marking paid.\n6. If payment is not showing, create a support ticket."
  },
  {
    keys: ["menu", "price", "half", "full", "variant", "item"],
    answer: "1. Open Menu Items and edit the item.\n2. For normal items, keep Half/Full pricing disabled and enter one price.\n3. For portion items, enable Half and Full pricing and enter both prices.\n4. Save the item and refresh the customer menu.\n5. Old items without variants continue using normal price.\n6. If price is wrong in cart or bill, create a support ticket."
  },
  {
    keys: ["table", "occupied", "yesterday", "status"],
    answer: "1. Table status is based on active unpaid orders.\n2. Mark old completed orders as Paid or Completed.\n3. Check Live Orders > All for old active orders on that table.\n4. Use Reset Data only if you intentionally want to clear scoped business data.\n5. If table remains occupied incorrectly, create a support ticket."
  },
  {
    keys: ["backend", "disconnected", "render", "health"],
    answer: "1. Open the Backend URL and check it says Scan2Plate backend is running.\n2. Open /api/health on the backend URL.\n3. If Render was sleeping, wait 30-60 seconds and retry.\n4. Confirm Backend URL in Settings has no extra slash/path.\n5. If health fails, create a support ticket with the backend URL."
  },
  {
    keys: ["firebase", "permission", "denied", "rules"],
    answer: "1. Confirm you are logged in with the correct restaurant account.\n2. Refresh the page and login again if needed.\n3. Check that restaurantId matches the account.\n4. Firebase permission errors usually need rules or backend access updates.\n5. Create a support ticket with the exact permission-denied message."
  }
];
function fallbackHelpAnswer(message = "") {
  const text = safeString(message, 2000).toLowerCase();
  const scored = helpKnowledgeBase
    .map(item => ({ item, score: item.keys.reduce((sum, key) => sum + (text.includes(key) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score)[0];
  if (scored?.score > 0) return scored.item.answer;
  return "1. Refresh the page and check your internet connection.\n2. Confirm the correct restaurant account is logged in.\n3. Open Settings and verify Backend URL if the issue uses OCR, WhatsApp, logo upload, or diagnostics.\n4. Try the action once more and note the exact error message.\n5. If the problem continues, create a support ticket so the Scan2Plate team can check it.";
}
function aiHelpSystemPrompt() {
  return "You are Scan2Plate AI Help Assistant for restaurant owners. Give concise, practical troubleshooting steps for Scan2Plate admin dashboard, QR ordering, KOT, billing, menu, inventory OCR, logo upload, WhatsApp, payment, table status, reports, and backend health. Never ask for API keys or private customer data. End with creating a support ticket if unresolved.";
}
function aiLimitForPlan(planType = "") {
  const plan = String(planType || "").toLowerCase();
  if (plan.includes("basic") || plan.includes("free")) return Number(process.env.DAILY_AI_LIMIT_BASIC || 20);
  return Number(process.env.DAILY_AI_LIMIT_ADVANCED || process.env.DAILY_AI_LIMIT_ADVANCE || 100);
}
function aiUsageKey(restaurantId = "") {
  return `${safeString(restaurantId || "unknown", 80)}_${new Date().toISOString().slice(0, 10)}`;
}
function incrementAiUsage(restaurantId, planType) {
  const key = aiUsageKey(restaurantId);
  const used = Number(aiHelpDailyUsage.get(key) || 0);
  const limit = aiLimitForPlan(planType);
  if (used >= limit) return { allowed: false, used, limit };
  aiHelpDailyUsage.set(key, used + 1);
  return { allowed: true, used: used + 1, limit };
}
async function callAiProvider({ userMessage, appContext, diagnostics }) {
  const provider = String(process.env.AI_PROVIDER || "openai").toLowerCase();
  const apiKey = String(process.env.AI_API_KEY || "").trim();
  const model = String(process.env.AI_MODEL || (provider.includes("gemini") ? "gemini-1.5-flash" : "gpt-4o-mini")).trim();
  if (!apiKey) return null;
  const safePayload = {
    restaurantId: safeString(appContext?.restaurantId, 80),
    restaurantName: safeString(appContext?.restaurantName, 120),
    pageName: safeString(appContext?.pageName, 80),
    planType: safeString(appContext?.planType, 60),
    recentError: safeString(appContext?.recentError, 500),
    diagnostics
  };
  if (provider.includes("gemini")) {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: `${aiHelpSystemPrompt()}\nContext: ${JSON.stringify(safePayload)}\nProblem: ${safeString(userMessage, 1200)}` }] }] })
    });
    if (!response.ok) throw new Error(`AI provider HTTP ${response.status}`);
    const result = await response.json();
    return result.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n").trim() || null;
  }
  const response = await fetch(process.env.AI_BASE_URL || "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: aiHelpSystemPrompt() },
        { role: "user", content: `Context: ${JSON.stringify(safePayload)}\nProblem: ${safeString(userMessage, 1200)}` }
      ],
      temperature: 0.2,
      max_tokens: 500
    })
  });
  if (!response.ok) throw new Error(`AI provider HTTP ${response.status}`);
  const result = await response.json();
  return result.choices?.[0]?.message?.content?.trim() || null;
}
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
  const key = String(process.env.OCR_SPACE_API_KEY || "").trim();
  const params = new URLSearchParams();
  params.append("apikey", key);
  params.append("url", "https://ocr.space/Content/Images/receipt-ocr-original.jpg");
  params.append("language", "eng");
  params.append("OCREngine", "2");
  params.append("isOverlayRequired", "false");
  params.append("filetype", "JPG");

  return fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
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
  backendName: "scan2plate",
  storageBucket: storageBucketName,
  firebaseAdminReady: adminReady,
  logoUploadRoute: true,
  ocrKeyConfigured: Boolean(ocrKey()),
  ocrKeyLength: ocrKey().length,
  aiHelpEnabled: process.env.AI_HELP_ENABLED !== "false",
  aiProvider: process.env.AI_PROVIDER || "fallback",
  aiModel: process.env.AI_MODEL || "",
  aiLimitBasic: Number(process.env.DAILY_AI_LIMIT_BASIC || 20),
  aiLimitAdvanced: Number(process.env.DAILY_AI_LIMIT_ADVANCED || process.env.DAILY_AI_LIMIT_ADVANCE || 100),
  time: new Date().toISOString()
}));
app.post("/api/ai/help", async (req, res) => {
  const { restaurantId = "", pageName = "", userMessage = "", recentError = "", appContext = {}, diagnostics = {} } = req.body || {};
  const cleanMessage = safeString(userMessage, 1500);
  if (!cleanMessage) return res.status(400).json({ success: false, answer: fallbackHelpAnswer(""), error: "userMessage is required" });
  const backendDiagnostics = {
    backendHealth: true,
    firebaseAdminReady: adminReady,
    storageBucketConfigured: Boolean(storageBucketName),
    ocrKeyConfigured: Boolean(ocrKey()),
    serverTime: new Date().toISOString()
  };
  const context = {
    restaurantId: safeString(restaurantId || appContext.restaurantId, 80),
    restaurantName: safeString(appContext.restaurantName, 120),
    pageName: safeString(pageName || appContext.pageName, 80),
    planType: safeString(appContext.planType, 60),
    recentError: safeString(recentError || appContext.recentError, 500)
  };
  if (process.env.AI_HELP_ENABLED === "false") return res.status(403).json({ success: false, error: "AI Help Assistant is disabled" });
  const usage = incrementAiUsage(context.restaurantId || restaurantId || "unknown", context.planType);
  if (!usage.allowed) return res.status(429).json({ success: false, error: "Daily AI help limit reached. Please create support ticket.", limit: usage.limit, used: usage.used });
  let answer = "";
  let source = "fallback";
  let providerFailed = false;
  try {
    answer = await callAiProvider({ userMessage: cleanMessage, appContext: context, diagnostics: { frontend: diagnostics, backend: backendDiagnostics } });
    if (answer) source = "ai";
  } catch (error) {
    providerFailed = true;
    console.warn("AI help provider failed:", error.message);
  }
  if (!answer) answer = `${providerFailed ? "AI service is temporarily unavailable. Here is a standard troubleshooting guide.\n\n" : ""}${fallbackHelpAnswer(cleanMessage)}`;
  res.json({ success: true, answer, source, diagnostics: backendDiagnostics });
});

app.post("/api/restaurants/:restaurantId/staff", verifyAdmin, async (req, res) => {
  try {
    const restaurantId = String(req.params.restaurantId || req.body?.restaurantId || "").trim();
    const { name = "", email = "", password = "", phone = "", role = "waiter" } = req.body || {};
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanRole = String(role || "waiter").trim().toLowerCase();
    const allowedRoles = new Set(["owner", "manager", "cashier", "kitchen", "waiter"]);
    if (!restaurantId) return res.status(400).json({ ok: false, error: "restaurantId is required." });
    if (!String(name).trim()) return res.status(400).json({ ok: false, error: "Staff name is required." });
    if (!cleanEmail) return res.status(400).json({ ok: false, error: "Email is required." });
    if (!allowedRoles.has(cleanRole)) return res.status(400).json({ ok: false, error: "Invalid staff role." });
    if (!String(password).trim() || String(password).length < 6) return res.status(400).json({ ok: false, error: "Password must be at least 6 characters." });
    await assertRestaurantAccess(req.user.uid, restaurantId);

    const auth = getAuth();
    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(cleanEmail);
      await auth.updateUser(userRecord.uid, { password: String(password), displayName: String(name).trim(), disabled: false });
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
      userRecord = await auth.createUser({ email: cleanEmail, password: String(password), displayName: String(name).trim(), disabled: false });
    }

    const db = getFirestore();
    const docId = cleanEmail.replaceAll("@", "_").replaceAll(".", "_");
    const staffPayload = {
      uid: userRecord.uid,
      restaurantId,
      email: cleanEmail,
      name: String(name).trim(),
      phone: String(phone || "").trim(),
      role: cleanRole,
      status: "active",
      createdAt: FieldValue.serverTimestamp(),
      createdBy: req.user.email || req.user.uid,
      updatedAt: FieldValue.serverTimestamp()
    };
    await db.doc(`restaurants/${restaurantId}/users/${docId}`).set(staffPayload, { merge: true });
    await db.doc(`restaurantStaff/${userRecord.uid}`).set(staffPayload, { merge: true });
    await db.collection("auditLogs").add({
      restaurantId,
      action: "staff_created",
      performedBy: req.user.email || req.user.uid,
      role: "owner",
      details: { staffUid: userRecord.uid, email: cleanEmail, role: cleanRole },
      createdAt: FieldValue.serverTimestamp()
    });
    res.json({ ok: true, success: true, uid: userRecord.uid, staff: { ...staffPayload, createdAt: null, updatedAt: null } });
  } catch (error) {
    res.status(error.status || 400).json({ ok: false, error: error.message || "Could not create staff." });
  }
});
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
  const key = String(process.env.OCR_SPACE_API_KEY || "").trim();
  if (!key) return res.json({ connected: false, error: "OCR_SPACE_API_KEY missing" });
  try {
    const response = await testOcrSpaceConnection();
    const bodyText = await response.text();
    let result = null;
    try { result = bodyText ? JSON.parse(bodyText) : {}; } catch {
      return res.json({
        connected: false,
        error: "OCR provider HTTP error",
        status: response.status,
        bodyPreview: bodyText.slice(0, 300)
      });
    }
    if (!response.ok) {
      return res.json({
        connected: false,
        error: "OCR provider HTTP error",
        status: response.status,
        bodyPreview: bodyText.slice(0, 300)
      });
    }
    if (result.IsErroredOnProcessing || result.OCRExitCode !== 1 || !Array.isArray(result.ParsedResults)) {
      return res.json({
        connected: false,
        error: "OCR Space test failed",
        ocrExitCode: result.OCRExitCode || null,
        errorMessage: result.ErrorMessage || result.ErrorDetails || result.error || null,
        raw: result
      });
    }
    res.json({ connected: true, message: "OCR Space connected", ocrExitCode: result.OCRExitCode });
  } catch (error) {
    res.json({
      connected: false,
      error: "OCR provider HTTP error",
      status: error.status || null,
      bodyPreview: error.message || "OCR provider request failed"
    });
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
  logoUpload.fields([{ name: "logo", maxCount: 1 }, { name: "file", maxCount: 1 }, { name: "image", maxCount: 1 }])(req, res, error => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, ok: false, error: "Logo image must be 5MB or smaller." });
    return res.status(400).json({ ok: false, error: error.message || "Logo upload failed." });
  });
}, async (req, res) => {
  try {
    const restaurantIdParam = String(req.params.restaurantId || "").trim();
    const uploadedLogo = req.file || req.files?.logo?.[0] || req.files?.file?.[0] || req.files?.image?.[0] || null;
    console.info("[Logo Upload]", {
      restaurantId: restaurantIdParam,
      fileMimetype: uploadedLogo?.mimetype || "",
      fileSize: uploadedLogo?.size || 0
    });
    if (!restaurantIdParam) return res.status(400).json({ success: false, ok: false, error: "restaurantId missing" });
    if (!uploadedLogo) return res.status(400).json({ success: false, ok: false, error: "Logo file is required. Use form-data field logo, file, or image." });
    if (!String(uploadedLogo.mimetype || "").startsWith("image/")) return res.status(415).json({ success: false, ok: false, error: "Use an image logo file." });
    if (uploadedLogo.size > 5 * 1024 * 1024) return res.status(413).json({ success: false, ok: false, error: "Logo image must be 5MB or smaller." });
    if (!adminReady) return res.status(503).json({ success: false, ok: false, error: "FIREBASE_SERVICE_ACCOUNT missing on backend" });
    if (!storageBucketName) return res.status(503).json({ success: false, ok: false, error: "FIREBASE_STORAGE_BUCKET missing on backend" });

    const restaurantSnap = await findRestaurantDocByBusinessId(restaurantIdParam);
    if (!restaurantSnap) return res.status(404).json({ success: false, ok: false, error: "Restaurant not found", restaurantId: restaurantIdParam });
    console.info("[Logo Upload] restaurant found", { restaurantId: restaurantIdParam, documentId: restaurantSnap.id });

    const extensionFromName = String(uploadedLogo.originalname || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
    const extension = ({ "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/svg+xml": "svg" })[String(uploadedLogo.mimetype || "").toLowerCase()] || extensionFromName || "jpg";
    const storagePath = `restaurants/${restaurantIdParam}/logo/logo-${Date.now()}.${extension}`;
    const bucket = getStorage().bucket(storageBucketName);
    const file = bucket.file(storagePath);
    let token = "";
    try {
      token = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
      await file.save(uploadedLogo.buffer, {
        metadata: {
          contentType: uploadedLogo.mimetype || "image/jpeg",
          metadata: {
            firebaseStorageDownloadTokens: token
          }
        },
        resumable: false
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        ok: false,
        error: "Firebase Storage logo upload failed",
        bucket: storageBucketName,
        details: error.message || "Storage upload failed",
        code: error.code || null
      });
    }
    const logoUrl = `https://firebasestorage.googleapis.com/v0/b/${storageBucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
    await restaurantSnap.ref.set({
      restaurantLogoUrl: logoUrl,
      restaurantLogoStoragePath: storagePath,
      logoUrl,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true, ok: true, restaurantId: restaurantIdParam, logoUrl, storagePath });
  } catch (error) {
    res.status(500).json({ success: false, ok: false, error: error.message || "Logo upload failed." });
  }
});
app.all("/api/restaurants/:restaurantId/logo", (_, res) => {
  res.status(405).json({ success: false, ok: false, error: "Use POST multipart/form-data with field logo, file, or image." });
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
