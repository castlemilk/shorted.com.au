import type { CountrySeries, MarkerEvent, YearValue } from "./types";

/**
 * All numeric series for the housing feature, transcribed from the fact-checked
 * research dossier (2026-06-23). Sources are attached per series in the captions
 * via the matching `sourceId` in sources.ts.
 *
 * House-price indices are BIS "Real Residential Property Prices" (2010 = 100),
 * pulled from FRED and reduced to annual averages — one consistent, comparable
 * basis across all four countries (QAUR/QJPR/QCNR/QUSR 628BIS).
 */

// ── Australian real house-price index (BIS real, 2010 = 100) ──────────────
// Reused by both the policy/price dashboard and the international overlay.
export const AUS_REAL_HPI: YearValue[] = [
  { year: 1980, value: 39.04 }, { year: 1981, value: 41.02 }, { year: 1982, value: 38.23 },
  { year: 1983, value: 36.68 }, { year: 1984, value: 39.35 }, { year: 1985, value: 40.63 },
  { year: 1986, value: 39.39 }, { year: 1987, value: 37.81 }, { year: 1988, value: 43.15 },
  { year: 1989, value: 50.1 }, { year: 1990, value: 47.43 }, { year: 1991, value: 47.11 },
  { year: 1992, value: 47.42 }, { year: 1993, value: 47.77 }, { year: 1994, value: 48.57 },
  { year: 1995, value: 47.0 }, { year: 1996, value: 46.15 }, { year: 1997, value: 47.87 },
  { year: 1998, value: 50.95 }, { year: 1999, value: 53.85 }, { year: 2000, value: 55.86 },
  { year: 2001, value: 59.48 }, { year: 2002, value: 68.57 }, { year: 2003, value: 78.77 },
  { year: 2004, value: 81.8 }, { year: 2005, value: 81.13 }, { year: 2006, value: 83.75 },
  { year: 2007, value: 90.43 }, { year: 2008, value: 90.14 }, { year: 2009, value: 92.09 },
  { year: 2010, value: 100.0 }, { year: 2011, value: 94.66 }, { year: 2012, value: 92.75 },
  { year: 2013, value: 96.52 }, { year: 2014, value: 102.71 }, { year: 2015, value: 110.32 },
  { year: 2016, value: 114.92 }, { year: 2017, value: 122.15 }, { year: 2018, value: 118.13 },
  { year: 2019, value: 111.53 }, { year: 2020, value: 116.56 }, { year: 2021, value: 133.0 },
  { year: 2022, value: 135.21 }, { year: 2023, value: 127.67 }, { year: 2024, value: 133.5 },
  { year: 2025, value: 136.75 },
];

// ════════════════════════════════════════════════════════════════════════
//  Dashboard ②  — Policy vs prices (negative gearing + 1999 CGT discount)
// ════════════════════════════════════════════════════════════════════════

/** Investor share of new housing-loan value, % (ABS Lending Indicators). */
export const INVESTOR_SHARE: YearValue[] = [
  { year: 2003, value: 41.6 }, { year: 2005, value: 37.2 }, { year: 2007, value: 37.1 },
  { year: 2009, value: 31.7 }, { year: 2011, value: 36.1 }, { year: 2013, value: 40.3 },
  { year: 2014, value: 43.3 }, { year: 2016, value: 37.8 }, { year: 2018, value: 31.5 },
  { year: 2020, value: 25.1 }, { year: 2022, value: 34.0 }, { year: 2023, value: 34.7 },
  { year: 2024, value: 37.7 }, { year: 2025, value: 39.0 },
];

/**
 * Negatively-geared individual landlords (ATO Taxation Statistics, count).
 * x = the ending calendar year of the financial year (e.g. 2007-08 → 2008).
 */
export const NEG_GEARED_LANDLORDS: YearValue[] = [
  { year: 2000, value: 631_435 }, { year: 2004, value: 897_019 },
  { year: 2008, value: 1_151_601 }, { year: 2012, value: 1_243_212 },
  { year: 2016, value: 1_280_452 }, { year: 2019, value: 1_305_002 },
  { year: 2020, value: 1_195_145 }, { year: 2021, value: 1_056_951 },
  { year: 2022, value: 949_519 }, { year: 2023, value: 1_117_175 },
];

