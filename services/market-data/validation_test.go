package main

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	marketdatav1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/marketdata/v1"
)

func TestValidateGetStockPriceRequest(t *testing.T) {
	tests := []struct {
		name        string
		request     *marketdatav1.GetStockPriceRequest
		expectError bool
		errorMsg    string
	}{
		{
			name: "valid stock code",
			request: &marketdatav1.GetStockPriceRequest{
				StockCode: "CBA",
			},
			expectError: false,
		},
		{
			name: "valid 4-letter stock code",
			request: &marketdatav1.GetStockPriceRequest{
				StockCode: "AAPL",
			},
			expectError: false,
		},
		{
			name: "lowercase stock code (should be normalized)",
			request: &marketdatav1.GetStockPriceRequest{
				StockCode: "cba",
			},
			expectError: false,
		},
		{
			name: "empty stock code",
			request: &marketdatav1.GetStockPriceRequest{
				StockCode: "",
			},
			expectError: true,
			errorMsg:    "stock code is required",
		},
		{
			name: "stock code too short",
			request: &marketdatav1.GetStockPriceRequest{
				StockCode: "AB",
			},
			expectError: true,
			errorMsg:    "stock code must be 3-4 uppercase letters",
		},
		{
			name: "stock code too long",
			request: &marketdatav1.GetStockPriceRequest{
				StockCode: "ABCDE",
			},
			expectError: true,
			errorMsg:    "stock code must be 3-4 uppercase letters",
		},
		{
			name: "stock code with numbers",
			request: &marketdatav1.GetStockPriceRequest{
				StockCode: "AB1",
			},
			expectError: true,
			errorMsg:    "stock code must be 3-4 uppercase letters",
		},
		{
			name: "stock code with special characters",
			request: &marketdatav1.GetStockPriceRequest{
				StockCode: "CB@",
			},
			expectError: true,
			errorMsg:    "stock code must be 3-4 uppercase letters",
		},
		{
			name: "stock code with spaces",
			request: &marketdatav1.GetStockPriceRequest{
				StockCode: "  CBA  ",
			},
			expectError: false, // Should be trimmed
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateGetStockPriceRequest(tt.request)
			
			if tt.expectError {
				require.Error(t, err)
				if tt.errorMsg != "" {
					assert.Contains(t, err.Error(), tt.errorMsg)
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestValidateGetHistoricalPricesRequest(t *testing.T) {
	tests := []struct {
		name        string
		request     *marketdatav1.GetHistoricalPricesRequest
		expectError bool
		errorMsg    string
	}{
		{
			name: "valid request with period",
			request: &marketdatav1.GetHistoricalPricesRequest{
				StockCode: "CBA",
				Period:    "1m",
			},
			expectError: false,
		},
		{
			name: "valid request without period",
			request: &marketdatav1.GetHistoricalPricesRequest{
				StockCode: "BHP",
			},
			expectError: false,
		},
		{
			name: "uppercase period (should be normalized)",
			request: &marketdatav1.GetHistoricalPricesRequest{
				StockCode: "CBA",
				Period:    "1M",
			},
			expectError: false,
		},
		{
			name: "empty stock code",
			request: &marketdatav1.GetHistoricalPricesRequest{
				StockCode: "",
				Period:    "1m",
			},
			expectError: true,
			errorMsg:    "stock code is required",
		},
		{
			name: "invalid period",
			request: &marketdatav1.GetHistoricalPricesRequest{
				StockCode: "CBA",
				Period:    "5y",
			},
			expectError: true,
			errorMsg:    "invalid period",
		},
		{
			name: "all valid periods",
			request: &marketdatav1.GetHistoricalPricesRequest{
				StockCode: "CBA",
				Period:    "1d",
			},
			expectError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateGetHistoricalPricesRequest(tt.request)
			
			if tt.expectError {
				require.Error(t, err)
				if tt.errorMsg != "" {
					assert.Contains(t, err.Error(), tt.errorMsg)
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestValidateGetMultipleStockPricesRequest(t *testing.T) {
	tests := []struct {
		name        string
		request     *marketdatav1.GetMultipleStockPricesRequest
		expectError bool
		errorMsg    string
	}{
		{
			name: "valid request with multiple stocks",
			request: &marketdatav1.GetMultipleStockPricesRequest{
				StockCodes: []string{"CBA", "BHP", "CSL"},
			},
			expectError: false,
		},
		{
			name: "empty stock codes",
			request: &marketdatav1.GetMultipleStockPricesRequest{
				StockCodes: []string{},
			},
			expectError: true,
			errorMsg:    "at least one stock code is required",
		},
		{
			name: "too many stock codes",
			request: &marketdatav1.GetMultipleStockPricesRequest{
				StockCodes: generateStockCodes(51),
			},
			expectError: true,
			errorMsg:    "cannot request more than 50 stocks",
		},
		{
			name: "invalid stock code in list",
			request: &marketdatav1.GetMultipleStockPricesRequest{
				StockCodes: []string{"CBA", "INVALID123", "BHP"},
			},
			expectError: true,
			errorMsg:    "invalid stock code 'INVALID123'",
		},
		{
			name: "lowercase stock codes (should be normalized)",
			request: &marketdatav1.GetMultipleStockPricesRequest{
				StockCodes: []string{"cba", "bhp", "csl"},
			},
			expectError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateGetMultipleStockPricesRequest(tt.request)
			
			if tt.expectError {
				require.Error(t, err)
				if tt.errorMsg != "" {
					assert.Contains(t, err.Error(), tt.errorMsg)
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestValidateGetStockCorrelationsRequest(t *testing.T) {
	tests := []struct {
		name        string
		request     *marketdatav1.GetStockCorrelationsRequest
		expectError bool
		errorMsg    string
	}{
		{
			name: "valid request",
			request: &marketdatav1.GetStockCorrelationsRequest{
				StockCodes: []string{"CBA", "BHP", "CSL"},
				Period:     "3m",
			},
			expectError: false,
		},
		{
			name: "minimum stocks (2)",
			request: &marketdatav1.GetStockCorrelationsRequest{
				StockCodes: []string{"CBA", "BHP"},
				Period:     "1m",
			},
			expectError: false,
		},
		{
			name: "too few stocks",
			request: &marketdatav1.GetStockCorrelationsRequest{
				StockCodes: []string{"CBA"},
				Period:     "3m",
			},
			expectError: true,
			errorMsg:    "at least 2 stock codes are required",
		},
		{
			name: "too many stocks",
			request: &marketdatav1.GetStockCorrelationsRequest{
				StockCodes: generateStockCodes(21),
				Period:     "3m",
			},
			expectError: true,
			errorMsg:    "cannot calculate correlations for more than 20 stocks",
		},
		{
			name: "invalid period for correlation",
			request: &marketdatav1.GetStockCorrelationsRequest{
				StockCodes: []string{"CBA", "BHP"},
				Period:     "1d",
			},
			expectError: true,
			errorMsg:    "invalid period for correlation",
		},
		{
			name: "valid correlation periods",
			request: &marketdatav1.GetStockCorrelationsRequest{
				StockCodes: []string{"CBA", "BHP"},
				Period:     "1y",
			},
			expectError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateGetStockCorrelationsRequest(tt.request)
			
			if tt.expectError {
				require.Error(t, err)
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
		{"CBA", "CBA"},
		{"  cba  ", "CBA"},
		{"  ZIP  ", "ZIP"},
		{"aapl", "AAPL"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := NormalizeStockCode(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestNormalizeStockCodes(t *testing.T) {
	input := []string{"cba", "  bhp  ", "CSL", "wbc"}
	expected := []string{"CBA", "BHP", "CSL", "WBC"}
	
	result := NormalizeStockCodes(input)
	assert.Equal(t, expected, result)
}

func TestSetDefaultValues(t *testing.T) {
	t.Run("GetHistoricalPricesRequest defaults", func(t *testing.T) {
		req := &marketdatav1.GetHistoricalPricesRequest{
			StockCode: "cba",
		}
		SetDefaultValues(req)
		
		assert.Equal(t, "CBA", req.StockCode)
		assert.Equal(t, "1m", req.Period)
	})

	t.Run("GetHistoricalPricesRequest preserves period", func(t *testing.T) {
		req := &marketdatav1.GetHistoricalPricesRequest{
			StockCode: "cba",
			Period:    "6M",
		}
		SetDefaultValues(req)
		
		assert.Equal(t, "CBA", req.StockCode)
		assert.Equal(t, "6m", req.Period) // Normalized to lowercase
	})

	t.Run("GetStockPriceRequest normalization", func(t *testing.T) {
		req := &marketdatav1.GetStockPriceRequest{
			StockCode: "  bhp  ",
		}
		SetDefaultValues(req)
		
		assert.Equal(t, "BHP", req.StockCode)
	})

	t.Run("GetMultipleStockPricesRequest normalization", func(t *testing.T) {
		req := &marketdatav1.GetMultipleStockPricesRequest{
			StockCodes: []string{"cba", "  bhp  ", "CSL"},
		}
		SetDefaultValues(req)
		
		assert.Equal(t, []string{"CBA", "BHP", "CSL"}, req.StockCodes)
	})

	t.Run("GetStockCorrelationsRequest defaults", func(t *testing.T) {
		req := &marketdatav1.GetStockCorrelationsRequest{
			StockCodes: []string{"cba", "bhp"},
		}
		SetDefaultValues(req)
		
		assert.Equal(t, []string{"CBA", "BHP"}, req.StockCodes)
		assert.Equal(t, "3m", req.Period)
	})
}

func TestValidateDateRange(t *testing.T) {
	now := time.Now()
	
	tests := []struct {
		name      string
		startDate time.Time
		endDate   time.Time
		expectError bool
		errorMsg  string
	}{
		{
			name:      "valid date range",
			startDate: now.AddDate(-1, 0, 0),
			endDate:   now,
			expectError: false,
		},
		{
			name:      "start after end",
			startDate: now,
			endDate:   now.AddDate(-1, 0, 0),
			expectError: true,
			errorMsg:  "start date must be before end date",
		},
		{
			name:      "range too large",
			startDate: now.AddDate(-6, 0, 0),
			endDate:   now,
			expectError: true,
			errorMsg:  "date range cannot exceed 5 years",
		},
		{
			name:      "end date in future",
			startDate: now,
			endDate:   now.AddDate(0, 1, 0),
			expectError: true,
			errorMsg:  "end date cannot be in the future",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateDateRange(tt.startDate, tt.endDate)
			
			if tt.expectError {
				require.Error(t, err)
				if tt.errorMsg != "" {
					assert.Contains(t, err.Error(), tt.errorMsg)
				}
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

// Helper function to generate stock codes for testing
func generateStockCodes(n int) []string {
	codes := make([]string, n)
	for i := 0; i < n; i++ {
		// Generate valid 3-letter codes like AAA, AAB, AAC, etc.
		codes[i] = string([]byte{
			'A' + byte(i/676),
			'A' + byte((i/26)%26),
			'A' + byte(i%26),
		})
	}
	return codes
}