package shorts

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestMemoryCache(t *testing.T) {
	t.Run("basic get/set operations", func(t *testing.T) {
		cache := NewMemoryCache(time.Minute)

		// Test setting and getting a value
		cache.Set("key1", "value1")
		value, found := cache.Get("key1")

		assert.True(t, found)
		assert.Equal(t, "value1", value)
	})

	t.Run("get non-existent key", func(t *testing.T) {
		cache := NewMemoryCache(time.Minute)

		value, found := cache.Get("non-existent")

		assert.False(t, found)
		assert.Nil(t, value)
	})

	t.Run("expiration", func(t *testing.T) {
		cache := NewMemoryCache(10 * time.Millisecond)

		cache.Set("key1", "value1")

		// Value should be available immediately
		value, found := cache.Get("key1")
		assert.True(t, found)
		assert.Equal(t, "value1", value)

		// Wait for expiration
		time.Sleep(20 * time.Millisecond)

		// Value should be expired
		value, found = cache.Get("key1")
		assert.False(t, found)
		assert.Nil(t, value)
	})

	t.Run("GetOrSet with cache hit", func(t *testing.T) {
		cache := NewMemoryCache(time.Minute)

		// Set initial value
		cache.Set("key1", "cached_value")

		// GetOrSet should return cached value without calling compute function
		computeCalled := false
		value, err := cache.GetOrSet("key1", func() (interface{}, error) {
			computeCalled = true
			return "computed_value", nil
		})

		assert.NoError(t, err)
		assert.Equal(t, "cached_value", value)
		assert.False(t, computeCalled)
	})

	t.Run("GetOrSet with cache miss", func(t *testing.T) {
		cache := NewMemoryCache(time.Minute)

		// GetOrSet should call compute function and cache result
		computeCalled := false
		value, err := cache.GetOrSet("key1", func() (interface{}, error) {
			computeCalled = true
			return "computed_value", nil
		})

		assert.NoError(t, err)
		assert.Equal(t, "computed_value", value)
		assert.True(t, computeCalled)

		// Subsequent call should return cached value
		computeCalled = false
		value, err = cache.GetOrSet("key1", func() (interface{}, error) {
			computeCalled = true
			return "new_computed_value", nil
		})

		assert.NoError(t, err)
		assert.Equal(t, "computed_value", value)
		assert.False(t, computeCalled)
	})

	t.Run("GetOrSet with compute error", func(t *testing.T) {
		cache := NewMemoryCache(time.Minute)

		// GetOrSet should return error from compute function
		value, err := cache.GetOrSet("key1", func() (interface{}, error) {
			return nil, assert.AnError
		})

		assert.Error(t, err)
		assert.Nil(t, value)

		// Error should not be cached
		value, found := cache.Get("key1")
		assert.False(t, found)
		assert.Nil(t, value)
	})

	t.Run("delete operation", func(t *testing.T) {
		cache := NewMemoryCache(time.Minute)

		cache.Set("key1", "value1")

		// Verify value exists
		value, found := cache.Get("key1")
		assert.True(t, found)
		assert.Equal(t, "value1", value)

		// Delete the value
		cache.Delete("key1")

		// Verify value is gone
		value, found = cache.Get("key1")
		assert.False(t, found)
		assert.Nil(t, value)
	})

	t.Run("clear operation", func(t *testing.T) {
		cache := NewMemoryCache(time.Minute)

		cache.Set("key1", "value1")
		cache.Set("key2", "value2")

		// Verify values exist
		assert.Equal(t, 2, cache.Size())

		// Clear the cache
		cache.Clear()

		// Verify cache is empty
		assert.Equal(t, 0, cache.Size())

		value, found := cache.Get("key1")
		assert.False(t, found)
		assert.Nil(t, value)
	})

	t.Run("size operation", func(t *testing.T) {
		cache := NewMemoryCache(time.Minute)

		assert.Equal(t, 0, cache.Size())

		cache.Set("key1", "value1")
		assert.Equal(t, 1, cache.Size())

		cache.Set("key2", "value2")
		assert.Equal(t, 2, cache.Size())

		cache.Delete("key1")
		assert.Equal(t, 1, cache.Size())
	})
}

func TestCacheKeyGeneration(t *testing.T) {
	cache := NewMemoryCache(time.Minute)

	t.Run("GetTopShortsKey", func(t *testing.T) {
		key1 := cache.GetTopShortsKey("1M", 10, 0)
		key2 := cache.GetTopShortsKey("1M", 10, 0)
		key3 := cache.GetTopShortsKey("1M", 20, 0)

		// Same parameters should generate same key
		assert.Equal(t, key1, key2)

		// Different parameters should generate different keys
		assert.NotEqual(t, key1, key3)

		// Key should have proper prefix
		assert.Contains(t, key1, "top_shorts:")
	})

	t.Run("GetStockKey", func(t *testing.T) {
		key1 := cache.GetStockKey("CBA")
		key2 := cache.GetStockKey("CBA")
		key3 := cache.GetStockKey("ZIP")

		assert.Equal(t, key1, key2)
		assert.NotEqual(t, key1, key3)
		assert.Contains(t, key1, "stock:")
	})

	t.Run("GetStockDataKey", func(t *testing.T) {
		key1 := cache.GetStockDataKey("CBA", "1M")
		key2 := cache.GetStockDataKey("CBA", "1M")
		key3 := cache.GetStockDataKey("CBA", "3M")

		assert.Equal(t, key1, key2)
		assert.NotEqual(t, key1, key3)
		assert.Contains(t, key1, "stock_data:")
	})

	t.Run("GetStockDetailsKey", func(t *testing.T) {
		key1 := cache.GetStockDetailsKey("CBA")
		key2 := cache.GetStockDetailsKey("CBA")
		key3 := cache.GetStockDetailsKey("ZIP")

		assert.Equal(t, key1, key2)
		assert.NotEqual(t, key1, key3)
		assert.Contains(t, key1, "stock_details:")
	})

	t.Run("GetIndustryTreeMapKey", func(t *testing.T) {
		key1 := cache.GetIndustryTreeMapKey(10, "1M", "CURRENT_CHANGE")
		key2 := cache.GetIndustryTreeMapKey(10, "1M", "CURRENT_CHANGE")
		key3 := cache.GetIndustryTreeMapKey(10, "1M", "PERCENTAGE_CHANGE")

		assert.Equal(t, key1, key2)
		assert.NotEqual(t, key1, key3)
		assert.Contains(t, key1, "industry_treemap:")
	})
}

func TestCacheEntry(t *testing.T) {
	t.Run("IsExpired", func(t *testing.T) {
		// Entry that expires in the future
		futureEntry := &CacheEntry{
			Value:     "test",
			ExpiresAt: time.Now().Add(time.Hour),
		}
		assert.False(t, futureEntry.IsExpired())

		// Entry that expired in the past
		pastEntry := &CacheEntry{
			Value:     "test",
			ExpiresAt: time.Now().Add(-time.Hour),
		}
		assert.True(t, pastEntry.IsExpired())

		// Entry that expires right now (should be considered expired)
		nowEntry := &CacheEntry{
			Value:     "test",
			ExpiresAt: time.Now(),
		}
		// Sleep a tiny bit to ensure it's in the past
		time.Sleep(time.Millisecond)
		assert.True(t, nowEntry.IsExpired())
	})
}
