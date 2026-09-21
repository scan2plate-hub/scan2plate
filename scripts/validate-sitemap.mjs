/* Checks the generated sitemaps before they ship.
 *
 * "Validates" here means more than well-formed XML: a sitemap that lists a
 * noindex page, a file that does not exist, or a URL whose canonical points
 * somewhere else is worse than one that omits it, because it asks a crawler
 * to spend budget on something it will then discard.
 */
import { readFileSync, existsSync } from "node:fs";

const SITE = "https://scan2plate.com";
const errors = [], seen = new Map();

const index = readFileSync("public/sitemap.xml", "utf8");
if (!/<sitemapindex/.test(index)) errors.push("sitemap.xml is not a sitemap index");
if (/<priority>|<changefreq>/.test(index)) errors.push("sitemap.xml still has priority/changefreq");

const children = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].replace(`${SITE}/`, ""));
console.log(`index lists ${children.length} sitemaps: ${children.join(", ")}`);

for (const child of children) {
  if (!existsSync(`public/${child}`)) { errors.push(`${child}: listed in index but missing`); continue; }
  const xml = readFileSync(`public/${child}`, "utf8");
  if (!/^<\?xml/.test(xml)) errors.push(`${child}: missing XML declaration`);
  if (/<priority>|<changefreq>/.test(xml)) errors.push(`${child}: has priority/changefreq`);

  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  const mods = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(m => m[1]);
  if (urls.length !== mods.length) errors.push(`${child}: ${urls.length} urls but ${mods.length} lastmod`);

  for (const [i, u] of urls.entries()) {
    if (seen.has(u)) errors.push(`${u}: listed in both ${seen.get(u)} and ${child}`);
    seen.set(u, child);

    const slug = u.replace(`${SITE}/`, "") || "index";
    const file = existsSync(`public/${slug}.html`) ? `public/${slug}.html`
               : existsSync(`public/${slug}/index.html`) ? `public/${slug}/index.html` : null;
    if (!file) { errors.push(`${u}: no file behind it`); continue; }

    const html = readFileSync(file, "utf8");
    if (/<meta[^>]*name="robots"[^>]*noindex/i.test(html)) errors.push(`${u}: listed but noindex`);
    const canonical = (html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]*)"/i) || [, ""])[1];
    if (canonical.replace(/\/$/, "") !== u.replace(/\/$/, "")) errors.push(`${u}: canonical is ${canonical || "missing"}`);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(mods[i])) errors.push(`${u}: lastmod "${mods[i]}" is not YYYY-MM-DD`);
    if (mods[i] > new Date().toISOString().slice(0, 10)) errors.push(`${u}: lastmod is in the future`);
  }
  console.log(`  ${child.padEnd(24)} ${urls.length} urls, lastmod ${[...new Set(mods)].sort().join(" / ")}`);
}

console.log(`\n${seen.size} unique urls total`);
if (errors.length) { console.log(`\nERRORS (${errors.length}):`); errors.forEach(e => console.log("  " + e)); process.exit(1); }
console.log("no errors: every url resolves to a real, indexable, self-canonical page");
