import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SITE = "https://scan2plate.com";
const OUT = "public";
const TODAY = "2026-07-29";
const HERO = `${SITE}/assets/scan2plate-hero.jpg`;
const LOGO = `${SITE}/assets/logo.PNG`;
const CONTACT_EMAIL = "support@scan2plate.com";
const CONTACT_PHONE = "+91 9142579601";

const featureLinks = [
  ["restaurant-billing-software", "Restaurant Billing Software"],
  ["restaurant-management-software", "Restaurant Management Software"],
  ["restaurant-pos", "Restaurant POS"],
  ["restaurant-qr-ordering", "Restaurant QR Ordering"],
  ["digital-menu", "Digital Menu"],
  ["table-ordering-system", "Table Ordering System"],
  ["kitchen-display-system", "Kitchen Display System"],
  ["restaurant-inventory", "Restaurant Inventory"],
  ["restaurant-analytics", "Restaurant Analytics"],
  ["cloud-kitchen-software", "Cloud Kitchen Software"],
  ["cafe-billing-software", "Cafe Billing Software"],
  ["petpooja-alternative", "Petpooja Alternative"]
];

const pages = [
  {
    slug: "about",
    title: "About Scan2Plate",
    priority: "0.8",
    type: "AboutPage",
    description: "Learn about Scan2Plate's mission to help restaurants, cafes, cloud kitchens, hotels, food courts, and vendors digitize ordering, billing, kitchen, and inventory workflows.",
    intro: "Scan2Plate helps food businesses move daily operations from disconnected manual processes to a practical web platform for orders, billing, QR menus, KOT, stock, and reports.",
    sections: [
      ["Our Mission", "Scan2Plate is built to make restaurant digitization simpler for Indian food businesses. The goal is to help owners manage service, billing, kitchen visibility, inventory, payments, and reports without replacing the character of their restaurant."],
      ["Who We Serve", "The platform is designed for restaurants, cafes, cloud kitchens, hotels, food courts, and street-vendor style counters that need practical digital workflows for dine-in, takeaway, pre-order, token, and table ordering."],
      ["Product Purpose", "Scan2Plate connects customer ordering, staff order handling, kitchen preparation, billing, payment tracking, inventory updates, and analytics so teams can work with clearer information during busy hours."]
    ],
    benefits: ["Clearer order flow from customer to kitchen", "Faster billing and payment status tracking", "Better owner visibility into menu, stock, and sales", "Configurable workflows for different food-service formats"]
  },
  {
    slug: "contact",
    title: "Contact Scan2Plate",
    priority: "0.8",
    type: "ContactPage",
    description: "Contact Scan2Plate for product demos, onboarding, restaurant billing software support, QR ordering setup, and technical help.",
    intro: "Use this page to request a Scan2Plate demo, ask support questions, or share details about your restaurant workflow.",
    form: "contact",
    sections: [
      ["Support and Demo Enquiries", `Restaurant teams can contact Scan2Plate at ${CONTACT_PHONE} or ${CONTACT_EMAIL}. Include your business name, restaurant ID if available, and the page or workflow where you need help.`],
      ["What to Include", "For faster support, include your business type, current billing or ordering workflow, whether you need QR ordering, kitchen display, inventory, analytics, or pre-order support, and any launch timeline."]
    ],
    benefits: ["Demo enquiry", "Onboarding help", "Billing and QR ordering support", "Technical issue reporting"]
  },
  {
    slug: "privacy-policy",
    title: "Privacy Policy",
    priority: "0.7",
    description: "Read how Scan2Plate handles restaurant owner data, customer order data, device information, cookies, analytics, Firebase services, payment provider data, retention, deletion requests, and India DPDP compliance.",
    intro: "This Privacy Policy explains how Scan2Plate handles data used to operate restaurant billing, QR ordering, digital menu, kitchen display, inventory, analytics, and support workflows.",
    sections: [
      ["Data We Process", "Scan2Plate may process restaurant account details, owner or staff contact details, menu and pricing data, customer order data, table or token details, bill and payment status, support messages, device information, and operational logs."],
      ["Firebase and Service Providers", "Scan2Plate uses Firebase-related services and may work with hosting, analytics, payment, communication, and support providers to run the platform. Payment providers may process payment data under their own terms."],
      ["Cookies and Device Information", "Cookies, local storage, and similar browser technologies may support login sessions, security, preferences, analytics, and product reliability."],
      ["Retention and Deletion", "Operational data is retained only as needed for restaurant service, billing records, legal obligations, support, security, and legitimate business requirements. Deletion requests can be sent to support with account-identifying information."],
      ["India DPDP Alignment", "Scan2Plate aims to handle personal data in a responsible manner consistent with applicable Indian data protection expectations, including purpose limitation, reasonable security, and response to valid data requests."]
    ],
    benefits: ["Purpose-based data use", "Security-focused handling", "Deletion request channel", "Provider transparency"]
  },
  {
    slug: "terms-of-service",
    title: "Terms of Service",
    priority: "0.7",
    description: "Review Scan2Plate terms covering account responsibility, subscriptions, acceptable use, payments, availability, intellectual property, termination, liability limits, and Indian governing law.",
    intro: "These Terms describe the conditions for using Scan2Plate's restaurant billing, QR ordering, kitchen, inventory, and management software.",
    sections: [
      ["Account Responsibility", "Restaurant owners and authorized users are responsible for accurate account information, secure credentials, staff access, menu data, pricing, taxes, customer service, and legal compliance for their business."],
      ["Subscriptions and Payments", "Subscription activation, renewal, billing, taxes, and payment gateway handling depend on the selected plan and payment method. Any pricing or commercial terms should be confirmed directly with Scan2Plate."],
      ["Acceptable Use", "Users must not misuse the platform, interfere with security, upload unlawful content, access another restaurant's data, or use Scan2Plate for fraudulent or harmful activity."],
      ["Availability and Changes", "Scan2Plate works to keep services available, but software, hosting, payment, network, or third-party issues may affect access. Features may evolve as the product improves."],
      ["Intellectual Property and Termination", "Scan2Plate software, design, content, and brand assets remain protected. Accounts may be suspended or terminated for non-payment, misuse, or legal risk. Indian law governs these terms unless a written agreement states otherwise."]
    ],
    benefits: ["Clear account duties", "Acceptable use rules", "Subscription expectations", "Indian governing law"]
  },
  {
    slug: "refund-policy",
    title: "Refund and Cancellation Policy",
    priority: "0.7",
    description: "Understand Scan2Plate refund eligibility, subscription activation, payment gateway charges, demo policy, cancellation requests, and legally required refunds.",
    intro: "This Refund Policy explains how Scan2Plate reviews cancellation and refund requests for restaurant software subscriptions and setup services.",
    sections: [
      ["Subscription Activation", "Once a subscription or onboarding service is activated, the restaurant may receive account setup, hosting access, QR configuration, menu setup, and support. Activated services may not always be refundable."],
      ["Refund Eligibility", "Refunds are reviewed case by case for duplicate payments, failed activation, incorrect charges, or legally required refund situations. Approved refunds may exclude payment gateway or banking charges."],
      ["Demo Policy", "Restaurants should request a demo or clarify workflow requirements before subscribing. A demo enquiry does not require invented pricing claims or guaranteed outcomes."],
      ["Cancellation Requests", "Cancellation or refund requests should be sent to support with payment reference, business name, contact details, and reason for review."]
    ],
    benefits: ["Transparent review process", "Clear payment references", "No guaranteed refund claims", "Legally required refunds respected"]
  },
  {
    slug: "cookie-policy",
    title: "Cookie Policy",
    priority: "0.7",
    description: "Learn how Scan2Plate uses cookies, local storage, login sessions, security controls, analytics, preferences, and browser controls.",
    intro: "Scan2Plate uses browser storage technologies to keep the restaurant software reliable, secure, and easier to use.",
    sections: [
      ["Necessary Cookies", "Necessary cookies and local storage may support login sessions, admin access, customer order flow, security checks, and application preferences."],
      ["Analytics and Reliability", "Analytics or diagnostic tools may help understand page performance, errors, and usage patterns so Scan2Plate can improve the service."],
      ["Preference Storage", "Browser storage may remember user preferences, selected restaurant context, workflow state, or interface settings."],
      ["Browser Controls", "Users can manage cookies through browser settings. Blocking necessary storage may affect login, ordering, dashboard, or checkout workflows."]
    ],
    benefits: ["Session support", "Security handling", "Preference storage", "Browser-level control"]
  },
  {
    slug: "features",
    title: "Scan2Plate Features",
    priority: "0.9",
    description: "Explore Scan2Plate features for billing, QR ordering, digital menu, KOT, kitchen display, inventory, tables, payments, reports, analytics, staff access, and pre-orders.",
    intro: "Scan2Plate combines the restaurant workflows that owners and staff use every day into one web-based system.",
    sections: [
      ["Core Features", "Billing, QR ordering, digital menu, KOT, kitchen display, inventory, table management, payment tracking, reports, analytics, staff access, and pre-orders work together so restaurant teams can reduce disconnected manual steps."],
      ["For Different Businesses", "Restaurants can use table ordering, cafes can use token or takeaway workflows, cloud kitchens can focus on kitchen flow, and hotels or food courts can adapt the ordering model to their service style."],
      ["Operational Visibility", "Owners can review orders, payment methods, stock movement, best-selling items, and date-based reports to make better daily decisions."]
    ],
    benefits: ["Billing and bill printing", "QR menus and table ordering", "KOT and kitchen display", "Inventory and reports", "Analytics and staff access", "Pre-order workflows"]
  },
  {
    slug: "pricing",
    title: "Scan2Plate Pricing Enquiry",
    priority: "0.8",
    description: "Request Scan2Plate pricing details based on restaurant billing, QR ordering, kitchen display, inventory, analytics, and support requirements.",
    intro: "Scan2Plate pricing should be confirmed through a demo or enquiry so the plan can match your restaurant workflow, service format, and support needs.",
    form: "pricing",
    sections: [
      ["Pricing Without Guesswork", "This page does not invent prices. Share your restaurant type, outlet count, QR ordering needs, billing workflow, kitchen display requirements, and inventory expectations to receive the right commercial information."],
      ["What Affects Plan Fit", "Important factors include dine-in or takeaway volume, number of staff users, table count, billing counters, inventory complexity, cloud kitchen workflow, and onboarding support."]
    ],
    benefits: ["No unsupported prices", "Workflow-based enquiry", "Demo-led plan discussion", "Clear onboarding scope"]
  },
  {
    slug: "demo",
    title: "Request a Scan2Plate Demo",
    priority: "0.8",
    description: "Request a Scan2Plate demo for restaurant billing, QR ordering, digital menu, KOT, kitchen display, inventory, analytics, and pre-order workflows.",
    intro: "Use the demo request form to share your restaurant requirements and see how Scan2Plate can fit your daily operations.",
    form: "demo",
    sections: [
      ["What the Demo Covers", "A demo can cover menu setup, QR ordering, billing, tax setup, kitchen display, table flow, payment status, reports, inventory, analytics, pre-orders, and admin workflows."],
      ["Prepare for the Demo", "Share your restaurant type, current tools, pain points, outlet count, and whether you need dine-in, token, takeaway, hotel, cloud kitchen, or food-court workflows."]
    ],
    benefits: ["Workflow walkthrough", "Setup discussion", "Feature fit review", "Support and onboarding planning"]
  },
  {
    slug: "restaurant-billing-software",
    title: "Restaurant Billing Software",
    priority: "0.9",
    description: "Restaurant billing software for taxes, payment methods, bill printing, cashier workflow, reports, KOT, and order-to-bill operations.",
    intro: "Scan2Plate helps restaurants turn live orders into clear bills while connecting cashier, kitchen, payment, and reporting workflows.",
    sections: [
      ["Billing Workflow", "Create bills from dine-in, QR, takeaway, token, or pre-order workflows. Staff can track payment status, tax details, printable receipts, and order history."],
      ["Cashier and Kitchen Connection", "Billing connects with KOT and kitchen display so the cashier and preparation team work from the same order information."],
      ["Reports and Payments", "Owners can review sales, payment methods, bill status, menu item performance, and daily totals."]
    ],
    benefits: ["Tax-aware billing", "Payment status tracking", "Bill printing", "KOT connection", "Daily reports"]
  },
  {
    slug: "restaurant-management-software",
    title: "Restaurant Management Software",
    priority: "0.9",
    description: "Complete restaurant management software for billing, QR ordering, digital menus, KOT, inventory, tables, payments, reports, analytics, and staff workflows.",
    intro: "Scan2Plate supports complete restaurant operations without forcing teams into separate tools for ordering, billing, kitchen, stock, and reports.",
    sections: [
      ["End-to-End Operations", "Manage menus, table QR codes, customer orders, KOT, kitchen status, bills, payments, stock, staff access, and daily reports from one platform."],
      ["Flexible Service Models", "Use Scan2Plate for dine-in restaurants, cafes, cloud kitchens, hotels, food courts, and vendor-style counters."],
      ["Owner Visibility", "Date filters, payment method summaries, sales reports, inventory records, and analytics help owners understand what is happening across operations."]
    ],
    benefits: ["Menu and table setup", "Order and kitchen flow", "Billing and payments", "Stock and reports", "Analytics"]
  },
  {
    slug: "restaurant-pos",
    title: "Restaurant POS Software",
    priority: "0.9",
    description: "Restaurant POS workflows for order entry, billing, payment tracking, KOT, table service, QR ordering, reports, and cashier operations.",
    intro: "Scan2Plate provides POS-related workflows for restaurants that need billing, QR ordering, kitchen status, and reporting in a web-based system.",
    sections: [
      ["POS Workflows", "Staff can manage order details, bills, taxes, payment status, KOT, and reports while customers can also place orders through QR menus where enabled."],
      ["For Counter and Table Service", "Restaurants can adapt Scan2Plate for cashier billing, table ordering, takeaway, tokens, and pre-order workflows."],
      ["Reporting", "POS data can support daily sales review, payment method checks, and item-level visibility."]
    ],
    benefits: ["Counter billing", "Table ordering", "KOT support", "Payment tracking", "Daily POS reports"]
  },
  {
    slug: "restaurant-qr-ordering",
    title: "Restaurant QR Ordering",
    priority: "0.9",
    description: "QR ordering software for scan-to-menu, customer ordering, kitchen flow, order tracking, payment status, and table-specific service.",
    intro: "Scan2Plate lets customers scan a QR code, open a digital menu, add items, place an order, and follow the service flow from their phone.",
    sections: [
      ["Scan, Browse, Order", "Customers can scan a table or counter QR, browse menu categories, choose items, and submit orders without waiting for a paper menu."],
      ["Kitchen and Staff Flow", "Orders can move to kitchen and admin workflows where staff review, accept, prepare, mark ready, bill, and update payment status."],
      ["Table Context", "Table-specific QR links help restaurants connect orders to the correct table or service context."]
    ],
    benefits: ["Mobile menu access", "Table-specific orders", "Kitchen visibility", "Order tracking", "Payment flow support"]
  },
  {
    slug: "digital-menu",
    title: "Digital Menu Software",
    priority: "0.9",
    description: "Digital menu software for mobile-friendly categories, item pricing, images, availability, QR access, and easy restaurant menu updates.",
    intro: "Scan2Plate gives restaurants a digital menu experience that customers can open from QR links and staff can keep aligned with live operations.",
    sections: [
      ["Mobile Menu Experience", "Customers can view categories, item names, prices, images, and availability on their phone."],
      ["Operational Updates", "Restaurants can update menu data from admin workflows so customer-facing ordering reflects current options."],
      ["QR Access", "Digital menus connect naturally with table ordering, token ordering, and pre-order use cases."]
    ],
    benefits: ["Mobile-friendly menus", "Category organization", "Item pricing and images", "Availability control", "QR access"]
  },
  {
    slug: "table-ordering-system",
    title: "Table Ordering System",
    priority: "0.9",
    description: "Table ordering system for table-specific QR codes, active bills, add-more-items flow, table status, kitchen updates, and staff billing.",
    intro: "Scan2Plate helps dine-in restaurants connect each table to an ordering and billing workflow through QR codes.",
    sections: [
      ["Table-Specific QR Codes", "Each table can use a QR link that carries table context into customer ordering, kitchen flow, and billing."],
      ["Active Bills and Add-More Items", "Restaurants can support ongoing table service where customers add more items and staff manage the active bill."],
      ["Table Status", "Staff can use order and payment status to understand which tables need service, preparation, billing, or clearing."]
    ],
    benefits: ["Table QR mapping", "Add-more-items flow", "Active bill context", "Kitchen updates", "Table status visibility"]
  },
  {
    slug: "kitchen-display-system",
    title: "Kitchen Display System",
    priority: "0.9",
    description: "Kitchen display system for new, accepted, preparing, ready, KOT, alerts, and staff preparation workflows.",
    intro: "Scan2Plate helps kitchen teams see live order status and move items through preparation stages.",
    sections: [
      ["Kitchen Status Flow", "Orders can be managed through stages such as new, accepted, preparing, and ready depending on the restaurant workflow."],
      ["KOT Visibility", "Kitchen order tickets help staff focus on what needs preparation and reduce confusion between front-of-house and kitchen teams."],
      ["Alerts and Coordination", "Status changes and sound alerts can help teams respond faster during busy service periods."]
    ],
    benefits: ["Live order queue", "KOT workflow", "Preparation status", "Ready updates", "Staff coordination"]
  },
  {
    slug: "restaurant-inventory",
    title: "Restaurant Inventory Software",
    priority: "0.9",
    description: "Restaurant inventory software for stock management, bill OCR, auto inventory, purchase tracking, usage visibility, and low-stock workflows.",
    intro: "Scan2Plate supports restaurant inventory workflows so owners can understand stock, purchases, usage, and low-stock situations.",
    sections: [
      ["Stock Management", "Track ingredients, purchase entries, supplier information, available stock, and low-stock signals."],
      ["Bill OCR and Auto Inventory", "Where configured, bill import and OCR workflows can help reduce manual entry and connect purchasing records to inventory updates."],
      ["Usage and Purchases", "Inventory visibility helps restaurants compare item usage, purchases, and daily operations."]
    ],
    benefits: ["Stock tracking", "Supplier bill records", "OCR-assisted entry", "Purchase visibility", "Low-stock checks"]
  },
  {
    slug: "restaurant-analytics",
    title: "Restaurant Analytics",
    priority: "0.9",
    description: "Restaurant analytics for daily reports, revenue, payment methods, best-selling items, date filters, order trends, and owner visibility.",
    intro: "Scan2Plate analytics help restaurant owners review sales and operations from the data created during ordering, billing, and payments.",
    sections: [
      ["Daily Reports", "Review date-based sales, order counts, bill status, and payment method information."],
      ["Menu Performance", "Best-selling item and category visibility can help owners understand customer demand and menu movement."],
      ["Operational Trends", "Analytics can support better decisions around staffing, inventory, menu updates, and service flow."]
    ],
    benefits: ["Revenue summaries", "Payment method reports", "Best-selling items", "Date filters", "Order trends"]
  },
  {
    slug: "cloud-kitchen-software",
    title: "Cloud Kitchen Software",
    priority: "0.9",
    description: "Cloud kitchen software for centralized order management, kitchen workflows, token billing, menus, inventory, reports, and delivery-ready operations.",
    intro: "Scan2Plate helps cloud kitchens organize orders, kitchen work, billing, menus, and reporting without relying on paper-based coordination.",
    sections: [
      ["Centralized Orders", "Cloud kitchen teams can manage incoming orders and preparation from a shared order and kitchen workflow."],
      ["Kitchen and Billing", "KOT, status updates, bill records, and payment tracking help connect preparation with business records."],
      ["Inventory and Reports", "Stock, purchases, and sales reports support better daily planning for cloud kitchen operations."]
    ],
    benefits: ["Centralized order view", "Kitchen flow", "Token or takeaway support", "Inventory tracking", "Reports"]
  },
  {
    slug: "cafe-billing-software",
    title: "Cafe Billing Software",
    priority: "0.9",
    description: "Cafe billing software for quick billing, QR menu, tokens, takeaway orders, KOT, payment tracking, inventory, and daily reports.",
    intro: "Scan2Plate helps cafes and quick-service counters handle fast ordering, billing, tokens, kitchen updates, and payment records.",
    sections: [
      ["Fast Counter Billing", "Cafe teams can manage quick bills, takeaway orders, payment status, and item totals."],
      ["QR Menu and Tokens", "QR menus and token workflows can support counter pickup and busy cafe service."],
      ["KOT and Inventory", "Kitchen tickets, item availability, stock records, and reports help cafes stay organized."]
    ],
    benefits: ["Quick billing", "Token workflows", "QR menu", "Takeaway orders", "Payment tracking"]
  },
  {
    slug: "petpooja-alternative",
    title: "Petpooja Alternative",
    priority: "0.9",
    description: "A balanced Scan2Plate comparison page for restaurants considering QR ordering, billing, KOT, inventory, analytics, and restaurant management software options.",
    intro: "Restaurants comparing Scan2Plate with other restaurant software should choose based on their own workflow, team needs, integrations, support, and budget.",
    sections: [
      ["Balanced Comparison", "Petpooja and Scan2Plate may fit different restaurant requirements. Consider your current workflow, billing needs, QR ordering expectations, kitchen process, inventory complexity, reporting needs, and support preferences."],
      ["When to Consider Scan2Plate", "Scan2Plate may be useful if you want a web-based system that combines QR ordering, digital menu, billing, KOT, kitchen display, inventory, analytics, and pre-order workflows."],
      ["Evaluate Carefully", "Do not choose based on slogans. Test the workflows that matter to your restaurant, including billing speed, kitchen usability, reporting, menu setup, staff access, and support response."]
    ],
    benefits: ["Neutral comparison", "Workflow-based decision", "QR ordering focus", "Billing and KOT fit", "Inventory and analytics review"]
  },
  {
    slug: "blog",
    title: "Scan2Plate Blog",
    priority: "0.8",
    description: "Read Scan2Plate guides and category resources about restaurant billing, QR ordering, POS, inventory, digital menus, cloud kitchens, cafes, and restaurant operations.",
    intro: "The Scan2Plate blog organizes practical restaurant technology topics into categories. Full article publishing can be expanded as the content system grows.",
    blog: true,
    sections: [
      ["Blog Categories", "Explore restaurant tips, restaurant marketing, billing, inventory, cloud kitchen operations, cafe business, POS workflows, and digital menu ideas."],
      ["Content Approach", "Initial blog cards are category placeholders, not fake articles or publication dates. They help users find the topics Scan2Plate plans to cover."]
    ],
    benefits: ["Restaurant tips", "Billing guides", "Inventory topics", "Digital menu ideas", "Cloud kitchen operations"]
  }
];

