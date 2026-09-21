/* SEO acceptance gate.
 *
 * Checks the things the rebuild brief lists as its bar, so every later phase
 * can be verified the same way instead of by eye. Exits non-zero on failure.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";


const MARKETING = [
  "index", "about", "contact", "demo", "features", "pricing", "download", "blog",
  "restaurant-billing-software", "restaurant-pos", "restaurant-qr-ordering", "digital-menu",
  "table-ordering-system", "kitchen-display-system", "restaurant-inventory", "restaurant-analytics",
  "cafe-billing-software", "cloud-kitchen-software", "restaurant-management-software",
  "petpooja-alternative", "cookie-policy", "privacy-policy", "refund-policy", "terms-of-service"
];
const OPERATIONAL = [
  "admin-login", "admin-dashboard", "super-admin-login", "super-admin-dashboard",
  "restaurant-onboarding", "qr-generator", "kitchen-dashboard", "track", "customer-order",
  "bill", "restaurant-list", "add-restaurant", "renew", "cafe-token-panel",
  "cloud-kitchen-panel", "food-court-panel", "hotel-room-panel", "vendor-panel"
];

// Blog posts are marketing pages too. They were not covered at first, which is
// exactly why five of them shipped with over-length titles. This must sit after
// MARKETING is declared: placed above it, the push throws on the temporal dead
// zone and a try/catch swallows it, leaving the audit silently narrower.
try {
  for (const f of readdirSync("public/blog").filter(n => n.endsWith(".html") && n !== "index.html"))
    MARKETING.push(`blog/${f.replace(/\.html$/, "")}`);
} catch { /* no blog yet */ }

const problems = [];
const warn = [];
const fail = (page, msg) => problems.push(`${page}: ${msg}`);
const soft = (page, msg) => warn.push(`${page}: ${msg}`);
const read = name => readFileSync(`public/${name}.html`, "utf8");
const textOf = s => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();

for (const page of MARKETING) {
  if (!existsSync(`public/${page}.html`)) { fail(page, "file missing"); continue; }
  const html = read(page);

  const h1s = html.match(/<h1[\s>]/gi) || [];
  if (h1s.length !== 1) fail(page, `${h1s.length} <h1> (want exactly 1)`);

  const title = textOf((html.match(/<title>([\s\S]*?)<\/title>/i) || [, ""])[1]);
  if (!title) fail(page, "no <title>");
  else if (title.length < 50 || title.length > 60) soft(page, `title ${title.length} chars (want 50-60): "${title}"`);

  const desc = textOf((html.match(/<meta\s+name="description"\s+content="([^"]*)"/i) || [, ""])[1]);
  if (!desc) fail(page, "no meta description");
  else if (desc.length < 150 || desc.length > 160) soft(page, `description ${desc.length} chars (want 150-160)`);

  const canonical = (html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]*)"/i) || [, ""])[1];
  if (!canonical) fail(page, "no canonical");
  else {
    const want = page === "index" ? "/" : `/${page}`;
    const got = canonical.replace(/https?:\/\/[^/]+/, "") || "/";
    if (got !== want) fail(page, `canonical points at ${got}, expected ${want}`);
  }

  if (/aggregateRating/i.test(html)) fail(page, "aggregateRating present with no real reviews on page");
  if (/<meta[^>]*name="robots"[^>]*noindex/i.test(html)) fail(page, "marketing page is noindex");

  for (const block of html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || []) {
    const json = block.replace(/<[^>]+>/g, "");
    try { JSON.parse(json); } catch (e) { fail(page, `invalid JSON-LD: ${e.message.slice(0, 60)}`); }
  }
}

for (const page of OPERATIONAL) {
  if (!existsSync(`public/${page}.html`)) continue;
  if (!/<meta[^>]*name="robots"[^>]*noindex/i.test(read(page))) fail(page, "operational page is indexable");
}

// Every primary keyword in the map must be unique.
if (existsSync("docs/seo-keyword-map.md")) {
  const md = readFileSync("docs/seo-keyword-map.md", "utf8");
  const allocation = md.slice(0, md.indexOf("## Internal linking"));
  const rows = allocation
    .split("\n").filter(l => /^\| `\//.test(l))
    .map(l => l.split("|").map(c => c.trim()));
  const seen = new Map();
  rows.forEach(cells => {
    const [, url, kw] = cells;
    if (!kw) return;
    if (seen.has(kw)) fail("keyword-map", `"${kw}" used by both ${seen.get(kw)} and ${url}`);
    else seen.set(kw, url);
  });
  console.log(`keyword map: ${seen.size} unique primary keywords`);
} else {
  fail("docs", "seo-keyword-map.md missing");
}

// Nothing should still point at the deleted 2.4MB duplicate.
const dangling = readdirSync("public").filter(f => f.endsWith(".html"))
  .filter(f => readFileSync(`public/${f}`, "utf8").includes("placeholder-food"));
if (dangling.length) fail("assets", `placeholder-food referenced by ${dangling.join(", ")}`);

console.log(`\nchecked ${MARKETING.length} marketing + ${OPERATIONAL.length} operational pages`);
if (warn.length) { console.log(`\nwarnings (${warn.length}) — phase 3 fixes these:`); warn.slice(0, 8).forEach(w => console.log("  " + w)); if (warn.length > 8) console.log(`  …and ${warn.length - 8} more`); }
if (problems.length) { console.log(`\nFAILURES (${problems.length}):`); problems.forEach(p => console.log("  " + p)); process.exit(1); }
console.log("\nno failures");
