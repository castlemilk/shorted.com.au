import { Redis as UpstashRedis } from "@upstash/redis";
import Redis from "ioredis";

// In-memory fallback for development when no Redis is configured
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

// Initialize Redis clients for caching
// Priority: REDIS_URL (standard Redis) > KV_REST_API_URL (Upstash) > in-memory fallback
let upstashRedis: UpstashRedis | null = null;
let ioRedis: Redis | null = null;
let localCache: InMemoryCache | null = null;

if (process.env.REDIS_URL) {
  // Standard Redis URL (e.g., redis://... or rediss://...)
  ioRedis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 3) return null; // Stop retrying after 3 attempts
      return Math.min(times * 100, 3000); // Exponential backoff, max 3s
    },
    enableReadyCheck: false,
    lazyConnect: true,
  });

  // Handle connection errors gracefully
  ioRedis.on("error", (err) => {
    console.error("Redis connection error:", err.message);
  });
} else if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  // Upstash REST API (Vercel KV)
  upstashRedis = new UpstashRedis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
} else {
  // Fallback to in-memory cache if no Redis configured
  if (process.env.NODE_ENV !== "production") {
    console.warn("⚠️  No Redis configured. Using in-memory cache fallback for development.");
    localCache = new InMemoryCache();
  }
}

const CACHE_PREFIX = "cache:about:";
const HOMEPAGE_CACHE_PREFIX = "cache:homepage:";
const TOOLTIP_CACHE_PREFIX = "tooltip:stock:";
const TOP_PAGE_CACHE_PREFIX = "cache:top:";
const DEFAULT_TTL = 300; // 5 minutes
// Event-driven caching: the underlying ASIC short data changes ~once/day, so we
// cache hard (24h ceiling) and flush these prefixes on the daily data-change
// event via /api/revalidate (see deleteCachedByPrefix + SHORTS_DATA_CACHE_PREFIXES).
// The 24h ceiling bounds staleness if a flush is ever missed.
export const HOMEPAGE_TTL = 86400; // 24h, flushed on data change
export const TOOLTIP_TTL = 86400; // 24h, flushed on data change
export const TOP_PAGE_TTL = 86400; // 24h, flushed on data change

// Prefixes covering all data derived from the `shorts` table — flushed together
// when a sync writes new ASIC data.
export const SHORTS_DATA_CACHE_PREFIXES = [
  HOMEPAGE_CACHE_PREFIX,
  TOP_PAGE_CACHE_PREFIX,
  TOOLTIP_CACHE_PREFIX,
] as const;

/**
 * Cache keys for various data types
 */
export const CACHE_KEYS = {
  statistics: `${CACHE_PREFIX}statistics`,
  topStocks: (limit: number) => `${CACHE_PREFIX}top-stocks:${limit}`,
  // Homepage cache keys
  topShorts: (period: string, limit: number, offset: number) =>
    `${HOMEPAGE_CACHE_PREFIX}top-shorts:${period}:${limit}:${offset}`,
  industryTreeMap: (period: string, limit: number, viewMode: string) =>
    `${HOMEPAGE_CACHE_PREFIX}treemap:${period}:${limit}:${viewMode}`,
  industryIntelligence: (industry: string, recordLimit: number, stockCode = "") =>
    `${HOMEPAGE_CACHE_PREFIX}industry-intelligence:v1:${industry}:${recordLimit}:${stockCode}`,
  // Tooltip cache keys
  tooltipData: (productCode: string) =>
    `${TOOLTIP_CACHE_PREFIX}${productCode}`,
  // Top page cache keys (SSR + client-side period changes)
  topPageData: (period: string, limit: number) =>
    `${TOP_PAGE_CACHE_PREFIX}${period}:${limit}`,
} as const;

/**
 * Get cached data from Redis (standard or Upstash) or local fallback
 */