const routeAliases = [
  ["about-us", "about"],
  ["contact-us", "contact"]
];

const sitemapPages = [
  { slug: "", priority: "1.0", changefreq: "weekly" },
  ...pages.map(page => ({ slug: page.slug, priority: page.priority, changefreq: page.slug === "blog" ? "weekly" : "monthly" }))
];

function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function ensureFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function loc(slug) {
  return slug ? `${SITE}/${slug}` : `${SITE}/`;
}

function jsonLd(data) {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

function commonSchema(page) {
  const url = loc(page.slug);
  const schema = [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${SITE}/#organization`,
      "name": "Scan2Plate",
      "url": SITE,
      "logo": LOGO,
      "contactPoint": {
        "@type": "ContactPoint",
        "telephone": CONTACT_PHONE,
        "contactType": "sales and customer support",
        "areaServed": "IN",
        "availableLanguage": ["English", "Hindi"]
      }
    },
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${SITE}/#website`,
      "url": SITE,
      "name": "Scan2Plate",
      "publisher": { "@id": `${SITE}/#organization` }
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      "@id": `${SITE}/#software`,
      "name": "Scan2Plate",
      "applicationCategory": "BusinessApplication",
      "operatingSystem": "Web",
      "countryOfOrigin": { "@type": "Country", "name": "India" },
      "url": SITE,
      "image": HERO,
      "description": "Scan2Plate is restaurant billing, QR ordering, digital menu, KOT, kitchen display, inventory, table management, payment tracking, analytics, and restaurant management software."
    },
    {
      "@context": "https://schema.org",
      "@type": page.type || "WebPage",
      "@id": `${url}#webpage`,
      "url": url,
      "name": `${page.title} | Scan2Plate`,
      "description": page.description,
      "isPartOf": { "@id": `${SITE}/#website` },
      "about": { "@id": `${SITE}/#software` },
      "inLanguage": "en-IN"
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": SITE },
        { "@type": "ListItem", "position": 2, "name": page.title, "item": url }
      ]
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": faqItems(page).map(([name, text]) => ({
        "@type": "Question",
        "name": name,
        "acceptedAnswer": { "@type": "Answer", "text": text }
      }))
    }
  ];
  return schema.map(jsonLd).join("\n  ");
}

