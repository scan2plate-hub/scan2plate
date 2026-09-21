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
  razorpayMonthlyAmountPaise,    // what that plan id actually charges
  razorpayYearlyAmountPaise,     //   (drives the no-duplicate rule below)
  razorpayMonthlyPlanMode,       // "test" | "live" — which Razorpay universe
  razorpayYearlyPlanMode,        //   this id belongs to
  razorpayMonthlyPlanSource,     // "manual" (pasted in) | "auto" (we created it)
  razorpayYearlyPlanSource,
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
  razorpayMode,                               // "test" | "live" at creation
  status,                                     // see states below
  billingCycle, amount, currency,
  paidMonths, bonusMonths, offerId, offerName, gracePeriodDays,
  customer: { businessName, email, phone, uid },   // captured at creation
  startDate,
  currentPeriodStart, currentPeriodEnd,       // billing period, as Razorpay reports it
  nextBillingDate,
  endDate, expiryDate,                        // ACCESS ends here: paid period + bonus
  paymentId, lastPaymentId, lastPaymentAmount, lastPaidAt, paymentFailedAt,
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

### Two ways a Razorpay plan id gets here

**Paste one you created** in Razorpay Dashboard → Subscriptions → Plans, into
Super Admin → Subscription Plans. This is the normal path.

**Or let Scan2Plate create it** from the price you typed, which is what happens
for any priced cycle with no id. Untick *"Let Scan2Plate create a Razorpay plan
automatically"* to manage plans entirely by hand.

Every pasted id is **fetched from Razorpay before it is saved**. That single
call is what catches all four ways a pasted id goes wrong:

| What you pasted | What happens |
| --- | --- |
| An id from the other mode | Rejected, naming both modes — a live plan cannot be billed with test keys |
| A monthly id in the yearly box | Rejected, naming the real period |
| A plan charging ₹499 while the page advertises ₹599 | Rejected, naming both amounts |
| Anything that is not a plan id | Rejected before any API call |

A plan id with no price typed alongside it **sets** the price from Razorpay,
so the advertised price can never drift from the billed one.

### Razorpay plans are immutable, so edits are handled carefully

A plan's amount cannot be changed at Razorpay. The amount each stored plan id
actually charges is recorded, so:

- renaming / re-describing a plan → **reuses** the existing Razorpay plan
- genuinely changing the price of an **auto-created** plan → **creates a new** one
- genuinely changing the price of a **hand-entered** plan → **rejected**, asking
  for the new plan's id

That last case matters: quietly creating a second plan behind someone who is
managing plans in the Razorpay dashboard would leave two plans for one price
and no sign of it.

Existing subscribers keep billing on the plan they signed up to, which is the
correct behaviour for a price change.

### Test and live are kept apart

Test and live are separate Razorpay universes, and a plan id carries no marker
of which one it belongs to. So the key mode (`rzp_test_` / `rzp_live_`) is
recorded next to every stored plan id and checked in three places:

1. **On save** — the fetch above fails for a cross-mode id.
2. **On save of an existing plan** — a stored id from the other mode is refused,
   so switching a deployment's keys fails loudly here.
3. **At checkout** — a plan whose recorded mode is not the server's mode returns
   `razorpay_mode_mismatch` and nothing is created at Razorpay.

Super Admin → Subscription Plans shows the mode against every configured plan.

### A business can only buy a plan meant for its type

