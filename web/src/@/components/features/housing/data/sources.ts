import type { Source } from "./types";

/**
 * Bibliography for the housing feature. Numbers are assigned in roughly the
 * order sources first appear in the article. Every inline <Cite id="…" /> must
 * resolve to an id here; the Sources & method section renders each with an
 * `id="source-<id>"` anchor that the citations link to.
 *
 * Compiled from the fact-checked research dossier (2026-06-23). Where the
 * dossier flagged a figure as derived/uncertain, the prose softens it and the
 * caption discloses it — see the per-chart notes.
 */
export const SOURCES: Source[] = [
  // ── The widow-maker short ──────────────────────────────────────────────
  {
    id: "atlas-widowmaker",
    n: 1,
    title: "Australian banks and the widow-maker trade",
    publisher: "Atlas Funds Management",
    year: "2024",
    url: "https://atlasfunds.com.au/australian-banks-and-the-widow-maker-trade/",
    group: "short-thesis",
  },
  {
    id: "fortune-2016",
    n: 2,
    title: "Why hedge funds are betting against Australia's banks",
    publisher: "Fortune",
    year: "2016",
    url: "https://fortune.com/2016/05/23/hedge-funds-australian-banks/",
    group: "short-thesis",
  },
  {
    id: "wolfstreet-2016",
    n: 3,
    title: "Hedge funds bet on meltdown of Australian banks, housing bubble",
    publisher: "Wolf Street",
    year: "2016",
    url: "https://wolfstreet.com/2016/05/23/hedge-funds-bet-meltdown-australian-banks-housing-bubble-record-short-positions/",
    group: "short-thesis",
  },
  {
    id: "bloomberg-eisman-2019",
    n: 4,
    title: "Eisman sees '20% plus' drop in Canada bank stocks on short call",
    publisher: "Bloomberg",
    year: "2019",
    url: "https://www.bloomberg.com/news/articles/2019-04-09/eisman-sees-20-plus-drop-in-canada-bank-stocks-on-short-call",
    group: "short-thesis",
  },
  {
    id: "hedgeweek-11bn-2026",
    n: 5,
    title: "Hedge funds build record A$11bn short interest against Australia's major banks",
    publisher: "Hedgeweek",
    year: "2026",
    url: "https://www.hedgeweek.com/hedge-funds-build-record-aud11bn-short-interest-against-australias-major-banks/",
    group: "short-thesis",
  },
  {
    id: "ibtimes-cba-2026",
    n: 6,
    title: "CBA plunges 10.4% in record A$25 billion wipeout",
    publisher: "IBTimes Australia",
    year: "2026",
    url: "https://www.ibtimes.com.au/cba-plunges-104-record-25-billion-wipeout-bad-debts-budget-tax-changes-hammer-asx-banks-1868709",
    group: "short-thesis",
  },
  {
    id: "fool-cba-2025",
    n: 7,
    title: "How did the CBA share price perform in 2025?",
    publisher: "Motley Fool Australia",
    year: "2026",
    url: "https://www.fool.com.au/2026/01/02/how-did-the-cba-share-price-perform-in-2025/",
    group: "short-thesis",
  },

  // ── Negative gearing ───────────────────────────────────────────────────
  {
    id: "ato-taxstats-2223",
    n: 8,
    title: "Taxation Statistics 2022-23 — Individuals (rental tables)",
    publisher: "Australian Taxation Office",
    year: "2025",
    url: "https://www.ato.gov.au/about-ato/research-and-statistics/in-detail/taxation-statistics/taxation-statistics-2022-23/statistics/individuals-statistics",
    group: "negative-gearing",
  },
  {
    id: "treasury-teis-2023",
    n: 9,
    title: "Tax Expenditures and Insights Statement",
    publisher: "Australian Treasury",
    year: "2023",
    url: "https://treasury.gov.au/sites/default/files/2023-02/p2023-370286-teis.pdf",
    group: "negative-gearing",
  },
  {
    id: "pbo-ng-cgt",
    n: 10,
    title: "Cost of negative gearing and the capital gains tax discount",
    publisher: "Parliamentary Budget Office",
    year: "2024",
    url: "https://www.pbo.gov.au/publications-and-data/publications/costings/cost-of-negative-gearing-and-capital-gains-tax-discount",
    group: "negative-gearing",
  },
  {
    id: "rentwest-ng-history",
    n: 11,
    title: "A history of negative gearing in Australia",
    publisher: "RentWest",
    year: "2023",
    url: "https://www.rentwest.com.au/local-news/a-history-of-negative-gearing-in-australia/",
    group: "negative-gearing",
  },

  // ── CGT discount ───────────────────────────────────────────────────────
  {
    id: "rba-impact-taxation-2015",
    n: 12,
    title: "Submission to the Inquiry into Home Ownership — Impact of Taxation",
    publisher: "Reserve Bank of Australia",
    year: "2015",
    url: "https://www.rba.gov.au/publications/submissions/housing-and-housing-finance/inquiry-into-home-ownership/impact-of-taxation.html",
    group: "cgt",
  },
  {
    id: "grattan-hot-property-2016",
    n: 13,
    title: "Hot Property: negative gearing and capital gains tax reform",
    publisher: "Grattan Institute",
    year: "2016",
    url: "https://grattan.edu.au/wp-content/uploads/2016/04/872-Hot-Property.pdf",
    group: "cgt",
  },
  {
    id: "cgt-wikipedia",
    n: 14,
    title: "Capital gains tax in Australia",
    publisher: "Wikipedia",
    year: "2025",
    url: "https://en.wikipedia.org/wiki/Capital_gains_tax_in_Australia",
    group: "cgt",
  },
  {
    id: "abs-lending-indicators",
    n: 15,
    title: "Lending Indicators (investor share of new housing finance)",
    publisher: "Australian Bureau of Statistics",
    year: "2026",
    url: "https://www.abs.gov.au/statistics/economy/finance/lending-indicators/latest-release",
    group: "cgt",
  },

  // ── Bank buying power & household debt ──────────────────────────────────
  {
    id: "rba-rdp-2019-01",
    n: 16,
    title: "A Model of the Australian Housing Market (RDP 2019-01)",
    publisher: "Reserve Bank of Australia",
    year: "2019",
    url: "https://www.rba.gov.au/publications/rdp/2019/2019-01/full.html",
    group: "bank-credit",
  },
  {
    id: "apra-qpex-2025",
    n: 17,
    title: "Quarterly ADI Property Exposures — December 2025",
    publisher: "APRA",
    year: "2026",
    url: "https://www.apra.gov.au/quarterly-authorised-deposit-taking-institution-property-exposure-statistics-december-2025",
    group: "bank-credit",
  },
  {
    id: "rba-e2",
    n: 18,
    title: "Statistical Table E2 — Household Finances: Selected Ratios",
    publisher: "Reserve Bank of Australia",
    year: "2026",
    url: "https://www.rba.gov.au/statistics/tables/csv/e2-data.csv",
    group: "bank-credit",
  },
  {
    id: "rba-debt-speech-2018",
    n: 19,
    title: "The Evolution of Household Sector Risks (speech)",
    publisher: "Reserve Bank of Australia",
    year: "2018",
    url: "https://www.rba.gov.au/speeches/2018/sp-ag-2018-09-10.html",
    group: "bank-credit",
  },
  {
    id: "oecd-house-prices",
    n: 20,
    title: "Analytical house price indicators (price-to-income)",
    publisher: "OECD",
    year: "2026",
    url: "https://www.oecd.org/en/data/datasets/analytical-house-price-database.html",
    group: "bank-credit",
  },
  {
    id: "demographia-2025",
    n: 21,
    title: "International Housing Affordability, 2025 edition",
    publisher: "Demographia / Chapman University",
    year: "2025",
    url: "https://www.newgeography.com/content/008534-demographia-international-housing-affordability-2025-edition-released",
    group: "bank-credit",
  },
  {
    id: "statista-mortgages",
    n: 22,
    title: "Mortgages in Australia (big-four lender share)",
    publisher: "Statista",
    year: "2025",
    url: "https://www.statista.com/topics/10424/mortgages-in-australia/",
    group: "bank-credit",
  },

  // ── International corrections ───────────────────────────────────────────
  {
    id: "bis-fred-hpi",
    n: 23,
    title: "Real Residential Property Prices (BIS, 2010=100) — Australia, Japan, USA, China",
    publisher: "Bank for International Settlements via FRED",
    year: "2026",
    url: "https://fred.stlouisfed.org/release?rid=464",
    group: "international",
  },
  {
    id: "japan-bubble-wikipedia",
    n: 24,
    title: "Japanese asset price bubble",
    publisher: "Wikipedia",
    year: "2025",
    url: "https://en.wikipedia.org/wiki/Japanese_asset_price_bubble",
    group: "international",
  },
  {
    id: "imf-china-rogoff-2024",
    n: 25,
    title: "China's Real Estate Challenge (Rogoff & Yang)",
    publisher: "IMF Finance & Development",
    year: "2024",
    url: "https://www.imf.org/en/publications/fandd/issues/2024/12/chinas-real-estate-challenge-kenneth-rogoff",
    group: "international",
  },
  {
    id: "aljazeera-evergrande-2021",
    n: 26,
    title: "China's Evergrande officially defaults on dollar debt",
    publisher: "Al Jazeera",
    year: "2021",
    url: "https://www.aljazeera.com/economy/2021/12/9/bb-chinas-evergrande-officially-defaults-on-dollar-debt",
    group: "international",
  },
  {
    id: "case-shiller-wikipedia",
    n: 27,
    title: "Case–Shiller index",
    publisher: "Wikipedia",
    year: "2025",
    url: "https://en.wikipedia.org/wiki/Case%E2%80%93Shiller_index",
    group: "international",
  },
];

const BY_ID: Record<string, Source> = Object.fromEntries(
  SOURCES.map((s) => [s.id, s]),
);

/** Resolve a source by id (throws in dev if the id is unknown). */
export function getSource(id: string): Source | undefined {
  return BY_ID[id];
}

export const SOURCES_BY_GROUP: { group: Source["group"]; label: string }[] = [
  { group: "short-thesis", label: "The widow-maker short" },
  { group: "negative-gearing", label: "Negative gearing" },
  { group: "cgt", label: "The 1999 CGT discount" },
  { group: "bank-credit", label: "Bank buying power & household debt" },
  { group: "international", label: "International corrections" },
];
