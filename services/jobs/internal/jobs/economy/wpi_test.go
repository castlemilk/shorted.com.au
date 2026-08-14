package economy

import "testing"

// wpiFixture mirrors the pinned ABS,WPI(1.2.0) SDMX-CSV shape from the
// 2026-07-22 probe. The dataflow dimension order is
// MEASURE.INDEX.SECTOR.INDUSTRY.TSEST.REGION.FREQ.
func wpiFixture() [][]string {
	header := []string{"DATAFLOW", "MEASURE: Measure", "INDEX: Index", "SECTOR: Sector", "INDUSTRY: Industry", "TSEST: Adjustment Type", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure"}
	regions := [][3]string{
		{"AUS", "Australia", "160.3"}, {"1", "New South Wales", "161.1"}, {"2", "Victoria", "159.8"},
		{"3", "Queensland", "160.7"}, {"4", "South Australia", "158.9"}, {"5", "Western Australia", "162.2"},
		{"6", "Tasmania", "157.5"}, {"7", "Northern Territory", "159.2"}, {"8", "Australian Capital Territory", "163.4"},
	}
	rows := [][]string{header}
	for i, region := range regions {
		yoy := []string{"3.2", "3.4", "3.1", "3.3", "3.0", "3.6", "2.9", "3.5", "3.2"}[i]
		rows = append(rows,
			[]string{"ABS:WPI(1.2.0)", "1: Index number", "THRPEB: Total hourly rates of pay excluding bonuses", "7: Private and public sectors", "TOT: Total", "10: Original", region[0] + ": " + region[1], "Q: Quarterly", "2026-Q2", region[2], "INX: Index"},
			[]string{"ABS:WPI(1.2.0)", "3: Percentage change from corresponding quarter of previous year", "THRPEB: Total hourly rates of pay excluding bonuses", "7: Private and public sectors", "TOT: Total", "10: Original", region[0] + ": " + region[1], "Q: Quarterly", "2026-Q2", yoy, "PCT: Percent"},
		)
	}
	return append(rows,
		[]string{"ABS:WPI(1.2.0)", "2: Quarterly percentage change", "THRPEB: Total hourly rates of pay excluding bonuses", "7: Private and public sectors", "TOT: Total", "10: Original", "AUS: Australia", "Q: Quarterly", "2026-Q2", "999", "PCT: Percent"},
		[]string{"ABS:WPI(1.2.0)", "1: Index number", "THRPEB: Total hourly rates of pay excluding bonuses", "1: Private sector", "TOT: Total", "10: Original", "AUS: Australia", "Q: Quarterly", "2026-Q2", "999", "INX: Index"},
		[]string{"ABS:WPI(1.2.0)", "1: Index number", "THRPEB: Total hourly rates of pay excluding bonuses", "7: Private and public sectors", "TOT: Total", "20: Seasonally Adjusted", "AUS: Australia", "Q: Quarterly", "2026-Q2", "999", "INX: Index"},
		[]string{"ABS:WPI(1.2.0)", "1: Index number", "AWE: Average weekly earnings", "7: Private and public sectors", "TOT: Total", "10: Original", "AUS: Australia", "Q: Quarterly", "2026-Q2", "999", "INX: Index"},
		[]string{"ABS:WPI(1.2.0)", "1: Index number", "THRPEB: Total hourly rates of pay excluding bonuses", "7: Private and public sectors", "A: Agriculture", "10: Original", "AUS: Australia", "Q: Quarterly", "2026-Q2", "999", "INX: Index"},
	)
}

func TestWPIPinnedSDMXQuery(t *testing.T) {
	if wpiFlow != "WPI" || wpiVersion != "1.2.0" ||
		wpiKey != "1+3.THRPEB.7.TOT.10.1+2+3+4+5+6+7+8+AUS.Q" || wpiStartPeriod != "2000-Q1" {
		t.Fatalf("unexpected WPI query: flow=%q version=%q key=%q start=%q", wpiFlow, wpiVersion, wpiKey, wpiStartPeriod)
	}
}

func TestParseWPI(t *testing.T) {
	obs, err := parseWPI(wpiFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 18 {
		t.Fatalf("want 18 selected measure/region observations, got %d: %#v", len(obs), obs)
	}
	byKey := make(map[string]Obs, len(obs))
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}
	index, ok := byKey["wages.wpi.aus"]
	if !ok || index.Value < 50 || index.Value > 300 {
		t.Fatalf("Australia WPI index missing or outside magnitude guard 50..300: %#v", index)
	}
	yoy, ok := byKey["wages.wpi_yoy.aus"]
	if !ok || yoy.Value < -5 || yoy.Value > 15 {
		t.Fatalf("Australia WPI YoY missing or outside magnitude guard -5..15: %#v", yoy)
	}
	if index.Value != 160.3 || index.Series.Unit != "index" || yoy.Value != 3.2 || yoy.Series.Unit != "percent" {
		t.Fatalf("unexpected WPI values/units: index=%#v yoy=%#v", index, yoy)
	}
	for key, o := range byKey {
		if o.Series.Topic != "wages" || o.Series.Product != "" || o.Series.Frequency != "quarterly" ||
			o.Series.Adjustment != "original" || o.Series.SourceKey != "abs-wage-price-index" || o.Series.Licence != "CC-BY-4.0" {
			t.Errorf("unexpected metadata for %q: %#v", key, o.Series)
		}
	}
	for name, want := range map[string]string{
		"abs_dataflow": "WPI", "abs_dataflow_version": "1.2.0", "measure": "1", "index": "THRPEB",
		"sector": "7", "industry": "TOT", "tsest": "10", "region": "AUS", "freq": "Q",
	} {
		if got := index.Series.Dimensions[name]; got != want {
			t.Errorf("Dimensions[%q]=%q, want %q", name, got, want)
		}
	}
}

func TestParseWPIMissingRequiredColumn(t *testing.T) {
	for _, name := range []string{"MEASURE", "INDEX", "SECTOR", "INDUSTRY", "TSEST", "REGION", "FREQ", "TIME_PERIOD", "OBS_VALUE"} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseWPI(withoutSDMXColumn(wpiFixture()[:2], name)); err == nil {
				t.Fatalf("expected schema-drift error when %s is missing", name)
			}
		})
	}
}

func TestParseWPIRejectsInvalidRequiredRows(t *testing.T) {
	fixture := wpiFixture()
	filteredRow := fixture[len(fixture)-5]
	_, err := parseWPI([][]string{append([]string(nil), fixture[0]...), filteredRow[:9]})
	assertSDMXRowError(t, err, "parseWPI", 2)
}

func TestParseWPIHeaderOnlyAndReordered(t *testing.T) {
	obs, err := parseWPI([][]string{{"DATAFLOW"}})
	if err != nil || obs != nil {
		t.Fatalf("header-only input = (%#v, %v), want (nil, nil)", obs, err)
	}
	obs, err = parseWPI(reverseSDMXColumns(wpiFixture()))
	if err != nil || len(obs) != 18 {
		t.Fatalf("reordered header input = (%d observations, %v), want (18, nil)", len(obs), err)
	}
}
