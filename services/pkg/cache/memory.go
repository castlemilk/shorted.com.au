package cache

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
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
	done   chan struct{}
	sf     singleflight.Group // Deduplicates concurrent computations for the same key
}

// NewMemoryCache creates a new memory cache with the specified max age
func NewMemoryCache(maxAge time.Duration) *MemoryCache {
	cache := &MemoryCache{
		store:  make(map[string]*CacheEntry),
		maxAge: maxAge,
		done:   make(chan struct{}),
	}

	// Start cleanup goroutine
	go cache.cleanup()

	return cache
}

// Close stops the cleanup goroutine and releases resources
func (c *MemoryCache) Close() {
	close(c.done)
}

// GenerateKey creates a cache key from the given parameters using SHA-256
func (c *MemoryCache) GenerateKey(prefix string, params ...interface{}) string {
	data, err := json.Marshal(params)
	if err != nil {
		// Fallback to a simple string representation if JSON marshal fails
		data = []byte(fmt.Sprintf("%v", params))
	}
	hash := sha256.Sum256(data)
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

// GetOrSet retrieves a value from cache or computes it using the provided function.
// Uses singleflight to deduplicate concurrent computations for the same key,
// preventing thundering herd problems under burst traffic.
func (c *MemoryCache) GetOrSet(key string, computeFn func() (interface{}, error)) (interface{}, error) {
	// Try to get from cache first
	if value, found := c.Get(key); found {
		return value, nil
	}

	// Use singleflight to ensure only one goroutine computes the value
	// for a given key at a time. Other concurrent callers will wait and
	// share the result.
	value, err, _ := c.sf.Do(key, func() (interface{}, error) {
		// Double-check cache inside singleflight (another goroutine may
		// have populated it while we were waiting)
		if v, found := c.Get(key); found {
			return v, nil
		}

		v, err := computeFn()
		if err != nil {
			return nil, err
		}

		c.Set(key, v)
		return v, nil
	})
	if err != nil {
		return nil, err
	}

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

	for {
		select {
		case <-c.done:
			return
		case <-ticker.C:
			c.mu.Lock()
			for key, entry := range c.store {
				if entry.IsExpired() {
					delete(c.store, key)
				}
			}
			c.mu.Unlock()
		}
	}
}
