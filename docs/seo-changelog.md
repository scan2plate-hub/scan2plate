# SEO and AEO rebuild — changelog and owner handover

**Completed:** 21 September 2026
**Branch:** `claude/upbeat-dirac-xs1vqa` — 10 commits, `a510c69` to `dbd7af5`

Reproduce every number here with `npm run seo:check`.

---

## Read this first

One finding outranks everything else in this document, and it is not an SEO
problem.

### `restaurant-onboarding.html` may be exposing customer data

That page has **no authentication code at all** — no `auth` import, no
`currentUser`, no `onAuthStateChanged`. Type any Restaurant ID into its box and
it reads the business record and renders **owner name, admin email, phone,
address, UPI ID, GST number and coordinates**.

IDs are trivially guessable. `RST006` and `RST_OLD_MONK` are hardcoded in your
own HTML; `RST001`–`RST006` and `RST_BALAJI_CAFE` appear in screenshots.

**There is no `firestore.rules` file in this repository.** Your rules are
unversioned and could not be checked from here. The page is a thin client, so
those rules are the only thing standing between an enumerated ID and a
customer's UPI ID and GST number.

**What to do today:**

1. Firebase Console → Firestore → Rules. Check whether `match /restaurants/{id}`
   allows unauthenticated `read`.
2. Commit that file to this repository so it is reviewable.
3. If reads are open, restrict them to the authenticated owner and treat it as
   a disclosure incident.

This rebuild added `noindex` to that page, which removes it from search. **That
is not a fix.** It does nothing about anyone who has the URL.

---

## What changed, by phase

### Phase 1 — page weight and indexability (`a510c69`)

| | Before | After |
| --- | --- | --- |
| Hero image | 2.44 MB JPEG | 103 KB WebP + 113 KB JPEG fallback |
| Logo | 37.7 KB PNG | 5 KB WebP |
| Menu-item placeholder | **2.55 MB** | 468-byte SVG |
| Operational pages indexable | 18 | 0 |
| Pages with `lang` | 29 correct, 15 `en`, 5 with none | **48 of 48** `en-IN` |

`public/` holds 49 `.html` files; the 49th is
`googled64db0c1a2415718.html`, the Search Console verification token, which has
no `<html>` element and is excluded from every check in this rebuild.

The hero was the LCP element and carried **both** `<link rel=preload>` and
`loading="lazy"` — contradictory instructions. Now a `<picture>` with explicit
dimensions and `fetchpriority="high"`.

`placeholder-food.jpg` was a **byte-identical copy** of the 2.4 MB hero (same
md5) and was the fallback for a menu item with no photo. Every menu with a
missing image pulled 2.4 MB into a 120px thumbnail on a customer's phone. That
is a customer-facing performance fix, not an SEO one, and the crawl report
never mentioned it.

The 404 claimed `rel=canonical` to itself and carried six JSON-LD blocks
including `Organization` and `SoftwareApplication` — an error page asserting it
was the product. Reduced to one `WebPage` block.

### Phase 2 — keyword map (`370494c`)

Measured the duplication rather than asserting it. `scripts/page-similarity.mjs`
uses Sørensen–Dice over word 5-grams on visible body text, nav and footer
stripped.

**Baseline: 78 of 91 page pairs ≥30% similar. Worst pair 68.4%.** Median page
336 words.

`docs/seo-keyword-map.md` assigns one primary keyword to exactly one URL across
21 URLs. Nine pages are deliberately left untargeted — giving `/features` a
commercial keyword would put it straight back into competition with
`/restaurant-management-software`.

### Phase 3 — titles, descriptions, headings (`043a107`)

All 24 marketing pages moved inside 50–60 character titles and 150–160
character descriptions. The audit went from **42 warnings to 0**.

The homepage `<h1>` was `Run Your Restaurant<br>From One Simple Platform.` — the
`<br>` with no surrounding space is what rendered as "RestaurantFrom".

Six headings appeared **identically on 21–22 pages** (`Quick answer`,
`How it works`, `Benefits`, `FAQ`, `Related Scan2Plate pages`, `Ready to review…`).
All now page-specific.

Several pages carried the **homepage's Open Graph title**, so every social share
of any page looked like a share of the homepage.

Full before/after: `docs/seo-title-meta.md`.

### Phase 4 — rewriting the thin pages (`331e9cf`, `866a813`, `506e40e`, `541826f`)

All 14 solution pages rewritten to 916–1,218 words, in four batches so they
could not collapse into one template.

**Result: 0 of 91 pairs ≥30%. Worst pair 4.8%.**

Each was written from what the code actually does:

