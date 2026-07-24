package main

import (
	"log"
	"math"
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

func TestExposureMVStalenessWarning(t *testing.T) {
	now := time.Date(2026, 7, 24, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name        string
		refreshedAt *time.Time
		wantWarning bool
	}{
		{name: "pre-migration null is silent", refreshedAt: nil, wantWarning: false},
		{name: "fresh", refreshedAt: timePtr(now.AddDate(0, 0, -10)), wantWarning: false},
		{name: "exactly 45 days is not older", refreshedAt: timePtr(now.Add(-45 * 24 * time.Hour)), wantWarning: false},
		{name: "older than 45 days warns", refreshedAt: timePtr(now.Add(-45*24*time.Hour - time.Second)), wantWarning: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			warning := exposureMVStalenessWarning(tt.refreshedAt, now)
			if got := warning != ""; got != tt.wantWarning {
				t.Fatalf("warning=%q, present=%v want %v", warning, got, tt.wantWarning)
			}
			if tt.wantWarning {
				for _, phrase := range []string{"WARNING", "mv_company_state_exposure", "45 days"} {
					if !strings.Contains(warning, phrase) {
						t.Errorf("warning %q omits %q", warning, phrase)
					}
				}
			}
		})
	}
}

func timePtr(value time.Time) *time.Time {
	return &value
}

func TestPriceReturnIndexSeriesDef(t *testing.T) {
	def, ok := priceReturnIndexSeriesDef("wa")
	if !ok {
		t.Fatal("priceReturnIndexSeriesDef(wa): expected ok")
	}
	if got, want := def.Key(), "markets.price_return_index.wa"; got != want {
		t.Fatalf("Key() = %q, want %q", got, want)
	}
	if def.Unit != "index" || def.Frequency != "monthly" || def.Adjustment != "original" {
		t.Fatalf("series metadata = %#v", def)
	}
	if def.SourceKey != "derived-shorted-markets" || def.Licence != "derived" {
		t.Fatalf("source metadata = %#v", def)
	}
	if got := def.Dimensions["basis"]; got != "current-constituent" {
		t.Fatalf("Dimensions[basis] = %q", got)
	}
	if got := def.Dimensions["weighting"]; got != "weight_x_market_cap" {
		t.Fatalf("Dimensions[weighting] = %q", got)
	}
}

func TestAssemblePriceReturnIndexObsBase100AndCumprod(t *testing.T) {
	rows := []priceReturnRow{
		{Region: "nsw", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC), Return: 0.10, Constituents: 6},
		{Region: "nsw", Period: time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC), Return: -0.05, Constituents: 5},
		{Region: "nsw", Period: time.Date(2025, 3, 1, 0, 0, 0, 0, time.UTC), Return: 0.20, Constituents: 8},
	}

	obs, err := assembleStatePriceReturnIndexObs(rows)
	if err != nil {
		t.Fatalf("assembleStatePriceReturnIndexObs: %v", err)
	}
	if got, want := len(obs), 3; got != want {
		t.Fatalf("len(obs) = %d, want %d", got, want)
	}
	want := []float64{100, 95, 114}
	for i := range want {
		if math.Abs(obs[i].Value-want[i]) > 1e-12 {
			t.Errorf("obs[%d].Value = %.12f, want %.12f", i, obs[i].Value, want[i])
		}
	}
}

func TestAssemblePriceReturnIndexObsDoesNotInventGapMonth(t *testing.T) {
	rows := []priceReturnRow{
		{Region: "vic", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC), Return: 0.02, Constituents: 5},
		{Region: "vic", Period: time.Date(2025, 3, 1, 0, 0, 0, 0, time.UTC), Return: 0.10, Constituents: 5},
	}

	obs, err := assembleStatePriceReturnIndexObs(rows)
	if err != nil {
		t.Fatalf("assembleStatePriceReturnIndexObs: %v", err)
	}
	if got, want := len(obs), 2; got != want {
		t.Fatalf("len(obs) = %d, want %d", got, want)
	}
	if got := obs[0].Period.Format("2006-01-02"); got != "2025-01-01" {
		t.Fatalf("first period = %s", got)
	}
	if got := obs[1].Period.Format("2006-01-02"); got != "2025-03-01" {
		t.Fatalf("second period = %s, gap month must remain absent", got)
	}
	if math.Abs(obs[1].Value-110) > 1e-12 {
		t.Fatalf("post-gap index = %.12f, want 110", obs[1].Value)
	}
}

