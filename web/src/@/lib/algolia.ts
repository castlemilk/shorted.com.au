/**
 * Algolia Search Client
 * 
 * Uses the Go backend as a proxy to Algolia to keep API keys secure.
 * The backend handles authentication with Algolia.
 */

// API URL for the Go backend proxy
const SHORTS_API_URL = process.env.NEXT_PUBLIC_SHORTS_API_URL ?? "http://localhost:9091";

/**
 * Stock hit returned from Algolia search
 */
export interface AlgoliaStockHit {
  objectID: string;
  stock_code: string;
  company_name: string;
  industry: string;
  tags: string[];
  logo_gcs_url: string;
  percentage_shorted: number;
  summary?: string;
  market_cap?: string;
  market_cap_numeric?: number | null;
  pe_ratio?: number | null;
  dividend_yield?: number | null;
  key_people_names?: string;
  _highlightResult?: {
    stock_code?: { value: string; matchLevel: string };
    company_name?: { value: string; matchLevel: string };
    industry?: { value: string; matchLevel: string };
    key_people_names?: { value: string; matchLevel: string };
  };
}

/**
 * Algolia search response structure
 */
export interface AlgoliaSearchResponse {
  hits: AlgoliaStockHit[];
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
  processingTimeMS: number;
  query: string;
  facets?: Record<string, Record<string, number>>;
}

/**
 * Options for Algolia search
 */
export interface AlgoliaSearchOptions {
  hitsPerPage?: number;
  filters?: string;
  facetFilters?: string[][];
  facets?: string[];
}

/**
 * Search stocks using Algolia via the Go backend proxy
 *
 * @param query - Search query string
 * @param options - Search options (hitsPerPage, filters, facetFilters, facets)
 * @returns Search response from Algolia
 */
export async function searchStocksAlgolia(
  query: string,
  optionsOrHitsPerPage: AlgoliaSearchOptions | number = 20
): Promise<AlgoliaSearchResponse> {
  const options: AlgoliaSearchOptions =
    typeof optionsOrHitsPerPage === "number"
      ? { hitsPerPage: optionsOrHitsPerPage }
      : optionsOrHitsPerPage;

  const body: Record<string, unknown> = {
    query,
    hitsPerPage: options.hitsPerPage ?? 20,
  };
  if (options.filters) body.filters = options.filters;
  if (options.facetFilters) body.facetFilters = options.facetFilters;
  if (options.facets) body.facets = options.facets;

  const response = await fetch(`${SHORTS_API_URL}/api/algolia/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Algolia search failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<AlgoliaSearchResponse>;
}

/**
 * Check if Algolia search is available
 * Tests the proxy endpoint
 */
export async function isAlgoliaAvailable(): Promise<boolean> {
  try {
    // Try a simple search to test connectivity
    const response = await fetch(`${SHORTS_API_URL}/api/algolia/search?q=test&limit=1`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Convert Algolia hit to the StockSearchResult format used by the UI
 */
export function algoliaHitToSearchResult(hit: AlgoliaStockHit) {
  return {
    product_code: hit.stock_code,
    name: hit.company_name,
    percentage_shorted: hit.percentage_shorted,
    total_product_in_issue: 0, // Not in Algolia index
    reported_short_positions: 0, // Not in Algolia index
    industry: hit.industry,
    tags: hit.tags,
    logoUrl: hit.logo_gcs_url,
    companyName: hit.company_name,
  };
}

