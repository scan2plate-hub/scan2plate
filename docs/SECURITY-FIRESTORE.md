# Firestore security rules

## What the problem was

There was **no `firestore.rules` file in this repository**, and no `firestore`
section in `firebase.json`. A Firestore database with no rules deployed is open:
every document can be read, written and deleted by anyone holding the public web
API key — and that key ships inside the client bundle, so "anyone" means anyone
who opens DevTools on the live site.

That is not a theoretical exposure. Running the rules test suite against the
"no rules" state fails **18 of its 28 checks**. Among them, a stranger could:

- read every restaurant's **staff records and salaries**, attendance, payroll,
  expenses, purchase bills and inventory;
- **rewrite the UPI ID** in a restaurant's settings, redirecting its payments;
- mark any bill **paid**, edit any order, or **delete** orders outright;
- **upgrade any restaurant's plan** to Advance for free;
- **mint a 100% discount coupon**;
- rewrite subscription plan pricing;
- **make themselves a super admin**;
- edit or erase the audit log.

`public/restaurant-onboarding.html` made the read side trivially easy: it had no
sign-in code at all and printed a business's owner name, admin email, phone,
address, UPI ID and GST number for any Restaurant ID typed into its box.
Restaurant IDs are short and guessable (`RST006`).

## What is fixed now

### 1. `firestore.rules` — the actual fix

The shape of the app constrains what the rules can do. **Customers are not
signed in**: they scan a QR code and order. So the menu, the table list, the
restaurant's public profile and order creation must stay open to anonymous
callers. Everything a customer does not need is now closed.

| Data | Who can read | Who can write |
|---|---|---|
| Menu, tables, table QRs | anyone | restaurant staff |
| `settings/general` (UPI, tax %, geofence) | anyone — the customer cannot pay or pass the geofence without it | restaurant owner |
| Restaurant profile | anyone — the public ordering site lists restaurants | owner (update), super admin (create/delete) |
| `restaurants/{id}/private/*` | owner + super admin | owner + super admin |
| Staff, salaries, attendance, payroll, expenses, purchases, inventory | restaurant staff | restaurant staff |
| Any other subcollection | **owner only** | **owner only** |
| Orders | anyone (customers track their own order) | anyone may **create**; only signed-in staff may update or delete |
| Audit log | signed-in | append-only — **nobody** may edit or delete, including super admins |
| Subscription plans, offers | anyone (the pricing page) | super admin |
| `superAdmins` / `admins` | your own document only | **nobody from a client** |
| Anything else | nobody | nobody — default deny |

### Two access levels, and why the distinction matters

**Owner** is the restaurant's `adminUid`, or a super admin. Only the owner may
change `settings/general` (the UPI ID lives there), manage staff accounts, and
read `private/`.

**Staff** is the owner plus any `restaurants/{id}/users/{doc}` record whose
`uid` is the caller's and whose status has not been revoked — managers,
cashiers, kitchen. They can work the menu, orders, inventory, expenses and
attendance, but they are not owners.

Two traps were caught by the test suite while writing this, both of which would
have reached production:

1. **An owner-only `isStaffOf()` locked out every manager and cashier.** The
   first draft only checked `adminUid`. Non-owner staff have their own Firebase
   accounts, so the dashboard would have broken for all of them.

2. **A staff-level `match /{document=**}` catch-all leaked `private/`.** A
   recursive wildcard also matches `private/profile`, and Firestore grants
   access when **any** matching rule allows it — so the catch-all quietly
   overrode the owner-only rule above it. The catch-all is now owner-only.

A third trap is worth naming because it is silent: the staff document id is
derived from the e-mail with `replace()`, which takes a **regex**. An
unescaped `.` matches every character and mangles the address, so every staff
lookup fails and everyone is locked out. The dot is escaped as `\\.`, and a
mutation test confirms three tests fail without it.

### 2. The onboarding sheet is super-admin only

`restaurant-onboarding.html` now refuses to render anything without a super
admin session, and checks the Firebase session as well as `localStorage`,
because a `localStorage` entry is trivially forged. **This gate is defence in
depth, not the fix** — the rules are what actually protect the data, because
the REST API does not care what a web page decides to render.

### 3. Dead code with an unauthenticated plan escalation, deleted

`public/js/restaurant-onboarding.js` was **not referenced by any page**, but it
contained a "Save Plan" button wired to an unauthenticated
`updateDoc(restaurants/{id}, { plan })`. Had it ever been wired up, any visitor
could have upgraded any restaurant to Advance. The file is removed.

## Deploying the rules — this is the step that actually fixes it

**Nothing in this repository protects anything until the rules are deployed.**
Merging changes nothing on its own.

The project is **`scan2serve-23bf6`**, now set as the default in `.firebaserc`.
It previously held the literal placeholder `your-firebase-project-id`, so a
deploy would have failed before it started.