- `/download` — the offline sync is idempotent. Each bill carries
  `OFF-<restaurant>-<date>-<uuid>` generated on the device, and sync uploads
  only what the server lacks, so an interrupted sync resumes without
  double-counting. Verified in `test/mobile-offline-core-parity.test.mjs`.
- `/restaurant-billing-software` — bill numbers are allocated in a database
  transaction, and **a cancelled bill retires its number** rather than reusing
  it. That is a GST audit argument, pinned by `test/bill-serial.test.mjs`.
- `/restaurant-qr-ordering` — the location check in `public/js/customer.js`
  refuses orders beyond a set radius, 150 m by default. A QR code is a public
  link; this is the fraud angle nobody in the segment writes about.

**Claims deliberately limited**, because a buyer discovering a limit after
paying is a refund and a bad review:

- No delivery aggregator integration (`/cloud-kitchen-software`)
- No recipe-level ingredient costing (`/restaurant-inventory`)
- Not accounting software, does not file GST returns (`/restaurant-analytics`)
- No centralised multi-branch control (`/restaurant-management-software`)

`/petpooja-alternative` states **no Petpooja price, tier or contract term**.
None was verifiable from here, and a comparison page that guesses a
competitor's pricing is unfair to them and a liability for you. It compares on
four dimensions instead and has a genuine "when Petpooja is the better choice"
section. See the owner tasks below to fill it in properly.

### Phase 5 — structured data (`0afbd6f`)

| | Before | After |
| --- | --- | --- |
| `Organization` blocks | 22 | **1** |
| `WebSite` blocks | 22 | **1** |
| `SoftwareApplication` blocks | 22 | **2** (`/` and `/pricing`) |
| Duplicate FAQ questions | 89 | **0** |
| Unique FAQ questions | — | 93 |
| `aggregateRating` | — | none, anywhere |

FAQ markup is now **generated from the visible page** by
`scripts/build-schema.mjs`, which reads each page's `<details>` blocks. Google
requires the two to match; generating one from the other makes drift
impossible.

`sameAs` on `Organization` links the GitHub org. That is the actual mechanism
for stopping your repository outranking your site on a brand search — it tells
a search engine the two are one entity.

Added `public/llms.txt`: what Scan2Plate is, pricing, features, key URLs, **who
it is not for**, and an explicit statement that no customer counts or ratings
are published.

### Phase 6 — sitemaps, and the root cause (`26ffaa8`)

**`scripts/generate-seo.mjs` is what produced every problem above.** 680 lines
that wrote the identical FAQPage onto every page, the flat sitemap with
hardcoded `lastmod`, and ~410-word near-identical pages. Its `ensureFile()`
calls `writeFileSync` unconditionally, so **`npm run generate:seo` would have
overwritten the entire rebuild in one command.** It now refuses to run.

It also wrote every page **twice** — `<slug>.html` and `<slug>/index.html` —
leaving **33 directory copies, each a stale version of its flat page and each
asserting the same `rel=canonical`**. `/pricing` had an 18,776-byte rewritten
page and a 12,921-byte copy both claiming to be the same URL.

They were **synced byte-for-byte rather than noindexed**: which copy Firebase
serves for a clean URL is a precedence question, and guessing wrong would have
noindexed your real pages. `scripts/sync-directory-copies.mjs` keeps them
identical and runs in `predeploy`.

**Eight blog category pages** were live, indexable, correctly canonical, in no
sitemap, and had zero posts to list. Eight thin pages. Now temporarily
`noindex,follow` until each lists three posts.

`sitemap.xml` is now an index over `sitemap-pages`, `sitemap-solutions` and
`sitemap-blog`. `lastmod` comes from `git log -1 --format=%cI`. `priority` and
`changefreq` removed entirely. All 24 original URLs preserved; `/case-studies`,
`/security` and `/testimonials` added — they existed but had never been listed.

### Phase 7 — the blog (`dbd7af5`)

Five posts, 1,206–1,335 words, each with `Article` schema, byline, dates, table
of contents, internal links and one CTA. Worst similarity against anything else
on the site: 4.5%.

`best-restaurant-billing-software-india-2026` **opens with "Scan2Plate is our
product"** and prints no competitor prices, for the same reason as the Petpooja
page.

---

## Final state

| Metric | Before | After |
| --- | --- | --- |
| Page pairs ≥30% similar | 78 / 91 | **0 / 91** |
| Worst pair | 68.4% | **4.8%** |
| Solution page length | 336 avg | 916–1,218 |
| Schema errors | — | **0** |
| Sitemap errors | — | **0** |
| Duplicate FAQ questions | 89 | **0** |
| Indexable pages in sitemap | 24 | **32** |
| Blog posts | 0 | **5** |
| Hero image | 2.44 MB | **103 KB** |

