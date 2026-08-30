// Theme registry — the single source of truth for the /themes pages.
//
// A theme is a hand-curated basket of ASX codes (lithium, uranium, the rare
// earth "magnet stocks", …) charted and ranked by short interest. The
// screener serves the same rows via the ScreenerFilters.product_codes filter;
// themes exist because a stable, sitewide-linked URL per basket ranks and a
// ?codes= query param doesn't.
//
// Everything here must stay serializable (no functions) — the registry is
// imported by server pages AND the sitemap.
//
// CURATION CONTRACT
//
//  1. Every ticker below was verified against the local screener MV on
//     2026-08-25: it exists in mv_screener_data (so it carries live ASIC
//     short data), and its "company-metadata" row (company_name, industry,
//     description, summary, enhanced_summary) states the business that puts
//     it in the theme. Sector membership asserted by industry alone is only
//     acceptable where the industry IS the theme (banks, biotech, software).
//  2. A wrong member is worse than a missing one. Where the database could
//     not corroborate a candidate the candidate was dropped, even when it is
//     well known off-platform — the site rule is withhold rather than guess.
//     Dropped for that reason at launch: ILU (metadata says mineral sands
//     only, never rare earths), SYR and EMR (metadata is a bare "Mining
//     explorer" / "Mineral exploration"), WA1 (niobium-primary), DRR (royalty
//     portfolio, no iron-ore mention), BCI (salt and potash), MP1 (network
//     connectivity, no data-centre mention), NIC (nickel pig iron for
//     stainless, not battery feedstock).
//  3. Overlap between themes is expected and fine — PLS sits in both lithium
//     and battery-metals because it belongs in both.
//  4. To add a theme: verify each candidate with
//       SELECT stock_code, company_name, industry FROM mv_screener_data
//         WHERE stock_code = 'XYZ';
//       SELECT company_name, industry, description, summary, enhanced_summary
//         FROM "company-metadata" WHERE stock_code = 'XYZ';
//     keep 6-15 verified tickers (a theme that cannot reach 5 does not ship),
//     and use exact industry strings from
//       SELECT DISTINCT industry FROM mv_screener_data;
//     for relatedIndustries. registry.test.ts enforces the structural rules.
//  5. Delistings and renames are not detected automatically. Re-verify the
//     whole file when short data goes missing for a member.

export interface ThemeDefinition {
  slug: string;
  /** Short display name (nav, chips, cross-links). */
  name: string;
  /** <title> without the "| Shorted" suffix (layout template appends it). */
  title: string;
  h1: string;
  /** Meta description (~155 chars, query-targeted). */
  description: string;
  keywords: string[];
  /** Short visible dek under the H1. */
  dek: string;
  /** ~120-160 words of unique explanatory copy (server-rendered). */
  blurb: string;
  /** Verified ASX codes — passed straight to ScreenerFilters.product_codes. */
  tickers: string[];
  /** Slugs of related themes to cross-link. */
  relatedThemes: string[];
  /** Exact industry values from mv_screener_data.industry. */
  relatedIndustries: string[];
}

