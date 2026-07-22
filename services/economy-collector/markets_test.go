package main

import (
	"regexp"
	"strings"
	"testing"
	"time"
)

// The markets importer is SQL-derived (it reads the DB, not a web source), so
// there is no SDMX fixture to parse. What IS pure and unit-testable is the
// assembly of a query row (region, month, weighted-avg %) into an Obs with the
// right SeriesDef — series_key shape, unit, frequency, source_key, licence,
// and the current-constituent basis dimension. The SQL itself is validated
// against the local DB in the smoke (per the task), targeting the exported
// marketsQuery const.

func TestMarketSeriesDef_Key(t *testing.T) {
	def, ok := marketSeriesDef("wa")
	if !ok {
		t.Fatal("marketSeriesDef(wa): expected ok")
	}
	if got, want := def.Key(), "markets.short_interest_wavg.wa"; got != want {
		t.Errorf("Key() = %q, want %q", got, want)
	}
	if def.Topic != "markets" {
		t.Errorf("Topic = %q, want markets", def.Topic)
	}
	if def.Metric != "short_interest_wavg" {
		t.Errorf("Metric = %q, want short_interest_wavg", def.Metric)
	}
	if def.RegionType != "state" {
		t.Errorf("RegionType = %q, want state", def.RegionType)
	}
	if def.RegionCode != "wa" {
		t.Errorf("RegionCode = %q, want wa", def.RegionCode)
	}
	if def.RegionName != "Western Australia" {
		t.Errorf("RegionName = %q, want Western Australia", def.RegionName)
	}
	if def.Unit != "percent" {
		t.Errorf("Unit = %q, want percent", def.Unit)
	}
	if def.Frequency != "monthly" {
		t.Errorf("Frequency = %q, want monthly", def.Frequency)
	}
	if def.Adjustment != "original" {
		t.Errorf("Adjustment = %q, want original", def.Adjustment)
	}
	if def.SourceKey != "derived-shorted-markets" {
		t.Errorf("SourceKey = %q, want derived-shorted-markets", def.SourceKey)
	}
	if def.Licence != "derived" {
		t.Errorf("Licence = %q, want derived", def.Licence)
	}
	// The data-honesty caveat must be carried on the series itself so any
	// consumer inspecting the dimensions learns the weighting is present-day
	// composition applied retrospectively.
	if def.Dimensions["basis"] != "current-constituent" {
		t.Errorf("Dimensions[basis] = %q, want current-constituent", def.Dimensions["basis"])
	}
}

func TestMarketSeriesDef_AllStates(t *testing.T) {
	// Exactly the 8 states, no international, no national — 8 series.
	wantCodes := map[string]string{
		"nsw": "New South Wales", "vic": "Victoria", "qld": "Queensland",
		"sa": "South Australia", "wa": "Western Australia", "tas": "Tasmania",
		"nt": "Northern Territory", "act": "Australian Capital Territory",
	}
	if len(marketStateNames) != len(wantCodes) {
		t.Fatalf("marketStateNames has %d entries, want %d", len(marketStateNames), len(wantCodes))
	}
	for code, name := range wantCodes {
		def, ok := marketSeriesDef(code)
		if !ok {
			t.Errorf("marketSeriesDef(%q): expected ok", code)
			continue
		}
		if def.RegionName != name {
			t.Errorf("marketSeriesDef(%q).RegionName = %q, want %q", code, def.RegionName, name)
		}
	}
}

func TestMarketSeriesDef_RejectsNonState(t *testing.T) {
	for _, code := range []string{"international", "aus", "", "xyz", "AUS"} {
		if _, ok := marketSeriesDef(code); ok {
			t.Errorf("marketSeriesDef(%q): expected NOT ok", code)
		}
	}
}

func TestMarketObs(t *testing.T) {
	period := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	o, ok := marketObs("nsw", period, 1.87)
	if !ok {
		t.Fatal("marketObs(nsw): expected ok")
	}
	if o.Series.Key() != "markets.short_interest_wavg.nsw" {
		t.Errorf("Key() = %q", o.Series.Key())
	}
	if !o.Period.Equal(period) {
		t.Errorf("Period = %v, want %v", o.Period, period)
	}
	if o.Value != 1.87 {
		t.Errorf("Value = %v, want 1.87", o.Value)
	}
}

func TestMarketObs_RejectsUnknownRegion(t *testing.T) {
	if _, ok := marketObs("international", time.Now(), 2.0); ok {
		t.Error("marketObs(international): expected NOT ok — should never emit a series for a non-state region")
	}
}

