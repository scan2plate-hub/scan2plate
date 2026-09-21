# Scan2Plate keyword map

**Status:** contract for SEO phases 3–7. Every title, H1, body rewrite and
internal link in those phases must match this file. If a page argues for a
different keyword, change this file first, then the page.

**Last updated:** 2026-09-21

---

## The rule this file exists to enforce

One primary keyword belongs to exactly one URL. No primary keyword appears
twice. That is not a style preference — it is the fix for the specific problem
measured below.

## Measured baseline (2026-09-21)

Run `node scripts/page-similarity.mjs` to reproduce.

| Metric | Value |
| --- | --- |
| Solution pages measured | 14 |
| Page pairs compared | 91 |
| Pairs at or above 30% similar | **78** |
| Worst pair | **68.4%** — `/restaurant-analytics` ↔ `/cafe-billing-software` |
| Median page length | ~336 words |
| Longest | `/pricing`, 443 words |
| Shortest | `/download`, 226 words |

Measured as Sørensen–Dice over word 5-grams on visible body text, with nav,
header, footer and script content stripped. Shared chrome is not duplicate
content, so counting it would flatter or damn every page equally. Bag-of-words
would call two pages identical for merely sharing vocabulary; 5-grams only
match where the same phrasing genuinely runs on.

**What this means.** Fourteen pages are competing for overlapping terms with
near-identical text. Google picks one and discards the rest — which is
consistent with only `/` and `/about` being found in the index. The fix is not
more pages; it is making each existing page genuinely about one thing.

---

## Allocation — existing URLs

| URL | Primary keyword | Secondary keywords | Intent | The one question this page answers |
| --- | --- | --- | --- | --- |
| `/` | restaurant billing software India | restaurant management software, QR ordering software | Commercial | What is Scan2Plate and what does it cost? |
| `/restaurant-billing-software` | restaurant billing software | GST billing restaurant, billing software with KOT | Commercial | How does Scan2Plate handle a restaurant bill from order to payment? |
| `/restaurant-pos` | restaurant POS software India | POS billing system restaurant, counter billing software | Commercial | What does Scan2Plate replace at the billing counter? |
| `/restaurant-qr-ordering` | QR ordering system for restaurants | scan and order, contactless ordering India | Commercial | How does a customer order by scanning a QR code at the table? |
| `/digital-menu` | digital menu software | QR code menu for restaurant, online menu card | Commercial | How do I put my menu online and change prices without reprinting? |
| `/table-ordering-system` | table ordering system | table management software restaurant | Commercial | How do I track which table ordered what, and who is still seated? |
| `/kitchen-display-system` | kitchen display system India | KDS software, KOT display screen | Commercial | How do orders reach the kitchen without paper tickets? |
| `/restaurant-inventory` | restaurant inventory management software | stock management restaurant, bill OCR inventory | Commercial | How do I know what stock I have without counting it by hand? |
| `/restaurant-analytics` | restaurant sales report software | restaurant analytics dashboard, daily sales report | Commercial | What did my restaurant actually earn today, and on what? |
| `/cafe-billing-software` | cafe billing software | coffee shop POS India, cafe management software | Commercial | What changes when Scan2Plate runs a cafe rather than a restaurant? |
| `/cloud-kitchen-software` | cloud kitchen software India | cloud kitchen POS, delivery-only restaurant software | Commercial | How does a delivery-only kitchen with no dine-in use Scan2Plate? |
| `/restaurant-management-software` | restaurant management software India | all-in-one restaurant software | Commercial | What does running the whole restaurant on one system look like? |
| `/petpooja-alternative` | Petpooja alternative | Petpooja vs Scan2Plate, cheaper Petpooja alternative | Commercial | How does Scan2Plate compare with Petpooja, and when is Petpooja the better choice? |
| `/pricing` | restaurant billing software price India | affordable restaurant POS ₹499 | Transactional | What does Scan2Plate cost and what is not included? |
| `/download` | offline restaurant POS software | restaurant billing software without internet, restaurant POS for Windows | Commercial | What keeps working when the internet goes down mid-service? |

## Allocation — new URLs

| URL | Primary keyword | Intent | The one question this page answers |
| --- | --- | --- | --- |
| `/gst-billing-software-restaurant` | GST billing software for restaurant | Commercial | How does Scan2Plate produce a GST-compliant restaurant bill? |
| `/kot-software` | KOT software for restaurant | Informational → commercial | What is a KOT and how does Scan2Plate generate one? |
| `/food-court-billing-software` | food court billing software | Commercial | How do several counters in one food court bill under one system? |
| `/hotel-restaurant-billing-software` | hotel restaurant billing software | Commercial | How do restaurant charges post to a hotel room bill? |
| `/restaurant-pre-order-system` | restaurant pre-order with advance payment | Commercial | How do customers order and pay before they arrive? |
| `/case-studies/old-monk-cafe-darbhanga` | restaurant billing software case study India | Informational | What happened when a real cafe in Darbhanga switched to Scan2Plate? |