function faqItems(page) {
  return [
    ["What is Scan2Plate?", "Scan2Plate is restaurant billing, QR ordering, digital menu, KOT, kitchen display, inventory, table management, payment tracking, analytics, and restaurant management software."],
    [`Who is ${page.title} for?`, "It is for restaurants, cafes, cloud kitchens, hotels, food courts, and vendor-style food businesses that need practical digital ordering, billing, kitchen, and reporting workflows."],
    ["How does Scan2Plate work?", "Restaurants configure menus, tables, QR links, billing, payment, kitchen, inventory, and staff workflows. Customers or staff place orders, kitchens update preparation, and owners review bills and reports."],
    ["How do I request a demo?", "Use the demo or contact page to share your business name, contact details, restaurant type, and the workflows you want to review."]
  ];
}

function head(page) {
  const url = loc(page.slug);
  return `<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(page.title)} | Scan2Plate</title>
  <meta name="description" content="${esc(page.description)}" />
  <meta name="robots" content="index,follow" />
  <link rel="canonical" href="${url}" />
  <link rel="icon" href="/assets/logo.PNG" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Scan2Plate" />
  <meta property="og:title" content="${esc(page.title)} | Scan2Plate" />
  <meta property="og:description" content="${esc(page.description)}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${HERO}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(page.title)} | Scan2Plate" />
  <meta name="twitter:description" content="${esc(page.description)}" />
  <meta name="twitter:image" content="${HERO}" />
  <link rel="stylesheet" href="/css/style.css?v=latest-business-login-fix" />
  <link rel="stylesheet" href="/css/seo.css" />
  ${commonSchema(page)}
</head>`;
}