func TestIndustrySlugMapMatchesPinnedGICSValuesAndWebSlugify(t *testing.T) {
	want := map[string]string{
		"Materials":                        "materials",
		"Energy":                           "energy",
		"Software & Services":              "software-services",
		"Financial Services":               "financial-services",
		"Health Care Equipment & Services": "health-care-equipment-services",
		"Pharmaceuticals, Biotechnology & Life Sciences": "pharmaceuticals-biotechnology-life-sciences",
		"Capital Goods":                                "capital-goods",
		"Commercial & Professional Services":           "commercial-professional-services",
		"Media & Entertainment":                        "media-entertainment",
		"Food, Beverage & Tobacco":                     "food-beverage-tobacco",
		"Consumer Discretionary Distribution & Retail": "consumer-discretionary-distribution-retail",
		"Consumer Services":                            "consumer-services",
		"Equity Real Estate Investment Trusts (REITs)": "equity-real-estate-investment-trusts-reits",
		"Technology Hardware & Equipment":              "technology-hardware-equipment",
		"Transportation":                               "transportation",
		"Real Estate Management & Development":         "real-estate-management-development",
		"Utilities":                                    "utilities",
		"Telecommunication Services":                   "telecommunication-services",
		"Consumer Durables & Apparel":                  "consumer-durables-apparel",
		"Banks":                                        "banks",
		"Household & Personal Products":                "household-personal-products",
		"Insurance":                                    "insurance",
		"Automobiles & Components":                     "automobiles-components",
		"Consumer Staples Distribution & Retail":       "consumer-staples-distribution-retail",
		"Semiconductors & Semiconductor Equipment":     "semiconductors-semiconductor-equipment",
	}
	if len(industrySlugs) != 25 {
		t.Fatalf("industrySlugs has %d entries, want 25", len(industrySlugs))
	}

	// Replicates createSlug in web/src/app/actions/industry/getIndustryData.ts:
	// lowercase, collapse non-alphanumerics to '-', trim leading/trailing '-'.
	nonAlphaNumeric := regexp.MustCompile(`[^a-z0-9]+`)
	webSlugify := func(raw string) string {
		return strings.Trim(nonAlphaNumeric.ReplaceAllString(strings.ToLower(raw), "-"), "-")
	}

	reverse := make(map[string]string, len(industrySlugs))
	for raw, wantSlug := range want {
		got, ok := industrySlugs[raw]
		if !ok {
			t.Errorf("industrySlugs missing raw GICS value %q", raw)
			continue
		}
		if got != wantSlug {
			t.Errorf("industrySlugs[%q] = %q, want pinned %q", raw, got, wantSlug)
		}
		if previous, exists := reverse[got]; exists {
			t.Errorf("slug %q maps from both %q and %q", got, previous, raw)
		}
		reverse[got] = raw

		webSlug := webSlugify(raw)
		if got != webSlug {
			t.Errorf("industrySlugs[%q] = %q, web createSlug gives %q", raw, got, webSlug)
		}
	}
	for raw, gotSlug := range industrySlugs {
		if wantSlug, ok := want[raw]; !ok {
			t.Errorf("industrySlugs has unpinned raw GICS value %q", raw)
		} else if gotSlug != wantSlug {
			t.Errorf("industrySlugs[%q] = %q, want %q", raw, gotSlug, wantSlug)
		}
	}
}

func TestAssembleIndustryMarketObsAppliesFiveStockNoiseFloor(t *testing.T) {
	period := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	rows := []industryMarketRow{
		{Industry: "Materials", Period: period, Average: 2.5, Constituents: 5},
		{Industry: "Energy", Period: period, Average: 1.5, Constituents: 4},
	}

	obs, stats, err := assembleIndustryMarketObs(rows)
	if err != nil {
		t.Fatalf("assembleIndustryMarketObs: %v", err)
	}
	if len(obs) != 1 {
		t.Fatalf("len(obs) = %d, want 1", len(obs))
	}
	if got, want := obs[0].Series.Key(), "markets.short_interest_avg.materials.aus"; got != want {
		t.Errorf("Key() = %q, want %q", got, want)
	}
	if got := obs[0].Series.Dimensions["industry"]; got != "Materials" {
		t.Errorf("Dimensions[industry] = %q, want Materials", got)
	}
	if got := obs[0].Series.Dimensions["basis"]; got != "equal-weight,current-membership" {
		t.Errorf("Dimensions[basis] = %q", got)
	}
	if stats.MappedConstituentMonths != 9 {
		t.Errorf("MappedConstituentMonths = %d, want 9", stats.MappedConstituentMonths)
	}
}

func TestAssembleIndustryMarketObsTripsOnMoreThanTenPercentUnmapped(t *testing.T) {
	period := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	rows := []industryMarketRow{
		{Industry: "Materials", Period: period, Average: 2.5, Constituents: 100},
		{Industry: "Future GICS Group", Period: period, Average: 1.5, Constituents: 11},
	}

	obs, stats, err := assembleIndustryMarketObs(rows)
	if err == nil {
		t.Fatal("expected vocabulary-drift error, got nil")
	}
	if len(obs) != 0 {
		t.Errorf("len(obs) = %d, want 0 on tripwire", len(obs))
	}
	if stats.MappedConstituentMonths != 100 || stats.UnmappedConstituentMonths != 11 || stats.UnmappedRows != 1 {
		t.Errorf("stats = %#v", stats)
	}
	if !strings.Contains(err.Error(), "11 unmapped constituent-months") {
		t.Errorf("error = %q, want unmapped count", err)
	}
}
