import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import twilio from "twilio";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
const required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"];
const missing = required.filter((k) => !process.env[k]);
const twilioEnabled = missing.length === 0;
const client = twilioEnabled ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;
function sanitizePhone(phone) { if (!phone) return ""; const raw = String(phone).trim(); if (raw.startsWith("whatsapp:")) return raw; const clean = raw.replace(/[^\d+]/g, ""); return clean ? `whatsapp:${clean}` : ""; }
async function sendMessage(to, body) { if (!twilioEnabled) return { skipped: true, reason: `Missing env: ${missing.join(", ")}` }; if (!to) return { skipped: true, reason: "Missing recipient" }; const msg = await client.messages.create({ from: process.env.TWILIO_WHATSAPP_FROM, to: sanitizePhone(to), body }); return { sid: msg.sid }; }
app.get('/health', (_,res)=>res.json({ ok:true, twilioEnabled, missing }));
app.post('/notify-order', async (req,res)=>{ try{ const { customerPhone, customerName, kitchenPhone, orderId, tableNo, items, grandTotal, status, etaMinutes, restaurantName, billUrl } = req.body || {}; const itemLine=Array.isArray(items)?items.map(i=>`${i.name} x ${i.qty}`).join(', '):''; const baseUrl=(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/,''); const trackUrl=baseUrl ? `${baseUrl}/track.html?orderId=${encodeURIComponent(orderId||'')}` : ''; const finalBillUrl = billUrl || (baseUrl ? `${baseUrl}/bill.html?orderId=${encodeURIComponent(orderId||'')}` : ''); const kitchenTitle = status === 'updated' ? '➕ Items added to order' : '🍽️ New Order'; const kitchenBody=[ kitchenTitle, restaurantName ? `Restaurant: ${restaurantName}` : '', `Order: ${orderId || '-'}`, `Table: ${tableNo || '-'}`, `Customer: ${customerName || 'Guest'}`, customerPhone ? `Phone: ${customerPhone}` : '', itemLine ? `Items: ${itemLine}` : '', grandTotal != null ? `Total: ₹${Number(grandTotal).toFixed(2)}` : '', etaMinutes != null ? `ETA: ${etaMinutes} min` : '', finalBillUrl ? `Bill: ${finalBillUrl}` : '' ].filter(Boolean).join('
'); const customerBody=[ status === 'ready' ? '✅ Your order is ready' : status === 'preparing' ? '👨‍🍳 Your order is being prepared' : status === 'accepted' ? '👍 Your order is accepted' : status === 'rejected' ? '❌ Your order was rejected' : status === 'paid' ? '💸 Payment received' : status === 'updated' ? '➕ New items added to your running bill' : '🧾 Order update', `Order: ${orderId || '-'}`, `Status: ${status || 'pending'}`, etaMinutes != null ? `ETA: ${etaMinutes} min` : '', trackUrl ? `Track: ${trackUrl}` : '', finalBillUrl ? `Bill: ${finalBillUrl}` : '' ].filter(Boolean).join('
'); const results={ kitchen: await sendMessage(kitchenPhone || process.env.KITCHEN_WHATSAPP_TO, kitchenBody), customer: await sendMessage(customerPhone, customerBody) }; res.json({ success:true, results }); }catch(error){ console.error(error); res.status(500).json({ success:false, error:error.message }); } });
app.listen(process.env.PORT || 5000, ()=>console.log(`Scan2Plate backend running on port ${process.env.PORT || 5000}`));
