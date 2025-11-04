package main

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"connectrpc.com/connect"
	marketdatav1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/marketdata/v1"
)

var (
	stockCodeRegex = regexp.MustCompile(`^[A-Z]{3,4}$`)
	validPeriods   = map[string]bool{
		"1d": true, "1w": true, "1m": true,
		"3m": true, "6m": true, "1y": true,
		"2y": true, "5y": true, "10y": true,
		"max": true,
	}
)

// ValidateGetStockPriceRequest validates the GetStockPrice request
func ValidateGetStockPriceRequest(req *marketdatav1.GetStockPriceRequest) error {
	if req.StockCode == "" {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("stock code is required"),
		)
	}

	// Normalize and validate stock code
	stockCode := strings.ToUpper(strings.TrimSpace(req.StockCode))
	if !stockCodeRegex.MatchString(stockCode) {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("stock code must be 3-4 uppercase letters (e.g., CBA, BHP)"),
		)
	}

	return nil
}

// ValidateGetHistoricalPricesRequest validates the GetHistoricalPrices request
func ValidateGetHistoricalPricesRequest(req *marketdatav1.GetHistoricalPricesRequest) error {
	if req.StockCode == "" {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("stock code is required"),
		)
	}

	// Validate stock code format
	stockCode := strings.ToUpper(strings.TrimSpace(req.StockCode))
	if !stockCodeRegex.MatchString(stockCode) {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("stock code must be 3-4 uppercase letters"),
		)
	}

	// Validate period
	if req.Period != "" {
		period := strings.ToLower(req.Period)
		if !validPeriods[period] {
			return connect.NewError(
				connect.CodeInvalidArgument,
				fmt.Errorf("invalid period. Valid periods: 1d, 1w, 1m, 3m, 6m, 1y, 2y, 5y, 10y, max"),
			)
		}
	}

	return nil
}

// ValidateGetMultipleStockPricesRequest validates the GetMultipleStockPrices request
func ValidateGetMultipleStockPricesRequest(req *marketdatav1.GetMultipleStockPricesRequest) error {
	if len(req.StockCodes) == 0 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("at least one stock code is required"),
		)
	}

	// Limit the number of stocks that can be requested at once
	if len(req.StockCodes) > 50 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("cannot request more than 50 stocks at once"),
		)
	}

	// Validate each stock code
	for _, code := range req.StockCodes {
		stockCode := strings.ToUpper(strings.TrimSpace(code))
		if !stockCodeRegex.MatchString(stockCode) {
			return connect.NewError(
				connect.CodeInvalidArgument,
				fmt.Errorf("invalid stock code '%s': must be 3-4 uppercase letters", code),
			)
		}
	}

	return nil
}

// ValidateGetStockCorrelationsRequest validates the GetStockCorrelations request
func ValidateGetStockCorrelationsRequest(req *marketdatav1.GetStockCorrelationsRequest) error {
	if len(req.StockCodes) < 2 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("at least 2 stock codes are required for correlation analysis"),
		)
	}

	// Limit the number of stocks for correlation matrix
	if len(req.StockCodes) > 20 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("cannot calculate correlations for more than 20 stocks at once"),
		)
	}

	// Validate each stock code
	for _, code := range req.StockCodes {
		stockCode := strings.ToUpper(strings.TrimSpace(code))
		if !stockCodeRegex.MatchString(stockCode) {
			return connect.NewError(
				connect.CodeInvalidArgument,
				fmt.Errorf("invalid stock code '%s': must be 3-4 uppercase letters", code),
			)
		}
	}

	// Validate period
	if req.Period != "" {
		period := strings.ToLower(req.Period)
		// Correlation analysis typically needs longer periods
		validCorrelationPeriods := map[string]bool{
			"1m": true, "3m": true, "6m": true, "1y": true,
		}
		if !validCorrelationPeriods[period] {
			return connect.NewError(
				connect.CodeInvalidArgument,
				fmt.Errorf("invalid period for correlation. Valid periods: 1m, 3m, 6m, 1y"),
			)
		}
	}

	return nil
}

// NormalizeStockCode normalizes a stock code to uppercase and trims whitespace
func NormalizeStockCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}

// NormalizeStockCodes normalizes a slice of stock codes
func NormalizeStockCodes(codes []string) []string {
	normalized := make([]string, len(codes))
	for i, code := range codes {
		normalized[i] = NormalizeStockCode(code)
	}
	return normalized
}

// SetDefaultValues sets default values for request parameters
func SetDefaultValues(req interface{}) {
	switch r := req.(type) {
	case *marketdatav1.GetHistoricalPricesRequest:
		r.StockCode = NormalizeStockCode(r.StockCode)
		if r.Period == "" {
			r.Period = "1m"
		} else {
			r.Period = strings.ToLower(r.Period)
		}
	case *marketdatav1.GetStockPriceRequest:
		r.StockCode = NormalizeStockCode(r.StockCode)
	case *marketdatav1.GetMultipleStockPricesRequest:
		r.StockCodes = NormalizeStockCodes(r.StockCodes)
	case *marketdatav1.GetStockCorrelationsRequest:
		r.StockCodes = NormalizeStockCodes(r.StockCodes)
		if r.Period == "" {
			r.Period = "3m"
		} else {
			r.Period = strings.ToLower(r.Period)
		}
	}
}

// ValidateDateRange validates that start date is before end date and within reasonable bounds
func ValidateDateRange(startDate, endDate time.Time) error {
	if startDate.After(endDate) {
		return fmt.Errorf("start date must be before end date")
	}

	// Check if date range is too large (more than 5 years)
	maxDuration := 5 * 365 * 24 * time.Hour
	if endDate.Sub(startDate) > maxDuration {
		return fmt.Errorf("date range cannot exceed 5 years")
	}

	// Check if end date is in the future
	if endDate.After(time.Now()) {
		return fmt.Errorf("end date cannot be in the future")
	}

	return nil
}
