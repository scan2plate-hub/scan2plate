# Scan2Serve Full Pro Version

This package upgrades the earlier Firebase build with:

- customer WhatsApp consent + backend hook
- kitchen timer buttons (10 min / +10 min)
- customer phone visible in kitchen and admin
- best selling items section
- date-wise report section
- food image URL support
- bill logo + cafe address
- backend folder for Twilio WhatsApp

## Very important first step

Your Twilio Auth Token was exposed in chat screenshots. Rotate/regenerate it in Twilio before using this project.

## Frontend setup

1. Open `public/js/firebase-config.js`
2. Paste your Firebase web config.
3. In Firestore create/update:
   - `users/{uid_or_email}` with `role`, `name`, `email`, `active`
   - `settings/general`
   - `menu/*`
4. Netlify publish directory should stay `public`.

## New Firestore settings/general fields

```json
{
  "restaurantName": "Old Monk Cafe",
  "phone": "+91...",
  "address": "Your cafe address",
  "upiId": "yourupi@bank",
  "taxPercent": 5,
  "logoUrl": "https://...",
  "kitchenWhatsApp": "+91...",
  "backendUrl": "http://localhost:5000"
}
```

## Menu document fields

```json
{
  "name": "Masala Tea",
  "category": "Tea",
  "price": 20,
  "available": true,
  "description": "Freshly prepared item",
  "imageUrl": "https://...",
  "sortOrder": 1
}
```

## Backend setup for Twilio WhatsApp

1. Open terminal in `backend`
2. Run:
   ```bash
   npm install
   cp .env.example .env
   ```
3. Put your **new rotated** Twilio credentials in `.env`
4. Start backend:
   ```bash
   npm start
   ```
5. Save the backend URL in admin dashboard settings.

## WhatsApp notes

- Trial Twilio accounts can message only sandbox-joined or verified numbers.
- Frontend works even without backend; only WhatsApp notifications will be skipped.
- Customer must opt in to WhatsApp updates.

## What is included vs not fully automated yet

Included now:
- WhatsApp backend hook
- kitchen timer system
- reports and best sellers
- bill branding
- food images by URL

Not fully automatic in this zip:
- drag-and-drop menu reorder UI
- direct Firebase Storage upload button

Those can be added in the next version if you want.
