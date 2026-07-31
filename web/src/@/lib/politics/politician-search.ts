/**
 * Algolia client for the `politicians` index.
 *
 * Goes through the SAME Go proxy as stock search (`/api/algolia/search`), which
 * holds the Algolia key server-side — the browser never sees a credential. The
 * proxy allowlists the index name, so `index: "politicians"` is a request, not
 * an instruction.
 *
 * Deliberately NOT in `@/lib/algolia.ts`: that module's types are stock-shaped
 * and every /politicians route would import them for nothing.
 *
 * EDITORIAL: the index carries counts of declared things and never a value —
 * there is no amount in the register to index. See services/jobs/.../aph_algolia.go.
 */

const SHORTS_API_URL =
  typeof window !== "undefined"
    ? ""
    : (process.env.SHORTS_SERVICE_ENDPOINT ??
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      process.env.NEXT_PUBLIC_API_URL ??
      "http://localhost:9091");

/** One parliamentarian as the index holds them. */
export interface PoliticianHit {
  objectID: string;
  slug: string;
  display_name: string;
  surname?: string;
  chamber?: string;
  division?: string;
  state_code?: string;
  party?: string;
  party_ab?: string;
  first_parliament?: number;
  last_parliament?: number;
  parliaments?: number[];
  declared_listed_count: number;
  declared_property_count: number;
  stock_codes?: string[];
  company_names?: string[];
  industries?: string[];
  suburbs?: string[];
  has_interests?: boolean;
  _highlightResult?: Record<
    string,
    { value: string; matchLevel: string } | { value: string; matchLevel: string }[]
  >;
}

export interface PoliticianSearchResponse {
  hits: PoliticianHit[];
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
  processingTimeMS: number;
  query: string;
  facets?: Record<string, Record<string, number>>;
}

/** The facets the explorer's filter rail is built from. */
export const POLITICIAN_FACETS = [
  "party_ab",
  "chamber",
  "state_code",
  "industries",
  "has_interests",
] as const;

export interface PoliticianSearchOptions {
  hitsPerPage?: number;
  /** `[["party_ab:ALP","party_ab:LP"], ["chamber:house"]]` — OR within, AND across. */
  facetFilters?: string[][];
  facets?: readonly string[];
}

/**
 * Search the register.
 *
 * An EMPTY query is valid and is the explorer's opening state: Algolia treats it
 * as "match everything", so the rail shows real facet counts over the whole roll
 * before anyone types. The Go proxy used to 400 on an empty query; it no longer
 * does.
 */
export async function searchPoliticians(
  query: string,
  options: PoliticianSearchOptions = {},
): Promise<PoliticianSearchResponse> {
  const body: Record<string, unknown> = {
    query,
    index: "politicians",
    hitsPerPage: options.hitsPerPage ?? 24,
    facets: options.facets ?? POLITICIAN_FACETS,
  };
  if (options.facetFilters?.length) body.facetFilters = options.facetFilters;

  const response = await fetch(`${SHORTS_API_URL}/api/algolia/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });

  if (!response.ok) {
    throw new Error(`Politician search failed: ${response.status}`);
  }
  return response.json() as Promise<PoliticianSearchResponse>;
}

/**
 * Strip Algolia's `<em>` highlight markers to plain text.
 *
 * The UI renders highlights as React nodes rather than `dangerouslySetInnerHTML`:
 * these strings contain a member's own declared text, which is free text from a
 * PDF, and injecting it as HTML on a page about named individuals is not a risk
 * worth taking for a bit of bolding.
 */
export function splitHighlight(value: string): { text: string; hit: boolean }[] {
  if (!value) return [];
  return value
    .split(/(<em>.*?<\/em>)/g)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("<em>")
        ? { text: part.slice(4, -5), hit: true }
        : { text: part, hit: false },
    );
}

/** Read a highlight for a field, tolerating Algolia's array-or-object shape. */
export function highlightFor(hit: PoliticianHit, field: string): string | undefined {
  const h = hit._highlightResult?.[field];
  if (!h) return undefined;
  return Array.isArray(h) ? h[0]?.value : h.value;
}
