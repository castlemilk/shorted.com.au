package shorts

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
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

// validateStockCode validates an ASX code, naming `field` in any error it
// returns.
//
// The field name is a parameter rather than a fixed string because these
// requests do not agree on it: GetStock and GetStockData carry `product_code`,
// while GetStockNews, GetDirectorTrades, GetDividendHistory and
// GetPeerComparison carry `stock_code`. All of them once routed through a
// single validator hardcoded to say "product code", so an integrator calling
// GetStockNews was told to set a field the request does not have — they tried
// productCode, product_code, code, symbol and ticker, got the same 400 every
// time, and concluded the endpoint was auth-gated (issue #539). An error that
// names the wrong field is worse than no error, because it is actionable and
// wrong.
func validateStockCode(code, field string) error {
	if code == "" {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("%s is required", field),
		)
	}

	normalized := strings.ToUpper(strings.TrimSpace(code))
	if !stockCodeRegex.MatchString(normalized) {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("%s must be 3-4 alphanumeric characters (e.g., CBA, ZIP, AX1)", field),
		)
	}

	return nil
}

// ValidateGetStockRequest validates the GetStock request parameters
func ValidateGetStockRequest(req *shortsv1alpha1.GetStockRequest) error {
	return validateStockCode(req.ProductCode, "product_code")
}

// ValidateGetStockDataRequest validates the GetStockData request parameters
func ValidateGetStockDataRequest(req *shortsv1alpha1.GetStockDataRequest) error {
	if err := validateStockCode(req.ProductCode, "product_code"); err != nil {
		return err
	}

	// Validate period (normalize to uppercase)
	if req.Period != "" && !validPeriods[strings.ToUpper(req.Period)] {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("invalid period format. Valid periods: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y, MAX"),
		)
	}

	if err := validateWindowOptions(req.From, req.To, req.MaxPoints); err != nil {
		return err
	}
	return validateDateOption(req.AsOf, "as_of")
}

// ValidateGetStockDetailsRequest validates the GetStockDetails request parameters
func ValidateGetStockDetailsRequest(req *shortsv1alpha1.GetStockDetailsRequest) error {
	return validateStockCode(req.ProductCode, "product_code")
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
	if err := validateStockCode(req.StockCode, "stock_code"); err != nil {
		return err
	}
	if req.Limit < 0 || req.Limit > 100 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and 100"))
	}
	return nil
}

// ValidateGetDirectorTradesRequest validates the GetDirectorTrades request parameters
func ValidateGetDirectorTradesRequest(req *shortsv1alpha1.GetDirectorTradesRequest) error {
	if err := validateStockCode(req.StockCode, "stock_code"); err != nil {
		return err
	}
	if req.Limit < 0 || req.Limit > 200 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and 200"))
	}
	return nil
}

// ValidateGetDividendHistoryRequest validates the GetDividendHistory request parameters
func ValidateGetDividendHistoryRequest(req *shortsv1alpha1.GetDividendHistoryRequest) error {
	if err := validateStockCode(req.StockCode, "stock_code"); err != nil {
		return err
	}
	if req.Years < 0 || req.Years > 20 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("years must be between 0 and 20"))
	}
	return nil
}

// ValidateGetPeerComparisonRequest validates the GetPeerComparison request parameters
func ValidateGetPeerComparisonRequest(req *shortsv1alpha1.GetPeerComparisonRequest) error {
	if err := validateStockCode(req.StockCode, "stock_code"); err != nil {
		return err
	}
	if req.Limit < 0 || req.Limit > 20 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and 20"))
	}
	return nil
}

