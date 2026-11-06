package keymetrics

import (
	"encoding/json"
	"os"
	"sort"
	"testing"
)

// pythonKeys is the key set the Python script wrote, in its order: the contract
// the API reads and the stored rows already carry.
var pythonKeys = []string{
	"stock_code", "market_cap", "pe_ratio", "forward_pe", "eps", "dividend_yield",
	"book_value", "price_to_book", "revenue", "profit_margin", "debt_to_equity",
	"return_on_equity", "fifty_two_week_high", "fifty_two_week_low", "avg_volume", "beta",
}

func loadFixture(t *testing.T, name string) json.RawMessage {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return b
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestBuildMatchesThePythonContractOnRecordedBHP(t *testing.T) {
	got, err := Build("bhp", loadFixture(t, "quote_bhp.json"))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}

	want := map[string]any{
		"stock_code":          "BHP",
		"market_cap":          290439987200.0,
		"pe_ratio":            18.858086,
		"forward_pe":          15.591521,
		"eps":                 3.03,
		"dividend_yield":      4.35, // Yahoo's 0.0435 fraction, as the percent the readers expect
		"book_value":          14.261122,
		"price_to_book":       4.006697,
		"revenue":             58759999488.0,
		"profit_margin":       0.16734,
		"debt_to_equity":      50.473,
		"return_on_equity":    0.24002,
		"fifty_two_week_high": 68.77,
		"fifty_two_week_low":  40.175,
		"avg_volume":          7764345.0,
		"beta":                0.885,
	}
	if len(got) != len(pythonKeys) {
		t.Fatalf("keys = %d, want %d: %v", len(got), len(pythonKeys), keysOf(got))
	}
	for _, k := range pythonKeys {
		w, ok := want[k]
		if !ok {
			t.Fatalf("no expectation for %s", k)
		}
		if got[k] != w {
			t.Errorf("%s = %v (%T), want %v", k, got[k], got[k], w)
		}
	}
}

func TestBuildKeysAreTheSixteenPythonKeysInAnyOrder(t *testing.T) {
	got, err := Build("EML", loadFixture(t, "quote_eml.json"))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	want := append([]string(nil), pythonKeys...)
	sort.Strings(want)
	if gk := keysOf(got); !equalStrings(gk, want) {
		t.Fatalf("keys = %v\nwant    %v", gk, want)
	}
}

func TestBuildNullsForMissingAndUnusableValues(t *testing.T) {
	// EML's trailingPE is Yahoo's JSON null: pe_ratio is nil, not 0 and not
	// absent, so the stored object keeps the key the API reads.
	got, err := Build("EML", loadFixture(t, "quote_eml.json"))
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if v, ok := got["pe_ratio"]; !ok || v != nil {
		t.Fatalf("pe_ratio = %v (present %v), want a present nil", v, ok)
	}
	if got["market_cap"] == nil {
		t.Fatalf("market_cap is nil for EML, whose price module carries it")
	}

	result := json.RawMessage(`{
		"price": {"regularMarketPrice": {"raw": 10.5, "fmt": "10.50"}, "marketCap": {"fmt": "1.2B"}},
		"summaryDetail": {
			"trailingPE": "N/A",
			"forwardPE": {"raw": "12.5"},
			"dividendYield": {"raw": 1e400},
			"beta": {"raw": null},
			"averageVolume": 1200,
			"fiftyTwoWeekHigh": {"raw": -3.25}
		},
		"defaultKeyStatistics": {"trailingEps": {"raw": 0.5, "fmt": "0.50"}},
		"financialData": {"debtToEquity": {"raw": true}}
	}`)
	got, err = Build("abc", result)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	nils := []string{"market_cap", "pe_ratio", "forward_pe", "dividend_yield", "beta", "debt_to_equity"}
	for _, k := range nils {
		if got[k] != nil {
			t.Errorf("%s = %v, want nil (string, non-finite, null, fmt-only or bool)", k, got[k])
		}
	}
	if got["eps"] != 0.5 {
		t.Errorf("eps = %v, want 0.5 from the {raw} wrapper", got["eps"])
	}
	if got["avg_volume"] != 1200.0 {
		t.Errorf("avg_volume = %v, want the bare number 1200", got["avg_volume"])
	}
	if got["fifty_two_week_high"] != -3.25 {
		t.Errorf("fifty_two_week_high = %v, want -3.25 (negatives are finite)", got["fifty_two_week_high"])
	}
	if got["stock_code"] != "ABC" {
		t.Errorf("stock_code = %v, want the upper-cased code", got["stock_code"])
	}
}

