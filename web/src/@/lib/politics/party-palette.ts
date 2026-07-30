/**
 * Federal party labels and colours.
 *
 * Extracted from `@/lib/housing/highlight-metrics` so politician surfaces can
 * colour by party WITHOUT importing that module — it pulls in d3-scale and
 * d3-scale-chromatic (~20kB) for the choropleth ramps, which no /politicians
 * route needs. highlight-metrics re-exports from here, so the housing map keeps
 * working unchanged.
 *
 * Party is not on the APH Register listing. It reaches us through
 * politician_terms.division -> suburb_demographics.federal_division ->
 * federal_party, populated by house-price-collector's -mode electorates.
 */

/** Neutral grey for a party we do not have a colour for. */
export const PARTY_OTHER_COLOR = "#8a8578";

/** AEC party abbreviation -> readable label. Colours key off the label. */
export const PARTY_LABEL: Record<string, string> = {
  ALP: "Labor",
  LP: "Liberal",
  LIB: "Liberal",
  LNP: "Liberal National",
  NP: "Nationals",
  NAT: "Nationals",
  GRN: "Greens",
  IND: "Independent",
  KAP: "Katter's",
  XEN: "Centre Alliance",
  ON: "One Nation",
  CLP: "Country Liberal",
  // Parliaments 44-48 include parties that no longer sit. Without these a whole
  // cohort renders as grey "Other" on any historical view.
  PUP: "Palmer United",
  NXT: "Nick Xenophon Team",
  LDP: "Liberal Democrats",
  UAP: "United Australia",
  AJP: "Animal Justice",
  DHJP: "Derryn Hinch's Justice",
  JLN: "Jacqui Lambie Network",
  CA: "Centre Alliance",
  SFF: "Shooters, Fishers and Farmers",
  AC: "Australian Conservatives",
  FF: "Family First",
  DLP: "Democratic Labour",
};

export const PARTY_COLORS: Record<string, string> = {
  Labor: "#d9544d",
  Liberal: "#2f6fb0",
  "Liberal National": "#3f5e96",
  Nationals: "#c79a3a",
  Greens: "#5aa05a",
  Independent: "#1fa89f",
  "Katter's": "#9c6b4f",
  "Centre Alliance": "#d98a3d",
  "One Nation": "#e8842a",
  "Country Liberal": "#7d5aa0",
  "Palmer United": "#b8863b",
  "Nick Xenophon Team": "#c2653f",
  "Liberal Democrats": "#4f7fa8",
  "United Australia": "#b5a03c",
  "Animal Justice": "#6f9a52",
  "Derryn Hinch's Justice": "#8f6f9c",
  "Jacqui Lambie Network": "#4f8f8a",
  "Shooters, Fishers and Farmers": "#7a6b4f",
  "Australian Conservatives": "#5a6f9c",
  "Family First": "#a05a7a",
  "Democratic Labour": "#b06a5a",
  Other: PARTY_OTHER_COLOR,
};

/** Legend order. Historical parties trail the sitting ones. */
export const PARTY_ORDER = [
  "Labor",
  "Liberal",
  "Liberal National",
  "Country Liberal",
  "Nationals",
  "Greens",
  "Independent",
  "One Nation",
  "Katter's",
  "Centre Alliance",
  "Jacqui Lambie Network",
  "United Australia",
  "Palmer United",
  "Nick Xenophon Team",
  "Liberal Democrats",
  "Shooters, Fishers and Farmers",
  "Australian Conservatives",
  "Animal Justice",
  "Derryn Hinch's Justice",
  "Family First",
  "Democratic Labour",
  "Other",
];

export function partyColor(label: string): string {
  return PARTY_COLORS[label] ?? PARTY_OTHER_COLOR;
}

/** Resolve an abbreviation to its readable label. */
export function partyLabel(abbreviation: string | undefined | null): string {
  const key = (abbreviation ?? "").trim().toUpperCase();
  if (!key) return "Unknown";
  return PARTY_LABEL[key] ?? "Other";
}

/** Colour straight from an abbreviation. */
export function partyColorFromAb(abbreviation: string | undefined | null): string {
  return partyColor(partyLabel(abbreviation));
}
