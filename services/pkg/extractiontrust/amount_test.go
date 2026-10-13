package extractiontrust

import (
	"encoding/json"
	"math/big"
	"strconv"
	"testing"
)

// The entries are prod dividend entries (financial_report_extractions,
// 2026-10-12), quote and attributes as stored.
func TestPerSecurityAmount(t *testing.T) {
	cents := func(quote, value string) map[string]any {
		return map[string]any{"source_text": quote, "unit": "cents", "value_cents": value}
	}
	dollars := func(quote, value string) map[string]any {
		return map[string]any{"source_text": quote, "unit": "dollars", "value_dollars": value}
	}
	for _, tc := range []struct {
		name  string
		entry map[string]any
		want  string // "" = unread
	}{
		{"GMG 4E, cents", cents("Final dividend and distribution proposed per GMG security (cents)\n15.0", "15"), "3/20"},
		{"DXI 4E, three decimals of a cent", cents("Distribution per security for the period ending:\n30 September\n\n4.150", "4.150"), "83/2000"},
		{"SCG 4D", cents("Dividend/distributions for the period ended 30 June 2026\n9.215", "9.215"), "1843/20000"},
		{"a cent figure needs no per-security wording", cents("Final dividend/distribution\n16.2 ¢", "16.2"), "81/500"},
		{"a nil cent figure is read, as zero", cents("Final distribution\nNil", "0"), "0"},
		{"PDN: the string null", cents("Dividends", "null"), ""},
		{"BCN: dollars per share", dollars("A fully franked dividend of $0.04 per share", "0.04"), "1/25"},
		{"LRT: dollars per unit after a slash", dollars("A $0.1432/unit distribution to unitholders was announced", "0.1432"), "179/1250"},
		{"SKT: per Quoted Equity Security across table cells", dollars("Final Dividend\nAmount per Quoted Equity\nSecurity\n$0.17000000", "0.17"), "17/100"},
		{"GQG: per CHESS Depositary Interest", dollars("declared a dividend of $0.0362 per CHESS Depositary\nInterest", "0.0362"), "181/5000"},
		{"N1H: an aggregate in dollars", dollars("Dividends paid, recommended or declared during the financial year are $264,167", "264167"), ""},
		{"KSL: an aggregate in kina", dollars("Dividends declared for the half year amounted to PGK 41,812,470", "41812470"), ""},
		{"GTN: dollars with no per-security wording", dollars("Final dividend | $0.05", "0.05"), ""},
		{"no unit (a legacy entry)", map[string]any{"source_text": "Final dividend 15 cents per share", "value_cents": "15"}, ""},
		{"unit cents without value_cents", map[string]any{"source_text": "Final dividend $0.15 per share", "unit": "cents", "value_dollars": "0.15"}, ""},
		{"an unknown unit", map[string]any{"source_text": "Final dividend 15 cents per share", "unit": "percent", "value_cents": "15"}, ""},
		{"a thousands separator", cents("Distribution per unit 1,234.5", "1,234.5"), ""},
		{"a sign", cents("Distribution per unit -1.5", "-1.5"), ""},
		{"an exponent", cents("Distribution per unit", "1e1"), ""},
		{"a number decoded by encoding/json", map[string]any{"source_text": "Final distribution 4.8", "unit": "cents", "value_cents": 4.8}, "6/125"},
		{"a json.Number", map[string]any{"source_text": "Final distribution 4.8", "unit": "cents", "value_cents": json.Number("4.8")}, "6/125"},
	} {
		got, ok := PerSecurityAmount(tc.entry)
		switch {
		case tc.want == "" && ok:
			t.Errorf("%s: read %s, want unread", tc.name, got.RatString())
		case tc.want != "" && !ok:
			t.Errorf("%s: unread, want %s", tc.name, tc.want)
		case tc.want != "" && got.RatString() != tc.want:
			t.Errorf("%s: %s, want %s", tc.name, got.RatString(), tc.want)
		}
	}
}

// A notice states its amount in dollars ("AUD 0.01300000", parsed to a
// float64), a results document in cents ("1.3"). In float64 the two are not
// equal for about a quarter of one- and two-decimal cent values; as exact
// decimals they are.
func TestAmountsCompareExactly(t *testing.T) {
	for _, tc := range []struct {
		cents  string
		notice float64
	}{
		{"1.3", 0.013},     // MXT, September 2026
		{"15", 0.15},       // GMG
		{"4.15", 0.0415},   // DXI
		{"9.215", 0.09215}, // SCG
		{"0.125", 0.00125}, // CCG
		{"16.2", 0.162},    // SGP
		{"1.23", 0.0123},   // LF1
		{"9.83", 0.0983},   // BWP
		{"4.7", 0.047},     // MGR
		{"2.5", 0.025},     // GDI
		{"0.75", 0.0075},   // TOT
		{"4.25", 0.0425},   // ABG
		{"8.5", 0.085},     // ABG's full year
		{"14.32", 0.1432},  // LRT
		{"3.875", 0.03875}, // a three-decimal cent figure
		{"19.41", 0.1941},  // BWP's total
		{"0.07", 0.0007},   // a fraction of a cent
		{"100", 1.0},       // a dollar
		{"137.5", 1.375},   // a figure over a dollar
		{"7.0", 0.07},      // a trailing zero
		{"0.7", 0.007},     // float64: 0.7/100 is 0.006999999999999999
		{"1.1", 0.011},     // float64: 1.1/100 is 0.011000000000000001
		{"2.8", 0.028},     // float64: 2.8/100 is 0.027999999999999997
		{"3.7", 0.037},     // float64: 3.7/100 is 0.037000000000000005
	} {
		amount, ok := PerSecurityAmount(map[string]any{"unit": "cents", "value_cents": tc.cents})
		if !ok {
			t.Fatalf("%sc unread", tc.cents)
		}
		notice, ok := ParseAmount(strconv.FormatFloat(tc.notice, 'f', -1, 64))
		if !ok {
			t.Fatalf("%v: unread", tc.notice)
		}
		if amount.Cmp(notice) != 0 {
			t.Errorf("%sc = %s, notice %v = %s: want equal", tc.cents, amount.RatString(), tc.notice, notice.RatString())
		}
	}
	// The reason for the decimals: the float comparison fails on MXT's figure.
	if c, _ := strconv.ParseFloat("1.3", 64); c/100 == 0.013 {
		t.Error("1.3 / 100 == 0.013 in float64; this test no longer shows why amounts are compared as decimals")
	}
	// Different amounts stay different, however close.
	a, _ := ParseAmount("0.15")
	b, _ := ParseAmount("0.1500001")
	if a.Cmp(b) == 0 {
		t.Error("0.15 == 0.1500001")
	}
	if a.Cmp(new(big.Rat).SetFrac64(15, 100)) != 0 {
		t.Error("0.15 != 15/100")
	}
}

func TestParseAmount(t *testing.T) {
	for _, s := range []string{"", " ", "null", "N/A", "1,000", "-0.15", "+0.15", "1e-2", ".5", "5.", "0x10", "Inf", "NaN", "$0.15", "0.15 cents"} {
		if v, ok := ParseAmount(s); ok {
			t.Errorf("ParseAmount(%q) = %s, want unread", s, v.RatString())
		}
	}
	for s, want := range map[string]string{"0": "0", "15": "15", " 0.150 ": "3/20", "00.5": "1/2"} {
		if v, ok := ParseAmount(s); !ok || v.RatString() != want {
			t.Errorf("ParseAmount(%q) = %v, %v; want %s", s, v, ok, want)
		}
	}
}
