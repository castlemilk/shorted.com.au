const PREFIX = "shorted:cache:";
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  data: T;
  ts: number;
}

export function getSessionCached<T>(key: string, maxAgeMs = DEFAULT_MAX_AGE_MS): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry<T>;
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
    sessionStorage.setItem(PREFIX + key, JSON.stringify(entry));
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
