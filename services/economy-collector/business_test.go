package main

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

// businessFixture mirrors the pinned ABS,QBIS(1.0.0) SDMX-CSV shape from
// the 2026-07-23 probe. Dimension order is
// MEASURE.PRICE_ADJUSTMENT.INDUSTRY.SCOPE.TSEST.REGION.FREQ.
func businessFixture() [][]string {
	header := []string{"DATAFLOW", "MEASURE: Measure", "PRICE_ADJUSTMENT: Price Adjustment", "INDUSTRY: Industry", "SCOPE: Business Scope", "TSEST: Adjustment Type", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "UNIT_MULT: Unit of Multiplier", "OBS_STATUS: Observation Status", "OBS_COMMENT: Observation Comment"}
	divisions := [][3]string{
		{"B", "Mining", "48173"},
		{"C", "Manufacturing", "12505"},
		{"D", "Electricity, Gas, Water and Waste Services", "6311"},
		{"E", "Construction", "9744"},
		{"F", "Wholesale Trade", "11730"},
		{"G", "Retail Trade", "8453"},
		{"H", "Accommodation and Food Services", "3069"},
		{"I", "Transport, Postal and Warehousing", "10616"},
		{"J", "Information Media and Telecommunications", "5426"},
		{"K", "Financial and Insurance Services", "2042"},
		{"L", "Rental, Hiring and Real Estate Services", "12858"},
		{"M", "Professional, Scientific and Technical Services", "9500"},
		{"N", "Administrative and Support Services", "2182"},
		{"R", "Arts and Recreation Services", "1670"},
		{"S", "Other Services", "3208"},
	}
	rows := [][]string{header}
	for _, division := range divisions {
		rows = append(rows, []string{"ABS:QBIS(1.0.0)", "M7: Gross Operating Profits", "CUR: Current Price", division[0] + ": " + division[1], "TOT: TOTAL", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2026-Q1", division[2], "AUD: Australian Dollars", "6: Millions", "", ""})
	}
	for _, region := range [][3]string{
		{"1", "New South Wales", "315889"}, {"2", "Victoria", "231189"},
		{"3", "Queensland", "207366"}, {"4", "South Australia", "62494"},
		{"5", "Western Australia", "169590"}, {"6", "Tasmania", "16159"},
		{"7", "Northern Territory", "11902"}, {"8", "Australian Capital Territory", "12768"},
	} {
		rows = append(rows, []string{"ABS:QBIS(1.0.0)", "M1: Sales", "CUR: Current Price", "TOT: All Industries", "TOT: TOTAL", "20: Seasonally Adjusted", region[0] + ": " + region[1], "Q: Quarterly", "2026-Q1", region[2], "AUD: Australian Dollars", "6: Millions", "", ""})
	}
	for _, region := range [][3]string{
		{"1", "New South Wales", "67073"}, {"2", "Victoria", "52017"},
		{"3", "Queensland", "40872"}, {"4", "South Australia", "11659"},
		{"5", "Western Australia", "29453"}, {"6", "Tasmania", "3251"},
		{"7", "Northern Territory", "2221"}, {"8", "Australian Capital Territory", "3296"},
		{"AUS", "Australia", "209628"},
	} {
		rows = append(rows, []string{"ABS:QBIS(1.0.0)", "M5: Wages", "CUR: Current Price", "TOT: All Industries", "TOT: TOTAL", "20: Seasonally Adjusted", region[0] + ": " + region[1], "Q: Quarterly", "2026-Q1", region[2], "AUD: Australian Dollars", "6: Millions", "", ""})
	}
	return append(rows,
		// This is the obsolete state x industry family. Even with a value it
		// must never be emitted; production fetch keys must not request it.
		[]string{"ABS:QBIS(1.0.0)", "M1: Sales", "CUR: Current Price", "B: Mining", "TOT: TOTAL", "20: Seasonally Adjusted", "1: New South Wales", "Q: Quarterly", "2022-Q3", "280000", "AUD: Australian Dollars", "6: Millions", "", ""},
		// An upstream ANZSIC vocabulary addition must be skipped and warned,
		// never converted into a label-derived series key.
		[]string{"ABS:QBIS(1.0.0)", "M7: Gross Operating Profits", "CUR: Current Price", "X: Future Division", "TOT: TOTAL", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2026-Q1", "999", "AUD: Australian Dollars", "6: Millions", "", ""},
		[]string{"ABS:QBIS(1.0.0)", "M7: Gross Operating Profits", "CUR: Current Price", "B: Mining", "TOT: TOTAL", "10: Original", "AUS: Australia", "Q: Quarterly", "2026-Q1", "999", "AUD: Australian Dollars", "6: Millions", "", ""},
		[]string{"ABS:QBIS(1.0.0)", "M3: Inventories", "CUR: Current Price", "TOT: All Industries", "TOT: TOTAL", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2026-Q1", "999", "AUD: Australian Dollars", "6: Millions", "", ""},
		[]string{"ABS:QBIS(1.0.0)", "M5: Wages", "CUR: Current Price", "TOT: All Industries", "TOT: TOTAL", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2025-Q4", "", "AUD: Australian Dollars", "6: Millions", "q: not available", ""},
	)
}

func TestBusinessPinnedSDMXQueriesConstrainCurrentFamilies(t *testing.T) {
	if businessFlow != "QBIS" || businessVersion != "1.0.0" || businessStartPeriod != "2001-Q3" {
		t.Fatalf("unexpected business flow metadata: flow=%q version=%q start=%q", businessFlow, businessVersion, businessStartPeriod)
	}
	if businessGOPKey != "M7.CUR.B+C+D+E+F+G+H+I+J+K+L+M+N+R+S.TOT.20.AUS.Q" {
		t.Errorf("GOP key does not constrain the current national ANZSIC family: %q", businessGOPKey)
	}
	if businessSalesKey != "M1.CUR.TOT.TOT.20.1+2+3+4+5+6+7+8+AUS.Q" {
		t.Errorf("sales key does not constrain all-industry regional totals: %q", businessSalesKey)
	}
	if businessWagesKey != "M5.CUR.TOT.TOT.20.1+2+3+4+5+6+7+8+AUS.Q" {
		t.Errorf("wages key does not constrain all-industry regional totals: %q", businessWagesKey)
	}
	for name, key := range map[string]string{"gop": businessGOPKey, "sales": businessSalesKey, "wages": businessWagesKey} {
		if strings.Contains(key, "all") {
			t.Errorf("%s query uses broad all key: %q", name, key)
		}
	}
}

func TestANZSICDivisionSlugsMatchCurrentQBISProbe(t *testing.T) {
	want := map[string]string{
		"B": "mining", "C": "manufacturing", "D": "electricity-gas-water-waste",
		"E": "construction", "F": "wholesale-trade", "G": "retail-trade",
		"H": "accommodation-food-services", "I": "transport-postal-warehousing",
		"J": "information-media-telecommunications", "K": "financial-insurance-services",
		"L": "rental-hiring-real-estate", "M": "professional-scientific-technical",
		"N": "administrative-support", "R": "arts-recreation", "S": "other-services",
	}
	if len(anzsicDivisionSlugs) != len(want) {
		t.Fatalf("anzsicDivisionSlugs has %d entries, want the %d current probe divisions", len(anzsicDivisionSlugs), len(want))
	}
	for division, slug := range want {
		if got := anzsicDivisionSlugs[division]; got != slug {
			t.Errorf("anzsicDivisionSlugs[%q]=%q, want %q", division, got, slug)
		}
	}
	for division := range anzsicDivisionSlugs {
		if _, ok := want[division]; !ok {
			t.Errorf("anzsicDivisionSlugs contains division %q absent from current QBIS GOP probe", division)
		}
	}
}

func TestParseBusinessEmitsOnlyCurrentFamilies(t *testing.T) {
	obs, err := parseBusiness(businessFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 32 {
		t.Fatalf("want 32 current observations (15 GOP + 8 sales + 9 wages), got %d", len(obs))
	}
	byKey := make(map[string]Obs, len(obs))
	for _, o := range obs {
		byKey[o.Series.Key()] = o
		if o.Period.Year() == 2022 {
			t.Errorf("obsolete 2022 state x industry row was emitted: %#v", o)
		}
	}

	mining := byKey["business.gross_operating_profit.mining.aus.seasadj"]
	if mining.Value < 15e9 || mining.Value > 60e9 {
		t.Fatalf("mining GOP magnitude %v outside guard $15B..$60B/qtr", mining.Value)
	}
	if mining.Value != 48_173_000_000 {
		t.Errorf("mining GOP=%v, want 48.173B after UNIT_MULT=6 scaling", mining.Value)
	}
	if mining.Series.Topic != "business" || mining.Series.Unit != "aud" || mining.Series.Frequency != "quarterly" || mining.Series.Adjustment != "seasadj" || mining.Series.SourceKey != "abs-business-indicators" || mining.Series.Licence != "CC-BY-4.0" {
		t.Fatalf("unexpected GOP metadata: %#v", mining.Series)
	}
	if got := mining.Series.Dimensions["anzsic_division"]; got != "B" {
		t.Errorf("mining anzsic_division=%q, want raw division letter B", got)
	}

	sales := byKey["business.sales.total.vic.seasadj"]
	if sales.Value < 5e9 || sales.Value > 300e9 {
		t.Fatalf("Victoria sales magnitude %v outside state guard $5B..$300B/qtr", sales.Value)
	}
	if sales.Value != 231_189_000_000 {
		t.Errorf("Victoria sales=%v, want 231.189B after UNIT_MULT=6 scaling", sales.Value)
	}
	if _, ok := sales.Series.Dimensions["anzsic_division"]; ok {
		t.Errorf("all-industry sales total must not carry an ANZSIC division: %#v", sales.Series.Dimensions)
	}
	wages := byKey["business.wages.total.aus.seasadj"]
	if wages.Value != 209_628_000_000 {
		t.Errorf("Australia wages=%v, want 209.628B after UNIT_MULT=6 scaling", wages.Value)
	}
	for name, want := range map[string]string{
		"abs_dataflow": "QBIS", "abs_dataflow_version": "1.0.0", "measure": "M7",
		"price_adjustment": "CUR", "industry": "B", "scope": "TOT", "tsest": "20",
		"region": "AUS", "freq": "Q", "unit_mult": "6", "anzsic_division": "B",
	} {
		if got := mining.Series.Dimensions[name]; got != want {
			t.Errorf("mining Dimensions[%q]=%q, want %q", name, got, want)
		}
	}
	for _, forbidden := range []string{
		"business.sales.mining.nsw.seasadj",
		"business.gross_operating_profit.future-division.aus.seasadj",
		"business.inventories.total.aus.seasadj",
	} {
		if _, ok := byKey[forbidden]; ok {
			t.Errorf("filtered family unexpectedly emitted as %q", forbidden)
		}
	}
}

func TestParseBusinessWarnsAndSkipsUnknownANZSICDivision(t *testing.T) {
	fixture := businessFixture()
	unknown := fixture[len(fixture)-4]
	var logs bytes.Buffer
	previousWriter := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(previousWriter)

	obs, err := parseBusiness([][]string{fixture[0], unknown})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 0 {
		t.Fatalf("unknown ANZSIC division emitted %d observations", len(obs))
	}
	if !strings.Contains(logs.String(), `unknown ANZSIC division "X"`) {
		t.Errorf("missing unknown-division warning: %q", logs.String())
	}
}

func TestParseBusinessMissingRequiredColumn(t *testing.T) {
	for _, name := range []string{"MEASURE", "PRICE_ADJUSTMENT", "INDUSTRY", "SCOPE", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE", "UNIT_MULT"} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseBusiness(withoutSDMXColumn(businessFixture()[:2], name)); err == nil {
				t.Fatalf("expected schema-drift error when %s is missing", name)
			}
		})
	}
}

func TestParseBusinessRejectsInvalidRequiredRows(t *testing.T) {
	fixture := businessFixture()
	for _, tt := range []struct {
		name string
		row  []string
	}{
		{name: "truncated selected row", row: fixture[1][:11]},
		{name: "blank multiplier", row: replaceSDMXCell(fixture[1], 11, "")},
		{name: "malformed multiplier", row: replaceSDMXCell(fixture[1], 11, "million: Millions")},
		{name: "unexpected multiplier", row: replaceSDMXCell(fixture[1], 11, "3: Thousands")},
		{name: "malformed observation", row: replaceSDMXCell(fixture[1], 9, "not-a-number")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseBusiness([][]string{append([]string(nil), fixture[0]...), tt.row})
			assertSDMXRowError(t, err, "parseBusiness", 2)
		})
	}
}

func TestParseBusinessHeaderOnlyAndReordered(t *testing.T) {
	obs, err := parseBusiness([][]string{{"DATAFLOW"}})
	if err != nil || obs != nil {
		t.Fatalf("header-only input = (%#v, %v), want (nil, nil)", obs, err)
	}
	obs, err = parseBusiness(reverseSDMXColumns(businessFixture()))
	if err != nil || len(obs) != 32 {
		t.Fatalf("reordered header input = (%d observations, %v), want (32, nil)", len(obs), err)
	}
}
