/* Validates the JSON-LD on every indexable page.
 *
 * Parse errors are the obvious failure. The rest are the ones that get a site
 * penalised rather than merely ignored: review markup with no reviews,
 * FAQ markup whose questions are not on the page, and site-wide entities
 * repeated until a search engine has several to reconcile.
 */
import { readFileSync, readdirSync } from "node:fs";

const pages = readdirSync("public").filter(f => f.endsWith(".html"))
  .map(f => f.replace(/\.html$/, ""))
  .filter(n => !["404", "googled64db0c1a2415718"].includes(n))
  .filter(n => !/<meta[^>]*name="robots"[^>]*noindex/i.test(readFileSync(`public/${n}.html`, "utf8")));

const decode = s => s.replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'")
  .replace(/&#8377;/g,"₹").replace(/&mdash;/g,"—").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&nbsp;/g," ");
const plain = h => decode(h.replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();

const errors = [], counts = {};
for (const name of pages) {
  const html = readFileSync(`public/${name}.html`, "utf8");
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
  const seen = new Set();

  for (const [, raw] of blocks) {
    let doc;
    try { doc = JSON.parse(raw); }
    catch (e) { errors.push(`${name}: JSON-LD parse error - ${e.message.slice(0,70)}`); continue; }

    const type = doc["@type"];
    if (!doc["@context"]) errors.push(`${name}: ${type} has no @context`);
    if (seen.has(type)) errors.push(`${name}: duplicate ${type} block on one page`);
    seen.add(type);
    counts[type] = (counts[type] || 0) + 1;

    if (/aggregateRating|"@type"\s*:\s*"Review"/.test(raw))
      errors.push(`${name}: ${type} carries rating/review markup with no verified reviews`);

    if (type === "FAQPage") {
      for (const entry of doc.mainEntity || []) {
        // Schema that is not visible on the page violates Google's guidelines.
        const q = entry.name;
        if (!plain(html).includes(q.replace(/\s+/g," ")))
          errors.push(`${name}: FAQ question not visible on page - "${q.slice(0,50)}"`);
        const a = entry.acceptedAnswer?.text || "";
        if (a.length < 40) errors.push(`${name}: FAQ answer under 40 chars - "${q.slice(0,40)}"`);
      }
    }
    if (type === "BreadcrumbList") {
      const last = doc.itemListElement?.at(-1)?.item || "";
      const want = name === "index" ? "https://scan2plate.com/" : `https://scan2plate.com/${name}`;
      if (last !== want) errors.push(`${name}: breadcrumb ends at ${last}, expected ${want}`);
    }
    if (type === "Offer" || doc.offers) {
      const o = doc.offers || doc;
      if (o.priceCurrency && o.priceCurrency !== "INR") errors.push(`${name}: offer currency ${o.priceCurrency}`);
      if (o.price && String(o.price) !== "499") errors.push(`${name}: offer price ${o.price}, expected 499`);
    }
  }
}

// Site-wide entities must appear once, not on every page.
for (const [type, limit] of [["Organization", 1], ["WebSite", 1], ["SoftwareApplication", 2]])
  if ((counts[type] || 0) > limit)
    errors.push(`site: ${counts[type]} ${type} blocks across the site, expected at most ${limit}`);

console.log("schema blocks across the site:");
Object.entries(counts).sort((a,b)=>b[1]-a[1]).forEach(([t,n]) => console.log(`  ${String(n).padStart(3)}  ${t}`));
console.log(`\n${pages.length} indexable pages validated`);
if (errors.length) { console.log(`\nERRORS (${errors.length}):`); errors.slice(0,15).forEach(e=>console.log("  "+e)); process.exit(1); }
console.log("\nzero schema errors");