function header() {
  return `<header class="topbar">
    <div class="container nav">
      <a class="seo-logo" href="/"><img src="/assets/logo.PNG" alt="Scan2Plate logo" /><span><strong>Scan2Plate</strong><small>Restaurant software</small></span></a>
      <nav class="seo-nav" aria-label="Primary navigation">
        <a href="/">Home</a>
        <a href="/features">Features</a>
        <a href="/pricing">Pricing</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
        <a class="btn btn-primary" href="/demo">Demo</a>
      </nav>
    </div>
  </header>`;
}

function footer() {
  const links = [
    ["features", "Features"],
    ["pricing", "Pricing"],
    ["demo", "Demo"],
    ["about", "About"],
    ["contact", "Contact"],
    ["privacy-policy", "Privacy Policy"],
    ["terms-of-service", "Terms of Service"],
    ["refund-policy", "Refund Policy"],
    ["cookie-policy", "Cookie Policy"],
    ...featureLinks,
    ["blog", "Blog"]
  ];
  return `<footer class="seo-footer">
    <div class="container seo-footer-grid">
      <div>
        <strong>Scan2Plate</strong>
        <p>Restaurant billing, QR ordering, digital menu, KOT, kitchen display, inventory, analytics, pre-order, cafe, cloud-kitchen, hotel, food-court, and vendor management software.</p>
      </div>
      <nav aria-label="Footer navigation">${links.map(([slug, label]) => `<a href="/${slug}">${esc(label)}</a>`).join("")}</nav>
      <div>
        <p><strong>Contact</strong><br>${CONTACT_PHONE}<br>${CONTACT_EMAIL}</p>
        <a class="btn btn-outline" href="/admin-login.html?v=latest-business-login-fix">Admin Login</a>
      </div>
    </div>
  </footer>`;
}

