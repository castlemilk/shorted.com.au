import type { FeatureStat } from "./types";

/**
 * Headline figures for the stat strips. Each carries a `sourceId` so the
 * citation links back to the bibliography. Derived/estimated values say so in
 * their `context`.
 */

export const HERO_STATS: FeatureStat[] = [
  {
    value: "~A$11bn",
    label: "Record short against the big four",
    context: "June 2026 — largest since ASIC reporting began",
    sourceId: "hedgeweek-11bn-2026",
    tone: "down",
  },
  {
    value: "−10.4%",
    label: "CBA's worst day in 34 years",
    context: "13 May 2026 — ~A$25bn wiped in a session",
    sourceId: "ibtimes-cba-2026",
    tone: "down",
  },
  {
    value: "~35×",
    label: "CBA since its 1991 float",
    context: "A$5.40 → ~A$192 — the cost of being early",
    sourceId: "atlas-widowmaker",
    tone: "up",
  },
];

export const NEGATIVE_GEARING_STATS: FeatureStat[] = [
  {
    value: "1.12m",
    label: "Negatively-geared landlords",
    context: "2022-23 — 49% of all property investors",
    sourceId: "ato-taxstats-2223",
  },
  {
    value: "A$10.4bn",
    label: "Net rental losses claimed",
    context: "2022-23 income year",
    sourceId: "ato-taxstats-2223",
  },
  {
    value: "A$11bn",
    label: "Annual cost: negative gearing + CGT discount",
    context: "Grattan estimate",
    sourceId: "grattan-hot-property-2016",
  },
];

export const BANK_POWER_STATS: FeatureStat[] = [
  {
    value: "~A$1.9tn",
    label: "Big-four mortgage book",
    context: "derived: ~77% of APRA's A$2,475bn system book, Dec 2025",
    sourceId: "apra-qpex-2025",
  },
  {
    value: "187%",
    label: "Peak household debt-to-income",
    context: "2017-18 — among the highest in the advanced world",
    sourceId: "rba-e2",
    tone: "down",
  },
  {
    value: "+28%",
    label: "Prices, per 1pp lower real rate",
    context: "RBA model, long-run — the buying-power engine",
    sourceId: "rba-rdp-2019-01",
    tone: "up",
  },
];
