package keymetrics

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
)

// modules are the quoteSummary modules one fetch asks for. They carry every
// field below; the old Python path read the same four through yfinance's info.
var modules = []string{"price", "summaryDetail", "defaultKeyStatistics", "financialData"}

// field is one stored key: the Yahoo field that fills it and the module that
// carries it. A field missing from its module is looked up in the others, which
// is what yfinance's merged info did.
type field struct {
	key      string // the key in company-metadata.key_metrics
	module   string // the quoteSummary module that carries it
	yahooKey string // the field name inside that module
}

// fields is the key_metrics contract. Its keys and units are the ones the
// Python script wrote (services/shorts/scripts/fetch_key_metrics.py, now
// retired): market_cap in dollars, dividend_yield and profit_margin and
// return_on_equity as fractions, debt_to_equity as Yahoo states it.
var fields = []field{
	{"market_cap", "price", "marketCap"},
	{"pe_ratio", "summaryDetail", "trailingPE"},
	{"forward_pe", "summaryDetail", "forwardPE"},
	{"eps", "defaultKeyStatistics", "trailingEps"},
	{"dividend_yield", "summaryDetail", "dividendYield"},
	{"book_value", "defaultKeyStatistics", "bookValue"},
	{"price_to_book", "defaultKeyStatistics", "priceToBook"},
	{"revenue", "financialData", "totalRevenue"},
	{"profit_margin", "defaultKeyStatistics", "profitMargins"},
	{"debt_to_equity", "financialData", "debtToEquity"},
	{"return_on_equity", "financialData", "returnOnEquity"},
	{"fifty_two_week_high", "summaryDetail", "fiftyTwoWeekHigh"},
	{"fifty_two_week_low", "summaryDetail", "fiftyTwoWeekLow"},
	{"avg_volume", "summaryDetail", "averageVolume"},
	{"beta", "summaryDetail", "beta"},
}

// ErrNoData is returned by Build when Yahoo's answer carries no quote: no
// regularMarketPrice (the Python script's test), or not one field measured.
// Either way the stored row is left alone.
var ErrNoData = errors.New("keymetrics: no data from Yahoo")

// Build turns one quoteSummary result (the object keyed by module name) into
// the key_metrics map, exactly the keys and units of the Python script's
// output: stock_code first, then the fields in contract order. A missing,
// string or non-finite value is nil, which the JSON carries as null.
func Build(code string, result json.RawMessage) (map[string]any, error) {
	mods, err := decodeModules(result)
	if err != nil {
		return nil, err
	}
	if _, ok := numericField(mods, "price", "regularMarketPrice"); !ok {
		return nil, ErrNoData
	}

	out := make(map[string]any, len(fields)+1)
	out["stock_code"] = strings.ToUpper(strings.TrimSpace(code))
	measured := 0
	for _, f := range fields {
		v, ok := numericField(mods, f.module, f.yahooKey)
		if ok {
			measured++
			out[f.key] = v
		} else {
			out[f.key] = nil
		}
	}
	if measured == 0 {
		return nil, ErrNoData
	}
	return out, nil
}

// decodeModules splits the result into its modules. A module that is absent or
// null is an empty map.
func decodeModules(result json.RawMessage) (map[string]map[string]json.RawMessage, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(result, &top); err != nil {
		return nil, err
	}
	mods := make(map[string]map[string]json.RawMessage, len(top))
	for name, raw := range top {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			// A module that is not an object (null is an object's absence) is
			// simply no data for its fields.
			continue
		}
		mods[name] = fields
	}
	return mods, nil
}

// numericField reads field name from module first, then from the other modules
// in contract order. The first finite number wins.
func numericField(mods map[string]map[string]json.RawMessage, module, name string) (float64, bool) {
	if v, ok := numericFrom(mods[module], name); ok {
		return v, true
	}
	for _, m := range modules {
		if m == module {
			continue
		}
		if v, ok := numericFrom(mods[m], name); ok {
			return v, true
		}
	}
	return 0, false
}

func numericFrom(module map[string]json.RawMessage, name string) (float64, bool) {
	raw, ok := module[name]
	if !ok {
		return 0, false
	}
	return rawNumber(raw)
}

// rawNumber reads a quoteSummary value: the {raw, fmt} wrapper's raw number, or
// a bare number. A string, a bool, an array, null, or a non-finite number is
// not a measurement.
func rawNumber(raw json.RawMessage) (float64, bool) {
	s := bytes.TrimSpace(raw)
	if len(s) == 0 {
		return 0, false
	}
	switch s[0] {
	case '{':
		var wrapped struct {
			Raw json.RawMessage `json:"raw"`
		}
		if err := json.Unmarshal(s, &wrapped); err != nil || len(wrapped.Raw) == 0 {
			return 0, false
		}
		if bytes.TrimSpace(wrapped.Raw)[0] == '{' {
			return 0, false // a raw inside a raw is not a Yahoo shape
		}
		return rawNumber(wrapped.Raw)
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		f, err := strconv.ParseFloat(string(s), 64)
		if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}
