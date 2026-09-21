/* Word-for-word similarity between the solution pages.
 *
 * The SEO brief's acceptance bar is "under 30% between any two pages". This
 * measures it the way a search engine roughly would: on the VISIBLE body text
 * with nav, footer and script content stripped, because shared chrome is not
 * duplicate content and counting it would flatter or damn every page equally.
 *
 * Similarity is the Sørensen–Dice coefficient over word 5-grams — shingling,
 * the standard near-duplicate measure. Bag-of-words would call two pages
 * identical just for sharing vocabulary; 5-grams only match where genuinely
 * the same phrasing runs on.
 */
import { readFileSync, readdirSync } from "node:fs";

const PAGES = process.argv.slice(2).length ? process.argv.slice(2) : [
  "restaurant-billing-software", "restaurant-pos", "restaurant-qr-ordering", "digital-menu",
  "table-ordering-system", "kitchen-display-system", "restaurant-inventory", "restaurant-analytics",
  "cafe-billing-software", "cloud-kitchen-software", "restaurant-management-software",
  "petpooja-alternative", "pricing", "download"
];

function bodyText(file) {
  let html = readFileSync(`public/${file}.html`, "utf8");
  html = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ");
  html = html.replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, " ");
  html = html.replace(/<!--[\s\S]*?-->/g, " ");
  html = html.replace(/<[^>]+>/g, " ");
  return html.replace(/&[a-z]+;/gi, " ").toLowerCase().replace(/[^a-z0-9₹%.\s]/g, " ")
             .split(/\s+/).filter(Boolean);
}

const N = 5;
const shingles = words => {
  const set = new Set();
  for (let i = 0; i + N <= words.length; i++) set.add(words.slice(i, i + N).join(" "));
  return set;
};

const docs = PAGES.map(name => {
  const words = bodyText(name);
  return { name, words: words.length, grams: shingles(words) };
});

const dice = (a, b) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return (2 * shared) / (a.size + b.size);
};

let worst = { pct: 0, pair: "" };
const over = [];
console.log("page".padEnd(36) + "words");
docs.forEach(d => console.log(d.name.padEnd(36) + d.words));

console.log("\npairs at or above 30%:");
for (let i = 0; i < docs.length; i++) {
  for (let j = i + 1; j < docs.length; j++) {
    const pct = dice(docs[i].grams, docs[j].grams) * 100;
    if (pct > worst.pct) worst = { pct, pair: `${docs[i].name} <-> ${docs[j].name}` };
    if (pct >= 30) over.push([pct, `${docs[i].name} <-> ${docs[j].name}`]);
  }
}
over.sort((a, b) => b[0] - a[0]).forEach(([pct, pair]) => console.log(`  ${pct.toFixed(1).padStart(5)}%  ${pair}`));
if (!over.length) console.log("  none");

console.log(`\nworst pair: ${worst.pct.toFixed(1)}%  ${worst.pair}`);
console.log(`pairs compared: ${(docs.length * (docs.length - 1)) / 2}, at/over 30%: ${over.length}`);
process.exit(over.length ? 1 : 0);