Enforced **server-side**, at `/api/subscriptions/create`, against the business
record's own `businessType` — never the type in the request body, which the
caller controls. A restaurant sending a hostel plan's id gets `403
plan_business_type_mismatch`, and nothing is created at Razorpay.

A plan with `businessType: "all"` is sellable to everyone, unless
`businessTypes: [...]` narrows it to a named subset.

Checkout also **never creates a Razorpay plan**. A cycle with no configured
plan id is a Super Admin problem; inventing a plan mid-payment would be the
wrong way to hide it.

### Coupon codes

An offer with a `code` is a coupon: it applies **only** when a business types
that code. An offer without one applies automatically to everyone who
qualifies, as before. Codes ignore spaces and capitals, so `save 50` and
`SAVE50` are the same code.

Razorpay plan amounts are immutable and a subscription bills its plan, so a
coupon cannot simply charge less. There are exactly three honest outcomes:

| Coupon | How it is delivered |
| --- | --- |
| **100% off** | Not a payment at all. `/api/subscriptions/redeem` grants access directly, no Razorpay call — a zero-rupee subscription cannot exist |
| **Partial discount** | Requires a `razorpayOfferId` (Razorpay Dashboard → Offers). Razorpay applies the discount to the real charge |
| **Bonus months** | Extends access rather than changing the price, so it needs nothing at Razorpay |

A partial discount with **no** `razorpayOfferId` is refused — at save time in
Super Admin, and again at checkout. Showing a customer a discount and then
charging them full price is the one outcome that is never acceptable, so the
code would rather fail loudly.

Every coupon is re-validated **server-side** before anything is charged or
granted. A redemption is claimed in a Firestore transaction, so two people
typing the last use of a one-use code cannot both get it. A free grant is
recorded with `grantedByCoupon: true`, `amount: 0` and the `listPrice` it
would have cost, so revenue reporting never reads it as a sale.

### Only one offer is ever applied

Highest `priority` wins. Ties break on the larger saving, so two equally
ranked offers never show at random. Offers are re-validated **server-side** at
checkout — a client claiming an expired, inactive or wrong-cycle offer gets
nothing.

### Subscription states

`created` · `authenticated` · `trial` · `pending` · `active` · `paused` ·
`cancelled` · `halted` · `expired` · `payment_failed`

The first three of those mean quite different things and are deliberately not
merged:

| State | Means |
| --- | --- |
| `created` | Subscription made at Razorpay; the customer never completed checkout |
| `authenticated` | Mandate approved; no money has moved yet |
| `payment_failed` | A charge was attempted and declined (this is what Razorpay itself calls `pending`) |

None of them grants access. Telling them apart is the difference between "they
walked away" and "their bank declined", which is the first question anyone asks
about a subscription that never went live.

Webhook events are the authority for state. Out-of-order delivery is handled:
a late `authenticated` can never walk an already-`active` subscription
backwards.

A failed payment keeps access for `gracePeriodDays` (default 7, configurable
per plan) and **never deletes business data**.

### Settings and the sidebar follow the business type

`business-type-ui.js` hides the settings cards and sidebar sections a business
type does not use, and adds the ones it does (Rooms, Hostel & Residents, Mess,
Services & Appointments, Products & Custom Orders). A street vendor sees no
table or kitchen configuration; a hostel sees rooms, beds and mess.

Two rules keep it safe: it only ever **adds** `hidden` (so it can never undo
the role-based hiding `applyStaffPermissions()` already did), and it never
clears a stored value — switching a business's type back restores its
configuration untouched. The extra fields write into `settings/general`,
which is schemaless, so this is additive.

### Plan limits are enforced at the point of creation

`plan-limits.js` gates adding tables, staff accounts, menu items and inventory
items against the limits configured on the plan.

**It fails open by design.** A business with no subscription, no plan, an
unentitled (expired/cancelled) subscription, or an unreadable plan is never
blocked — every existing Scan2Plate business is in exactly that state, and a
billing lookup must not stop a live restaurant adding a table mid-service.
Editing an existing record is never blocked, only creating a new one.

This is a usability gate, not a security boundary: it stops an owner quietly
exceeding what they bought. Firestore rules and the backend remain what
actually enforce access.

### An expired business can pay for itself

Before this, expiry was a dead end. `login.js` signed the account out with
"Your plan has expired. Please renew", the dashboard lock said "contact your
Super Admin", `renew.html` was 710 bytes of the same, and the lock's "Renew
Now" button opened a `mailto:`. A customer who wanted to pay could not.

`renew.html` is now a real self-service renewal page:

- An expired login is redirected there **still signed in**, because buying a
  subscription needs a verified identity. The session written for it carries
  `role: "expired"` and the page reads only the business id from it.
- It sells the plans for that business's type, with the best live offer
  applied, through the same `/api/subscriptions/create` every other checkout
  uses. No second payment path.
- It watches the subscription and flips to a success state when **the webhook**
  activates it — never on Razorpay's checkout callback, which only says the
  customer finished, not that the money arrived.

Nothing about the gates changed. `admin.js` still locks the dashboard on
expiry, and the lock genuinely blocks: `checkRestaurantSubscription()` returns
true and the boot path skips loading any data behind it. Access comes back
only when the webhook says the payment happened.

### One source of pricing

`subscriptionPlans` is now the only place a price is defined. Three surfaces
used to carry their own copy, and they had drifted apart:

| Surface | Was | Now |
| --- | --- | --- |
| Super Admin → Plans | Hardcoded Basic ₹249 / Advance ₹999 / Enterprise ₹1999, priced from **localStorage** — so it differed per browser | Reads `subscriptionPlans`, grouped by business type |
| Super Admin → Renew | The same three tiers for every business, so a hostel could be renewed onto a restaurant's price | Lists the real plans that business type is sold |
| Landing page | A single `₹499` card written into `index.html` | Rendered from `subscriptionPlans`, with a business-type chooser |

The landing page keeps the static card in its markup as a deliberate
fallback. It is a marketing page: if Firestore is slow, blocked or the
catalogue is empty, a visitor deciding whether to buy should see a price
rather than an empty section.

Revenue on the Plans page counts only `active` and `trial` subscriptions, and
normalises a yearly amount to a monthly figure, so the total means one thing.

### The two Super Admin screens agree

Businesses and Subscriptions used to disagree about the same business.
`effectiveStatus()` on the Businesses page predates the Razorpay system and
looked only at `status` and `expiryDate`, ignoring the `subscriptionStatus`
the webhook writes — so a business the webhook had just marked active could
still show as Expired. It now prefers the subscription's own status where the
webhook has spoken, and reads both `expiryDate` and `planExpiryDate`, falling
back to the old fields exactly as before for businesses that never used
Razorpay.

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

### Where to put them

| Where | How |
| --- | --- |
| Production | Your backend host's dashboard → Environment / Config Vars → add the three keys → **redeploy** (env changes only take effect on restart) |
| Local development | `backend/.env`, copied from `backend/.env.example`. It is already in `.gitignore` |

There is **no admin screen for entering these**, and there deliberately never
will be. A secret typed into a browser form travels through the page, the
network tab and usually the browser's autofill store, which is exactly what
"backend only" rules out. Super Admin → Subscription Plans instead shows a
read-only panel that reports *whether* the backend has each value, the live/test
mode, and a masked prefix of the key id — enough to spot a wrong account or a
missing webhook secret without ever displaying a secret.

### `RAZORPAY_PLAN_ID` is not used

Razorpay plan ids are not global configuration. Each Scan2Plate plan gets its
own Razorpay plan, created by the backend when a Super Admin saves the plan and
stored on that plan document as `razorpayMonthlyPlanId` / `razorpayYearlyPlanId`.
A single env-var plan id would force every business type onto one price, which
is the opposite of what this system is for. If you have that variable set
somewhere, it is ignored; remove it.

Already required by the existing deployment:

```bash
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
```

`/api/health` reports whether Razorpay is configured.

---

## Who counts as a Super Admin

`/api/admin/plans` accepts an account granted through **any** of these, which
is the same set `public/js/super-admin-auth.js` checks in the browser:

| Where | What makes it a grant |
| --- | --- |
| `superAdmins/{uid}` | The document existing (role may be absent) |
| `super_admins/{uid}` | The document existing |
| `users/{uid}` | `role == "super_admin"` |
| `admins` where `email ==` | `role == "super_admin"` |

Any of them with `status` of `disabled` / `suspended` / `inactive` is refused,
as is a document that explicitly names a lesser role.

The first two were missing from the backend, so an account granted only
through `superAdmins` was welcomed into the console and then refused by every
route it called — "Main Super Admin" in the header, "Super Admin access
required" on save. Keep the two lists in step if either gains a source.

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
- [ ] In Super Admin → Subscription Plans, create your plans — either paste the
      plan ids you created in the Razorpay dashboard, or let Scan2Plate create
      them from the prices you type
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
- **Hostel/salon domain screens.** Their *settings* now exist (rooms, beds,
  warden, mess charge, appointment slots) and persist, but there is no room
  allocation screen, resident register, mess roster or appointment calendar.
- **Upgrade proration.** Changing plan creates a new subscription; the old one
  must be cancelled. Razorpay's `update` API is not used.
- **The existing one-time ₹499 signup checkout** (`/api/subscriptions/create-order`)
  is untouched and still works. It is separate from this recurring system.
