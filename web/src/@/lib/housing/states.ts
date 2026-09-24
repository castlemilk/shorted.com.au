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

/**
 * Title-case an ALL-CAPS place or member name: "MCMAHONS POINT" → "Mcmahons
 * Point", "O'CONNOR" → "O'Connor", "ST KILDA EAST" → "St Kilda East",
 * "PRESTON (VIC.)" → "Preston (Vic.)" — the ABS state qualifier sits in
 * parentheses, which CSS `capitalize` and the previous boundary set both
 * missed, so every qualified suburb rendered as "Preston (vic.)".
 *
 * Use this instead of CSS `capitalize`. `capitalize` only touches the first
 * letter of each word — so it cannot handle the apostrophe and hyphen cases —
 * and because the lowercasing happens in the DOM and the re-capitalising in CSS,
 * anyone copying the text gets "mcmahons point".
 */
export const titleCaseName = (n: string) =>
  n.toLowerCase().replace(/(^|[\s'(-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());

/** Canonical suburb slug (kebab name + postcode), used in every suburb URL. */
export const suburbSlug = (salName: string, postcode: string) =>
  `${salName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}${postcode ? `-${postcode}` : ""}`;

/**
 * The single source of truth for a suburb's URL: the clean canonical path.
 *
 * This used to append `?sal=<code>` as a resolution fast-path. The page now
 * resolves the suburb from the path alone (resolveSuburbSalCode) and ignores
 * the query, and the canonical it declares has no query — so every internal
 * link was creating a second, parameterised URL for crawlers to fetch, fold
 * and report on (Search Console showed `?sal=` variants earning impressions).
 * `salCode` stays in the signature so callers need not change and so a future
 * disambiguation can use it without another migration.
 */
export const suburbHref = (
  stateCode: string,
  s: { salName: string; postcode: string; salCode: string },
) => `/housing/${stateSlug(stateCode)}/${suburbSlug(s.salName, s.postcode)}`;