### 1. Sign in

```bash
npx firebase login          # opens a browser
npx firebase projects:list  # confirm scan2serve-23bf6 is listed
```

On a machine with no browser, use `npx firebase login --no-localhost`, or a
service account:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

### 2. Check what you are about to replace

The console shows the rules currently live at
**Firestore → Rules**. Today that is the default, which allows everything.
Copy it somewhere first if you want a way back.

### 3. Test, then deploy

```bash
npm install
npm run test:rules     # 36 tests against the emulator, on this same project id
npx firebase deploy --only firestore:rules --project scan2serve-23bf6
```

`test:rules` runs the rules being deployed, not a copy of them. If it fails,
do not deploy.

### 4. Smoke-test immediately, with a NON-owner account

The two faults fixed in #21 both only show up on a staff login, so testing as
the owner proves very little:

- [ ] Scan a table QR and place an order (unauthenticated customer path)
- [ ] Open the public "order from home" site and confirm restaurants list
- [ ] Sign in as a **manager or cashier** and open Inventory, Expenses and Staff
- [ ] Print a bill
- [ ] Sign in as the owner and open Settings

If anything is denied, the rules are too strict somewhere — the browser console
names the collection. Reverting is `firebase deploy` of the previous rules from
the console, or ask and it can be narrowed instead.

## Testing the rules

The rules are covered by 28 tests that run against the real Firestore emulator:

```bash
npm install
npm run test:rules
```

The suite asserts both directions — that a customer can still read a menu and
place an order, and that a stranger cannot read salaries or redirect payments.
Both halves matter: rules that pass only the "deny" tests would take the
business offline.

## The owner's login e-mail — fixed

`restaurants/{id}` used to hold `adminEmail`, `email` and `ownerName` alongside
the fields the public ordering site needs. Firestore rules are **document-level,
not field-level**, and the public site lists every restaurant, so that document
has to stay readable — which made `adminEmail` world-readable. That field names
the login account for every business on the platform.

Those three fields now live in `restaurants/{id}/private/profile`, which the
rules restrict to the restaurant's own admin and to super admins.

### What deliberately did NOT move

| Field | Why it stays public |
|---|---|
| `phone` | The order tracking page renders a **Call Staff** button from it. It is business contact information the customer is meant to have. |
| `adminUid` | An opaque Firebase id, not a credential — and `firestore.rules` reads it from the root document to decide who owns the restaurant. |
| `upiId`, `gstNumber`, `taxPercent` | The customer cannot pay or read their bill without them, and they are already in the publicly readable `settings/general`. A GST number is printed on every invoice by law. |

### The code

`public/js/restaurant-private.js` is the single place that decides what is
private. `splitRestaurantPayload()` is used by every writer, and
`mergeRestaurantProfile()` / `ownerEmailOf()` by every reader — so a restaurant
migrated and one not yet migrated both read correctly, and there is no window
where the dashboard shows a dash instead of an e-mail.

Writers updated: `add-restaurant.js`, `business-panel.js`.
Readers updated: `super-admin-dashboard.js`, `restaurant-list.js`,
`restaurant-onboarding.html`, `business-panel.js`.

`business-panel.js` was writing the **same payload** to `settings/general` *and*
the root document, so it was leaking the owner name into a second publicly
readable place. Both writes are now split.

### A third unauthenticated admin page

`public/restaurant-list.html` had **no sign-in code at all**. It listed every
business with its owner e-mail and carried working **Suspend**, **Activate** and
**Renew +30d** buttons. It is now super-admin gated, like the onboarding sheet,
and checks the Firebase session as well as `localStorage`.

## Running the backfill — this is the step that removes the data

Deploying the rules does **not** move anything. Existing restaurants keep their
`adminEmail` in the public document until this runs:

```bash
cd backend                      # where firebase-admin is installed
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json

node ../scripts/migrate-private-profile.mjs           # dry run — shows the plan, changes nothing
node ../scripts/migrate-private-profile.mjs --apply   # performs the move
```

It copies to `private/profile` **before** deleting from the public document, one
restaurant at a time, so an interrupted run can never lose a field — worst case
a rerun repeats the copy. It is idempotent, and one restaurant failing does not
stop the rest. Eleven tests cover it, including both interruption points.

Afterwards, confirm in the Firebase console that a restaurant document no longer
has an `adminEmail` field, and that the super admin dashboard still shows owner
e-mails in its business list.

---

### A note on dependencies

`npm run test:rules` needs `firebase-tools`, `firebase` and
`@firebase/rules-unit-testing`, which are declared in `devDependencies` but are
**not** committed into the repository's `node_modules/` — `firebase-tools` alone
is several hundred megabytes. Run `npm install` once before `npm run test:rules`.

Nothing in the customer-facing app depends on these; they are test tooling only.