export const POLICY_MARKERS: MarkerEvent[] = [
  { year: 1985, label: "CGT introduced + NG quarantined", detail: "Sept 1985", sourceId: "cgt-wikipedia" },
  { year: 1987, label: "NG quarantine reversed", detail: "Sept 1987 Budget", sourceId: "rentwest-ng-history" },
  { year: 1999, label: "50% CGT discount", detail: "20 Sept 1999", sourceId: "cgt-wikipedia" },
];

// ════════════════════════════════════════════════════════════════════════
//  Dashboard ③  — Bank buying power & household debt
// ════════════════════════════════════════════════════════════════════════

/** Household debt-to-income ratio, % (RBA Table E2, Dec qtr). */
export const DEBT_TO_INCOME: YearValue[] = [
  { year: 1990, value: 67.2 }, { year: 1995, value: 86.1 }, { year: 2000, value: 114.5 },
  { year: 2002, value: 133.2 }, { year: 2005, value: 157.3 }, { year: 2010, value: 164.3 },
  { year: 2015, value: 174.1 }, { year: 2017, value: 186.5 }, { year: 2018, value: 187.4 },
  { year: 2020, value: 180.1 }, { year: 2022, value: 183.8 }, { year: 2024, value: 178.6 },
  { year: 2025, value: 177.0 },
];

/** OECD price-to-income index (2015 = 100) — the internally-consistent series. */
export const PRICE_TO_INCOME: YearValue[] = [
  { year: 1990, value: 65.5 }, { year: 2000, value: 67.8 }, { year: 2005, value: 88.4 },
  { year: 2010, value: 94.3 }, { year: 2015, value: 100.0 }, { year: 2020, value: 100.4 },
  { year: 2021, value: 112.3 }, { year: 2023, value: 117.2 }, { year: 2024, value: 120.1 },
  { year: 2025, value: 119.5 },
];

export const APRA_MARKERS: MarkerEvent[] = [
  { year: 2014, label: "10% investor-credit growth cap", detail: "APRA, Dec 2014" },
  { year: 2017, label: "30% interest-only lending cap", detail: "APRA, Mar 2017" },
  { year: 2021, label: "3.0pp serviceability buffer", detail: "APRA, Oct 2021" },
];

/** Debt-to-income peak, flagged on the chart. */
export const DTI_PEAK = { year: 2018, value: 187.4 } as const;

/**
 * RBA RDP 2019-01 (Saunders & Tulip) long-run semi-elasticity of real house
 * prices to a sustained 1pp fall in the real mortgage rate. Two values for two
 * assumed real user-costs — used by the illustrative borrowing-power slider.
 */
export const RATE_ELASTICITY = {
  /** % price change per 1pp lower real rate, at a 3.5% real user cost. */
  aggressive: 28,
  /** % price change per 1pp lower real rate, at a 6% real user cost. */
  conservative: 17,
  /** Baseline standard variable mortgage rate the slider centres on (%). */
  baselineRate: 6.0,
  minRate: 3.0,
  maxRate: 8.5,
} as const;

// ════════════════════════════════════════════════════════════════════════
//  Dashboard ④  — International corrections (BIS real HPI, 2010 = 100)
// ════════════════════════════════════════════════════════════════════════

const JPN_REAL_HPI: YearValue[] = [
  { year: 1980, value: 119.37 }, { year: 1981, value: 126.13 }, { year: 1982, value: 132.36 },
  { year: 1983, value: 136.25 }, { year: 1984, value: 137.57 }, { year: 1985, value: 138.21 },
  { year: 1986, value: 140.99 }, { year: 1987, value: 151.28 }, { year: 1988, value: 159.04 },
  { year: 1989, value: 167.53 }, { year: 1990, value: 184.64 }, { year: 1991, value: 186.46 },
  { year: 1992, value: 176.21 }, { year: 1993, value: 166.46 }, { year: 1994, value: 161.44 },
  { year: 1995, value: 159.11 }, { year: 1996, value: 156.0 }, { year: 1997, value: 151.4 },
  { year: 1998, value: 147.89 }, { year: 1999, value: 143.78 }, { year: 2000, value: 139.27 },
  { year: 2001, value: 134.09 }, { year: 2002, value: 128.15 }, { year: 2003, value: 120.49 },
  { year: 2004, value: 113.13 }, { year: 2005, value: 107.96 }, { year: 2006, value: 104.48 },
  { year: 2007, value: 103.34 }, { year: 2008, value: 100.34 }, { year: 2009, value: 97.85 },
  { year: 2010, value: 100.0 }, { year: 2011, value: 100.34 }, { year: 2012, value: 99.51 },
  { year: 2013, value: 100.79 }, { year: 2014, value: 99.62 }, { year: 2015, value: 101.22 },
  { year: 2016, value: 103.6 }, { year: 2017, value: 105.72 }, { year: 2018, value: 106.71 },
  { year: 2019, value: 107.93 }, { year: 2020, value: 108.03 }, { year: 2021, value: 114.71 },
  { year: 2022, value: 121.33 }, { year: 2023, value: 121.06 }, { year: 2024, value: 121.16 },
  { year: 2025, value: 122.62 },
];

