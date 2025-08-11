// Simple in-memory cache with TTL support
// In production, this could be replaced with Redis or another caching solution

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

class MemoryCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Run cleanup every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
  }

  set<T>(key: string, data: T, ttl = 300): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttl * 1000, // Convert to milliseconds
    });
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }

    const now = Date.now();
    const isExpired = now - entry.timestamp > entry.ttl;

    if (isExpired) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => this.cache.delete(key));
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clear();
  }
}

// Singleton instance
export const memoryCache = new MemoryCache();

// Cache key generators
export const cacheKeys = {
  stockQuote: (symbol: string) => `quote:${symbol}`,
  historicalData: (symbol: string, range: string, interval: string) => 
    `historical:${symbol}:${range}:${interval}`,
  sectorPerformance: (period: string) => `sector:${period}`,
  correlationMatrix: (symbols: string[], period: string) => 
    `correlation:${symbols.sort().join(',')}:${period}`,
};

// Cache TTL values (in seconds)
export const cacheTTL = {
  quote: 60,           // 1 minute for real-time quotes
  historical: 300,     // 5 minutes for historical data
  sector: 300,         // 5 minutes for sector performance
  correlation: 600,    // 10 minutes for correlation matrix
};