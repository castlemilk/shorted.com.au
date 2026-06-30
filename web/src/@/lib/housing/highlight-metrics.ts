import { scaleSequential, scaleSequentialSqrt, scaleDiverging } from "d3-scale";
import { interpolateOranges, interpolateRdBu } from "d3-scale-chromatic";
import { fmtPriceShort } from "./price-scale";

/**
 * The suburb map's "highlight" toggle. Continuous metrics (price, population,
 * age, income, born-overseas) shade an amber sequential ramp; discrete metrics
 * (religion, language) paint each suburb by its dominant category with a fixed
 * qualitative palette — a gradient would imply an order these categories don't
 * have.
 */

// The fields a metric reads. SuburbDatum is structurally a superset of this, so
// metric accessors take this minimal shape and avoid importing the component.
export type SuburbMetricInput = {
  latestMedianPrice: number;
  population: number;
  medianAge: number;
  medianWeeklyHhdIncome: number;
  pctBornOverseas: number;
  topReligion: string; // '' if none
  topLanguage: string; // '' if none (no language other than English)
  pctTopLanguage: number;
  federalPartyAb: string; // '' if none — party holding the federal division
  federalTppAlp: number;  // 0..100 Labor two-party-preferred (0 = unknown)
  statePartyAb: string;   // '' if none/Hare-Clark — party holding the state seat
};

export type MetricKey =
  | "price" | "population" | "age" | "income" | "born_overseas" | "religion" | "language"
  | "federal_party" | "federal_lean" | "state_party";

type Base = { key: MetricKey; label: string; legendLabel: string };

export type ContinuousMetric = Base & {
  kind: "continuous";
  value: (s: SuburbMetricInput) => number | null; // null = no data (hatch)
  format: (v: number) => string;
  sqrt?: boolean; // sqrt ramp for long-tailed metrics (price, population)
  /** fixed [min,max] (e.g. [0,100] for a percentage) instead of the data range. */
  domain?: [number, number];
  /** custom colour scale (e.g. diverging) instead of the amber ramp. */
  makeScale?: (min: number, max: number) => (v: number) => string;
};

export type CategoricalMetric = Base & {
  kind: "categorical";
  category: (s: SuburbMetricInput) => string | null; // null = no data (hatch)
  colorFor: (cat: string) => string;
  /** legend order (only entries that appear in the data are shown). */
  order: string[];
};

export type HighlightMetric = ContinuousMetric | CategoricalMetric;

