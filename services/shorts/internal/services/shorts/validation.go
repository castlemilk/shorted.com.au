package shorts

import (
	"fmt"
	"regexp"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

var (
	// Allow 3-4 characters: uppercase letters and digits (e.g., CBA, ZIP, AX1, 3PL)
	stockCodeRegex = regexp.MustCompile(`^[A-Z0-9]{3,4}$`)
	validPeriods   = map[string]bool{
		"1D": true, "1W": true, "1M": true,
		"3M": true, "6M": true, "1Y": true,
		"2Y": true, "5Y": true, "10Y": true,
		"MAX": true,
	}
	validViewModes = map[string]bool{
		"CURRENT_CHANGE":    true,
		"PERCENTAGE_CHANGE": true,
	}
)

// ValidateGetTopShortsRequest validates the GetTopShorts request parameters
func ValidateGetTopShortsRequest(req *shortsv1alpha1.GetTopShortsRequest) error {
	// Validate period (normalize to uppercase)
	if req.Period != "" && !validPeriods[strings.ToUpper(req.Period)] {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("invalid period format. Valid periods: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y, MAX"),
		)
	}

	// Validate limit
	if req.Limit < 0 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("limit must be positive"),
		)
	}

	// Set reasonable upper limit
	if req.Limit > 1000 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("limit cannot exceed 1000"),
		)
	}

	// Validate offset
	if req.Offset < 0 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("offset must be non-negative"),
		)
	}

	return nil
}

// ValidateGetStockRequest validates the GetStock request parameters
func ValidateGetStockRequest(req *shortsv1alpha1.GetStockRequest) error {
	// Validate product code is provided
	if req.ProductCode == "" {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("product code is required"),
		)
	}

	// Validate product code format
	productCode := strings.ToUpper(strings.TrimSpace(req.ProductCode))
	if !stockCodeRegex.MatchString(productCode) {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("product code must be 3-4 alphanumeric characters (e.g., CBA, ZIP, AX1)"),
		)
	}

	return nil
}

// ValidateGetStockDataRequest validates the GetStockData request parameters
func ValidateGetStockDataRequest(req *shortsv1alpha1.GetStockDataRequest) error {
	// Validate product code
	if err := ValidateGetStockRequest(&shortsv1alpha1.GetStockRequest{
		ProductCode: req.ProductCode,
	}); err != nil {
		return err
	}

	// Validate period (normalize to uppercase)
	if req.Period != "" && !validPeriods[strings.ToUpper(req.Period)] {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("invalid period format. Valid periods: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y, MAX"),
		)
	}

	return nil
}

// ValidateGetStockDetailsRequest validates the GetStockDetails request parameters
func ValidateGetStockDetailsRequest(req *shortsv1alpha1.GetStockDetailsRequest) error {
	return ValidateGetStockRequest(&shortsv1alpha1.GetStockRequest{
		ProductCode: req.ProductCode,
	})
}

// ValidateGetIndustryTreeMapRequest validates the GetIndustryTreeMap request parameters
func ValidateGetIndustryTreeMapRequest(req *shortsv1alpha1.GetIndustryTreeMapRequest) error {
	// Validate period (normalize to uppercase)
	if req.Period != "" && !validPeriods[strings.ToUpper(req.Period)] {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("invalid period format. Valid periods: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y, MAX"),
		)
	}

	// Validate limit
	if req.Limit < 0 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("limit must be positive"),
		)
	}

	// Set reasonable upper limit
	if req.Limit > 500 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("limit cannot exceed 500 for treemap data"),
		)
	}

	// Validate view mode
	if req.ViewMode.String() != "" && !validViewModes[req.ViewMode.String()] {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("invalid view mode. Valid modes: CURRENT_CHANGE, PERCENTAGE_CHANGE"),
		)
	}

	return nil
}

// ValidateGetMarketByDateRequest validates the GetMarketByDate request parameters
func ValidateGetMarketByDateRequest(req *shortsv1alpha1.GetMarketByDateRequest) error {
	if req.Date == "" {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("date is required (YYYY-MM-DD format)"),
		)
	}

	// Basic date format validation
	if len(req.Date) != 10 || req.Date[4] != '-' || req.Date[7] != '-' {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("date must be in YYYY-MM-DD format"),
		)
	}

	if req.Limit < 0 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("limit must be positive"),
		)
	}
	if req.Limit > 1000 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("limit cannot exceed 1000"),
		)
	}
	if req.Offset < 0 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("offset must be non-negative"),
		)
	}
	return nil
}

