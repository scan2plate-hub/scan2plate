#!/usr/bin/env node
/* Generates the sitemap index and its three child sitemaps.
 *
 * Why this is a script and not a hand-edited file: the old sitemap.xml carried
 * lastmod 2026-07-29 on pages that had changed weeks later. A lastmod a search
 * engine can prove wrong makes it distrust every date in the file, which is
 * worse than omitting them. Dates here come from git, so they cannot go stale
 * without someone deliberately bypassing this.
 *
 * priority and changefreq are deliberately absent. Google has ignored both for
 * years, and the previous file set priority 0.9 on nearly everything, which
 * communicates nothing even to a crawler that did read it.
 *
 * Run: node scripts/build-sitemap.mjs   (wire into deploy)
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SITE = "https://scan2plate.com";

// Navigation, conversion, trust and legal. Things a visitor reaches directly.
const PAGES = ["index", "about", "contact", "demo", "features", "pricing", "download",
  "blog", "cookie-policy", "privacy-policy", "refund-policy", "terms-of-service",
  "security", "testimonials", "case-studies"];

// Everything that targets a commercial keyword.
const SOLUTIONS = ["restaurant-billing-software", "restaurant-pos", "restaurant-qr-ordering",
  "digital-menu", "table-ordering-system", "kitchen-display-system", "restaurant-inventory",
  "restaurant-analytics", "cafe-billing-software", "cloud-kitchen-software",
  "restaurant-management-software", "petpooja-alternative",
  // Phase 4 additions appear here automatically once the files exist.
  "gst-billing-software-restaurant", "kot-software", "food-court-billing-software",
  "hotel-restaurant-billing-software", "restaurant-pre-order-system"];

const exists = n => { try { return statSync(`public/${n}.html`).isFile(); } catch { return false; } };

/** Real last-modified date, from the file's last commit. */
function lastmod(name) {
  // A category is a directory with an index.html; everything else is a file.
  const direct = `public/${name}.html`;
  const file = existsSync(direct) ? direct : `public/${name}/index.html`;
  try {
    const iso = execFileSync("git", ["log", "-1", "--format=%cI", "--", file], { encoding: "utf8" }).trim();
    // %cI renders in the COMMITTER'S timezone offset, so slicing the string
    // takes that person's calendar day, not UTC's. A merge committed at
    // 02:59 +05:30 slices to a date that is still tomorrow in UTC, and
    // validate-sitemap.mjs — which compares against UTC, as a crawler does —
    // then rejects every page in the file as modified in the future. Parse it
    // and re-render in UTC so the date means the same thing to both.
    if (iso) return new Date(iso).toISOString().slice(0, 10);
  } catch { /* not a git checkout, or the file is untracked */ }
  // A file git does not know about is genuinely new; its mtime is the honest
  // answer, and is still better than a hardcoded date.
  return new Date(statSync(file).mtime).toISOString().slice(0, 10);
}

const url = n => n === "index" ? `${SITE}/` : `${SITE}/${n}`;

/** A page is listed only if it is real, indexable and canonical to itself. */
function includable(name) {
  if (!exists(name)) return false;
  const html = readFileSync(`public/${name}.html`, "utf8");
  if (/<meta[^>]*name="robots"[^>]*noindex/i.test(html)) return false;
  const canonical = (html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]*)"/i) || [, ""])[1];
  if (!canonical) { console.warn(`  skipped ${name}: no canonical`); return false; }
  if (canonical.replace(/\/$/, "") !== url(name).replace(/\/$/, "")) {
    console.warn(`  skipped ${name}: canonical points elsewhere (${canonical})`);
    return false;
  }
  return true;
}

function urlset(names) {
  const rows = names.filter(includable)
    .map(n => `  <url>\n    <loc>${url(n)}</loc>\n    <lastmod>${lastmod(n)}</lastmod>\n  </url>`);
  return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join("\n")}\n</urlset>\n`, count: rows.length };
}

const written = [];
function write(file, xml, count) {
  writeFileSync(`public/${file}`, xml);
  written.push({ file, count });
}

const pages = urlset(PAGES);
write("sitemap-pages.xml", pages.xml, pages.count);

const solutions = urlset(SOLUTIONS);
write("sitemap-solutions.xml", solutions.xml, solutions.count);

// Blog posts live in public/blog/. The file is written only when there are
// posts: an empty sitemap is a crawl request for nothing.
let blogPosts = [];
try {
  // Posts sit directly in public/blog/. index.html is the blog landing page,
  // which is already listed in sitemap-pages as /blog -- emitting it here too
  // produced the nonsense URL /blog/index.
  blogPosts = readdirSync("public/blog", { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith(".html") && e.name !== "index.html")
    .map(e => `blog/${e.name.replace(/\.html$/, "")}`);
  // Category pages are included only once they are not thin, which is the same
  // rule that put a temporary noindex on the empty ones.
  for (const e of readdirSync("public/blog", { withFileTypes: true }).filter(x => x.isDirectory())) {
    const idx = `public/blog/${e.name}/index.html`;
    try {
      if (/<meta[^>]*name="robots"[^>]*noindex/i.test(readFileSync(idx, "utf8"))) continue;
      blogPosts.push(`blog/${e.name}`);
    } catch { /* category with no index page */ }
  }
} catch { /* no blog directory yet */ }
if (blogPosts.length) {
  const rows = blogPosts.map(n => `  <url>\n    <loc>${SITE}/${n}</loc>\n    <lastmod>${lastmod(n)}</lastmod>\n  </url>`);
  write("sitemap-blog.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join("\n")}\n</urlset>\n`, rows.length);
}

const today = new Date().toISOString().slice(0, 10);
const index = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${written.map(w => `  <sitemap>\n    <loc>${SITE}/${w.file}</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`).join("\n")}
</sitemapindex>
`;
writeFileSync("public/sitemap.xml", index);

written.forEach(w => console.log(`  ${w.file.padEnd(24)} ${String(w.count).padStart(3)} urls`));
console.log(`  sitemap.xml              index of ${written.length}`);
console.log(`\ntotal ${written.reduce((s, w) => s + w.count, 0)} urls`);
