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
 * Point", "O'CONNOR" → "O'Connor", "ST KILDA EAST" → "St Kilda East".
 *
 * Only for sources that deliver UPPERCASE (MP names and the like). ABS suburb
 * names are already proper-cased — render them as delivered, never through
 * this: lowercasing first is what turned "McCrae" into "Mccrae" and
 * "Paddington (Qld)" into "Paddington (qld)" on 2,290 profiles. Input that
 * already carries a lowercase letter is returned untouched for the same
 * reason, so a mixed-case name can never be mangled by a stray call.
 *
 * Use this instead of CSS `capitalize`. `capitalize` only touches the first
 * letter of each word — so it cannot handle the apostrophe and hyphen cases —
 * and because the lowercasing happens in the DOM and the re-capitalising in CSS,
 * anyone copying the text gets "mcmahons point".
 */
export const titleCaseName = (n: string) =>
  /[a-z]/.test(n)
    ? n
    : n.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());

/**
 * Split an ABS SAL name into the place and the disambiguating qualifier ABS
 * appends to repeated names: "Paddington (Qld)" → { place: "Paddington",
 * region: null }, "Glenroy (Albury - NSW)" → { place: "Glenroy", region:
 * "Albury" }. `region` is the qualifier minus its state part (the page already
 * names the state), so it is null when the qualifier is only a state. Casing is
 * kept exactly as delivered. Lists that mix suburbs keep the full salName —
 * there the qualifier is what tells two Paddingtons apart.
 */
export function splitSalName(name: string): { place: string; region: string | null } {
  const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(name.trim());
  if (!m) return { place: name.trim(), region: null };
  const parts = m[2]!.split(" - ").map((p) => p.trim());
  const region = parts.length > 1 ? parts.slice(0, -1).join(" - ") : null;
  return { place: m[1]!, region: region || null };
}

/** Canonical suburb slug (kebab name + postcode), used in every suburb URL. */
export const suburbSlug = (salName: string, postcode: string) =>
  `${salName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}${postcode ? `-${postcode}` : ""}`;

/** The single source of truth for a suburb's URL — load-bearing `?sal=`. */
export const suburbHref = (
  stateCode: string,
  s: { salName: string; postcode: string; salCode: string },
) => `/housing/${stateSlug(stateCode)}/${suburbSlug(s.salName, s.postcode)}?sal=${s.salCode}`;
