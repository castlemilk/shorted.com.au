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
const DEFAULT_TTL = 300; // 5 minutes
export const HOMEPAGE_TTL = 600; // 10 minutes - homepage data changes less frequently
export const TOOLTIP_TTL = 300; // 5 minutes - tooltip data refreshes reasonably often

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
  // Tooltip cache keys
  tooltipData: (productCode: string) =>
    `${TOOLTIP_CACHE_PREFIX}${productCode}`,
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
      // ioredis requires manual JSON serialization
      await ioRedis.setex(key, Number(ttl), JSON.stringify(data));
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
