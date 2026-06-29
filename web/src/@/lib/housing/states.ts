/** ABS STE_CODE21 (string) → state code; plus slug/name helpers. */
export const STE_CODE_TO_STATE: Record<string, string> = {
  "1": "NSW", "2": "VIC", "3": "QLD", "4": "SA",
  "5": "WA", "6": "TAS", "7": "NT", "8": "ACT",
};
export const STATE_TO_STE_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(STE_CODE_TO_STATE).map(([k, v]) => [v, k]),
);
export const STATE_NAMES: Record<string, string> = {
  NSW: "New South Wales", VIC: "Victoria", QLD: "Queensland", SA: "South Australia",
  WA: "Western Australia", TAS: "Tasmania", NT: "Northern Territory", ACT: "Australian Capital Territory",
};
export const ALL_STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];
export const stateSlug = (code: string) => code.toLowerCase();
export const slugToState = (slug: string) =>
  ALL_STATES.find((s) => s.toLowerCase() === slug.toLowerCase()) ?? null;
/** GCCSA region_code (from GetHousingOverview) → state, e.g. '1GSYD' → NSW. */
export const GCCSA_TO_STATE: Record<string, string> = {
  "1GSYD": "NSW", "2GMEL": "VIC", "3GBRI": "QLD", "4GADE": "SA",
  "5GPER": "WA", "6GHOB": "TAS", "7GDAR": "NT", "8ACTE": "ACT",
};