export async function getCached<T>(key: string): Promise<T | null> {
  // Standard Redis via ioredis
  if (ioRedis) {
    try {
      const value = await ioRedis.get(key);
      if (value === null) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      console.error(`Cache get error for key ${key}:`, error);
      return null;
    }
  }

  // Upstash Redis (auto-parses JSON)
  if (upstashRedis) {
    try {
      return await upstashRedis.get<T>(key);
    } catch (error) {
      console.error(`Cache get error for key ${key}:`, error);
      return null;
    }
  }

  // In-memory fallback
  if (localCache) {
    return localCache.get<T>(key);
  }

  return null; // No cache available
}

/**
 * Set cached data in Redis (standard or Upstash) or local fallback
 */
export async function setCached<T>(
  key: string,
  data: T,
  ttl: number = DEFAULT_TTL,
): Promise<boolean> {
  // Standard Redis via ioredis
  if (ioRedis) {
    try {
      // ioredis requires manual JSON serialization.
      // BigInt replacer: protobuf Timestamp/int64 fields come back as BigInt
      // and default JSON.stringify throws on them. Stringify to a plain
      // number-as-string — read paths already coerce to Number or string.
      const bigintReplacer = (_key: string, value: unknown): unknown =>
        typeof value === "bigint" ? value.toString() : value;
      await ioRedis.setex(key, Number(ttl), JSON.stringify(data, bigintReplacer));
      return true;
    } catch (error) {
      console.error(`Cache set error for key ${key}:`, error);
      return false;
    }
  }

  // Upstash Redis (auto-handles JSON serialization)
  if (upstashRedis) {
    try {
      await upstashRedis.setex(key, Number(ttl), data);
      return true;
    } catch (error) {
      console.error(`Cache set error for key ${key}:`, error);
      return false;
    }
  }

  // In-memory fallback
  if (localCache) {
    localCache.set(key, data, ttl);
    return true;
  }

  return false; // No cache available
}

/**
 * Delete cached data from Redis (standard or Upstash) or local fallback
 */
export async function deleteCached(key: string): Promise<boolean> {
  // Standard Redis via ioredis
  if (ioRedis) {
    try {
      await ioRedis.del(key);
      return true;
    } catch (error) {
      console.error(`Cache delete error for key ${key}:`, error);
      return false;
    }
  }

  // Upstash Redis
  if (upstashRedis) {
    try {
      await upstashRedis.del(key);
      return true;
    } catch (error) {
      console.error(`Cache delete error for key ${key}:`, error);
      return false;
    }
  }

  // In-memory fallback
  if (localCache) {
    localCache.del(key);
    return true;
  }

  return false;
}

/**
 * Delete all cached keys matching a prefix (event-driven invalidation).
 * Returns the number of keys deleted. Best-effort — logs and returns 0 on error.
 */
export async function deleteCachedByPrefix(prefix: string): Promise<number> {
  // Standard Redis via ioredis — SCAN + DEL in batches
  if (ioRedis) {
    try {
      let cursor = "0";
      let deleted = 0;
      do {
        const [next, keys] = await ioRedis.scan(
          cursor,
          "MATCH",
          `${prefix}*`,
          "COUNT",
          200,
        );
        cursor = next;
        if (keys.length > 0) {
          await ioRedis.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== "0");
      return deleted;
    } catch (error) {
      console.error(`Cache prefix-delete error for ${prefix}:`, error);
      return 0;
    }
  }

  // Upstash REST API — SCAN + DEL
  if (upstashRedis) {
    try {
      let cursor = 0;
      let deleted = 0;
      do {
        const [next, keys] = await upstashRedis.scan(cursor, {
          match: `${prefix}*`,
          count: 200,
        });
        cursor = Number(next);
        if (keys.length > 0) {
          await upstashRedis.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== 0);
      return deleted;
    } catch (error) {
      console.error(`Cache prefix-delete error for ${prefix}:`, error);
      return 0;
    }
  }

  // In-memory fallback (dev) has no prefix iteration; dev doesn't need flushing.
  return 0;
}

/**
 * Check if cache is available
 */
export function isCacheAvailable(): boolean {
  return ioRedis !== null || upstashRedis !== null || localCache !== null;
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
