const PREFIX = "shorted:cache:";
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  data: T;
  ts: number;
}

// protobuf int64 / Timestamp.seconds fields deserialize to BigInt, which the
// default JSON.stringify THROWS on. That throw was swallowed by setSessionCached's
// catch, so BigInt-bearing responses (getHousePriceSeriesClient, whose series
// carry a Timestamp) silently never cached. Round-trip BigInt losslessly through
// a `{ "$bigint": "<digits>" }` sentinel so those consumers still get real BigInt
// values back on read.
const BIGINT_TAG = "$bigint";

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 1 &&
    typeof (value as Record<string, unknown>)[BIGINT_TAG] === "string"
  ) {
    return BigInt((value as Record<string, string>)[BIGINT_TAG]!);
  }
  return value;
}

export function getSessionCached<T>(key: string, maxAgeMs = DEFAULT_MAX_AGE_MS): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw, bigintReviver) as CacheEntry<T>;
    if (Date.now() - entry.ts > maxAgeMs) {
      sessionStorage.removeItem(PREFIX + key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

export function setSessionCached<T>(key: string, data: T): void {
  if (typeof window === "undefined") return;
  try {
    const entry: CacheEntry<T> = { data, ts: Date.now() };
    sessionStorage.setItem(PREFIX + key, JSON.stringify(entry, bigintReplacer));
  } catch {
    // sessionStorage full or unavailable — ignore
  }
}

export function clearSessionCache(prefix?: string): void {
  if (typeof window === "undefined") return;
  const fullPrefix = PREFIX + (prefix ?? "");
  const keysToRemove: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key?.startsWith(fullPrefix)) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((k) => sessionStorage.removeItem(k));
}