const USA_REAL_HPI: YearValue[] = [
  { year: 1995, value: 82.48 }, { year: 1996, value: 82.42 }, { year: 1997, value: 83.39 },
  { year: 1998, value: 87.46 }, { year: 1999, value: 91.91 }, { year: 2000, value: 97.31 },
  { year: 2001, value: 102.94 }, { year: 2002, value: 109.89 }, { year: 2003, value: 117.88 },
  { year: 2004, value: 131.06 }, { year: 2005, value: 146.89 }, { year: 2006, value: 150.55 },
  { year: 2007, value: 137.96 }, { year: 2008, value: 113.73 }, { year: 2009, value: 103.06 },
  { year: 2010, value: 100.0 }, { year: 2011, value: 94.27 }, { year: 2012, value: 96.7 },
  { year: 2013, value: 104.68 }, { year: 2014, value: 109.51 }, { year: 2015, value: 115.17 },
  { year: 2016, value: 119.82 }, { year: 2017, value: 124.19 }, { year: 2018, value: 127.96 },
  { year: 2019, value: 130.65 }, { year: 2020, value: 137.79 }, { year: 2021, value: 151.55 },
  { year: 2022, value: 158.25 }, { year: 2023, value: 158.05 }, { year: 2024, value: 160.18 },
  { year: 2025, value: 158.6 },
];

const CHN_REAL_HPI: YearValue[] = [
  { year: 2005, value: 89.07 }, { year: 2006, value: 91.04 }, { year: 2007, value: 92.74 },
  { year: 2008, value: 92.87 }, { year: 2009, value: 94.71 }, { year: 2010, value: 100.0 },
  { year: 2011, value: 98.65 }, { year: 2012, value: 95.49 }, { year: 2013, value: 98.62 },
  { year: 2014, value: 99.13 }, { year: 2015, value: 93.92 }, { year: 2016, value: 98.03 },
  { year: 2017, value: 103.3 }, { year: 2018, value: 106.72 }, { year: 2019, value: 109.78 },
  { year: 2020, value: 109.65 }, { year: 2021, value: 111.82 }, { year: 2022, value: 107.16 },
  { year: 2023, value: 103.45 }, { year: 2024, value: 95.56 }, { year: 2025, value: 89.48 },
];

/**
 * The four markets, aligned for the "years-from-peak" overlay. Each `peakYear`
 * is the market's cyclical top: a bubble that burst (Japan/USA/China) or, for
 * Australia, its last cyclical peak before the rate-hike wobble — the contrast
 * the whole chart exists to show.
 */
export const COUNTRY_SERIES: CountrySeries[] = [
  {
    code: "AUS",
    name: "Australia",
    color: "hsl(var(--primary))", // amber — the hero
    peakYear: 2017,
    data: AUS_REAL_HPI.filter((d) => d.year >= 1995),
    crashNote: "no crash — a ~9% dip, then record highs",
  },
  {
    code: "JPN",
    name: "Japan",
    color: "#8b5cf6", // violet
    peakYear: 1991,
    data: JPN_REAL_HPI,
    crashNote: "−47% real over 18 years; still −34% below its 1991 peak",
  },
  {
    code: "USA",
    name: "United States",
    color: "#06b6d4", // cyan
    peakYear: 2006,
    data: USA_REAL_HPI,
    crashNote: "−37% real to 2011; reclaimed its 2006 peak only in 2021",
  },
  {
    code: "CHN",
    name: "China",
    color: "#f43f5e", // rose
    peakYear: 2021,
    data: CHN_REAL_HPI,
    crashNote: "−20% since 2021 — and still falling",
  },
];