function formMarkup(kind) {
  if (!kind) return "";
  const title = kind === "pricing" ? "Pricing enquiry" : kind === "demo" ? "Demo request" : "Support and demo enquiry";
  const businessLabel = kind === "demo" ? "Restaurant name" : kind === "contact" ? "Restaurant or business name" : "Business name";
  const cityField = kind === "demo" ? `
        <label>City<input name="city" autocomplete="address-level2" required /></label>` : "";
  return `<section class="seo-section">
    <div class="container seo-content">
      <h2>${title}</h2>
      <form class="seo-form" data-seo-form novalidate>
        <label>Name<input name="name" autocomplete="name" required /></label>
        <label>Phone<input name="phone" type="tel" autocomplete="tel" required /></label>
        <label>Email<input name="email" type="email" autocomplete="email" required /></label>
        <label>${businessLabel}<input name="business" autocomplete="organization" required /></label>
        ${cityField}
        <label>Message<textarea name="message" rows="5" required></textarea></label>
        <button class="btn btn-primary" type="submit">Send enquiry</button>
        <p class="seo-form-status" role="status" aria-live="polite"></p>
      </form>
    </div>
  </section>`;
}

function formScript(page) {
  if (!page.form) return "";
  return `<script>
    document.querySelectorAll("[data-seo-form]").forEach(form => {
      form.addEventListener("submit", event => {
        event.preventDefault();
        const status = form.querySelector(".seo-form-status");
        const data = new FormData(form);
        const email = String(data.get("email") || "");
        const phone = String(data.get("phone") || "");
        if (!form.checkValidity() || !email.includes("@") || phone.replace(/\\D/g, "").length < 8) {
          status.textContent = "Please enter your name, valid email, phone, business name, and message.";
          status.className = "seo-form-status error";
          form.reportValidity();
          return;
        }
        status.textContent = "Thanks. Your enquiry is ready. Please email support@scan2plate.com or call +91 9142579601 for the fastest response.";
        status.className = "seo-form-status success";
        form.reset();
      });
    });
  </script>`;
}

