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
| Orders | anyone (customers track their own order) | anyone may **create**; only signed-in staff may update or delete |
| Audit log | signed-in | append-only — **nobody** may edit or delete, including super admins |
| Subscription plans, offers | anyone (the pricing page) | super admin |
| `superAdmins` / `admins` | your own document only | **nobody from a client** |
| Anything else | nobody | nobody — default deny |

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

**Nothing above protects anything until the rules are deployed.** Committing the
file changes nothing on its own.

```bash
npx firebase deploy --only firestore:rules
```

Verify in the Firebase console under **Firestore → Rules** that the published
rules are dated after this deploy, then re-check that the app still works:
scan a table QR and place an order, open the admin dashboard, and print a bill.

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

## What is NOT fixed yet

**Owner contact details are still readable in the restaurant's root document.**

`restaurants/{id}` currently holds `ownerName`, `adminEmail`, `email`, `phone`,
`adminUid`, `upiId` and `gstNumber` alongside the fields the public ordering
site needs (name, city, business type, whether it is accepting orders).

Firestore rules are **document-level, not field-level** — there is no way to
allow reading some fields of a document and not others. And the public "order
from home" site lists every restaurant, so that document has to stay publicly
readable for that feature to work.

`adminEmail` is the field that matters: it names the login account for every
business on the platform, which is the first half of an account takeover.

The rules already define `restaurants/{id}/private/*` as owner-only, so the
destination exists. What remains is the move itself, which is a real change and
should be done deliberately rather than bundled here:

**Option A — move the private fields out (recommended).** Copy `ownerName`,
`adminEmail`, `email`, `phone` and `adminUid` into
`restaurants/{id}/private/profile`, delete them from the root document, and
update the three writers (`add-restaurant.js`) and readers
(`super-admin-dashboard.js`, `business-panel.js`). Cost: the super admin
business list needs one extra document read per restaurant, and its
search-by-email needs rethinking.

**Option B — add a public projection.** Keep the root document private and give
the public site a `restaurants/{id}/public/card` document holding only the
discovery fields. Cost: it changes the customer ordering path, which is the
revenue path, so it carries more risk than Option A.

Either way a one-time backfill is needed for the restaurants that already exist.

Until one of these is done, treat `adminEmail` on the platform as public
information, and make sure every admin account has a strong, unique password.

---

### A note on dependencies

`npm run test:rules` needs `firebase-tools`, `firebase` and
`@firebase/rules-unit-testing`, which are declared in `devDependencies` but are
**not** committed into the repository's `node_modules/` — `firebase-tools` alone
is several hundred megabytes. Run `npm install` once before `npm run test:rules`.

Nothing in the customer-facing app depends on these; they are test tooling only.
