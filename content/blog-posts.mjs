/* Blog post content. Rendered by scripts/build-blog.mjs.
 *
 * AUTHOR: schema.org allows an Organization as author and that is what is used
 * here, because inventing a person's name would be worse than not naming one.
 * A named human with a real byline is a materially stronger E-E-A-T signal and
 * is what a search engine and an answer engine both prefer.
 *
 * TODO(owner): replace AUTHOR with a real person once someone is willing to be
 * named — { "@type": "Person", name: "...", jobTitle: "...", url: "/about" } —
 * and add a short bio line to /about.
 */
export const AUTHOR = {
  "@type": "Organization",
  name: "Scan2Plate",
  url: "https://scan2plate.com/about"
};

const p = t => `<p>${t}</p>`;
const ol = items => `<ol class="numbered-steps">\n${items.map(i => `          <li>${i}</li>`).join("\n")}\n        </ol>`;
const ul = items => `<ul>\n${items.map(i => `          <li>${i}</li>`).join("\n")}\n        </ul>`;
const table = (caption, rows) =>
`<div class="table-wrap">
          <table class="spec-table">
            <caption>${caption}</caption>
            <tbody>
${rows.map(([k, v]) => `              <tr><th scope="row">${k}</th><td>${v}</td></tr>`).join("\n")}
            </tbody>
          </table>
        </div>`;

