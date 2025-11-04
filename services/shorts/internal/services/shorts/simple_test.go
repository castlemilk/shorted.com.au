package shorts

import (
	"testing"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/stretchr/testify/assert"
)

// Simple validation tests that don't depend on complex mocking
func TestSimpleValidation(t *testing.T) {
	t.Run("ValidateGetTopShortsRequest - valid period", func(t *testing.T) {
		req := &shortsv1alpha1.GetTopShortsRequest{
			Period: "1M",
			Limit:  10,
			Offset: 0,
		}

		err := ValidateGetTopShortsRequest(req)
		assert.NoError(t, err)
	})

	t.Run("ValidateGetTopShortsRequest - invalid period", func(t *testing.T) {
		req := &shortsv1alpha1.GetTopShortsRequest{
			Period: "INVALID",
			Limit:  10,
			Offset: 0,
		}

		err := ValidateGetTopShortsRequest(req)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "invalid period format")
	})

	t.Run("ValidateGetTopShortsRequest - negative limit", func(t *testing.T) {
		req := &shortsv1alpha1.GetTopShortsRequest{
			Period: "1M",
			Limit:  -5,
			Offset: 0,
		}

		err := ValidateGetTopShortsRequest(req)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "limit must be positive")
	})
}

func TestNormalizeStockCodeSimple(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"cba", "CBA"},
		{"  CBA  ", "CBA"},
		{"zip", "ZIP"},
		{"AAPL", "AAPL"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := NormalizeStockCode(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}