function pageHtml(page) {
  const related = featureLinks.filter(([slug]) => slug !== page.slug).slice(0, 8);
  const categoryCards = page.blog ? `<div class="seo-card-grid">${["Restaurant Tips", "Restaurant Marketing", "Billing", "Inventory", "Cloud Kitchen", "Cafe Business", "POS", "Digital Menu"].map(title => `<article><h3>${title}</h3><p>Category resources for ${title.toLowerCase()} workflows. Full article publishing can be added when the content system is ready.</p></article>`).join("")}</div>` : "";
  return `<!DOCTYPE html>
<html lang="en-IN">
${head(page)}
<body>
  ${header()}
  <main>
    <nav class="seo-breadcrumb container" aria-label="Breadcrumb"><a href="/">Home</a><span>/</span><span>${esc(page.title)}</span></nav>
    <section class="seo-hero seo-hero-simple">
      <div class="container">
        <p class="seo-eyebrow">Scan2Plate public page</p>
        <h1>${esc(page.title)}</h1>
        <p>${esc(page.intro)}</p>
        <div class="seo-cta"><a class="btn btn-primary" href="/demo">Request demo</a><a class="btn btn-outline" href="/features">Explore features</a></div>
      </div>
    </section>
    <section class="seo-section">
      <div class="container seo-content">
        <aside class="seo-answer-box"><h2>Quick answer</h2><p>${esc(page.intro)}</p></aside>
        ${page.sections.map(([title, text]) => `<h2>${esc(title)}</h2><p>${esc(text)}</p>`).join("\n        ")}
        <h2>Benefits</h2>
        <ul>${page.benefits.map(item => `<li>${esc(item)}</li>`).join("")}</ul>
        <h2>How it works</h2>
        <ol>
          <li>Set up business details, menu, tables or service type, tax, payments, and staff access.</li>
          <li>Customers or staff place orders through QR menu, counter, table, token, or pre-order workflows.</li>
          <li>Kitchen and admin teams manage KOT, preparation, billing, payment status, inventory, and reports.</li>
        </ol>
        <h2>Related Scan2Plate pages</h2>
        <div class="seo-link-grid">${related.map(([slug, label]) => `<a href="/${slug}">${esc(label)}</a>`).join("")}</div>
        ${categoryCards}
        <h2>FAQ</h2>
        <div class="seo-faq">${faqItems(page).map(([question, answer]) => `<details><summary>${esc(question)}</summary><p>${esc(answer)}</p></details>`).join("")}</div>
      </div>
    </section>
    ${formMarkup(page.form)}
    <section class="seo-section seo-cta-band"><div class="container"><h2>Ready to review Scan2Plate for your restaurant?</h2><p>Share your workflow and the team can help you decide which setup fits your restaurant, cafe, cloud kitchen, hotel, food court, or vendor operation.</p><a class="btn btn-primary" href="/contact">Contact Scan2Plate</a></div></section>
  </main>
  ${footer()}
  ${formScript(page)}
</body>
</html>`;
}