func TestAssemblePriceReturnIndexObsAppliesConstituentFloor(t *testing.T) {
	rows := []priceReturnRow{
		{Region: "qld", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC), Return: 0.01, Constituents: 4},
		{Region: "qld", Period: time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC), Return: 0.02, Constituents: 5},
	}

	obs, err := assembleStatePriceReturnIndexObs(rows)
	if err != nil {
		t.Fatalf("assembleStatePriceReturnIndexObs: %v", err)
	}
	if got, want := len(obs), 1; got != want {
		t.Fatalf("len(obs) = %d, want %d", got, want)
	}
	if obs[0].Value != 100 {
		t.Fatalf("first qualifying month index = %v, want 100", obs[0].Value)
	}
}

func TestAssemblePriceReturnIndexObsPricesInUnpublishedBelowFloorMonth(t *testing.T) {
	rows := []priceReturnRow{
		{Region: "qld", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC), Return: 0.10, Constituents: 5},
		{Region: "qld", Period: time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC), Return: 0.20, Constituents: 4},
		{Region: "qld", Period: time.Date(2025, 3, 1, 0, 0, 0, 0, time.UTC), Return: 0.10, Constituents: 5},
	}

	obs, err := assembleStatePriceReturnIndexObs(rows)
	if err != nil {
		t.Fatalf("assembleStatePriceReturnIndexObs: %v", err)
	}
	if got, want := len(obs), 2; got != want {
		t.Fatalf("len(obs) = %d, want %d", got, want)
	}
	if got := obs[1].Period.Format("2006-01-02"); got != "2025-03-01" {
		t.Fatalf("second period = %s, below-floor month must remain unpublished", got)
	}
	if got, want := obs[1].Value, 132.0; math.Abs(got-want) > 1e-12 {
		t.Fatalf("post-floor index = %.12f, want %.12f with February priced in", got, want)
	}
}

func TestAssemblePriceReturnIndexObsSkipsDriftGuardForBaseMonth(t *testing.T) {
	rows := []priceReturnRow{{
		Region: "tas", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
		Return: 0.50, Constituents: 5,
	}}

	obs, err := assembleStatePriceReturnIndexObs(rows)
	if err != nil {
		t.Fatalf("base month return is discarded and must not trigger drift guard: %v", err)
	}
	if got, want := len(obs), 1; got != want {
		t.Fatalf("len(obs) = %d, want %d", got, want)
	}
	if got := obs[0].Value; got != 100 {
		t.Fatalf("base index = %v, want 100", got)
	}
}

func TestAssemblePriceReturnIndexObsExcludesEntireBreachingState(t *testing.T) {
	rows := []priceReturnRow{
		{Region: "act", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC), Return: 0, Constituents: 5},
		{Region: "act", Period: time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC), Return: 0.10, Constituents: 5},
		{Region: "act", Period: time.Date(2025, 3, 1, 0, 0, 0, 0, time.UTC), Return: 0.30, Constituents: 5},
		{Region: "vic", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC), Return: 0, Constituents: 5},
		{Region: "vic", Period: time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC), Return: 0.05, Constituents: 5},
		{Region: "vic", Period: time.Date(2025, 3, 1, 0, 0, 0, 0, time.UTC), Return: -0.02, Constituents: 5},
	}

	obs, err := assembleStatePriceReturnIndexObs(rows)
	if err != nil {
		t.Fatalf("one healthy state should keep the family alive: %v", err)
	}
	if got, want := len(obs), 3; got != want {
		t.Fatalf("len(obs) = %d, want %d healthy-state observations: %#v", got, want, obs)
	}
	for _, observation := range obs {
		if got := observation.Series.RegionCode; got != "vic" {
			t.Fatalf("published rejected state %q: %#v", got, obs)
		}
	}
}

func TestAssemblePriceReturnIndexObsErrorsWhenAllStatesBreach(t *testing.T) {
	rows := []priceReturnRow{
		{Region: "act", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC), Return: 0, Constituents: 5},
		{Region: "act", Period: time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC), Return: 0.30, Constituents: 5},
		{Region: "nt", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC), Return: 0, Constituents: 5},
		{Region: "nt", Period: time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC), Return: -0.30, Constituents: 5},
	}

	obs, err := assembleStatePriceReturnIndexObs(rows)
	if err == nil {
		t.Fatal("expected family error when zero state series survive")
	}
	if obs != nil {
		t.Fatalf("obs = %#v, want nil when zero state series survive", obs)
	}
}

