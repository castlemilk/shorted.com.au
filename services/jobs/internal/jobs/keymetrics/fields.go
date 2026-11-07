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
	// fallback is a second field name in the same module, read when yahooKey is
	// absent. ETFs and trusts carry their yield as summaryDetail.yield only.
	fallback string
	// percent is set when Yahoo's raw value is a fraction but the stored key is
	// a percent (dividend_yield): the value is multiplied by 100 and rounded to
	// two decimals, which is what Yahoo's v7 quote, and so yfinance, reported.
	percent bool
}

// fields is the key_metrics contract. Its keys and units are the ones the
// Python script wrote (services/shorts/scripts/fetch_key_metrics.py, now
// retired): market_cap in dollars, dividend_yield as a PERCENT (4.35 means
// 4.35%, the unit the screener, the peers card, MCP and the weekly report read),
// profit_margin and return_on_equity as fractions, debt_to_equity as Yahoo
// states it.
var fields = []field{
	{key: "market_cap", module: "price", yahooKey: "marketCap"},
	{key: "pe_ratio", module: "summaryDetail", yahooKey: "trailingPE"},
	{key: "forward_pe", module: "summaryDetail", yahooKey: "forwardPE"},
	{key: "eps", module: "defaultKeyStatistics", yahooKey: "trailingEps"},
	{key: "dividend_yield", module: "summaryDetail", yahooKey: "dividendYield", fallback: "yield", percent: true},
	{key: "book_value", module: "defaultKeyStatistics", yahooKey: "bookValue"},
	{key: "price_to_book", module: "defaultKeyStatistics", yahooKey: "priceToBook"},
	{key: "revenue", module: "financialData", yahooKey: "totalRevenue"},
	{key: "profit_margin", module: "defaultKeyStatistics", yahooKey: "profitMargins"},
	{key: "debt_to_equity", module: "financialData", yahooKey: "debtToEquity"},
	{key: "return_on_equity", module: "financialData", yahooKey: "returnOnEquity"},
	{key: "fifty_two_week_high", module: "summaryDetail", yahooKey: "fiftyTwoWeekHigh"},
	{key: "fifty_two_week_low", module: "summaryDetail", yahooKey: "fiftyTwoWeekLow"},
	{key: "avg_volume", module: "summaryDetail", yahooKey: "averageVolume"},
	{key: "beta", module: "summaryDetail", yahooKey: "beta"},
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
		if !ok && f.fallback != "" {
			v, ok = numericField(mods, f.module, f.fallback)
		}
		if ok && f.percent {
			v = percentOf(v)
		}
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

// percentOf turns a fraction into a percent, rounded to two decimals so the
// stored value carries no float noise (0.0435 becomes 4.35, not 4.3500000000000005).
func percentOf(fraction float64) float64 {
	return math.Round(fraction*100*100) / 100
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