function aliasHtml(alias, target) {
  return `<!DOCTYPE html>
<html lang="en-IN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Redirecting | Scan2Plate</title>
  <meta name="robots" content="noindex,follow" />
  <link rel="canonical" href="${loc(target)}" />
  <meta http-equiv="refresh" content="0; url=/${target}" />
</head>
<body>
  <p>Redirecting to <a href="/${target}">/${target}</a>.</p>
</body>
</html>`;
}

function notFoundHtml() {
  const page = {
    slug: "404",
    title: "Page Not Found",
    description: "The requested Scan2Plate page could not be found.",
    intro: "The page you are looking for does not exist or may have moved.",
    sections: [],
    benefits: []
  };
  return `<!DOCTYPE html>
<html lang="en-IN">
${head(page)}
<body>
  ${header()}
  <main>
    <section class="seo-hero seo-hero-simple"><div class="container"><h1>Page not found</h1><p>The page you are looking for does not exist. Use the links below to return to a public Scan2Plate page.</p><div class="seo-cta"><a class="btn btn-primary" href="/">Go home</a><a class="btn btn-outline" href="/contact">Contact support</a></div></div></section>
    <section class="seo-section"><div class="container seo-link-grid">${featureLinks.map(([slug, label]) => `<a href="/${slug}">${esc(label)}</a>`).join("")}</div></section>
  </main>
  ${footer()}
</body>
</html>`;
}

function sitemapXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapPages.map(page => `  <url>
    <loc>${loc(page.slug)}</loc>
    <lastmod>${TODAY}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`).join("\n")}
</urlset>
`;
}

function robotsTxt() {
  return `User-agent: *
Allow: /

Disallow: /admin
Disallow: /super-admin
Disallow: /dashboard
Disallow: /kitchen
Disallow: /staff
Disallow: /settings
Disallow: /login
Disallow: /register
Disallow: /reset-password
Disallow: /forgot-password

Sitemap: https://scan2plate.com/sitemap.xml
`;
}

for (const page of pages) {
  ensureFile(join(OUT, `${page.slug}.html`), pageHtml(page));
  ensureFile(join(OUT, page.slug, "index.html"), pageHtml(page));
}
for (const [alias, target] of routeAliases) {
  ensureFile(join(OUT, `${alias}.html`), aliasHtml(alias, target));
  ensureFile(join(OUT, alias, "index.html"), aliasHtml(alias, target));
}
ensureFile(join(OUT, "404.html"), notFoundHtml());
ensureFile(join(OUT, "sitemap.xml"), sitemapXml());
ensureFile("sitemap.xml", sitemapXml());
ensureFile(join(OUT, "robots.txt"), robotsTxt());
ensureFile("robots.txt", robotsTxt());

console.log(`Generated ${pages.length} public SEO pages, sitemap.xml, robots.txt, and 404.html.`);
