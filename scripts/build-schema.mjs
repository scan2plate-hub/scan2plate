/* Rebuilds the JSON-LD on every marketing page.
 *
 * Two rules drive this:
 *
 * 1. FAQ markup is GENERATED FROM THE VISIBLE PAGE. Google requires that
 *    FAQPage schema matches Q&A a human can actually read on the page, and the
 *    old site had the same "What is Scan2Plate?" block on 22 pages regardless
 *    of what those pages said. Reading the <details> blocks out of the DOM
 *    makes drift impossible rather than merely discouraged.
 *
 * 2. Site-wide entities appear ONCE. Organization, WebSite and
 *    SoftwareApplication were repeated on all 22 pages. Repeating an entity
 *    does not strengthen it; it just gives a search engine 22 things to
 *    reconcile. Organization and WebSite live on the homepage;
 *    SoftwareApplication on the homepage and /pricing, because those are the
 *    two pages that state a price.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const SITE = "https://scan2plate.com";
const HOME_ONLY = ["index"];
const SOFTWARE_ON = ["index", "pricing"];

const MARKETING = readdirSync("public").filter(f => f.endsWith(".html")).map(f => f.replace(/\.html$/, ""))
  .filter(n => !readFileSync(`public/${n}.html`, "utf8").match(/<meta[^>]*name="robots"[^>]*noindex/i))
  .filter(n => !["404", "googled64db0c1a2415718"].includes(n));

const decode = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#8377;/g, "₹")
  .replace(/&mdash;/g, "—").replace(/&nbsp;/g, " ").replace(/&hellip;/g, "…");
const plain = html => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** The Q&A a visitor can actually see, read out of the page's own markup. */
function visibleFaqs(html) {
  const out = [];
  for (const m of html.matchAll(/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi)) {
    const q = plain(m[1]);
    const a = plain(m[2]);
    // Install instructions and similar accordions are not questions.
    if (!q || !a || a.length < 40 || !/\?$/.test(q)) continue;
    out.push({ q, a });
  }
  return out;
}

const url = n => n === "index" ? `${SITE}/` : `${SITE}/${n}`;
const titleOf = h => plain((h.match(/<title>([\s\S]*?)<\/title>/i) || [, ""])[1]);
const descOf = h => decode((h.match(/<meta\s+name="description"\s+content="([^"]*)"/i) || [, ""])[1]);

const organization = {
  "@context": "https://schema.org", "@type": "Organization",
  name: "Scan2Plate", url: `${SITE}/`, logo: `${SITE}/assets/logo.webp`,
  description: "Restaurant billing, QR ordering and POS software for Indian restaurants, priced at a flat ₹499 per month per restaurant with every feature included.",
  areaServed: { "@type": "Country", name: "India" },
  // Phone taken from the contact page rather than invented. A contactPoint
  // with an unreachable number is worse than none.
  contactPoint: {
    "@type": "ContactPoint", contactType: "sales", telephone: "+91-9142579601",
    url: `${SITE}/contact`, areaServed: "IN", availableLanguage: ["en", "hi"]
  },
  // TODO(owner): add the registered business address here as a PostalAddress
  // (street, city, postalCode, addressRegion, addressCountry: "IN"). A real
  // address is one of the strongest trust signals for a local software vendor
  // and is also required before a Google Business Profile can be verified.
  // sameAs is the fix for the public GitHub repository outranking this site on
  // a brand search: it tells a search engine which profiles are the same
  // entity. Only verified profiles belong here - an unreachable URL in sameAs
  // is worse than a short list.
  // TODO(owner): add LinkedIn, Instagram, YouTube and the Google Business
  // Profile URL here once each exists, then resubmit the homepage.
  sameAs: ["https://github.com/scan2plate-hub"]
};

const website = {
  "@context": "https://schema.org", "@type": "WebSite",
  name: "Scan2Plate", url: `${SITE}/`,
  inLanguage: "en-IN", publisher: { "@type": "Organization", name: "Scan2Plate", url: `${SITE}/` }
};

const software = {
  "@context": "https://schema.org", "@type": "SoftwareApplication",
  name: "Scan2Plate", applicationCategory: "BusinessApplication",
  operatingSystem: "Windows, macOS, Android, Linux, Web",
  url: `${SITE}/`,
  description: "Restaurant billing, QR ordering, KOT, kitchen display, inventory and reporting for Indian restaurants.",
  offers: {
    "@type": "Offer", price: "499", priceCurrency: "INR",
    url: `${SITE}/pricing`, availability: "https://schema.org/InStock",
    priceSpecification: {
      "@type": "UnitPriceSpecification", price: "499", priceCurrency: "INR",
      billingDuration: 1, billingIncrement: 1, unitCode: "MON", unitText: "MONTH",
      referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitText: "restaurant" }
    }
  }
  // No aggregateRating: there are no reviews on this page, and inventing them
  // is what earns a manual penalty.
};

let changed = 0, faqTotal = 0, report = [];
for (const name of MARKETING) {
  const path = `public/${name}.html`;
  let html = readFileSync(path, "utf8");

  const blocks = [];
  if (HOME_ONLY.includes(name)) blocks.push(organization, website);
  if (SOFTWARE_ON.includes(name)) blocks.push(software);

  blocks.push({
    "@context": "https://schema.org", "@type": "WebPage",
    name: titleOf(html), description: descOf(html), url: url(name),
    inLanguage: "en-IN", isPartOf: { "@type": "WebSite", name: "Scan2Plate", url: `${SITE}/` },
    ...(HOME_ONLY.includes(name) ? {} : { about: { "@type": "Organization", name: "Scan2Plate", url: `${SITE}/` } })
  });

  if (name !== "index") {
    const label = plain((html.match(/<nav class="seo-breadcrumb[^>]*>([\s\S]*?)<\/nav>/i) || [, ""])[1])
      .replace(/^Home\s*\/\s*/, "") || titleOf(html).split("|")[0].trim();
    blocks.push({
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
        { "@type": "ListItem", position: 2, name: label, item: url(name) }
      ]
    });
  }

  const faqs = visibleFaqs(html);
  if (faqs.length) {
    faqTotal += faqs.length;
    blocks.push({
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: faqs.map(f => ({
        "@type": "Question", name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a }
      }))
    });
  }
  report.push(`${name.padEnd(32)} ${String(faqs.length).padStart(2)} FAQ  ${blocks.map(b => b["@type"]).join(", ")}`);

  html = html.replace(/\s*<script type="application\/ld\+json">[\s\S]*?<\/script>/gi, "");
  const json = blocks.map(b => `  <script type="application/ld+json">\n${JSON.stringify(b, null, 2)}\n  </script>`).join("\n");
  html = html.replace(/<\/head>/i, `${json}\n</head>`);
  writeFileSync(path, html);
  changed++;
}

console.log(report.join("\n"));
console.log(`\n${changed} pages rebuilt, ${faqTotal} unique FAQ entries generated from visible page content`);