export const THEMES: Record<string, ThemeDefinition> = {
  "rare-earths": {
    slug: "rare-earths",
    name: "Rare Earths",
    title: "ASX Rare Earth Stocks — Short Interest in the Magnet Stocks",
    h1: "ASX Rare Earth Stocks",
    description:
      "Short interest across the ASX rare earth and magnet stocks — Lynas, Arafura, Iluka's peers and the developers chasing NdPr. Official ASIC data, updated daily.",
    keywords: [
      "asx rare earth stocks",
      "magnet stocks asx",
      "rare earth short interest",
      "ndpr asx",
      "lynas short interest",
    ],
    dek: "The magnet stocks — NdPr, dysprosium and the separation plants — ranked by short interest.",
    blurb:
      "Rare earths are the ASX's purest policy trade. The elements that matter commercially are the magnet inputs — neodymium, praseodymium, dysprosium and terbium — because permanent magnets drive electric vehicle motors, wind turbines and guided weapons, and because China refines the overwhelming majority of them. That concentration is what governments are paying to break, so the magnet stocks re-rate on offtake agreements, price floors and defence funding rather than on production. Short sellers are drawn to the same feature from the other side: most names here are pre-revenue developers whose separation flowsheets are technically hard, whose capital costs keep rising, and whose economics depend on an opaque, thinly traded price set outside the market they sell into. Crowding builds when an equity raise is expected or a milestone slips, and unwinds violently when a policy announcement lands.",
    tickers: [
      "LYC",
      "ARU",
      "ARR",
      "BRE",
      "IXR",
      "NTU",
      "HAS",
      "MEI",
      "VML",
      "CRI",
      "LIN",
      "VMM",
      "VHM",
      "ASM",
    ],
    relatedThemes: ["lithium", "battery-metals", "uranium"],
    relatedIndustries: ["Materials"],
  },

  lithium: {
    slug: "lithium",
    name: "Lithium",
    title: "ASX Lithium Stocks — Short Interest Tracker",
    h1: "ASX Lithium Stocks",
    description:
      "Short interest across ASX lithium miners and developers — PLS, Mineral Resources, Liontown and the brine and spodumene juniors. Official ASIC data, updated daily.",
    keywords: [
      "asx lithium stocks",
      "lithium short interest",
      "most shorted lithium stocks",
      "spodumene asx",
      "pls short interest",
    ],
    dek: "Spodumene producers, brine developers and the most crowded shorts on the ASX.",
    blurb:
      "Lithium is where Australian short selling is most visible. The ASX hosts the largest listed cluster of hard-rock spodumene producers in the world, and the spodumene price is set by a Chinese converter market that moves faster than mine plans do. When conversion margins compress, high-cost producers and pre-production developers lose the ability to fund themselves, and that gap between a fixed cost base and a falling received price is the short thesis in one sentence. The register itself amplifies it: several of these names carry index inclusion, deep options markets and stock lending pools large enough to support double-digit short interest for months. That same depth is why lithium produces the ASX's sharpest squeezes — a supply cut, a takeover approach or a battery-demand surprise forces crowded positions to buy back into limited liquidity.",
    tickers: [
      "PLS",
      "MIN",
      "IGO",
      "LTR",
      "ELV",
      "CXO",
      "VUL",
      "GL1",
      "GLN",
      "DLI",
      "PMT",
      "WC8",
      "LKE",
      "AGY",
      "INR",
    ],
    relatedThemes: ["battery-metals", "rare-earths", "iron-ore"],
    relatedIndustries: ["Materials"],
  },

  uranium: {
    slug: "uranium",
    name: "Uranium",
    title: "ASX Uranium Stocks — Short Interest Tracker",
    h1: "ASX Uranium Stocks",
    description:
      "Short interest across ASX uranium producers, developers and explorers — Paladin, Boss, Deep Yellow, Lotus and peers. Official ASIC data, updated daily.",
    keywords: [
      "asx uranium stocks",
      "uranium short interest",
      "most shorted uranium stocks",
      "nuclear stocks asx",
      "paladin energy short interest",
    ],
    dek: "Producers restarting, developers financing, and where the bears sit in the nuclear trade.",
    blurb:
      "Uranium equities trade on a contract market almost nobody can see. Utilities buy under long-term contracts at undisclosed terms, the published spot price reflects a thin sliver of volume, and the gap between the two decides whether a restart or a greenfield development is financeable. The ASX names in this theme are mostly restarts and developers rather than steady producers, which makes them a sequence of binary events: a ramp-up rate, a permitting decision, a financing package. Short sellers concentrate around exactly those dates, and around the recurring pattern of ramp guidance being revised. The offsetting risk is that uranium sentiment moves as a bloc — a reactor policy shift, a supply disruption at a major mine, or a single utility contracting round can re-rate every name at once, regardless of where each one sits on its own timeline.",
    tickers: [
      "PDN",
      "BOE",
      "DYL",
      "LOT",
      "BMN",
      "NXG",
      "PEN",
      "EL8",
      "AGE",
      "AEE",
      "BKY",
      "SLX",
    ],
    relatedThemes: ["rare-earths", "gold", "battery-metals"],
    relatedIndustries: ["Energy", "Materials", "Capital Goods"],
  },

  gold: {
    slug: "gold",
    name: "Gold",
    title: "ASX Gold Stocks — Short Interest Tracker",
    h1: "ASX Gold Stocks",
    description:
      "Short interest across ASX gold producers — Northern Star, Evolution, Genesis, Ramelius and peers. Official ASIC short position data, updated daily.",
    keywords: [
      "asx gold stocks",
      "gold miners short interest",
      "most shorted gold stocks asx",
      "gold producers asx",
      "northern star short interest",
    ],
    dek: "The ASX gold producers, ranked by how much of each register is sold short.",
    blurb:
      "Gold miners are rarely a directional short on the metal; they are a short on the gap between the gold price and what a specific mine can deliver. Australian producers sell into a strong Australian dollar gold price but run into grade reconciliation problems, labour and diesel inflation, hedge books entered at lower prices, and acquisitions that take longer to integrate than the guidance implied. That is why short interest here clusters around individual operational stories rather than across the sector. The other structural source of shorting is merger activity: the sector consolidates constantly, and a scrip-funded takeover invites arbitrage that appears in ASIC data as short interest in the acquirer. Reading this table alongside the four-week change column separates the two — an operational short builds slowly, a merger-arbitrage short appears in a single reporting week.",
    tickers: [
      "NST",
      "EVN",
      "NEM",
      "GMD",
      "PRU",
      "CMM",
      "RMS",
      "VAU",
      "RRL",
      "WGX",
      "WAF",
      "BGL",
      "RSG",
      "GGP",
    ],
    relatedThemes: ["iron-ore", "uranium", "rare-earths"],
    relatedIndustries: ["Materials"],
  },

  "iron-ore": {
    slug: "iron-ore",
    name: "Iron Ore",
    title: "ASX Iron Ore Stocks — Short Interest Tracker",
    h1: "ASX Iron Ore Stocks",
    description:
      "Short interest across ASX iron ore miners — BHP, Rio Tinto, Fortescue, Champion Iron and the junior producers. Official ASIC data, updated daily.",
    keywords: [
      "asx iron ore stocks",
      "iron ore short interest",
      "fortescue short interest",
      "most shorted mining stocks asx",
      "iron ore miners asx",
    ],
    dek: "The bulk miners and juniors whose earnings track one Chinese steel input price.",
    blurb:
      "Iron ore is the largest single earnings exposure on the ASX and the most direct listed bet on Chinese construction. The majors are low-cost enough to stay profitable through most of the cycle, so shorting them is a macro position — a view on Chinese steel output, on new Guinean supply arriving, or on the discount applied to lower-grade product. The juniors are a different trade entirely: their margins are thin, their shipping and haulage costs are fixed, and a modest fall in the benchmark price can erase the spread between cost and revenue. Short interest in the majors therefore tends to be small in percentage terms but enormous in dollars, while the juniors show high percentage short interest on much smaller registers. Days-to-cover, not short percentage, is the meaningful comparison across this theme.",
    tickers: ["BHP", "RIO", "FMG", "MIN", "CIA", "FEX", "GRR", "MGX", "RHI"],
    relatedThemes: ["gold", "lithium", "battery-metals"],
    relatedIndustries: ["Materials"],
  },

  "battery-metals": {
    slug: "battery-metals",
    name: "Battery Metals",
    title: "ASX Battery Metals Stocks — Short Interest Tracker",
    h1: "ASX Battery Metals Stocks",
    description:
      "Short interest across ASX battery metals stocks — lithium, graphite, cobalt, nickel sulphate and vanadium names feeding the cell supply chain. Updated daily.",
    keywords: [
      "asx battery metals stocks",
      "battery minerals asx",
      "graphite stocks asx",
      "battery metals short interest",
      "ev supply chain asx",
    ],
    dek: "Lithium, graphite, cobalt, nickel sulphate and vanadium — the cell supply chain, ranked by short interest.",
    blurb:
      "Battery metals is the wider basket that lithium sits inside: the anode graphite, the cobalt and nickel sulphate in the cathode, the vanadium in grid-scale storage, and the processing companies trying to move up the chain rather than ship concentrate. What links them for a short seller is dependence on a cell chemistry roadmap they do not control. Cathode chemistry has already shifted once toward lower-cobalt and iron-phosphate formulations, stranding projects sized for the previous mix, and synthetic graphite competes directly with natural flake. Most of these companies are also pre-revenue, so each is a funding story: capital cost estimates, offtake conversion and the timing of the next raise. Short interest builds through those financing windows and unwinds on binding offtakes, government support packages and trade measures against incumbent Chinese supply.",
    tickers: [
      "PLS",
      "IGO",
      "LTR",
      "VUL",
      "NVX",
      "TLG",
      "EGR",
      "RNU",
      "COB",
      "AVL",
      "ATC",
      "TVN",
      "CTM",
      "SVM",
    ],
    relatedThemes: ["lithium", "rare-earths", "iron-ore"],
    relatedIndustries: ["Materials", "Technology Hardware & Equipment"],
  },

  "tech-software": {
    slug: "tech-software",
    name: "Tech & Software",
    title: "ASX Tech and Software Stocks — Short Interest Tracker",
    h1: "ASX Tech & Software Stocks",
    description:
      "Short interest across ASX software and technology stocks — WiseTech, Xero, TechnologyOne, Life360 and the SaaS mid-caps. Official ASIC data, updated daily.",
    keywords: [
      "asx tech stocks",
      "asx software stocks short interest",
      "most shorted tech stocks asx",
      "saas stocks asx",
      "wisetech short interest",
    ],
    dek: "The ASX software complex — high multiples, recurring revenue, and where the bears disagree.",
    blurb:
      "ASX software carries some of the highest earnings multiples on the market, and a multiple is the part of a valuation a short seller can attack without disputing a single number in the accounts. The bear cases here are consistent in shape: growth decelerating as a product saturates its home market, net revenue retention slipping, capitalised development expense flattering reported profit, or an offshore expansion costing more than the revenue it wins. Because valuation is the thesis, these positions are sensitive to interest rates as well as to results — the same discount rate that justifies a premium multiple removes it. Reporting season is the pressure point in both directions: a downgrade from a highly rated name repices the sector, while an in-line result against a heavily shorted register can force a squeeze with very little stock available to buy.",
    tickers: [
      "XRO",
      "WTC",
      "TNE",
      "360",
      "NXL",
      "SDR",
      "MP1",
      "HSN",
      "IRE",
      "OCL",
      "RDY",
      "GTK",
      "CAT",
      "QOR",
      "SKO",
    ],
    relatedThemes: ["ai-data-centres", "biotech", "banks"],
    relatedIndustries: ["Software & Services"],
  },

  "ai-data-centres": {
    slug: "ai-data-centres",
    name: "AI & Data Centres",
    title: "ASX AI and Data Centre Stocks — Short Interest Tracker",
    h1: "ASX AI & Data Centre Stocks",
    description:
      "Short interest across the ASX AI and data centre complex — NEXTDC, Macquarie Technology, Infratil, BrainChip and peers. Official ASIC data, updated daily.",
    keywords: [
      "asx ai stocks",
      "asx data centre stocks",
      "nextdc short interest",
      "ai stocks short interest australia",
      "data centre reits asx",
    ],
    dek: "Data centre operators, AI compute and the chip and data names funding the build-out.",
    blurb:
      "The ASX's exposure to artificial intelligence is mostly physical: the operators building and leasing the halls that training and inference run in, plus a small group of chip, high-performance computing and AI-data companies. That split matters to a short seller. The data centre operators are capital-intensive infrastructure businesses whose contracted revenue is genuine but whose returns depend on debt and equity raised years before a hall earns anything — so the short case is funding cost, construction timing and pre-commitment rates, not whether demand exists. The AI-adjacent technology names are the opposite: small registers, narrative-driven prices and revenue that has to arrive to justify the market capitalisation. The two halves rarely move together, and the same headline that lifts a speculative chip developer can widen the funding spread the operators borrow at.",
    tickers: ["NXT", "MAQ", "IFT", "DXN", "AI1", "BRN", "APX", "DUG"],
    relatedThemes: ["tech-software", "banks", "biotech"],
    relatedIndustries: ["Software & Services", "Capital Goods"],
  },

  banks: {
    slug: "banks",
    name: "Banks",
    title: "ASX Bank Stocks — Short Interest Tracker",
    h1: "ASX Bank Stocks",
    description:
      "Short interest across ASX-listed banks — CBA, NAB, Westpac, ANZ and the regionals. Official ASIC short position data, updated daily.",
    keywords: [
      "asx bank stocks",
      "bank short interest australia",
      "cba short interest",
      "most shorted bank stocks asx",
      "australian banks shorted",
    ],
    dek: "The majors and regionals — where short interest tracks the mortgage cycle.",
    blurb:
      "Australian bank shorting is a housing and net-interest-margin trade wearing a financials label. Roughly two thirds of major bank lending is residential mortgages, so the bear case attaches to arrears, to deposit competition compressing margins, and to the point in the cycle when provisions written back during good years have to be rebuilt. Valuation is a second, separate thesis: the largest banks have traded at multiples of book value well above global peers, which invites relative-value positions that are long one bank and short another rather than short the sector outright. That pairing is why the regionals often show higher percentage short interest than the majors despite far smaller balance sheets. Franking-driven demand from domestic income investors sits on the other side, which keeps a persistent bid under these registers and makes crowded positions expensive to hold through dividend dates.",
    tickers: ["CBA", "NAB", "WBC", "ANZ", "BOQ", "BEN", "JDO", "MYS", "KSL"],
    relatedThemes: ["tech-software", "iron-ore", "ai-data-centres"],
    relatedIndustries: ["Banks"],
  },

  biotech: {
    slug: "biotech",
    name: "Biotech",
    title: "ASX Biotech Stocks — Short Interest Tracker",
    h1: "ASX Biotech Stocks",
    description:
      "Short interest across ASX biotech and pharmaceutical stocks — CSL, Telix, Neuren, Mesoblast, Clarity and the clinical-stage names. Updated daily.",
    keywords: [
      "asx biotech stocks",
      "biotech short interest asx",
      "most shorted biotech stocks",
      "clinical trial stocks asx",
      "mesoblast short interest",
    ],
    dek: "Clinical-stage developers and commercial pharma, ranked by short interest.",
    blurb:
      "Biotech short interest is priced off binary events. A clinical-stage company's value rests on trial readouts and regulatory decisions whose dates are public, so positions build ahead of them and clear immediately afterwards — the sharpest short-interest moves in this theme are calendar-driven rather than gradual. Between those dates the recurring bear case is dilution: companies without revenue fund trials by issuing stock, and a raise at a discount is the outcome a short is positioned for. Commercial-stage names attract a different argument about reimbursement decisions, competitor launches and the cost of building a sales force in the United States. The asymmetry is what makes this basket distinctive: an approval or a licensing deal can multiply a small-cap price overnight, so a crowded short in a thinly traded developer carries loss potential unlike anything in the mining or banking themes.",
    tickers: [
      "CSL",
      "TLX",
      "NEU",
      "MSB",
      "IMU",
      "CU6",
      "PYC",
      "OPT",
      "DXB",
      "BOT",
      "CUV",
      "IMM",
      "PAR",
      "MYX",
      "AVH",
    ],
    relatedThemes: ["tech-software", "ai-data-centres", "banks"],
    relatedIndustries: ["Pharmaceuticals, Biotechnology & Life Sciences"],
  },
};

