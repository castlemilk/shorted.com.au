package shorts

import (
	"testing"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestMergeKeyMetricsToInfo_EmptyInputs tests merging with empty/nil inputs
func TestMergeKeyMetricsToInfo_EmptyInputs(t *testing.T) {
	tests := []struct {
		name           string
		keyMetrics     map[string]interface{}
		existingInfo   *stocksv1alpha1.FinancialStatementsInfo
		expectedResult *stocksv1alpha1.FinancialStatementsInfo
	}{
		{
			name:           "nil keyMetrics, nil info",
			keyMetrics:     nil,
			existingInfo:   nil,
			expectedResult: &stocksv1alpha1.FinancialStatementsInfo{},
		},
		{
			name:           "empty keyMetrics, nil info",
			keyMetrics:     map[string]interface{}{},
			existingInfo:   nil,
			expectedResult: &stocksv1alpha1.FinancialStatementsInfo{},
		},
		{
			name:       "nil keyMetrics, existing info",
			keyMetrics: nil,
			existingInfo: &stocksv1alpha1.FinancialStatementsInfo{
				MarketCap: 1000000,
				PeRatio:   15.5,
			},
			expectedResult: &stocksv1alpha1.FinancialStatementsInfo{
				MarketCap: 1000000,
				PeRatio:   15.5,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := mergeKeyMetricsToInfo(tt.keyMetrics, tt.existingInfo)
			assert.Equal(t, tt.expectedResult, result)
		})
	}
}

// TestMergeKeyMetricsToInfo_AllFields tests merging all supported fields
func TestMergeKeyMetricsToInfo_AllFields(t *testing.T) {
	keyMetrics := map[string]interface{}{
		"market_cap":            float64(267812405248),
		"current_price":         float64(125.50),
		"pe_ratio":              float64(18.5),
		"eps":                   float64(6.78),
		"dividend_yield":        float64(0.045),
		"beta":                  float64(1.2),
		"fifty_two_week_high":   float64(135.00),
		"fifty_two_week_low":    float64(95.00),
		"avg_volume":            float64(5000000),
		"employee_count":        int(50000),
		"sector":                "Financials",
		"industry":              "Banks",
	}

	result := mergeKeyMetricsToInfo(keyMetrics, nil)

	require.NotNil(t, result)
	assert.Equal(t, float64(267812405248), result.MarketCap)
	assert.Equal(t, float64(125.50), result.CurrentPrice)
	assert.Equal(t, float64(18.5), result.PeRatio)
	assert.Equal(t, float64(6.78), result.Eps)
	assert.Equal(t, float64(0.045), result.DividendYield)
	assert.Equal(t, float64(1.2), result.Beta)
	assert.Equal(t, float64(135.00), result.Week_52High)
	assert.Equal(t, float64(95.00), result.Week_52Low)
	assert.Equal(t, float64(5000000), result.Volume)
	assert.Equal(t, int64(50000), result.EmployeeCount)
	assert.Equal(t, "Financials", result.Sector)
	assert.Equal(t, "Banks", result.Industry)
}

// TestMergeKeyMetricsToInfo_PreserveExisting tests that existing values are preserved
func TestMergeKeyMetricsToInfo_PreserveExisting(t *testing.T) {
	keyMetrics := map[string]interface{}{
		"market_cap": float64(100000000),
		"pe_ratio":   float64(10.0),
		"sector":     "NewSector",
	}

	existing := &stocksv1alpha1.FinancialStatementsInfo{
		MarketCap: 267812405248,  // Should NOT be overwritten
		PeRatio:   0,              // Should be filled from keyMetrics
		Beta:      1.5,            // Should be preserved
		Sector:    "",             // Should be filled from keyMetrics
	}

	result := mergeKeyMetricsToInfo(keyMetrics, existing)

	// Existing non-zero values should be preserved
	assert.Equal(t, float64(267812405248), result.MarketCap, "Existing MarketCap should be preserved")
	assert.Equal(t, float64(1.5), result.Beta, "Existing Beta should be preserved")
	
	// Zero/empty values should be filled from keyMetrics
	assert.Equal(t, float64(10.0), result.PeRatio, "PeRatio should be filled from keyMetrics")
	assert.Equal(t, "NewSector", result.Sector, "Sector should be filled from keyMetrics")
}

// TestMergeKeyMetricsToInfo_TypeConversions tests various type conversions
func TestMergeKeyMetricsToInfo_TypeConversions(t *testing.T) {
	tests := []struct {
		name     string
		input    interface{}
		expected float64
	}{
		{"float64", float64(123.45), 123.45},
		{"float32", float32(123.45), float64(float32(123.45))},
		{"int", int(123), 123.0},
		{"int64", int64(123), 123.0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			keyMetrics := map[string]interface{}{
				"market_cap": tt.input,
			}

			result := mergeKeyMetricsToInfo(keyMetrics, nil)
			assert.Equal(t, tt.expected, result.MarketCap)
		})
	}
}