// ValidateGetAvailableDatesRequest validates the GetAvailableDates request parameters
func ValidateGetAvailableDatesRequest(req *shortsv1alpha1.GetAvailableDatesRequest) error {
	if req.Limit < 0 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("limit must be positive"),
		)
	}
	if req.Limit > 1000 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("limit cannot exceed 1000"),
		)
	}
	if req.Before != "" && (len(req.Before) != 10 || req.Before[4] != '-' || req.Before[7] != '-') {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("before date must be in YYYY-MM-DD format"),
		)
	}
	return nil
}

// ValidateGetStockNewsRequest validates the GetStockNews request parameters
func ValidateGetStockNewsRequest(req *shortsv1alpha1.GetStockNewsRequest) error {
	if err := ValidateGetStockRequest(&shortsv1alpha1.GetStockRequest{
		ProductCode: req.StockCode,
	}); err != nil {
		return err
	}
	if req.Limit < 0 || req.Limit > 100 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and 100"))
	}
	return nil
}

// ValidateGetDirectorTradesRequest validates the GetDirectorTrades request parameters
func ValidateGetDirectorTradesRequest(req *shortsv1alpha1.GetDirectorTradesRequest) error {
	if err := ValidateGetStockRequest(&shortsv1alpha1.GetStockRequest{
		ProductCode: req.StockCode,
	}); err != nil {
		return err
	}
	if req.Limit < 0 || req.Limit > 200 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and 200"))
	}
	return nil
}

// ValidateGetDividendHistoryRequest validates the GetDividendHistory request parameters
func ValidateGetDividendHistoryRequest(req *shortsv1alpha1.GetDividendHistoryRequest) error {
	if err := ValidateGetStockRequest(&shortsv1alpha1.GetStockRequest{
		ProductCode: req.StockCode,
	}); err != nil {
		return err
	}
	if req.Years < 0 || req.Years > 20 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("years must be between 0 and 20"))
	}
	return nil
}

// ValidateGetPeerComparisonRequest validates the GetPeerComparison request parameters
func ValidateGetPeerComparisonRequest(req *shortsv1alpha1.GetPeerComparisonRequest) error {
	if err := ValidateGetStockRequest(&shortsv1alpha1.GetStockRequest{
		ProductCode: req.StockCode,
	}); err != nil {
		return err
	}
	if req.Limit < 0 || req.Limit > 20 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and 20"))
	}
	return nil
}

// NormalizeStockCode normalizes a stock code to uppercase and trims whitespace
func NormalizeStockCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}

// SetDefaultValues sets default values for request parameters if not provided
func SetDefaultValues(req interface{}) {
	switch r := req.(type) {
	case *shortsv1alpha1.GetTopShortsRequest:
		if r.Period == "" {
			r.Period = "1M"
		} else {
			r.Period = strings.ToUpper(r.Period)
		}
		if r.Limit == 0 {
			r.Limit = 50
		}
	case *shortsv1alpha1.GetStockDataRequest:
		if r.Period == "" {
			r.Period = "1M"
		} else {
			r.Period = strings.ToUpper(r.Period)
		}
		r.ProductCode = NormalizeStockCode(r.ProductCode)
	case *shortsv1alpha1.GetStockRequest:
		r.ProductCode = NormalizeStockCode(r.ProductCode)
	case *shortsv1alpha1.GetStockDetailsRequest:
		r.ProductCode = NormalizeStockCode(r.ProductCode)
	case *shortsv1alpha1.GetIndustryTreeMapRequest:
		if r.Period == "" {
			r.Period = "1M"
		} else {
			r.Period = strings.ToUpper(r.Period)
		}
		if r.Limit == 0 {
			r.Limit = 100
		}
	case *shortsv1alpha1.GetMarketByDateRequest:
		if r.Limit == 0 {
			r.Limit = 50
		}
	case *shortsv1alpha1.GetAvailableDatesRequest:
		if r.Limit == 0 {
			r.Limit = 90
		}
	case *shortsv1alpha1.GetStockNewsRequest:
		r.StockCode = NormalizeStockCode(r.StockCode)
		if r.Limit == 0 {
			r.Limit = 20
		}
	case *shortsv1alpha1.GetMarketNewsRequest:
		if r.Limit == 0 {
			r.Limit = 50
		}
	case *shortsv1alpha1.GetDirectorTradesRequest:
		r.StockCode = NormalizeStockCode(r.StockCode)
		if r.Limit == 0 {
			r.Limit = 20
		}
	case *shortsv1alpha1.GetDividendHistoryRequest:
		r.StockCode = NormalizeStockCode(r.StockCode)
		if r.Years == 0 {
			r.Years = 5
		}
	case *shortsv1alpha1.GetPeerComparisonRequest:
		r.StockCode = NormalizeStockCode(r.StockCode)
		if r.Limit == 0 {
			r.Limit = 5
		}
	}
}
