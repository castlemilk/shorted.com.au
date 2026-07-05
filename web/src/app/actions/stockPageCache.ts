export const STOCK_PAGE_CACHE_SECONDS = 86400;
export const SHORTS_DATA_CACHE_TAG = "shorts-data";

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

export function stockPageCacheTags(...parts: string[]): string[] {
  const suffix = parts
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join(":");

  return suffix
    ? [SHORTS_DATA_CACHE_TAG, `stock-page:${suffix}`]
    : [SHORTS_DATA_CACHE_TAG];
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
