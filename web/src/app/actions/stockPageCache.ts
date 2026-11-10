export const STOCK_PAGE_CACHE_SECONDS = 86400;

/**
 * The BROAD shorts tag: every data cache derived from ASIC short data carries
 * it, and revalidating it expires every stock page, market date and report on
 * the site. Operators, the deploy sweep and any caller that cannot say what
 * changed send it (`tag=shorts-data` or `flush=shorts` on /api/revalidate).
 *
 * A narrow sync never sends it. It names the stocks and report dates it wrote
 * instead, and /api/revalidate expires these narrower tags:
 *   - stockCodeCacheTag(code)   every per-stock read (stockPageCacheTags)
 *   - SHORTS_LATEST_CACHE_TAG   reads built from the newest snapshot across all
 *                               stocks (top shorts, treemap, screener, ...)
 *   - market-date:<date>, report-<slug>, market-index
 * So every reader that carries the broad tag must also carry one of these, or a
 * narrow sync leaves it stale until its TTL. Build tags with the helpers below;
 * `shorts-tag-scopes.test.ts` fails on a bare "shorts-data" anywhere else.
 */
export const SHORTS_DATA_CACHE_TAG = "shorts-data";

/** Reads built from the newest ASIC snapshot across every stock. */
export const SHORTS_LATEST_CACHE_TAG = "shorts-latest";

type NextDataCacheValue<T> = T extends bigint
  ? number
  : T extends readonly (infer Item)[]
    ? NextDataCacheValue<Item>[]
    : T extends object
      ? { [Key in keyof T]: NextDataCacheValue<T[Key]> }
      : T;

export function normalizeStockPageCacheCode(productCode: string): string {
  return productCode.trim().toUpperCase();
}

/**
 * The one tag every cached read about a single stock carries, so one
 * revalidateTag expires that stock's data and, through the tags each page
 * collects from its reads, every tab of /shorts/<CODE>, its OG card, its chart
 * share page and any comparison that includes it.
 */
export function stockCodeCacheTag(productCode: string): string {
  return `stock:${normalizeStockPageCacheCode(productCode)}`;
}

/**
 * Tags for a cached read about one stock: the broad tag, the stock's tag and
 * a kind-specific tag (`stock-page:<kind>:<code>[:<part>...]`).
 */
export function stockPageCacheTags(
  kind: string,
  productCode: string,
  ...parts: string[]
): string[] {
  const suffix = [kind, productCode, ...parts]
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(":");

  return [
    SHORTS_DATA_CACHE_TAG,
    stockCodeCacheTag(productCode),
    `stock-page:${suffix}`,
  ];
}

/** Tags for a read built from the newest snapshot across all stocks. */
export function shortsLatestCacheTags(...extra: string[]): string[] {
  return Array.from(
    new Set([SHORTS_DATA_CACHE_TAG, SHORTS_LATEST_CACHE_TAG, ...extra]),
  );
}

function toNextDataCacheUnknown(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => toNextDataCacheUnknown(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        toNextDataCacheUnknown(entry),
      ]),
    );
  }

  return value;
}

export function toNextDataCacheValue<T>(value: T): NextDataCacheValue<T> {
  return toNextDataCacheUnknown(value) as NextDataCacheValue<T>;
}
