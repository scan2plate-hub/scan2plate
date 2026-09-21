/* Builds blog posts from content/blog-posts.mjs.
 *
 * The page shell (header, footer, stylesheets) is READ FROM A LIVE PAGE at
 * build time rather than copied into this file. The legacy generator hardcoded
 * its templates, so the pages it produced drifted away from the rest of the
 * site and nobody noticed. Taking the shell from digital-menu.html means a nav
 * change reaches blog posts on the next build.
 *
 * Unlike scripts/generate-seo.mjs this only ever writes public/blog/*.html. It
 * cannot touch a marketing page.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { POSTS, AUTHOR } from "../content/blog-posts.mjs";

const SITE = "https://scan2plate.com";
const SHELL_SOURCE = "public/digital-menu.html";

const shell = readFileSync(SHELL_SOURCE, "utf8");
const header = (shell.match(/<header[\s\S]*?<\/header>/) || [""])[0];
const footer = (shell.match(/<footer[\s\S]*?<\/footer>/) || [""])[0];
const styles = [...shell.matchAll(/<link rel="stylesheet"[^>]*>/g)].map(m => m[0]).join("\n  ");
if (!header || !footer) { console.error(`could not read the page shell from ${SHELL_SOURCE}`); process.exit(1); }

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Section headings become a table of contents and the anchors it points at. */
function renderBody(sections) {
  return sections.map(s => {
    if (s.h2) return `        <h2 id="${slugify(s.h2)}">${s.h2}</h2>\n${(s.body || []).map(p => `        ${p}`).join("\n")}`;
    return (s.body || []).map(p => `        ${p}`).join("\n");
  }).join("\n\n");
}

function toc(sections) {
  const items = sections.filter(s => s.h2).map(s => `          <li><a href="#${slugify(s.h2)}">${s.h2}</a></li>`);
  return items.length < 3 ? "" :
`        <nav class="post-toc" aria-label="On this page">
          <strong>On this page</strong>
          <ul>
${items.join("\n")}
          </ul>
        </nav>`;
}

let built = 0;
mkdirSync("public/blog", { recursive: true });

for (const post of POSTS) {
  const url = `${SITE}/blog/${post.slug}`;
  const countable = [post.answer, renderBody(post.sections),
    ...(post.faqs || []).flatMap(f => [f.q, f.a])].join(" ");
  const words = countable.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;

  const article = {
    "@context": "https://schema.org", "@type": "Article",
    headline: post.title, description: post.description,
    datePublished: post.published, dateModified: post.updated || post.published,
    inLanguage: "en-IN",
    author: AUTHOR,
    publisher: { "@type": "Organization", name: "Scan2Plate", url: `${SITE}/`, logo: { "@type": "ImageObject", url: `${SITE}/assets/logo.webp` } },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    articleSection: post.category
  };
  const breadcrumb = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE}/blog` },
      { "@type": "ListItem", position: 3, name: post.title, item: url }
    ]
  };
  const blocks = [article, breadcrumb];
  if (post.faqs?.length) blocks.push({
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: post.faqs.map(f => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } }))
  });

  const html = `<!DOCTYPE html>
<html lang="en-IN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(post.title)} | Scan2Plate</title>
  <meta name="description" content="${esc(post.description)}" />
  <meta name="robots" content="index,follow" />
  <link rel="canonical" href="${url}" />
  <link rel="icon" href="/assets/logo.PNG" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Scan2Plate" />
  <meta property="og:title" content="${esc(post.title)}" />
  <meta property="og:description" content="${esc(post.description)}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${SITE}/assets/scan2plate-hero.webp" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(post.title)}" />
  <meta name="twitter:description" content="${esc(post.description)}" />
  <meta name="twitter:image" content="${SITE}/assets/scan2plate-hero.webp" />
  ${styles}
${blocks.map(b => `  <script type="application/ld+json">\n${JSON.stringify(b, null, 2)}\n  </script>`).join("\n")}
</head>
<body>
${header}
  <main>
    <nav class="seo-breadcrumb container" aria-label="Breadcrumb"><a href="/">Home</a><span>/</span><a href="/blog">Blog</a><span>/</span><span>${esc(post.title)}</span></nav>
    <article class="seo-section">
      <div class="container seo-content">
        <h1>${post.title}</h1>
        <p class="post-meta">By ${AUTHOR.name} &middot; Published ${post.published}${post.updated && post.updated !== post.published ? ` &middot; Updated ${post.updated}` : ""} &middot; ${Math.max(1, Math.round(words / 220))} min read</p>
        <p class="lede">${post.answer}</p>

${toc(post.sections)}

${renderBody(post.sections)}

${post.faqs?.length ? `        <h2 id="questions">Questions people ask</h2>
        <div class="faq-list">
${post.faqs.map(f => `          <details>\n            <summary>${f.q}</summary>\n            <p>${f.a}</p>\n          </details>`).join("\n")}
        </div>` : ""}

        <p class="cta-line"><a class="btn btn-primary" href="${post.cta.href}">${post.cta.label}</a></p>
      </div>
    </article>
  </main>
${footer}
</body>
</html>
`;
  writeFileSync(`public/blog/${post.slug}.html`, html);
  console.log(`  ${post.slug.padEnd(44)} ${String(words).padStart(5)} words`);
  built++;
}
console.log(`\n${built} posts built`);