// ValidateScreenStocksRequest validates the ScreenStocks request parameters.
// The cap covers the full listed universe (~3.3k rows in mv_screener_data):
// the /directory pages fetch everything in ONE request because paged bursts
// from Vercel SSR trip the Cloudflare edge rate limit. The query is a ~3ms
// MV scan, so a full-universe page is cheap.
func ValidateScreenStocksRequest(req *shortsv1alpha1.ScreenStocksRequest) error {
	if req.Limit < 0 || req.Limit > 4000 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and 4000"))
	}
	if req.Offset < 0 {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("offset must be non-negative"))
	}
	if req.Filters != nil && len(req.Filters.ProductCodes) > shortsstore.MaxScreenerProductCodes {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("product_codes must contain at most %d codes", shortsstore.MaxScreenerProductCodes))
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
	case *shortsv1alpha1.ScreenStocksRequest:
		if r.Limit == 0 {
			r.Limit = 50
		}
		// Normalize here, not just in the store: the cache key is built from
		// the filters, so "bhp" and "BHP" must collapse to one entry.
		if r.Filters != nil && len(r.Filters.ProductCodes) > 0 {
			r.Filters.ProductCodes = shortsstore.NormalizeScreenerProductCodes(r.Filters.ProductCodes)
		}
	}
}

// ValidateGetStockPricesRequest validates the GetStockPrices request parameters.
func ValidateGetStockPricesRequest(req *shortsv1alpha1.GetStockPricesRequest) error {
	if err := validateStockCode(req.ProductCode, "product_code"); err != nil {
		return err
	}
	if req.Period != "" && !validPeriods[strings.ToUpper(req.Period)] {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("invalid period format. Valid periods: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y, MAX"),
		)
	}
	return validateWindowOptions(req.From, req.To, req.MaxPoints)
}

// validateDateOption accepts an empty value or a real YYYY-MM-DD date, naming
// the field in the error so a caller is told which of from/to is wrong.
//
// Parsed rather than shape-checked: "2026-02-31" and "2026-99-01" both have
// the right shape, and a date that only Postgres rejects surfaces as a query
// failure the handler maps to NotFound — telling the caller the STOCK does not
// exist when the truth is that their date does not.
func validateDateOption(value, field string) error {
	if value == "" {
		return nil
	}
	if _, err := time.Parse("2006-01-02", value); err != nil {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("%s must be a valid date in YYYY-MM-DD format", field),
		)
	}
	return nil
}

// validateWindowOptions checks the from/to/max_points trio shared by
// GetStockData and GetStockPrices.
//
// Shared because they are the same options with the same meaning, and when
// they were validated separately only the endpoint written second got it
// right: GetStockData silently ignored a negative max_points and answered a
// transposed window with an empty series, which looks like a real result.
func validateWindowOptions(from, to string, maxPoints int32) error {
	if err := validateDateOption(from, "from"); err != nil {
		return err
	}
	if err := validateDateOption(to, "to"); err != nil {
		return err
	}
	if from != "" && to != "" {
		// Both already parsed above, so these cannot fail.
		fromDate, _ := time.Parse("2006-01-02", from)
		toDate, _ := time.Parse("2006-01-02", to)
		if toDate.Before(fromDate) {
			return connect.NewError(
				connect.CodeInvalidArgument,
				fmt.Errorf("to (%s) must not be before from (%s)", to, from),
			)
		}
	}
	if maxPoints < 0 {
		return connect.NewError(
			connect.CodeInvalidArgument,
			fmt.Errorf("max_points must be non-negative; 0 means no cap"),
		)
	}
	return nil
}

// ValidateGetIndexSeriesRequest validates the GetIndexSeries request.
func ValidateGetIndexSeriesRequest(req *shortsv1alpha1.GetIndexSeriesRequest) error {
	if strings.TrimSpace(req.IndexCode) == "" {
		return connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("index_code is required — call ListIndices for the available codes"))
	}
	if req.Period != "" && !validPeriods[strings.ToUpper(req.Period)] {
		return connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("invalid period format. Valid periods: 1D, 1W, 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y, MAX"))
	}
	return validateWindowOptions(req.From, req.To, req.MaxPoints)
}