func TestAssemblePriceReturnIndexObsWarningNamesExcludedStateMonthAndReturn(t *testing.T) {
	var logs strings.Builder
	previousOutput := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() {
		log.SetOutput(previousOutput)
	})

	rows := []priceReturnRow{
		{Region: "act", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC), Return: 0, Constituents: 5},
		{Region: "act", Period: time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC), Return: 0.10, Constituents: 5},
		{Region: "act", Period: time.Date(2025, 3, 1, 0, 0, 0, 0, time.UTC), Return: 0.30, Constituents: 5},
		{Region: "vic", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC), Return: 0, Constituents: 5},
	}

	if _, err := assembleStatePriceReturnIndexObs(rows); err != nil {
		t.Fatalf("healthy state should keep the family alive: %v", err)
	}
	warning := logs.String()
	for _, phrase := range []string{"WARNING", "act", "2025-03-01", "0.300000"} {
		if !strings.Contains(warning, phrase) {
			t.Errorf("warning %q omits %q", warning, phrase)
		}
	}
	if got, want := strings.Count(warning, "WARNING"), 1; got != want {
		t.Errorf("warning count = %d, want %d: %q", got, want, warning)
	}
}

func TestConsecutiveStockPriceReturnsBreaksChainOnGap(t *testing.T) {
	rows := []monthlyPriceExposureRow{
		{
			StockCode: "ABC", Region: "wa", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
			Close: 100, ExposureWeight: 1, MarketCap: 1_000_000,
		},
		{
			StockCode: "ABC", Region: "wa", Period: time.Date(2025, 3, 1, 0, 0, 0, 0, time.UTC),
			Close: 120, ExposureWeight: 1, MarketCap: 1_000_000,
		},
		{
			StockCode: "XYZ", Region: "wa", Period: time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC),
			Close: 50, ExposureWeight: 1, MarketCap: 2_000_000,
		},
		{
			StockCode: "XYZ", Region: "wa", Period: time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC),
			Close: 55, ExposureWeight: 1, MarketCap: 2_000_000,
		},
	}

	returns, err := consecutiveStockPriceReturns(rows)
	if err != nil {
		t.Fatalf("consecutiveStockPriceReturns: %v", err)
	}
	if got, want := len(returns), 1; got != want {
		t.Fatalf("len(returns) = %d, want %d: %#v", got, want, returns)
	}
	if returns[0].StockCode != "XYZ" || returns[0].Period.Format("2006-01-02") != "2025-02-01" {
		t.Fatalf("return row = %#v", returns[0])
	}
	if math.Abs(returns[0].Return-0.10) > 1e-12 {
		t.Fatalf("return = %.12f, want .10", returns[0].Return)
	}
}

func TestAggregateStatePriceReturnsUsesExposureWeightTimesMarketCap(t *testing.T) {
	period := time.Date(2025, 2, 1, 0, 0, 0, 0, time.UTC)
	rows := []weightedStockReturnRow{
		{StockCode: "A", Region: "nsw", Period: period, Return: 0.10, Weight: 1},
		{StockCode: "B", Region: "nsw", Period: period, Return: -0.10, Weight: 3},
		{StockCode: "C", Region: "nsw", Period: period, Return: 0, Weight: 1},
		{StockCode: "D", Region: "nsw", Period: period, Return: 0, Weight: 1},
		{StockCode: "E", Region: "nsw", Period: period, Return: 0, Weight: 1},
	}

	stateRows, err := aggregateStatePriceReturns(rows)
	if err != nil {
		t.Fatalf("aggregateStatePriceReturns: %v", err)
	}
	if got, want := len(stateRows), 1; got != want {
		t.Fatalf("len(stateRows) = %d, want %d", got, want)
	}
	if math.Abs(stateRows[0].Return-(-0.20/7.0)) > 1e-12 {
		t.Fatalf("weighted return = %.12f, want %.12f", stateRows[0].Return, -0.20/7.0)
	}
	if stateRows[0].Constituents != 5 {
		t.Fatalf("constituents = %d, want 5", stateRows[0].Constituents)
	}
}

func TestPriceReturnQueryLoadsMonthlyLastPricesAndCurrentWeights(t *testing.T) {
	for _, want := range []string{
		"DISTINCT ON (p.stock_code, date_trunc('month', p.date))",
		"JOIN mv_company_state_exposure e ON e.stock_code = m.stock_code",
		"e.weight",
		"e.market_cap",
		"ORDER BY m.stock_code, m.month, e.region",
	} {
		if !strings.Contains(priceReturnIndexQuery, want) {
			t.Errorf("price-return query missing %q", want)
		}
	}
}

func TestMarketsQuerySharesOneMonthlyLastScanAcrossFamilies(t *testing.T) {
	if got := strings.Count(marketsQuery, "WITH monthly_last AS MATERIALIZED"); got != 1 {
		t.Fatalf("monthly_last CTE count = %d, want exactly one shared materialized CTE", got)
	}
	for _, want := range []string{
		"'state'::text AS family",
		"'industry'::text AS family",
		"UNION ALL",
	} {
		if !strings.Contains(marketsQuery, want) {
			t.Errorf("marketsQuery missing %q", want)
		}
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