export const THEME_SLUGS = Object.keys(THEMES);

export function getTheme(slug: string): ThemeDefinition | undefined {
  return THEMES[slug];
}

// Reverse index, built once at module load: ticker -> theme slugs, in registry
// declaration order. Rebuilding it per call would be O(themes x tickers) on
// every stock page render.
const THEMES_BY_TICKER: Record<string, string[]> = (() => {
  const index: Record<string, string[]> = {};
  for (const theme of Object.values(THEMES)) {
    for (const ticker of theme.tickers) {
      const key = ticker.toUpperCase();
      (index[key] ??= []).push(theme.slug);
    }
  }
  return index;
})();

/**
 * Themes whose basket contains `code`, for the "Part of:" chips on
 * /shorts/[code]. Returns definitions (not slugs) so callers get the display
 * name without a second lookup; the array is a fresh copy per call, so a
 * caller cannot mutate the shared index.
 */
export function themesForTicker(code: string): ThemeDefinition[] {
  const slugs = THEMES_BY_TICKER[code?.trim().toUpperCase() ?? ""];
  if (!slugs) return [];
  return slugs.map((slug) => THEMES[slug]!);
}

/**
 * Themes whose `relatedIndustries` name this exact GICS industry, for the
 * cross-link block on /industry/[slug]. Compared case-insensitively on the
 * trimmed string — the registry stores exact mv_screener_data.industry values,
 * but an industry name arriving from a URL slug round-trip may differ in case.
 * Ten themes, so a linear scan beats maintaining a second index.
 */
export function themesForIndustry(industry: string): ThemeDefinition[] {
  const needle = industry?.trim().toLowerCase() ?? "";
  if (!needle) return [];
  return Object.values(THEMES).filter((theme) =>
    theme.relatedIndustries.some(
      (candidate) => candidate.trim().toLowerCase() === needle,
    ),
  );
}
