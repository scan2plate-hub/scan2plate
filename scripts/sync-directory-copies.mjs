/* Keeps public/<slug>/index.html byte-identical to public/<slug>.html.
 *
 * The legacy generator wrote every page twice, flat and as a directory index,
 * and both copies declare the same rel=canonical. Firebase's precedence
 * between the two for a clean URL is not something to rely on, so the safe
 * arrangement is that they never differ. Any build step that rewrites the flat
 * pages must run this afterwards, or the directory copies silently go stale
 * and start serving last month's content under this month's canonical.
 *
 * TODO(owner): once you have confirmed which copy Firebase actually serves,
 * the other set can be deleted and this script retired.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

let synced = 0, skipped = 0, inSync = 0;
for (const entry of readdirSync("public", { withFileTypes: true }).filter(e => e.isDirectory())) {
  const idx = `public/${entry.name}/index.html`;
  const flat = `public/${entry.name}.html`;
  if (!existsSync(idx)) continue;
  if (!existsSync(flat)) { skipped++; continue; }   // category pages have no flat twin
  const a = readFileSync(idx), b = readFileSync(flat);
  if (a.equals(b)) { inSync++; continue; }
  writeFileSync(idx, b);
  synced++;
}
console.log(`directory copies: ${synced + inSync} checked, ${synced} re-synced, ${inSync} already matching, ${skipped} without a flat page (left alone)`);
