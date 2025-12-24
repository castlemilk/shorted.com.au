# Key Metrics Merging - Test Documentation

## Overview

This document describes the test coverage for the key_metrics merging functionality, which ensures that market cap and other financial data from the `key_metrics` column is properly merged into `financial_statements.info`.

## Problem Statement

Stocks can have financial data in two places:
1. **`financial_statements`** JSONB column - Contains comprehensive financial statement data
2. **`key_metrics`** JSONB column - Contains real-time market metrics from daily sync

Some stocks (like EVN, WOW, NAB) only have data in `key_metrics`, so we need to merge this data into the response.

## Solution

The `mergeKeyMetricsToInfo()` function merges data from `key_metrics` into `financial_statements.info`, following these rules:
- Existing values in `financial_statements.info` are **preserved** (not overwritten)
- Empty/zero values are **filled** from `key_metrics`
- Handles type conversions (float64, float32, int, int64, string)
- Gracefully handles nil/null values

## Test Coverage

### Unit Tests (`key_metrics_merge_test.go`)

#### 1. **TestMergeKeyMetricsToInfo_EmptyInputs**
Tests edge cases with empty/nil inputs:
- nil keyMetrics, nil info
- empty keyMetrics, nil info  
- nil keyMetrics, existing info

**Purpose**: Ensures the function handles edge cases without crashing

#### 2. **TestMergeKeyMetricsToInfo_AllFields**
Tests that all supported fields are correctly mapped:
- market_cap → MarketCap
- pe_ratio → PeRatio
- eps → Eps
- dividend_yield → DividendYield
- beta → Beta
- fifty_two_week_high → Week_52High
- fifty_two_week_low → Week_52Low
- avg_volume → Volume
- employee_count → EmployeeCount
- sector → Sector
- industry → Industry

**Purpose**: Validates complete field mapping

#### 3. **TestMergeKeyMetricsToInfo_PreserveExisting**
Tests that existing non-zero values are preserved:
```go
existing.MarketCap = 267812405248  // Should NOT be overwritten
existing.PeRatio = 0                // Should be filled from keyMetrics
```

**Purpose**: Ensures data integrity - existing data is never lost

#### 4. **TestMergeKeyMetricsToInfo_TypeConversions**
Tests type conversion for numeric fields:
- float64 → float64
- float32 → float64
- int → float64
- int64 → float64

**Purpose**: Validates robustness against different numeric types

#### 5. **TestMergeKeyMetricsToInfo_NullValues**
Tests handling of nil values in keyMetrics:
```go
keyMetrics["market_cap"] = nil  // Should result in 0
```

**Purpose**: Ensures nil values don't cause panics

#### 6. **TestMergeKeyMetricsToInfo_PartialData**
Tests merging when only some fields are present in keyMetrics

**Purpose**: Validates behavior with incomplete data

#### 7. **TestMergeKeyMetricsToInfo_InvalidTypes**
Tests handling of invalid type values:
```go
keyMetrics["market_cap"] = "not_a_number"  // Should convert to 0
```

**Purpose**: Ensures graceful degradation with bad data

#### 8. **TestMergeKeyMetricsToInfo_RealWorldExample**
Tests a realistic scenario with both sources of data

**Purpose**: Integration-style test with real-world data patterns

#### 9. **TestMergeKeyMetricsToInfo_EVNScenario**
Tests the specific EVN stock scenario that prompted this feature

**Purpose**: Regression test for the original issue

#### 10. **TestIsEmptyJSON**
Tests the JSON empty check helper function

**Purpose**: Ensures proper detection of empty JSON values

### Integration Tests (`postgres_getstockdetails_test.go`)

#### 1. **TestGetStockDetailsKeyMetricsMerge**
End-to-end test that:
1. Inserts a stock with ONLY key_metrics (no financial_statements)
2. Calls `GetStockDetails()`
3. Verifies that financial_statements.info is populated from key_metrics

**Test Data**:
```json
{
  "market_cap": 5678912345,
  "pe_ratio": 22.3,
  "eps": 4.50,
  "dividend_yield": 0.038,
  "beta": 1.15,
  "fifty_two_week_high": 8.95,
  "fifty_two_week_low": 5.20,
  "avg_volume": 3500000
}
```

**Purpose**: Validates full integration with database

#### 2. **TestGetStockDetailsKeyMetricsPreserveExisting**
End-to-end test that:
1. Inserts a stock with BOTH financial_statements AND key_metrics
2. Verifies existing values are preserved
3. Verifies missing values are filled from key_metrics

**Test Data**:
- financial_statements has market_cap = 999999999
- key_metrics has market_cap = 5678912345
- Expected: market_cap = 999999999 (preserved)

**Purpose**: Validates data preservation priority

#### 3. **TestGetStockDetailsNoKeyMetrics**
Tests behavior when key_metrics is NULL

**Purpose**: Ensures system doesn't crash with missing data

#### 4. **TestGetStockDetailsColumnNames**
Updated to include `key_metrics` in required columns list

**Purpose**: Schema validation

#### 5. **TestGetStockDetailsSQLQuery**
Updated to fetch and scan `key_metrics` column

**Purpose**: Query structure validation

## Running the Tests

### Unit Tests Only (Fast)
```bash
cd services/shorts
go test -v ./internal/store/shorts -run TestMergeKeyMetricsToInfo
go test -v ./internal/store/shorts -run TestIsEmptyJSON
```

### All Tests (Short Mode - No Database)
```bash
cd services/shorts
go test ./internal/store/shorts/... -short
```

### Integration Tests (Requires Database)
```bash
# Set DATABASE_URL environment variable
export DATABASE_URL="postgresql://admin:password@localhost:5438/shorts"

cd services/shorts
go test -v ./internal/store/shorts -run TestGetStockDetailsKeyMetrics
```

### All Tests
```bash
cd services/shorts
go test ./internal/store/shorts/...
```

## Test Results

All tests pass ✅:
- 9 unit tests for `mergeKeyMetricsToInfo()`
- 1 unit test for `isEmptyJSON()`
- 3 integration tests for database interaction
- 2 updated schema validation tests

## Coverage

The tests cover:
- ✅ Empty/nil inputs
- ✅ Complete field mapping
- ✅ Data preservation
- ✅ Type conversions
- ✅ Null handling
- ✅ Partial data
- ✅ Invalid types
- ✅ Real-world scenarios
- ✅ Database integration
- ✅ Schema validation

## Example Usage

```go
// In GetStockDetails()
var keyMetricsJSON []byte
// ... scan from database ...

// Parse financial statements
fs := parseFinancialStatements(financialStatementsJSON)

// Merge key_metrics into financial_statements info
if !isEmptyJSON(keyMetricsJSON) {
    var keyMetrics map[string]interface{}
    if err := json.Unmarshal(keyMetricsJSON, &keyMetrics); err == nil {
        if fs == nil {
            fs = &stocksv1alpha1.FinancialStatements{Success: true}
        }
        fs.Info = mergeKeyMetricsToInfo(keyMetrics, fs.Info)
    }
}
```

## Maintenance

When adding new fields:
1. Update the `mergeKeyMetricsToInfo()` function
2. Add test cases to `TestMergeKeyMetricsToInfo_AllFields`
3. Update the mapping documentation in this file

## Related Files

- `postgres.go` - Implementation
- `key_metrics_merge_test.go` - Unit tests
- `postgres_getstockdetails_test.go` - Integration tests
- `../../proto/shortedtypes/stocks/v1alpha1/stocks.proto` - Proto definitions