export const POSTS = [
{
  slug: "what-is-kot-in-restaurant",
  category: "Restaurant operations",
  title: "What Is a KOT in a Restaurant? Plain Answer",
  description: "A KOT is the Kitchen Order Ticket telling the kitchen what to cook. What it contains, why it is separate from the bill, and how it works on paper and screen.",
  published: "2026-09-21",
  answer: "<strong>A KOT, or Kitchen Order Ticket, is the slip that tells a restaurant kitchen what to cook.</strong> It lists the items ordered, their quantities and the table or token they belong to. It is separate from the customer's bill because the kitchen needs to know what to make, not what it costs.",
  sections: [
    { h2: "What is actually on a KOT",
      body: [ p("A KOT carries only what the kitchen needs to act on. A typical one shows the table or token number, a serial number so tickets can be referred to, the time it was raised, and each item with its quantity and portion size."),
              p("What it does not carry is price. A cook does not need to know that the paneer is &#8377;240, and putting it there invites the ticket to be mistaken for a bill."),
              table("A KOT compared with a bill", [
                ["KOT shows", "Items, quantities, portion size, table or token, time"],
                ["Bill shows", "Items, quantities, rates, discount, tax, total, payment mode"],
                ["KOT goes to", "The kitchen"],
                ["Bill goes to", "The customer"],
                ["When raised", "As soon as the order is taken"],
                ["When raised (bill)", "When the guest asks to settle"]
              ]) ] },
    { h2: "Why the kitchen ticket is separate from the bill",
      body: [ p("Because they happen at different times and answer different questions."),
              p("A table that orders in three rounds generates three KOTs, because the kitchen has to cook three times. It generates one bill, because the guest pays once. Collapsing the two would mean either printing a bill the guest has not asked for, or making the kitchen wait until the end of the meal to start cooking."),
              p("The separation is also what makes a missing round detectable. If the kitchen cooked it, a KOT exists. If that KOT's items are not on the bill, something went wrong between the two &mdash; and that is a difference you can actually look for.") ] },
    { h2: "How a KOT works in practice",
      body: [ ol([ "<strong>The order is taken.</strong> A waiter writes it on a pad, or enters it on a POS, or a guest places it from a QR menu on their own phone.",
                   "<strong>The KOT is raised.</strong> On paper this is a carbon pad, one copy to the kitchen and one kept. On a system it prints in the kitchen or appears on a kitchen screen.",
                   "<strong>The kitchen cooks from it.</strong> The ticket is the instruction, so the order of tickets is the order of cooking.",
                   "<strong>The dish is marked done.</strong> On paper, the slip moves to a spike. On a screen, the ticket moves through preparing and ready.",
                   "<strong>The items reach the bill.</strong> On paper, someone adds them up at the end. On a system, they were already on the running bill from the moment the order was taken." ]) ] },
    { h2: "Paper KOT or kitchen screen?",
      body: [ p("Both are in use across India, and neither is wrong."),
              p("<strong>Paper</strong> survives heat, steam and a dropped connection. It needs no power at the pass. It is also the version that gets misfiled, goes under a counter, or is written in handwriting the cook on shift cannot read."),
              p("<strong>A screen</strong> is always legible, shows what has been waiting longest, and lets the floor see what is ready without walking into the kitchen and interrupting. It needs somewhere safe to mount and a connection."),
              p("Many restaurants run both: a screen at the pass, and a printed ticket for a station that cannot see it. A <a href=\"/kitchen-display-system\">kitchen display system</a> and a KOT printer are not alternatives so much as two outputs of the same order.") ] },
    { h2: "Numbering a KOT, and why it is not the bill number",
      body: [ p("A KOT carries its own serial, separate from the bill serial, and the two are not interchangeable."),
              p("One table can produce three KOTs and one bill. If the kitchen ticket and the bill shared a number, either the second round would overwrite the first or the guest would receive three bills. Keeping them separate is what lets you say &ldquo;KOT 112 was cooked and appears on bill 47&rdquo; and have both halves of that sentence mean something."),
              p("In a paper system both series are written by hand, which is where they drift. On a system the bill serial is allocated centrally per business day, so it cannot repeat even when two counters bill at once, and a cancelled bill retires its number instead of passing it on.") ] },
    { h2: "What happens when an order changes",
      body: [ p("Orders change constantly, and how a system handles the change is more revealing than how it handles the happy path."),
              ol([ "<strong>An item is added.</strong> A new KOT is raised for the addition only. The kitchen should not receive the whole order again, because it has already cooked most of it.",
                   "<strong>An item is cancelled before cooking.</strong> The cancellation has to reach the kitchen and the bill. Cancelling on the ticket alone leaves it on the running total.",
                   "<strong>An item is cancelled after cooking.</strong> This is a management decision, not a software one: the food exists and somebody pays for it or it is written off. What the system should do is record which happened.",
                   "<strong>A table moves.</strong> The order moves with it, or the kitchen delivers to an empty table.",
                   "<strong>A guest changes a portion from half to full.</strong> Treat it as a cancellation and a new item, because it is a different dish to cook and to cost." ]) ] },
    { h2: "KOT and the bill, reconciled",
      body: [ p("At the end of a service the useful question is whether everything cooked was charged for."),
              p("With paper, answering it means matching a spike of kitchen slips against a stack of bills, which nobody does nightly and everybody intends to. With a system the reconciliation already happened: the order that produced the KOT is the order on the bill, because they are the same record viewed twice."),
              p("That is the real argument for putting KOTs on a system, and it is not about the kitchen at all. The kitchen manages fine with paper. It is the round that got cooked and never billed that costs money, and that is a reconciliation problem rather than a cooking one.") ] },
    { h2: "Common KOT mistakes",
      body: [ ul([ "<strong>Reusing a KOT number.</strong> If two tickets share a number, a dispute about what was cooked cannot be settled.",
                   "<strong>Writing the price on it.</strong> Invites the ticket to be handed over as a bill.",
                   "<strong>Not raising one for an added round.</strong> The commonest way a round gets cooked and never billed.",
                   "<strong>Cancelling in the kitchen only.</strong> If the order is cancelled on the ticket but not on the system, the bill still has it.",
                   "<strong>Handwriting portion size.</strong> Half and full look identical when written quickly; they are different dishes to cost and to cook." ]) ] }
  ],
  faqs: [
    { q: "What does KOT stand for?", a: "KOT stands for Kitchen Order Ticket. It is the slip or screen entry that tells the kitchen what has been ordered, in what quantity, and for which table or token. The name is used across Indian restaurants regardless of whether the ticket is printed or shown on a display." },
    { q: "Is a KOT the same as a bill?", a: "No. A KOT tells the kitchen what to cook and carries no prices. A bill tells the customer what to pay and carries rates, discount, tax and a total. One table can generate several KOTs across the meal but settles a single bill at the end." },
    { q: "Do small restaurants need a KOT?", a: "Any restaurant where the person taking the order is not the person cooking needs some form of KOT, even if it is a spoken instruction. It becomes worth formalising the moment two orders can be in progress at once, because that is when things get cooked twice or not at all." },
    { q: "Can a KOT be cancelled?", a: "Yes, and it should be cancelled in the system rather than only in the kitchen. Cancelling on the ticket alone leaves the items on the running bill. In Scan2Plate a cancelled order leaves the live kitchen board, and a cancelled bill retires its number rather than reusing it." }
  ],
  cta: { href: "/kitchen-display-system", label: "See how KOTs reach the kitchen" }
},
{
  slug: "how-to-calculate-food-cost-percentage",
  category: "Restaurant finance",
  title: "How to Calculate Food Cost Percentage",
  description: "Food cost percentage is ingredients used divided by sales, times 100. The formula, a worked example in rupees, and what the number actually tells you.",
  published: "2026-09-21",
  answer: "<strong>Food cost percentage is the cost of the ingredients you used divided by the sales they produced, multiplied by 100.</strong> If you used &#8377;90,000 of ingredients to generate &#8377;3,00,000 of sales, your food cost is 30%. It is the single most useful number a restaurant can track, and most do not track it.",
  sections: [
    { h2: "The formula",
      body: [ p("<strong>Food cost % = (Opening stock + Purchases &minus; Closing stock) &divide; Food sales &times; 100</strong>"),
              p("The bracketed part is what you actually consumed, which is not the same as what you bought. A restaurant that buys &#8377;1,00,000 of stock on the last day of the month did not consume it that month, and counting it would make the figure meaningless."),
              p("Use food sales, not total sales. If you sell drinks or packaged items at a different margin, mixing them in gives you a blended number that hides both.") ] },
    { h2: "A worked example",
      body: [ p("A restaurant in Darbhanga closes its March books. The figures are:"),
              table("March", [
                ["Opening stock on 1 March", "&#8377;45,000"],
                ["Purchases during March", "&#8377;2,10,000"],
                ["Closing stock on 31 March", "&#8377;52,000"],
                ["Food sales in March", "&#8377;6,40,000"]
              ]),
              p("Consumed = 45,000 + 2,10,000 &minus; 52,000 = <strong>&#8377;2,03,000</strong>"),
              p("Food cost % = 2,03,000 &divide; 6,40,000 &times; 100 = <strong>31.7%</strong>"),
              p("Note what happened to the &#8377;52,000 of closing stock: it was bought in March but not consumed, so it is removed. If you skipped that step you would have reported 2,55,000 &divide; 6,40,000 = 39.8%, and spent a week hunting a problem that does not exist.") ] },
    { h2: "What the number means",
      body: [ p("There is no single correct figure, but the ranges are well known and worth knowing."),
              table("Typical ranges", [
                ["Under 25%", "Unusually low. Either high margins, or stock is being under-counted"],
                ["25&ndash;35%", "The band most full-service restaurants aim for"],
                ["Over 40%", "Worth investigating: portion sizes, wastage, theft, or prices too low"]
              ]),
              p("The trend matters more than the absolute number. A steady 33% is a business you understand. A figure moving from 29% to 36% over three months is a problem with a cause, and the cause is findable while the months are recent.") ] },
    { h2: "Where the number goes wrong",
      body: [ ul([ "<strong>Not counting stock at all.</strong> Without opening and closing figures you are measuring purchases, not consumption.",
                   "<strong>Counting in mixed units.</strong> A 5&nbsp;kg bag recorded as 5 packets is the commonest single error in an Indian restaurant stock register.",
                   "<strong>Forgetting staff meals.</strong> They consume stock and generate no sales, so they push the percentage up. That is correct, but you should know it is happening.",
                   "<strong>Bills that never got entered.</strong> A supplier bill in a drawer is stock you consumed and did not record.",
                   "<strong>Comparing a festival month with an ordinary one.</strong> Compare like with like or the trend is noise." ]) ] },
    { h2: "Counting stock without it taking an evening",
      body: [ p("The count is the step that kills the habit, so it has to be quick enough to survive a real month-end."),
              p("Count what matters rather than everything. In most kitchens a handful of items &mdash; oil, flour, rice, the main proteins, gas &mdash; account for the large majority of spend, and counting those weekly gives a more useful figure than counting all ninety items once a quarter and giving up."),
              p("Count in the unit you buy in. A 15&nbsp;kg tin of oil is one tin, not fifteen kilos, unless you are prepared to measure part-tins accurately. Mixed units are the commonest source of a wrong figure, and a consistent approximate count beats an inconsistent precise one."),
              p("Count at the same time each period, ideally before service on the same weekday. Comparing a Friday-night closing count against a Monday-morning one measures the weekend, not the month.") ] },
    { h2: "Reading it per dish, not just per month",
      body: [ p("A monthly percentage tells you that something is wrong. It does not tell you what."),
              p("The same arithmetic applied to one dish does. Take what a portion costs to make, divide by what you sell it for, and you have that dish's food cost. A biryani that costs &#8377;95 in ingredients and sells at &#8377;280 runs at 34%. A plate of fries costing &#8377;18 and selling at &#8377;120 runs at 15%."),
              table("Two dishes, same restaurant", [
                ["Biryani", "&#8377;95 cost, &#8377;280 price, 34% food cost, &#8377;185 contribution"],
                ["Fries", "&#8377;18 cost, &#8377;120 price, 15% food cost, &#8377;102 contribution"],
                ["Which to promote", "Depends: fries have the better percentage, biryani the better rupee contribution"]
              ]),
              p("That last row is the part people get wrong. A low percentage is not automatically the better dish. You bank rupees, not percentages, and a kitchen that fills up with high-margin low-value items can be busy and poor at the same time.") ] },
    { h2: "What to do when the number is too high",
      body: [ p("Work through the causes in order of how likely they are, not how interesting."),
              ol([ "<strong>Check the arithmetic first.</strong> Miscounted closing stock is the commonest cause of an alarming figure, and it costs nothing to rule out.",
                   "<strong>Compare purchase rates against last quarter.</strong> Supplier prices rise quietly and menu prices rarely follow on their own.",
                   "<strong>Weigh ten portions of your three best sellers.</strong> Portion creep is real, gradual, and invisible until measured.",
                   "<strong>Look at wastage.</strong> Prep that goes uncooked and dishes returned are both stock consumed with no sale against it.",
                   "<strong>Only then consider theft.</strong> It happens, but it is the last thing to conclude and the hardest to act on, and the four checks above explain most movements." ]) ] },
    { h2: "Menu pricing from a target percentage",
      body: [ p("The same formula runs backwards, which is how a price gets set rather than guessed."),
              p("If a dish costs &#8377;70 in ingredients and you want a 30% food cost, divide rather than multiply: 70 &divide; 0.30 = &#8377;233. Round to &#8377;240 and you are at 29%. Setting the price by adding a comfortable-looking margin is how dishes end up at wildly different food costs without anyone intending it."),
              p("Two cautions. A target percentage is a starting point, not an answer &mdash; what the market will pay and what competitors charge both constrain it. And the ingredient cost has to include everything that goes on the plate: the garnish, the oil, the gas, the portion of rice nobody counted. A cost that only counts the headline ingredient will produce a price that looks healthy and is not.") ] },
    { h2: "Making it a number you actually have",
      body: [ p("The arithmetic is trivial. Having the inputs is the hard part, and that is why most restaurants do not track this."),
              p("The two inputs are purchases and sales. Sales you already have if you bill on a system &mdash; <a href=\"/restaurant-analytics\">sales reporting</a> gives them by date range. Purchases are the ones that go missing, because entering forty line items off a paper bill at eleven at night does not happen."),
              p("Scanning the supplier bill instead takes seconds, which is the only version that survives contact with a real week. <a href=\"/restaurant-inventory\">Inventory from scanned bills</a> covers how that works, including the review step before anything is saved.") ] }
  ],
  faqs: [
    { q: "What is a good food cost percentage for an Indian restaurant?", a: "Most full-service restaurants aim for 25 to 35 percent, though it varies by cuisine and format. A tea stall and a fine-dining kitchen have different economics. The trend over several months tells you more than one figure, because a stable percentage means you understand your costs." },
    { q: "Should drinks be included in food cost?", a: "Keep them separate if you can. Beverages usually carry a very different margin from food, so blending them produces a number that hides both. Calculate food cost on food sales and food purchases, and track beverages on their own." },
    { q: "How often should I calculate it?", a: "Monthly is enough for most restaurants, because it needs a stock count at both ends of the period. Weekly is better if your figure is moving and you are trying to find out why, but it only works if somebody genuinely counts stock each week." },
    { q: "Why is my food cost percentage rising?", a: "The usual causes are supplier prices rising without menu prices following, portion sizes creeping up, wastage, or stock leaving without being sold. Item-level sales read against purchases narrows it down faster than a single monthly figure can." }
  ],
  cta: { href: "/restaurant-inventory", label: "See how stock tracking works" }
},
{
  slug: "restaurant-gst-billing-guide-india",
  category: "Billing and GST",
  title: "GST on Restaurant Bills in India: A Guide",
  description: "What GST rate applies to a restaurant bill, what must be printed on it, how a discount affects the taxable amount, and the errors that cause trouble at audit.",
  published: "2026-09-21",
  answer: "<strong>Most standalone restaurants in India charge GST at 5% on food, without input tax credit.</strong> Restaurants inside hotels above a room-tariff threshold are taxed differently. The rate applies to the amount after discount, not before, and the bill has to show the tax separately from the taxable value.",
  sections: [
    { h2: "Which rate applies to you",
      body: [ "<!-- TODO(owner): GST rates and the hotel room-tariff threshold change by\\n             notification. Verify the current figures with your CA or at\\n             cbic-gst.gov.in before this page is promoted, and update the\\n             table and the dateModified. Everything else on this page is\\n             structural and does not depend on the rate. -->",
              p("Rates are set by notification and do change, so treat the table below as the shape of the answer and confirm the current figures with your accountant."),
              table("Commonly applicable rates", [
                ["Standalone restaurant, dine-in or takeaway", "5% without input tax credit"],
                ["Restaurant inside a hotel above the specified room-tariff threshold", "18% with input tax credit"],
                ["Outdoor catering", "Treated separately"],
                ["Packaged goods sold as-is", "The rate applicable to that product, not the restaurant rate"]
              ]),
              p("The practical consequence of 5% without input tax credit is that GST paid on your purchases is not recoverable. It is a cost, not a credit, and it belongs in your margin calculation rather than being treated as pass-through.") ] },
    { h2: "What has to be on the bill",
      body: [ p("A tax invoice from a registered restaurant has to identify the supplier, the supply, and the tax charged. In practice that means:"),
              ul([ "Your restaurant name, address and GSTIN",
                   "An invoice number from a consecutive series, and the date",
                   "Each item with quantity and rate",
                   "The taxable value, after any discount",
                   "CGST and SGST shown separately, each at half the total rate, for a sale within your state",
                   "The total payable" ]),
              p("The phrase that matters is <strong>consecutive series</strong>. Numbers with gaps you cannot explain, or worse a number that appears twice, is the first thing that attracts a question at audit.") ] },
    { h2: "Discount before tax, not after",
      body: [ p("This is the single commonest arithmetic mistake on a restaurant bill."),
              p("A discount agreed at the time of supply reduces the taxable value. Tax is then calculated on the reduced amount. Applying the discount after tax produces a smaller-looking total but an incorrect tax figure, and the tax figure is the one that gets reconciled against your returns."),
              table("A ₹1,000 order with a 10% discount at 5% GST", [
                ["Correct: discount then tax", "1,000 &minus; 100 = 900 taxable; tax 45; total &#8377;945"],
                ["Wrong: tax then discount", "1,000 + 50 = 1,050; less 105; total &#8377;945"],
                ["Why it matters", "Both total &#8377;945, but the second reports &#8377;50 of tax on a &#8377;900 supply"]
              ]),
              p("The totals can coincide. The reported tax does not, and that is what your return carries.") ] },
    { h2: "Bill numbering, and why it gets restaurants into trouble",
      body: [ p("A consecutive series sounds trivial until a Saturday evening."),
              p("A second billing counter opens and starts its own count. A cancelled bill has its number handed to the next customer. Somebody reopens the billing app and the day restarts at one. None of that is dishonest, and all of it produces a sequence that cannot be explained a year later."),
              p("The structural fix is that the number must not be generated by whichever device happens to print it. In <a href=\"/restaurant-billing-software\">Scan2Plate billing</a> the number is allocated centrally inside a database transaction, two counters billing simultaneously cannot collide, a cancelled bill retires its number rather than reissuing it, and the counter belongs to the business day rather than the browser session.") ] },
    { h2: "Composition scheme, and whether it applies to you",
      body: [ p("Some small restaurants opt for the composition scheme, which trades a lower rate and simpler returns for restrictions."),
              p("Under it you cannot collect tax from customers as a separate line, cannot claim input credit, and must display that you are a composition taxable person. Turnover limits apply and are set by notification."),
              p("<!-- TODO(owner): confirm the current composition turnover limit and rate with your CA before quoting either. --> Whether it is worth it depends on your turnover, your input costs and how much of your trade is with businesses who want a tax invoice. It is a question for your accountant rather than for software, but it changes what your bill must say, so the decision has to reach whoever configures your billing.") ] },
    { h2: "What to configure once, and check",
      body: [ ol([ "<strong>Enter your GSTIN</strong> in settings so it prints on every bill. A bill without it is not a valid tax invoice.",
                   "<strong>Set the tax rate</strong> that applies to your category, and confirm it against one printed bill rather than assuming.",
                   "<strong>Print a test bill with a discount</strong> and check that tax was calculated on the discounted amount.",
                   "<strong>Cancel a test bill</strong> and confirm the next bill takes the following number rather than the cancelled one.",
                   "<strong>Bill from two devices at once</strong> if you run more than one counter, and confirm the numbers do not collide." ]),
              p("Those five checks take fifteen minutes and cover the failures that are expensive to discover later. The last two are the ones almost nobody tests, and they are the ones that produce an unexplainable sequence.") ] },
    { h2: "Keeping records you can actually produce",
      body: [ p("The question at an audit is rarely whether you charged the right rate. It is whether you can show what you charged, consistently, across a period."),
              p("That means bills retrievable by date, a sequence you can explain including its gaps, and sales figures that reconcile with what you filed. A restaurant billing on paper can produce all of it given enough time in a storeroom. A restaurant billing on a system can produce it in a minute, and that difference is most of the practical value of the record-keeping."),
              p("Whatever you use, export and keep a copy at period end rather than relying on any single vendor remaining available. Your bills are your records, not your software provider's, and a vendor you leave should not be holding the only copy.") ] },
    { h2: "Mistakes worth checking on your own bills tonight",
      body: [ ul([ "<strong>GSTIN missing</strong> from the printed bill.",
                   "<strong>Tax not split</strong> into CGST and SGST for an in-state supply.",
                   "<strong>Discount applied after tax</strong>, as above.",
                   "<strong>Duplicate bill numbers</strong> from a second counter.",
                   "<strong>Packaged goods billed at the restaurant rate</strong> rather than their own.",
                   "<strong>Rounding done twice</strong>, once per line and again on the total." ]) ] }
  ],
  faqs: [
    { q: "What GST rate applies to a standalone restaurant?", a: "Most standalone restaurants charge 5% on food without input tax credit, meaning GST paid on purchases cannot be recovered. Restaurants inside hotels above a specified room-tariff threshold are taxed at a different rate with credit available. Rates change by notification, so confirm the current figure with your accountant." },
    { q: "Is GST charged before or after a discount?", a: "After. A discount agreed at the time of supply reduces the taxable value, and tax is calculated on the reduced amount. Applying tax first and then the discount can produce the same total while reporting tax on a value you did not actually supply, which is the figure your return carries." },
    { q: "Does a restaurant bill need to show CGST and SGST separately?", a: "For a supply within your own state, yes. The total rate is split into equal CGST and SGST components and each is shown on the bill. A single combined tax line does not meet the requirement even when the total is correct." },
    { q: "What happens if bill numbers have gaps?", a: "A gap you can explain, such as a cancelled bill whose number was retired, is normal and defensible. A duplicate number, or a sequence that restarts mid-day because a second counter began its own count, is the version that causes problems, because it means two supplies share one identifier." }
  ],
  cta: { href: "/restaurant-billing-software", label: "See how GST billing works in Scan2Plate" }
},
{
  slug: "qr-ordering-vs-traditional-menu",
  category: "QR ordering",
  title: "QR Ordering vs a Printed Menu, Compared",
  description: "Where QR ordering genuinely helps a restaurant, where a printed menu is still better, and the operational trade-offs nobody mentions when selling either one.",
  published: "2026-09-21",
  answer: "<strong>QR ordering removes the order-taking bottleneck; a printed menu removes the dependency on a guest's phone.</strong> QR wins where the constraint is how many people can take orders at peak. Print wins where guests lack data, signal is poor indoors, or the menu is part of the experience being sold.",
  sections: [
    { h2: "What each one actually changes",
      body: [ table("Side by side", [
                ["Order-taking capacity", "QR: unlimited, every guest orders at once. Print: limited by staff"],
                ["Menu changes", "QR: instant. Print: a reprint, so patched with stickers in between"],
                ["Guest needs", "QR: a data-enabled phone and signal. Print: nothing"],
                ["Order errors", "QR: guest enters it, so no transcription. Print: written then re-typed"],
                ["Upselling", "QR: photographs and descriptions. Print: a waiter who knows the menu"],
                ["Cost per change", "QR: none. Print: printing plus the days of lead time"],
                ["Works in an outage", "Neither: QR needs the guest online, print needs a waiter to bill"]
              ]) ] },
    { h2: "Where QR ordering genuinely helps",
      body: [ p("The honest case for QR is narrow and strong: it removes a queue that exists at the counter rather than in the kitchen."),
              p("At a busy hour, most Indian restaurants are limited by how many people can take an order, not by how fast food is cooked. Guests wait to catch a waiter's eye, the waiter writes on a pad, walks to the counter and reads it out, and somebody types it again. Every step is a place the order can be misheard."),
              p("The second gain is quieter. A guest who wants one more portion waits to be noticed, gives up, and asks for the bill instead. Removing that wait adds rounds that a printed menu simply never captures.") ] },
    { h2: "Where a printed menu is still better",
      body: [ p("Three situations, and none of them is unusual."),
              p("<strong>Guests without data.</strong> If a meaningful share of your customers do not carry data-enabled phones, QR ordering excludes them at the first step. That is not a problem software solves."),
              p("<strong>Poor indoor signal.</strong> A dining room in a basement or behind thick walls can be a dead zone on one network and fine on another, and you will not find out until guests are annoyed."),
              p("<strong>The menu is the product.</strong> In a room where the menu is an object people are paying for, a QR code on the table is a downgrade. A digital menu can sit alongside it for pricing and availability, but it should not replace it.") ] },
    { h2: "The trade-offs nobody mentions",
      body: [ ul([ "<strong>A QR code is a public link.</strong> Anyone who photographs it can open the menu from anywhere. Unless orders are checked against location, you will eventually receive one from somebody not in your restaurant.",
                   "<strong>Older guests may simply not use it.</strong> Plan to run both rather than assuming adoption.",
                   "<strong>Phone batteries die.</strong> A table halfway through a meal with a flat phone still needs to order.",
                   "<strong>It changes what waiters do, not whether you need them.</strong> Service, recommendations and handling problems are still human work.",
                   "<strong>A stale digital menu is worse than a stale printed one,</strong> because guests trust the screen more." ]) ] },
    { h2: "What it does to the guest experience",
      body: [ p("The arguments for QR ordering are usually operational. The effect on guests is more mixed than either side admits."),
              p("<strong>It gives guests time.</strong> Nobody is standing over the table waiting. Guests read the whole menu, look at photographs, and order what they actually want rather than the first thing they recognise. Larger tables order in their own time instead of one person reading aloud for everyone."),
              p("<strong>It removes a moment of service.</strong> For some guests the waiter arriving is part of eating out, and a QR code is a small refusal of that. This matters more in the evening than at lunch, and more for a celebration than a weekday meal."),
              p("The restaurants that handle this well do not present it as a replacement. The code is on the table for guests who want it, and a waiter comes to anyone who has not scanned within a few minutes.") ] },
    { h2: "Rolling it out without annoying anyone",
      body: [ ol([ "<strong>Start with the digital menu, not the ordering.</strong> Let guests scan to read while waiters still take orders. You get accurate prices and availability with no behaviour change to manage.",
                   "<strong>Turn ordering on for part of the floor.</strong> An outdoor section or a few tables is enough to learn how your guests react.",
                   "<strong>Brief the staff on what changes.</strong> Waiters need to know that orders will appear without them, or they will assume the system is wrong.",
                   "<strong>Keep printed menus available.</strong> Not as a permanent fixture necessarily, but through the first month.",
                   "<strong>Watch the tables that do not scan.</strong> If a consistent group never uses it, that tells you who you would be excluding by going fully digital." ]) ] },
    { h2: "What it costs to run both",
      body: [ p("Running a printed menu alongside a digital one sounds like double work. In practice the cost is mostly one-off."),
              p("The menu is entered once, and after that it is the digital version that changes. The printed card is reprinted at whatever interval you were already reprinting it &mdash; annually for most restaurants &mdash; and in between it is allowed to be slightly out of date, because the price that is charged comes from the system rather than the card."),
              p("What that removes is the patching: no stickers over rates, no pen lines through sold-out dishes, no waiter reciting what is unavailable. The printed menu becomes a description of what you serve rather than a binding price list, which is a much easier thing to keep acceptable.") ] },
    { h2: "What most restaurants actually do",
      body: [ p("They run both, and treat the digital menu as the source of truth."),
              p("Prices and availability live in the <a href=\"/digital-menu\">digital menu</a>, so what a guest sees and what the bill charges come from the same record. Guests who want to order from their phone use <a href=\"/restaurant-qr-ordering\">QR ordering</a>; guests who want to order out loud tell a waiter, who enters it on the same system. Both land on one running bill for the table."),
              p("The printed card, if you keep one, becomes a courtesy rather than the thing that has to be correct. That is the arrangement that survives a real service, and it does not require choosing a side.") ] }
  ],
  faqs: [
    { q: "Do guests need to install an app to use QR ordering?", a: "They should not have to. Scanning should open the menu in whatever browser the phone already has, with no account and no phone number required. Any system that demands an install is adding a step at exactly the moment a hungry guest is most likely to give up." },
    { q: "Can someone order from outside the restaurant using a photographed QR code?", a: "Yes, unless orders are checked against location. A QR code on a table is a public link. Scan2Plate can compare the guest's position against the restaurant's coordinates and refuse orders beyond a radius you set, 150 metres by default, which closes that gap." },
    { q: "Does QR ordering mean I need fewer waiters?", a: "It usually means waiters spend less time writing and re-typing orders and more on service. The capacity gain at peak is real, but guests still want recommendations, corrections and someone to notice a problem. Treat it as removing a bottleneck rather than removing staff." },
    { q: "Should I stop printing menus entirely?", a: "Not necessarily. Many restaurants keep a printed card for guests who prefer one while treating the digital menu as the version that is correct. The printed card stops being the source of truth for prices and availability, which is the change that actually matters." }
  ],
  cta: { href: "/restaurant-qr-ordering", label: "See how QR ordering works" }
},
{
  slug: "best-restaurant-billing-software-india-2026",
  category: "Buying guides",
  title: "Choosing Restaurant Billing Software in India",
  description: "How to evaluate restaurant billing software in India: four questions that separate systems, what to test before signing, and where Scan2Plate honestly fits.",
  published: "2026-09-21",
  answer: "<strong>Restaurant billing software in India is separated by four things: what the price includes, what happens when the internet fails, what it costs to leave, and who answers at 9pm.</strong> Feature lists mostly match. This guide is how to test the four, not a ranking.",
  sections: [
    { h2: "A disclosure, before anything else",
      body: [ p("<strong>Scan2Plate is our product.</strong> This guide is published by the company that makes it, and you should read it knowing that."),
              p("What that means in practice: we have not ranked competitors, and we have not printed their prices. We cannot verify another vendor's current pricing or terms, and a comparison built on figures we guessed at would be unfair to them and useless to you. What follows is the evaluation method we would use, with an honest note at the end about where Scan2Plate fits and where it does not.") ] },
    { h2: "Why feature lists do not separate anything",
      body: [ p("Open five vendors' pages and you will find the same list: billing, KOT, QR ordering, inventory, reports. At this point in the market, almost everyone has almost everything."),
              p("What differs is which of those sit behind a higher plan, whether they work when the connection drops, and what happens when you want to leave. None of that appears on a feature grid, and all of it shows up in month three.") ] },
    { h2: "The four questions",
      body: [ ol([ "<strong>What does the price actually include?</strong> Ask which plan includes the kitchen display, the inventory module and the reports you intend to use. A &#8377;300 headline with the kitchen screen one tier up is not a &#8377;300 product. Ask about per-device charges too, because a second billing counter at peak is normal.",
                   "<strong>What happens when the internet fails?</strong> Ask for a demonstration with the network switched off, not a description of it. Watch a bill print. Then ask what happens to those bills when the connection returns, and specifically whether a bill can be uploaded twice.",
                   "<strong>What does it cost to leave?</strong> Contract length, notice period, and whether you can export your own menu, bills and customer data without asking permission. Ask before signing, because the answer changes afterwards.",
                   "<strong>Who answers at 9pm on a Saturday?</strong> Support hours matter more than a feature when a bill will not print mid-service. Ask for the actual hours and the actual channel." ]) ] },
    { h2: "What to test before you sign",
      body: [ p("A demo shows you the software working. What you need to know is how it fails."),
              ol([ "<strong>Bill a real service in parallel.</strong> Run the new system alongside your current one for one quiet weekday and compare day-end totals. A 2% discrepancy is far cheaper to find on a Tuesday than a Saturday.",
                   "<strong>Put a new member of staff on it.</strong> If somebody who has never seen it can take an order within ten minutes, training will not be your problem.",
                   "<strong>Switch the network off mid-bill.</strong> Whatever the vendor said, watch what actually happens.",
                   "<strong>Cancel a bill and check the next number.</strong> If the cancelled number is reissued, the sequence is not audit-safe.",
                   "<strong>Export your data.</strong> Do it during the trial, not when you are leaving." ]) ] },
    { h2: "Questions to ask that vendors do not expect",
      body: [ p("The four above are the structure. These are the ones that produce revealing answers because they are rarely rehearsed."),
              ul([ "<strong>&ldquo;Show me a bill being cancelled, then show me the next bill's number.&rdquo;</strong> If the cancelled number reappears, the sequence is not audit-safe.",
                   "<strong>&ldquo;What happens if two counters bill at the same second?&rdquo;</strong> The answer should involve the server deciding, not the devices coordinating.",
                   "<strong>&ldquo;Can I export my menu and my bills today, during the trial?&rdquo;</strong> Do it rather than accept an assurance.",
                   "<strong>&ldquo;Which features are on the plan you are quoting me?&rdquo;</strong> Ask for it in writing against the specific plan name.",
                   "<strong>&ldquo;What is the notice period?&rdquo;</strong> Ask before signing; the answer is less flexible afterwards.",
                   "<strong>&ldquo;What does support cost after the first year?&rdquo;</strong> Sometimes a separate line, sometimes not." ]) ] },
    { h2: "Formats have different requirements",
      body: [ p("&ldquo;Restaurant billing software&rdquo; covers formats with genuinely different needs, and a system that suits one can be awkward for another."),
              table("What each format needs most", [
                ["Table-service restaurant", "Floor view, one running bill per table, orders from staff and guests"],
                ["Cafe or counter service", "Speed at the counter, token numbers, payment before preparation"],
                ["Cloud kitchen", "Pre-orders, dispatch sequencing, no floor management at all"],
                ["Food court counter", "Token service, fast repeat orders, shared seating that nobody owns"],
                ["Hotel restaurant", "Charges posted to a room, different GST treatment"]
              ]),
              p("Ask a vendor which of these they are built for. A system that does all of them equally usually does none of them particularly well, and a demo on the wrong flow will look fine while hiding the friction you would hit daily.") ] },
    { h2: "Mistakes buyers make",
      body: [ ul([ "<strong>Buying on the demo.</strong> A demo is a rehearsed happy path. Ask to see a cancellation, a network failure and a busy floor.",
                   "<strong>Comparing headline prices.</strong> Add the tier you would actually need, per-device charges and separately priced modules first.",
                   "<strong>Switching during a busy period.</strong> Move systems in a quiet week, never before a festival or a weekend.",
                   "<strong>Cancelling the old system immediately.</strong> Keep it for one full billing cycle until you have reports you trust.",
                   "<strong>Not involving the staff who will use it.</strong> The person billing at peak will find the friction an owner never sees.",
                   "<strong>Ignoring the exit.</strong> Ask how you would leave before you join; the answer is more honest then." ]),
              p("Most regret in this category comes from the last three rather than from picking the wrong product.") ] },
    { h2: "Where Scan2Plate fits, and where it does not",
      body: [ p("Against the four questions above: &#8377;499 a month per restaurant with every feature included and no per-device charge; installed Windows, macOS, Linux and Android apps that keep billing through an outage and sync without duplicating a bill; a monthly subscription with no annual lock-in; and support you can reach through the contact page."),
              p("It is built for a single restaurant or a small group run by the people who own it."),
              p("<strong>It is the wrong choice if</strong> you need head-office control across many branches, you depend on delivery aggregator integration &mdash; Scan2Plate does not pull those orders in automatically &mdash; or you need recipe-level ingredient costing. Those are real limits and they are better read here than discovered in month two."),
              p("The <a href=\"/petpooja-alternative\">comparison with Petpooja</a> applies the same four questions and includes a section on when the incumbent is the better choice. The full cost is on the <a href=\"/pricing\">pricing page</a>.") ] }
  ],
  faqs: [
    { q: "What should restaurant billing software cost in India?", a: "Published prices in this segment range from roughly a hundred rupees a month to several thousand, but the headline is rarely the total. Add the tier you would actually need, any per-device charges, separately priced modules, and whether the rate quoted assumes an annual commitment. That total is the number worth comparing." },
    { q: "Do I need software that works offline?", a: "It depends on your connection, and the honest test is how often you have lost it during service. If the answer is never, offline capability is insurance you may not need. If a power cut or a dead link has ever sent you to a notebook mid-service, it is the feature that matters most." },
    { q: "How long does switching billing systems take?", a: "Setting up the menu, tables, tax rate and staff logins is the bulk of the work and depends on menu size rather than the software. Plan a week of parallel running before moving the floor across, and do not cancel the old subscription until you have a month of reports you trust." },
    { q: "Is cheaper software worse?", a: "Not necessarily, but check what the price excludes before deciding. Tiered pricing works by placing something you will eventually need in a plan above the one you signed for, so a low headline can become the higher figure within a few months. Ask which plan includes the features you actually intend to use." }
  ],
  cta: { href: "/demo", label: "Book a free demo and test the four questions" }
}

];