`npm run predeploy` runs: blog → schema → directory sync → sitemaps → four
gates. Wire it into your deploy so none of this can silently rot.

```
npm run seo:check     # audit + schema + sitemap + similarity
```

---

## What only you can do

### 1. Security — today

- [ ] Check Firestore rules on `restaurants/{id}` (see the top of this file)
- [ ] Commit `firestore.rules` to this repository
- [ ] Decide on repository privacy. The public repo contains PRs discussing
      Razorpay plan IDs, coupon logic and Super Admin auth, and it outranks your
      own site on a brand search. GitHub Pages needs a paid plan for private
      repos; **Cloudflare Pages and Netlify do it free.**

### 2. Search Console and indexing — week one

- [ ] Verify the property in Google Search Console and Bing Webmaster Tools
- [ ] Submit `https://scan2plate.com/sitemap.xml` (the index; the three children
      are listed inside it)
- [ ] Request indexing for `/`, `/pricing`, `/restaurant-billing-software`,
      `/download` and `/petpooja-alternative` first
- [ ] Re-check coverage after two weeks. Only `/` and `/about` were indexed
      before this work

### 3. Entity and trust signals

- [ ] Create a **Google Business Profile** — needs a physical address
- [ ] Create LinkedIn, Instagram and YouTube profiles, then add each URL to
      `sameAs` in `scripts/build-schema.mjs` and rebuild. **Only add profiles
      that exist** — an unreachable URL in `sameAs` is worse than a short list
- [ ] Add the registered business address to `scripts/build-schema.mjs` as a
      `PostalAddress`, and to `/contact`
- [ ] Replace the blog `AUTHOR` in `content/blog-posts.mjs` with a real named
      person once someone is willing to be named, and add a bio to `/about`.
      An Organization author is valid schema but a named human is a materially
      stronger signal

### 4. Listings and links — cannot be done from a repository

- [ ] Get listed on Capterra, G2, SoftwareSuggest, GetApp, Techjockey, SaaSworthy
- [ ] Ask satisfied restaurants for reviews on those profiles. **Do not add
      `aggregateRating` schema until real reviews exist on the page** — fake
      review markup earns a manual penalty
- [ ] Local links: Bihar restaurant associations, local press, Darbhanga
      business directories

### 5. Content gaps I left open

- [ ] **12 screenshots.** Every one is marked `<!-- TODO(owner): screenshot of … -->`
      in the page it belongs to. Phone photos of the real screens beat nothing.
      The highest-value three: the desktop app billing with the offline
      indicator, the Inventory screen showing parsed OCR rows, and the kitchen
      display with tickets in different states
- [ ] **Old Monk Cafe case study.** Even without metrics, what they did before
      and what changed operationally would make it the most persuasive page on
      the site. It is currently the weakest
- [ ] **Petpooja figures.** Verify price, tiers, offline support and contract
      length at their pricing page on a specific date, then fill the table in
      `public/petpooja-alternative.html` — the HTML comment there says exactly
      what to add and where
- [ ] **GST rates.** `public/blog/restaurant-gst-billing-guide-india.html`
      carries TODOs on the rate table and the composition scheme. Confirm with
      your CA or at cbic-gst.gov.in before promoting that post, and update
      `dateModified`
- [ ] **Five new URLs** from the keyword map were never built:
      `/gst-billing-software-restaurant`, `/kot-software`,
      `/food-court-billing-software`, `/hotel-restaurant-billing-software`,
      `/restaurant-pre-order-system`. The sitemap builder picks them up
      automatically once the files exist

### 6. Housekeeping

- [ ] Delete `scripts/generate-seo.mjs` once nothing references it
- [ ] Once you know which copy Firebase serves for a clean URL, delete the other
      set and retire `scripts/sync-directory-copies.mjs`
- [ ] Remove the temporary `noindex` from a blog category once it lists three
      posts

---

## What was not done, and why

- **No invented statistics anywhere.** No customer counts, no ratings, no
  `aggregateRating`. Every numeric claim on the solution pages is ₹499,
  150 metres or ₹0. One named customer: Old Monk Cafe, Darbhanga.
- **No competitor pricing**, on either the Petpooja page or the blog roundup.
- **No pagination or category filtering on `/blog`.** The repository had no
  existing pattern for it, and the brief said not to invent infrastructure.
- **Real Razorpay verification** is unrelated to SEO but still outstanding from
  earlier work: no live payment has been tested end to end.