## Pages deliberately left out of keyword targeting

`/about`, `/contact`, `/demo`, `/features`, `/blog`, `/cookie-policy`,
`/privacy-policy`, `/refund-policy`, `/terms-of-service`.

These serve navigation, conversion, trust or legal duty. Assigning them a
commercial keyword would put them back into competition with the solution
pages, which is the problem this file exists to end. `/features` in particular
must stay a hub that links out, not a page that tries to rank for
"restaurant management software" against `/restaurant-management-software`.

---

## Internal linking

Descriptive anchor text, 4–8 contextual links per page, placed in the body
where they make sense — not a repeated block of nine identical links at the
foot of every page, which is what exists today and which tells a search engine
nothing about which page is about what.

| Page | Links out to | Receives links from |
| --- | --- | --- |
| `/` | billing-software, qr-ordering, pricing, download, petpooja-alternative | every page (logo/nav) |
| `/restaurant-billing-software` | gst-billing-software-restaurant, kot-software, restaurant-pos, pricing | `/`, features, pos, management-software |
| `/restaurant-pos` | billing-software, table-ordering-system, download, pricing | `/`, billing-software, cafe-billing-software |
| `/restaurant-qr-ordering` | digital-menu, table-ordering-system, restaurant-pre-order-system, kot-software | `/`, digital-menu, cafe-billing-software |
| `/digital-menu` | qr-ordering, menu pricing section, restaurant-pre-order-system | qr-ordering, cafe-billing-software |
| `/table-ordering-system` | qr-ordering, restaurant-pos, kot-software | qr-ordering, pos |
| `/kitchen-display-system` | kot-software, restaurant-pos, cloud-kitchen-software | kot-software, billing-software |
| `/restaurant-inventory` | restaurant-analytics, management-software, pricing | management-software, analytics |
| `/restaurant-analytics` | restaurant-inventory, management-software, pricing | inventory, management-software |
| `/cafe-billing-software` | qr-ordering, digital-menu, restaurant-pos, pricing | `/`, pos |
| `/cloud-kitchen-software` | kitchen-display-system, restaurant-pre-order-system, download | kds, pre-order |
| `/restaurant-management-software` | billing-software, inventory, analytics, staff/payroll section, pricing | `/`, features |
| `/petpooja-alternative` | pricing, download, billing-software, case study | `/`, pricing |
| `/pricing` | `/`, demo, all solution pages as a comparison table | every solution page (CTA) |
| `/download` | restaurant-pos, pricing, cloud-kitchen-software | `/`, pos, petpooja-alternative |
| `/gst-billing-software-restaurant` | billing-software, kot-software, pricing | billing-software |
| `/kot-software` | kitchen-display-system, billing-software, table-ordering-system | kds, billing-software, qr-ordering |
| `/food-court-billing-software` | restaurant-pos, qr-ordering, pricing | pos |
| `/hotel-restaurant-billing-software` | restaurant-pos, billing-software, pricing | pos |
| `/restaurant-pre-order-system` | qr-ordering, cloud-kitchen-software, pricing | qr-ordering, cloud-kitchen |
| `/case-studies/old-monk-cafe-darbhanga` | `/`, pricing, billing-software | `/`, about, petpooja-alternative |

---

## Where the effort should go

The three pages below are the only ones targeting something competitors are
not already writing about. DineOpen, MenuScan, Zyrio, XMenuQR and BharatERP all
publish "restaurant billing software" pages; none of them writes seriously
about billing through an internet outage, or pre-orders with advance payment.

1. **`/download`** — offline POS. Currently the shortest page on the site at
   226 words, targeting the strongest differentiator. Worst ratio of effort to
   opportunity anywhere in this map.
2. **`/restaurant-pre-order-system`** — does not exist yet.
3. **`/restaurant-inventory`** — bill OCR auto-populating stock is unusual at
   this price point and is currently buried.

## Facts that may be used on any page

Only these. Anything else needs a source or an owner TODO.

- ₹499/month per restaurant, every feature included, nothing gated by tier.
- One named customer: **Old Monk Cafe, Darbhanga**. Write "restaurants like
  Old Monk Cafe in Darbhanga", never "hundreds of restaurants".
- Offline desktop/mobile app keeps billing during an outage, then syncs.
- Inventory can be populated from a supplier bill via OCR.
- Pre-orders support advance payment.
- Platforms: Windows, macOS, Android, Linux.

**No invented numbers.** No customer counts, no ratings, no `aggregateRating`
schema. A fabricated statistic is worse than a missing one: it is the thing
that gets a manual penalty and destroys the AEO trust this whole exercise is
meant to build.
