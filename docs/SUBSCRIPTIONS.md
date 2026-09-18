# Scan2Plate Subscriptions, Pricing and Offers

Multi-business subscription billing on Razorpay. This document covers what
exists, what you must configure, and what is **not** done yet.

> **Razorpay is not live.** The code is complete and tested against a stubbed
> Razorpay, but no real API call has ever been made from this repository. See
> [Going live](#going-live) for the steps only you can do.

---

## Architecture

```
Browser (public key id only)
   │
   ├─ reads  subscriptionPlans / offers / subscriptions   (Firestore, public catalogue)
   │
   └─ POST   /api/subscriptions/create ──► backend ──► Razorpay Subscriptions API
                                             │
Razorpay ──► POST /api/webhooks/razorpay ────┘ (HMAC verified, idempotent)
                     │
                     └─► Firestore: subscriptions + mirrored status on the business
```

`RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` exist **only** in backend
environment variables. The browser never receives either.

### Files

| File | Purpose |
| --- | --- |
| `public/js/business-types.js` | The 15 business types, their modules and settings groups |
| `public/js/subscription-core.js` | Pure pricing/offer/entitlement logic (shared, tested) |
| `public/js/subscription-client.js` | Firestore reads + backend calls + Razorpay checkout |
| `public/js/super-admin-billing.js` | Super Admin: plans, offers, subscriptions, revenue |
| `public/js/business-subscription.js` | Owner: My Subscription, pricing, offer popup |
| `backend/server.js` | Razorpay plan sync, subscription create/cancel, webhook |

---

## Firestore collections

All four are new. Nothing existing was renamed or removed.

### `subscriptionPlans`

```js
{
  name, businessType,            // "restaurant" | … | "all" for a global plan
  businessTypes: [],             // optional: restrict a global plan to a subset
  description,
  monthlyPrice, yearlyPrice,     // whole rupees
  razorpayMonthlyPlanId, razorpayYearlyPlanId,
  razorpayMonthlyAmountPaise,    // what that plan id was created for
  razorpayYearlyAmountPaise,     //   (drives the no-duplicate rule below)
  features: { qrOrdering: true, whatsapp: false, … },
  limits:   { maxTables: 20, maxStaff: -1, … },   // -1 = unlimited
  trialDays, gracePeriodDays,
  active, featured, displayOrder, badgeText,
  createdAt, updatedAt
}
```

### `offers`

```js
{
  name, businessType, planId, billingCycle,   // "monthly" | "yearly" | "any"
  discountType,                               // "percent" | "flat" | ""
  discountValue, bonusMonths,
  offerText, badge,
  startDate, endDate,                         // endDate is inclusive
  priority,                                   // higher wins
  maxRedemptions, redemptions,
  active, createdAt, updatedAt
}
```

### `subscriptions`

```js
{
  businessId, businessType, planId, planName,
  razorpaySubscriptionId, razorpayPlanId,
  status,                                     // see states below
  billingCycle, amount, currency,
  paidMonths, bonusMonths, offerId, gracePeriodDays,
  startDate, nextBillingDate, endDate,
  lastPaymentId, lastPaymentAmount, lastPaidAt, paymentFailedAt,
  createdAt, updatedAt
}
```

### `subscriptionEvents`

One document per Razorpay event id. This is the idempotency key: a replayed
webhook finds its marker and does nothing.

---

## Key behaviours

### "Pay 12 months, get 2 free" is an entitlement, not a 14-month cycle

Razorpay bills **12** months. Access runs **14**. `nextBillingDate` stays at 12
months; `endDate` is extended by the bonus. Modelling it as a 14-month
recurring period would make 14 months the customer's real billing cycle.

### Razorpay plans are immutable, so edits are handled carefully

A plan's amount cannot be changed at Razorpay. The amount each stored plan id
was created for is recorded, so:

- renaming / re-describing a plan → **reuses** the existing Razorpay plan
- genuinely changing the price → **creates a new** Razorpay plan

Existing subscribers keep billing on the plan they signed up to, which is the
correct behaviour for a price change.

### Only one offer is ever applied

Highest `priority` wins. Ties break on the larger saving, so two equally
ranked offers never show at random. Offers are re-validated **server-side** at
checkout — a client claiming an expired, inactive or wrong-cycle offer gets
nothing.

### Subscription states

`trial` · `pending` · `active` · `paused` · `cancelled` · `halted` ·
`expired` · `payment_failed`

A failed payment keeps access for `gracePeriodDays` (default 7, configurable
per plan) and **never deletes business data**.

### Existing businesses need no migration

`normalizeBusinessType()` resolves every spelling already in production —
`"Restaurant"`, `"Street Vendor"`, `"street_vendor"`, `"RestaurantAdmin"`,
`"cafetoken"` — and a record with **no** `businessType` resolves to
`restaurant`, because the product was restaurant-only before the field
existed. No backfill, no re-onboarding.

The webhook also mirrors `subscriptionStatus` / `planExpiryDate` / `status`
onto the business document, so the existing access checks in `admin.js` and
`login.js` keep working untouched.

---

## Environment variables (backend)

```bash
RAZORPAY_KEY_ID=rzp_live_xxxxxxxx        # public; safe in responses
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxx     # SECRET — backend only
RAZORPAY_WEBHOOK_SECRET=xxxxxxxxxxxx     # SECRET — backend only
```

Already required by the existing deployment:

```bash
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
```

`/api/health` reports whether Razorpay is configured.

---

## Firestore security rules

The plan catalogue is public pricing and is read by unauthenticated pricing
pages; everything else is restricted. Add:

```
match /subscriptionPlans/{planId} {
  allow read: if true;                       // public pricing
  allow write: if false;                     // only the backend service account
}

match /offers/{offerId} {
  allow read: if true;
  // Super Admin edits offers directly from the console.
  allow write: if request.auth != null
    && exists(/databases/$(database)/documents/users/$(request.auth.uid))
    && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'super_admin';
}

match /subscriptions/{subscriptionId} {
  // A business owner may read their own subscription; only the backend writes.
  allow read: if request.auth != null;
  allow write: if false;
}

match /subscriptionEvents/{eventId} {
  allow read, write: if false;               // backend only
}
```

The Firebase Admin SDK bypasses rules, so `allow write: if false` still lets
the backend write.

**No composite indexes are required.** Every query uses a single equality
filter (`active == true`, `businessId == …`, `razorpaySubscriptionId == …`),
which Firestore serves from its automatic single-field indexes.

---

## Razorpay dashboard configuration

1. **Enable Subscriptions** on the account (Razorpay enables the Subscriptions
   product per account; a plain payments account cannot create plans).
2. **Complete KYC / activate the account** for live mode.
3. **Create webhook**: Settings → Webhooks → Add New Webhook
   - URL: `https://<your-backend>/api/webhooks/razorpay`
   - Secret: the same value as `RAZORPAY_WEBHOOK_SECRET`
   - Events:
     `subscription.activated`, `subscription.charged`, `subscription.pending`,
     `subscription.halted`, `subscription.cancelled`, `subscription.paused`,
     `subscription.resumed`, `subscription.completed`, `payment.failed`
4. Razorpay delivers **at least once**, so duplicates are expected — they are
   handled via `subscriptionEvents`.

---

## Going live

Everything below is a manual step that could not be done from this repository.

- [ ] Set the three Razorpay env vars on the backend and redeploy
- [ ] Enable Subscriptions on the Razorpay account
- [ ] Complete Razorpay KYC / live activation
- [ ] Register the webhook URL and events, with a matching secret
- [ ] Publish the Firestore rules above
- [ ] In Super Admin → Subscription Plans, create your plans (this is what
      creates the Razorpay plans)
- [ ] In Super Admin → Offers, recreate the "12 months + 2 free" offer
- [ ] **Run one real end-to-end test payment in Razorpay test mode**, confirm
      the webhook arrives and the subscription flips to `active`
- [ ] Repeat once in live mode with a real card before announcing it

Until that end-to-end test passes, treat this as **not live**.

---

## Not implemented

Stated plainly so nothing is assumed:

- **Hotel / Hostel / Salon domain features.** Business types, their settings
  groups and their pricing exist. Room allocation, bed/resident management,
  mess plans and appointment booking are separate product modules and were not
  built.
- **Settings screen re-layout.** `business-types.js` declares which settings
  groups each type shows, but the existing Settings screen does not yet render
  itself from that declaration.
- **Plan limits are not yet enforced at write time.** `withinLimit()` exists
  and is tested, but the table/staff/menu creation paths do not call it, so
  limits are currently advisory.
- **Upgrade proration.** Changing plan creates a new subscription; the old one
  must be cancelled. Razorpay's `update` API is not used.
- **The existing one-time ₹499 signup checkout** (`/api/subscriptions/create-order`)
  is untouched and still works. It is separate from this recurring system.