// TestMergeKeyMetricsToInfo_NullValues tests handling of nil values
func TestMergeKeyMetricsToInfo_NullValues(t *testing.T) {
	keyMetrics := map[string]interface{}{
		"market_cap": nil,
		"pe_ratio":   float64(15.5),
		"sector":     nil,
	}

	result := mergeKeyMetricsToInfo(keyMetrics, nil)

	// nil values should result in zero values
	assert.Equal(t, float64(0), result.MarketCap)
	assert.Equal(t, float64(15.5), result.PeRatio)
	assert.Equal(t, "", result.Sector)
}

// TestMergeKeyMetricsToInfo_PartialData tests merging with partial data
func TestMergeKeyMetricsToInfo_PartialData(t *testing.T) {
	keyMetrics := map[string]interface{}{
		"market_cap": float64(1000000),
		"pe_ratio":   float64(12.5),
		// Other fields missing
	}

	result := mergeKeyMetricsToInfo(keyMetrics, nil)

	require.NotNil(t, result)
	assert.Equal(t, float64(1000000), result.MarketCap)
	assert.Equal(t, float64(12.5), result.PeRatio)
	// Unmapped fields should have zero values
	assert.Equal(t, float64(0), result.Eps)
	assert.Equal(t, float64(0), result.Beta)
	assert.Equal(t, "", result.Sector)
}

// TestMergeKeyMetricsToInfo_InvalidTypes tests handling of invalid type values
func TestMergeKeyMetricsToInfo_InvalidTypes(t *testing.T) {
	keyMetrics := map[string]interface{}{
		"market_cap": "not_a_number", // Invalid type
		"pe_ratio":   float64(15.5),   // Valid
		"sector":     12345,            // Invalid type for string
	}

	result := mergeKeyMetricsToInfo(keyMetrics, nil)

	// Invalid types should result in zero/empty values
	assert.Equal(t, float64(0), result.MarketCap, "Invalid string should convert to 0")
	assert.Equal(t, float64(15.5), result.PeRatio, "Valid value should be preserved")
	assert.Equal(t, "", result.Sector, "Invalid int should convert to empty string")
}

// TestMergeKeyMetricsToInfo_RealWorldExample tests a realistic scenario
func TestMergeKeyMetricsToInfo_RealWorldExample(t *testing.T) {
	// Simulate key_metrics from daily sync (has current market data)
	keyMetrics := map[string]interface{}{
		"market_cap":            float64(5678912345),
		"pe_ratio":              float64(22.3),
		"eps":                   float64(4.50),
		"dividend_yield":        float64(0.038),
		"beta":                  float64(1.15),
		"fifty_two_week_high":   float64(8.95),
		"fifty_two_week_low":    float64(5.20),
		"avg_volume":            float64(3500000),
	}

	// Simulate existing financial_statements.info (has some historical data)
	existing := &stocksv1alpha1.FinancialStatementsInfo{
		Sector:   "Materials",
		Industry: "Gold Mining",
		// Other fields are zero/empty
	}

	result := mergeKeyMetricsToInfo(keyMetrics, existing)

	// Should have data from both sources
	assert.Equal(t, float64(5678912345), result.MarketCap, "Should use key_metrics market cap")
	assert.Equal(t, float64(22.3), result.PeRatio, "Should use key_metrics PE ratio")
	assert.Equal(t, "Materials", result.Sector, "Should preserve existing sector")
	assert.Equal(t, "Gold Mining", result.Industry, "Should preserve existing industry")
}

// TestMergeKeyMetricsToInfo_EVNScenario tests the specific EVN scenario mentioned
func TestMergeKeyMetricsToInfo_EVNScenario(t *testing.T) {
	// Simulate EVN stock with only key_metrics (no financial_statements)
	keyMetrics := map[string]interface{}{
		"market_cap": float64(5678912345),
		"pe_ratio":   float64(22.3),
		"beta":       float64(1.05),
	}

	// No existing financial_statements.info
	result := mergeKeyMetricsToInfo(keyMetrics, nil)

	require.NotNil(t, result)
	assert.Greater(t, result.MarketCap, float64(0), "EVN should have market cap from key_metrics")
	assert.Greater(t, result.PeRatio, float64(0), "EVN should have PE ratio from key_metrics")
	assert.Greater(t, result.Beta, float64(0), "EVN should have beta from key_metrics")
}

// TestIsEmptyJSON tests the JSON empty check helper
func TestIsEmptyJSON(t *testing.T) {
	tests := []struct {
		name     string
		input    []byte
		expected bool
	}{
		{"nil", nil, true},
		{"empty", []byte{}, true},
		{"whitespace only", []byte("   "), true},
		{"empty array", []byte("[]"), true},
		{"empty object", []byte("{}"), true},
		{"null", []byte("null"), true},
		{"empty string", []byte(`""`), true},
		{"valid json", []byte(`{"key": "value"}`), false},
		{"valid array", []byte(`[1, 2, 3]`), false},
		{"number", []byte("123"), false},
		{"string", []byte(`"hello"`), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := isEmptyJSON(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}

