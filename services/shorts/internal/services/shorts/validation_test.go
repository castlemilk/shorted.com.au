package shorts

import (
	"testing"

	"github.com/stretchr/testify/assert"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

func TestValidateGetTopShortsRequest(t *testing.T) {
	tests := []struct {
		name        string
		request     *shortsv1alpha1.GetTopShortsRequest
		expectError bool
		errorMsg    string
	}{
		{
			name: "valid request",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "1M",
				Limit:  10,
				Offset: 0,
			},
			expectError: false,
		},
		{
			name: "valid request with empty period",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "",
				Limit:  10,
				Offset: 0,
			},
			expectError: false,
		},
		{
			name: "valid request with lowercase period",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "1m",
				Limit:  10,
				Offset: 0,
			},
			expectError: false,
		},
		{
			name: "valid request with mixed case period",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "6M",
				Limit:  10,
				Offset: 0,
			},
			expectError: false,
		},
		{
			name: "valid request with 2Y period",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "2Y",
				Limit:  10,
				Offset: 0,
			},
			expectError: false,
		},
		{
			name: "valid request with 5Y period",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "5Y",
				Limit:  10,
				Offset: 0,
			},
			expectError: false,
		},
		{
			name: "valid request with 10Y period",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "10Y",
				Limit:  10,
				Offset: 0,
			},
			expectError: false,
		},
		{
			name: "valid request with MAX period",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "MAX",
				Limit:  10,
				Offset: 0,
			},
			expectError: false,
		},
		{
			name: "valid request with lowercase max period",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "max",
				Limit:  10,
				Offset: 0,
			},
			expectError: false,
		},
		{
			name: "invalid period",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "7Y",
				Limit:  10,
				Offset: 0,
			},
			expectError: true,
			errorMsg:    "invalid period format",
		},
		{
			name: "negative limit",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "1M",
				Limit:  -5,
				Offset: 0,
			},
			expectError: true,
			errorMsg:    "limit must be positive",
		},
		{
			name: "limit exceeds maximum",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "1M",
				Limit:  1500,
				Offset: 0,
			},
			expectError: true,
			errorMsg:    "limit cannot exceed 1000",
		},
		{
			name: "negative offset",
			request: &shortsv1alpha1.GetTopShortsRequest{
				Period: "1M",
				Limit:  10,
				Offset: -1,
			},
			expectError: true,
			errorMsg:    "offset must be non-negative",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateGetTopShortsRequest(tt.request)

			if tt.expectError {
				assert.Error(t, err)
				if tt.errorMsg != "" {
					assert.Contains(t, err.Error(), tt.errorMsg)
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestValidateGetStockRequest(t *testing.T) {
	tests := []struct {
		name        string
		request     *shortsv1alpha1.GetStockRequest
		expectError bool
		errorMsg    string
	}{
		{
			name: "valid product code",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "CBA",
			},
			expectError: false,
		},
		{
			name: "valid 4-letter product code",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "AAPL",
			},
			expectError: false,
		},
		{
			name: "empty product code",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "",
			},
			expectError: true,
			errorMsg:    "product code is required",
		},
		{
			name: "product code too short",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "AB",
			},
			expectError: true,
			errorMsg:    "product code must be 3-4 alphanumeric characters",
		},
		{
			name: "product code too long",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "ABCDE",
			},
			expectError: true,
			errorMsg:    "product code must be 3-4 alphanumeric characters",
		},
		{
			name: "product code with special characters",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "AB@",
			},
			expectError: true,
			errorMsg:    "product code must be 3-4 alphanumeric characters",
		},
		{
			name: "product code with numbers (valid)",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "AX1",
			},
			expectError: false,
		},
		{
			name: "product code all numbers (valid)",
			request: &shortsv1alpha1.GetStockRequest{
				ProductCode: "3PL",
			},
			expectError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateGetStockRequest(tt.request)

			if tt.expectError {
				assert.Error(t, err)
				if tt.errorMsg != "" {
					assert.Contains(t, err.Error(), tt.errorMsg)
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestValidateGetStockDataRequest(t *testing.T) {
	tests := []struct {
		name        string
		request     *shortsv1alpha1.GetStockDataRequest
		expectError bool
		errorMsg    string
	}{
		{
			name: "valid request",
			request: &shortsv1alpha1.GetStockDataRequest{
				ProductCode: "CBA",
				Period:      "1M",
			},
			expectError: false,
		},
		{
			name: "valid request with empty period",
			request: &shortsv1alpha1.GetStockDataRequest{
				ProductCode: "CBA",
				Period:      "",
			},
			expectError: false,
		},
		{
			name: "valid request with lowercase period",
			request: &shortsv1alpha1.GetStockDataRequest{
				ProductCode: "CBA",
				Period:      "1m",
			},
			expectError: false,
		},
		{
			name: "valid request with mixed case period",
			request: &shortsv1alpha1.GetStockDataRequest{
				ProductCode: "CBA",
				Period:      "3m",
			},
			expectError: false,
		},
		{
			name: "invalid product code",
			request: &shortsv1alpha1.GetStockDataRequest{
				ProductCode: "",
				Period:      "1M",
			},
			expectError: true,
			errorMsg:    "product code is required",
		},
		{
			name: "invalid period",
			request: &shortsv1alpha1.GetStockDataRequest{
				ProductCode: "CBA",
				Period:      "invalid",
			},
			expectError: true,
			errorMsg:    "invalid period format",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateGetStockDataRequest(tt.request)

			if tt.expectError {
				assert.Error(t, err)
				if tt.errorMsg != "" {
					assert.Contains(t, err.Error(), tt.errorMsg)
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestNormalizeStockCode(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"cba", "CBA"},
		{"  CBA  ", "CBA"},
		{"zip", "ZIP"},
		{"AAPL", "AAPL"},
		{" apt ", "APT"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := NormalizeStockCode(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestSetDefaultValues(t *testing.T) {
	t.Run("GetTopShortsRequest defaults", func(t *testing.T) {
		req := &shortsv1alpha1.GetTopShortsRequest{}
		SetDefaultValues(req)

		assert.Equal(t, "1M", req.Period)
		assert.Equal(t, int32(50), req.Limit)
	})

	t.Run("GetTopShortsRequest preserves existing values", func(t *testing.T) {
		req := &shortsv1alpha1.GetTopShortsRequest{
			Period: "3M",
			Limit:  25,
		}
		SetDefaultValues(req)

		assert.Equal(t, "3M", req.Period)
		assert.Equal(t, int32(25), req.Limit)
	})

	t.Run("GetTopShortsRequest normalizes lowercase period", func(t *testing.T) {
		req := &shortsv1alpha1.GetTopShortsRequest{
			Period: "3m",
			Limit:  25,
		}
		SetDefaultValues(req)

		assert.Equal(t, "3M", req.Period)
		assert.Equal(t, int32(25), req.Limit)
	})

	t.Run("GetStockDataRequest defaults", func(t *testing.T) {
		req := &shortsv1alpha1.GetStockDataRequest{
			ProductCode: "cba",
		}
		SetDefaultValues(req)

		assert.Equal(t, "1M", req.Period)
		assert.Equal(t, "CBA", req.ProductCode)
	})

	t.Run("GetStockDataRequest normalizes lowercase period", func(t *testing.T) {
		req := &shortsv1alpha1.GetStockDataRequest{
			ProductCode: "cba",
			Period:      "6m",
		}
		SetDefaultValues(req)

		assert.Equal(t, "6M", req.Period)
		assert.Equal(t, "CBA", req.ProductCode)
	})

	t.Run("GetStockRequest normalization", func(t *testing.T) {
		req := &shortsv1alpha1.GetStockRequest{
			ProductCode: "  zip  ",
		}
		SetDefaultValues(req)

		assert.Equal(t, "ZIP", req.ProductCode)
	})
}
