import { Redis } from "@upstash/redis";

// In-memory fallback for development when Vercel KV is not configured
class InMemoryCache {
  private cache = new Map<string, { value: unknown; expiry: number }>();

  get<T>(key: string): T | null {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }

    return item.value as T;
  }

  set(key: string, value: unknown, ttlSeconds: number): void {
    this.cache.set(key, {
      value,
      expiry: Date.now() + ttlSeconds * 1000,
    });
  }

  del(key: string): void {
    this.cache.delete(key);
  }
}

// Initialize Redis client for caching (Vercel KV)
let redis: Redis | null = null;
let localCache: InMemoryCache | null = null;

if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
} else {
  // Fallback to in-memory cache if no Vercel KV credentials found
  // This is useful for local development
  if (process.env.NODE_ENV !== "production") {
    console.warn("⚠️  Vercel KV not configured. Using in-memory cache fallback for development.");
    localCache = new InMemoryCache();
  }
}

const CACHE_PREFIX = "cache:about:";
const HOMEPAGE_CACHE_PREFIX = "cache:homepage:";
const DEFAULT_TTL = 300; // 5 minutes
export const HOMEPAGE_TTL = 600; // 10 minutes - homepage data changes less frequently

/**
 * Cache keys for about page data
 */
export const CACHE_KEYS = {
  statistics: `${CACHE_PREFIX}statistics`,
  topStocks: (limit: number) => `${CACHE_PREFIX}top-stocks:${limit}`,
  // Homepage cache keys
  topShorts: (period: string, limit: number, offset: number) =>
    `${HOMEPAGE_CACHE_PREFIX}top-shorts:${period}:${limit}:${offset}`,
  industryTreeMap: (period: string, limit: number, viewMode: string) =>
    `${HOMEPAGE_CACHE_PREFIX}treemap:${period}:${limit}:${viewMode}`,
} as const;

/**
 * Get cached data from Vercel KV or local fallback
 */
export async function getCached<T>(key: string): Promise<T | null> {
  if (redis) {
    try {
      return await redis.get<T>(key);
    } catch (error) {
      console.error(`Cache get error for key ${key}:`, error);
      return null;
    }
  }

  if (localCache) {
    return localCache.get<T>(key);
  }

  return null; // No cache available
}

/**
 * Set cached data in Vercel KV or local fallback
 */
export async function setCached<T>(
  key: string,
  data: T,
  ttl: number = DEFAULT_TTL,
): Promise<boolean> {
  if (redis) {
    try {
      // Upstash Redis automatically handles JSON serialization
      // setex(key, ttl, value) - ttl must be a number
      await redis.setex(key, Number(ttl), data);
      return true;
    } catch (error) {
      console.error(`Cache set error for key ${key}:`, error);
      return false;
    }
  }

  if (localCache) {
    localCache.set(key, data, ttl);
    return true;
  }

  return false; // No cache available
}

/**
 * Delete cached data from Vercel KV or local fallback
 */
export async function deleteCached(key: string): Promise<boolean> {
  if (redis) {
    try {
      await redis.del(key);
      return true;
    } catch (error) {
      console.error(`Cache delete error for key ${key}:`, error);
      return false;
    }
  }

  if (localCache) {
    localCache.del(key);
    return true;
  }

  return false;
}

/**
 * Check if cache is available
 */
export function isCacheAvailable(): boolean {
  return redis !== null || localCache !== null;
}

/**
 * Get or set cached data with fallback function
 * This is a convenience function that checks cache first, then calls the fallback if cache miss
 */
export async function getOrSetCached<T>(
  key: string,
  fallback: () => Promise<T>,
  ttl: number = DEFAULT_TTL,
): Promise<T> {
  // Try to get from cache first
  const cached = await getCached<T>(key);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - fetch data
  const data = await fallback();

  // Store in cache (don't await - fire and forget for performance)
  setCached(key, data, ttl).catch((error) => {
    console.error(`Failed to cache data for key ${key}:`, error);
  });

  return data;
}