func TestBuildFallsBackToTheOtherModules(t *testing.T) {
	// beta is read from summaryDetail first; with it absent there, the other
	// modules are searched in contract order, as yfinance's merged info was.
	result := json.RawMessage(`{
		"price": {"regularMarketPrice": {"raw": 1}},
		"financialData": {"beta": {"raw": 0.7}}
	}`)
	got, err := Build("XYZ", result)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if got["beta"] != 0.7 {
		t.Fatalf("beta = %v, want 0.7 from financialData", got["beta"])
	}
}

func TestBuildNoDataWhenThePriceIsMissing(t *testing.T) {
	cases := map[string]json.RawMessage{
		"no price module":  json.RawMessage(`{"summaryDetail": {"marketCap": {"raw": 5}}}`),
		"price is null":    json.RawMessage(`{"price": null}`),
		"no regular price": json.RawMessage(`{"price": {"marketCap": {"raw": 5}}}`),
		"string price":     json.RawMessage(`{"price": {"regularMarketPrice": {"raw": "57.14"}}}`),
		"price is a null":  json.RawMessage(`{"price": {"regularMarketPrice": {"raw": null}}}`),
		"empty result":     json.RawMessage(`{}`),
	}
	for name, result := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Build("BHP", result); err != ErrNoData {
				t.Fatalf("err = %v, want ErrNoData", err)
			}
		})
	}
}

func TestBuildNoDataWhenNothingIsMeasured(t *testing.T) {
	// A price with no other field is not a record worth overwriting good data:
	// the all-null object would replace the row's measurements with nothing.
	_, err := Build("BHP", json.RawMessage(`{"price": {"regularMarketPrice": {"raw": 57.1}}}`))
	if err != ErrNoData {
		t.Fatalf("err = %v, want ErrNoData for a price with no other field", err)
	}
}

func TestRawNumberRejectsWhatIsNotAMeasurement(t *testing.T) {
	for _, s := range []string{`"1.5"`, `true`, `[1]`, `null`, `{}`, `{"fmt":"1"}`, `{"raw":{"raw":1}}`, `1e400`, `-1e400`, ``} {
		if v, ok := rawNumber(json.RawMessage(s)); ok {
			t.Errorf("rawNumber(%s) = %v, want not a number", s, v)
		}
	}
	for s, want := range map[string]float64{`0`: 0, `-2.5`: -2.5, `{"raw":3}`: 3, ` 4 `: 4} {
		v, ok := rawNumber(json.RawMessage(s))
		if !ok || v != want {
			t.Errorf("rawNumber(%s) = %v, %v; want %v", s, v, ok, want)
		}
	}
	if _, ok := rawNumber(json.RawMessage(`{"raw":NaN}`)); ok {
		t.Errorf("NaN is not valid JSON and must not be a number")
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestDividendYieldIsAPercentAndFallsBackToYieldForFunds(t *testing.T) {
	// A stock carries summaryDetail.dividendYield (a fraction); a fund or trust
	// carries only summaryDetail.yield. Both are stored as a percent, rounded to
	// two decimals, the unit v7 reported and the readers print.
	stockResult := json.RawMessage(`{
		"price": {"regularMarketPrice": {"raw": 100}},
		"summaryDetail": {"dividendYield": {"raw": 0.0304, "fmt": "3.04%"}, "yield": {"raw": 0.9}}
	}`)
	got, err := Build("CBA", stockResult)
	if err != nil {
		t.Fatal(err)
	}
	if got["dividend_yield"] != 3.04 {
		t.Errorf("stock dividend_yield = %v, want 3.04 (dividendYield wins over yield)", got["dividend_yield"])
	}

	fundResult := json.RawMessage(`{
		"price": {"regularMarketPrice": {"raw": 100}},
		"summaryDetail": {"yield": {"raw": 0.0295, "fmt": "2.95%"}}
	}`)
	got, err = Build("VAS", fundResult)
	if err != nil {
		t.Fatal(err)
	}
	if got["dividend_yield"] != 2.95 {
		t.Errorf("fund dividend_yield = %v, want 2.95 from summaryDetail.yield", got["dividend_yield"])
	}

	noYield := json.RawMessage(`{"price": {"regularMarketPrice": {"raw": 1}}, "summaryDetail": {"beta": {"raw": 1}}}`)
	got, err = Build("NOY", noYield)
	if err != nil {
		t.Fatal(err)
	}
	if got["dividend_yield"] != nil {
		t.Errorf("dividend_yield = %v, want null when neither field is present", got["dividend_yield"])
	}
}

func TestPercentOfRoundsWithoutFloatNoise(t *testing.T) {
	cases := map[float64]float64{0.0435: 4.35, 0.0304: 3.04, 0.0007: 0.07, 0: 0, 0.12345: 12.35, -0.01: -1}
	for in, want := range cases {
		if got := percentOf(in); got != want {
			t.Errorf("percentOf(%v) = %v, want %v", in, got, want)
		}
	}
}
