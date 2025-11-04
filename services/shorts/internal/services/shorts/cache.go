package shorts

import (
	"crypto/md5"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// CacheEntry represents a cached value with expiration
type CacheEntry struct {
	Value     interface{}
	ExpiresAt time.Time
}

// IsExpired checks if the cache entry has expired
func (e *CacheEntry) IsExpired() bool {
	return time.Now().After(e.ExpiresAt)
}

// MemoryCache is a simple in-memory cache implementation
type MemoryCache struct {
	mu     sync.RWMutex
	store  map[string]*CacheEntry
	maxAge time.Duration
}

// NewMemoryCache creates a new memory cache with the specified max age
func NewMemoryCache(maxAge time.Duration) *MemoryCache {
	cache := &MemoryCache{
		store:  make(map[string]*CacheEntry),
		maxAge: maxAge,
	}

	// Start cleanup goroutine
	go cache.cleanup()

	return cache
}

// generateKey creates a cache key from the given parameters
func (c *MemoryCache) generateKey(prefix string, params ...interface{}) string {
	data, _ := json.Marshal(params)
	hash := md5.Sum(data)
	return fmt.Sprintf("%s:%x", prefix, hash)
}

// Get retrieves a value from the cache
func (c *MemoryCache) Get(key string) (interface{}, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	entry, exists := c.store[key]
	if !exists || entry.IsExpired() {
		return nil, false
	}

	return entry.Value, true
}

// Set stores a value in the cache
func (c *MemoryCache) Set(key string, value interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.store[key] = &CacheEntry{
		Value:     value,
		ExpiresAt: time.Now().Add(c.maxAge),
	}
}

// GetOrSet retrieves a value from cache or computes it using the provided function
func (c *MemoryCache) GetOrSet(key string, computeFn func() (interface{}, error)) (interface{}, error) {
	// Try to get from cache first
	if value, found := c.Get(key); found {
		return value, nil
	}

	// Compute the value
	value, err := computeFn()
	if err != nil {
		return nil, err
	}

	// Store in cache
	c.Set(key, value)

	return value, nil
}

// Delete removes a value from the cache
func (c *MemoryCache) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	delete(c.store, key)
}

// Clear removes all values from the cache
func (c *MemoryCache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.store = make(map[string]*CacheEntry)
}

// Size returns the number of items in the cache
func (c *MemoryCache) Size() int {
	c.mu.RLock()
	defer c.mu.RUnlock()

	return len(c.store)
}

// cleanup periodically removes expired entries
func (c *MemoryCache) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		c.mu.Lock()
		for key, entry := range c.store {
			if entry.IsExpired() {
				delete(c.store, key)
			}
		}
		c.mu.Unlock()
	}
}

// Cache key generators for different endpoints
func (c *MemoryCache) GetTopShortsKey(period string, limit int32, offset int32) string {
	return c.generateKey("top_shorts", period, limit, offset)
}

func (c *MemoryCache) GetStockKey(productCode string) string {
	return c.generateKey("stock", productCode)
}

func (c *MemoryCache) GetStockDataKey(productCode, period string) string {
	return c.generateKey("stock_data", productCode, period)
}

func (c *MemoryCache) GetStockDetailsKey(productCode string) string {
	return c.generateKey("stock_details", productCode)
}

func (c *MemoryCache) GetIndustryTreeMapKey(limit int32, period, viewMode string) string {
	return c.generateKey("industry_treemap", limit, period, viewMode)
}

func (c *MemoryCache) GetSearchStocksKey(query string, limit int32) string {
	return c.generateKey("search_stocks", query, limit)
}