const fmtCompact = (v: number) =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`;
const fmtPct = (v: number) => `${Math.round(v)}%`;
const fmtMoneyWk = (v: number) => `$${Math.round(v).toLocaleString()}`;

// --- Categorical palettes (qualitative, deliberately NOT the price amber) ---

// A muted, editorial qualitative set; pure red/green are avoided so categories
// never read as the product's semantic up/down.
const C = {
  slate: "#7c8aa0", indigo: "#5b6bb5", teal: "#4f9d99", plum: "#9b6a9e",
  moss: "#6f9a55", clay: "#c2763d", gold: "#d8a83a", rose: "#c77b9a",
  stone: "#9c8e7f", sky: "#5a93c4", olive: "#8a8a4a", brick: "#b15a4e",
  sand: "#d9d3c7", // neutral base for English-dominant suburbs
};

export const RELIGION_COLORS: Record<string, string> = {
  "No religion": C.slate,
  "Catholic": C.indigo,
  "Anglican": C.sky,
  "Other Christian": C.teal,
  "Islam": C.moss,
  "Hinduism": C.clay,
  "Buddhism": C.gold,
  "Judaism": C.rose,
  "Other": C.stone,
};
const RELIGION_ORDER = [
  "No religion", "Catholic", "Anglican", "Other Christian",
  "Islam", "Hinduism", "Buddhism", "Judaism", "Other",
];

export const LANGUAGE_COLORS: Record<string, string> = {
  "English": C.sand, // neutral base — lets non-English pockets pop
  "Mandarin": C.brick,
  "Cantonese": C.clay,
  "Italian": C.moss,
  "Greek": C.indigo,
  "Vietnamese": C.gold,
  "Arabic": C.plum,
  "Punjabi": C.olive,
  "Hindi": C.teal,
  "Spanish": C.rose,
  "German": C.stone,
  "Filipino": C.sky,
  "Tagalog": C.sky,
  "Other": C.slate,
};
const LANGUAGE_ORDER = [
  "Mandarin", "Cantonese", "Italian", "Greek", "Vietnamese", "Arabic",
  "Punjabi", "Hindi", "Spanish", "German", "Filipino", "Tagalog", "Other", "English",
];

// Below this share, a suburb's "top non-English language" is too thin to be
// meaningful — render it in the neutral English base so genuine community-
// language pockets stand out.
const LANGUAGE_MIN_PCT = 5;

export function religionColor(cat: string): string {
  return RELIGION_COLORS[cat] ?? C.stone;
}
export function languageColor(cat: string): string {
  return LANGUAGE_COLORS[cat] ?? C.slate;
}

// --- Federal party palette (categorical) ---
// AEC party abbreviation → readable label; the map colours by these labels.
const PARTY_LABEL: Record<string, string> = {
  ALP: "Labor", LP: "Liberal", LIB: "Liberal", LNP: "Liberal National",
  NP: "Nationals", NAT: "Nationals", GRN: "Greens", IND: "Independent",
  KAP: "Katter's", XEN: "Centre Alliance", ON: "One Nation", CLP: "Country Liberal",
};
export const PARTY_COLORS: Record<string, string> = {
  "Labor": "#d9544d", "Liberal": "#2f6fb0", "Liberal National": "#3f5e96",
  "Nationals": "#c79a3a", "Greens": "#5aa05a", "Independent": "#1fa89f",
  "Katter's": "#9c6b4f", "Centre Alliance": "#d98a3d", "One Nation": "#e8842a",
  "Country Liberal": "#7d5aa0", "Other": C.stone,
};
const PARTY_ORDER = [
  "Labor", "Liberal", "Liberal National", "Country Liberal", "Nationals",
  "Greens", "Independent", "One Nation", "Katter's", "Centre Alliance", "Other",
];
export function partyColor(label: string): string {
  return PARTY_COLORS[label] ?? C.stone;
}

export const HIGHLIGHT_METRICS: HighlightMetric[] = [
  {
    kind: "continuous", key: "price", label: "Median house price",
    legendLabel: "Median house price",
    value: (s) => (s.latestMedianPrice > 0 ? s.latestMedianPrice : null),
    format: fmtPriceShort, sqrt: true,
  },
  {
    kind: "continuous", key: "population", label: "Population",
    legendLabel: "Population",
    value: (s) => (s.population > 0 ? s.population : null),
    format: fmtCompact, sqrt: true,
  },
  {
    kind: "continuous", key: "age", label: "Median age",
    legendLabel: "Median age (years)",
    value: (s) => (s.medianAge > 0 ? s.medianAge : null),
    format: (v) => `${Math.round(v)}`,
  },
  {
    kind: "continuous", key: "income", label: "Household income",
    legendLabel: "Median weekly household income",
    value: (s) => (s.medianWeeklyHhdIncome > 0 ? s.medianWeeklyHhdIncome : null),
    format: fmtMoneyWk,
  },
  {
    kind: "continuous", key: "born_overseas", label: "Born overseas",
    legendLabel: "Born overseas",
    value: (s) => (s.pctBornOverseas > 0 ? s.pctBornOverseas : null),
    format: fmtPct,
  },
  {
    kind: "categorical", key: "religion", label: "Religion",
    legendLabel: "Dominant religion",
    category: (s) => s.topReligion || null,
    colorFor: religionColor, order: RELIGION_ORDER,
  },
  {
    kind: "categorical", key: "language", label: "Language",
    legendLabel: "Top language at home",
    category: (s) => {
      if (s.population <= 0) return null;
      if (s.topLanguage && s.pctTopLanguage >= LANGUAGE_MIN_PCT) return s.topLanguage;
      return "English";
    },
    colorFor: languageColor, order: LANGUAGE_ORDER,
  },
  {
    kind: "categorical", key: "federal_party", label: "Federal party",
    legendLabel: "Party holding the seat",
    category: (s) => (s.federalPartyAb ? (PARTY_LABEL[s.federalPartyAb] ?? "Other") : null),
    colorFor: partyColor, order: PARTY_ORDER,
  },
  {
    kind: "continuous", key: "federal_lean", label: "Federal lean (2PP)",
    legendLabel: "Labor two-party-preferred",
    value: (s) => (s.federalTppAlp > 0 ? s.federalTppAlp : null),
    format: (v) => `${Math.round(v)}%`,
    domain: [0, 100], makeScale: () => politicalLeanScale(),
  },
  {
    kind: "categorical", key: "state_party", label: "State party",
    legendLabel: "Party holding the state seat",
    category: (s) => (s.statePartyAb ? (PARTY_LABEL[s.statePartyAb] ?? "Other") : null),
    colorFor: partyColor, order: PARTY_ORDER,
  },
];

export const METRIC_BY_KEY: Record<MetricKey, HighlightMetric> =
  Object.fromEntries(HIGHLIGHT_METRICS.map((m) => [m.key, m])) as Record<MetricKey, HighlightMetric>;

/** Amber sequential ramp over [min,max] for a continuous metric. */
export function amberScale(min: number, max: number, sqrt = false): (v: number) => string {
  const interp = (t: number) => interpolateOranges(0.18 + 0.74 * t);
  const s = sqrt ? scaleSequentialSqrt(interp) : scaleSequential(interp);
  return s.domain([min, Math.max(min + 1, max)]);
}

/** Diverging red(Labor)↔white↔blue(Coalition) for two-party-preferred %. */
export function politicalLeanScale(): (v: number) => string {
  // RdBu: 0=red, 0.5=white, 1=blue. We want high ALP-TPP → red, low → blue.
  return scaleDiverging<string>([0, 50, 100], (t) => interpolateRdBu(1 - t));
}
