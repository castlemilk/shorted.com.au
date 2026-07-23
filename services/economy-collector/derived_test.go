package main

import (
	"math"
	"strings"
	"testing"
	"time"
)

func TestRealWageObsSubtractsYoYFromQuarterlyCPIIndex(t *testing.T) {
	period := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	row := realWagesRow{
		RegionCode: "wa", RegionName: "Western Australia", RegionType: "state",
		Period: period, WPIYoY: 3.2, CPIIndex: 135, CPIIndexYearAgo: 130,
	}

	obs, ok := realWagesObs(row)
	if !ok {
		t.Fatal("realWagesObs: expected ok")
	}
	want := 3.2 - ((135.0/130.0)-1)*100
	if math.Abs(obs.Value-want) > 1e-12 {
		t.Errorf("Value = %.12f, want %.12f", obs.Value, want)
	}
	if got, want := obs.Series.Key(), "wages.real_wpi_yoy.wa"; got != want {
		t.Errorf("Key() = %q, want %q", got, want)
	}
	if obs.Series.Unit != "percent" || obs.Series.Frequency != "quarterly" || obs.Series.Adjustment != "original" {
		t.Errorf("series metadata = %#v", obs.Series)
	}
	if got := obs.Series.Dimensions["deflator"]; got != "cpi-national" {
		t.Errorf("Dimensions[deflator] = %q", got)
	}
	if obs.Series.SourceKey != "derived-shorted-economy" || obs.Series.Licence != "derived" {
		t.Errorf("source metadata = %#v", obs.Series)
	}
}

func TestTradeBalanceObsSubtractsImportsFromExports(t *testing.T) {
	period := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	rows := []tradeBalanceRow{
		{RegionCode: "aus", RegionName: "Australia", RegionType: "national", Period: period, ExportValue: 1250, ImportValue: 900},
	}

	obs := assembleTradeBalanceObs(rows)
	if len(obs) != 1 {
		t.Fatalf("len(obs) = %d, want 1", len(obs))
	}
	if got, want := obs[0].Value, 350.0; got != want {
		t.Errorf("Value = %v, want %v", got, want)
	}
	if got, want := obs[0].Series.Key(), "trade.balance.total.aus"; got != want {
		t.Errorf("Key() = %q, want %q", got, want)
	}
	if obs[0].Series.Unit != "aud" || obs[0].Series.Frequency != "monthly" || obs[0].Series.Adjustment != "original" {
		t.Errorf("series metadata = %#v", obs[0].Series)
	}
}

func TestRealWageObsRejectsZeroCPIBase(t *testing.T) {
	if _, ok := realWagesObs(realWagesRow{CPIIndex: 135, CPIIndexYearAgo: 0}); ok {
		t.Fatal("realWagesObs: expected zero CPI base to be rejected")
	}
}

func TestAssembleCrimeRateObsUsesExactJuneQuarterERPAndSkipsMissing(t *testing.T) {
	victims := []crimeVictimRow{
		{
			RegionCode: "nsw", RegionName: "New South Wales", RegionType: "state",
			Period:  time.Date(2023, 1, 1, 0, 0, 0, 0, time.UTC),
			Offence: "homicide", Victims: 200,
		},
		{
			RegionCode: "nsw", RegionName: "New South Wales", RegionType: "state",
			Period:  time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
			Offence: "assault", Victims: 65000, Comparability: "within-state-only",
		},
	}
	populations := []crimePopulationRow{
		// Wrong quarter for 2024: must not be used.
		{RegionCode: "nsw", Period: time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC), Population: 8_000_000},
		// Exact June-quarter start used for the 2024 victim year.
		{RegionCode: "nsw", Period: time.Date(2024, 4, 1, 0, 0, 0, 0, time.UTC), Population: 8_125_000},
		// No 2023-04-01 population: the 2023 victim count must be skipped.
	}

	obs := assembleCrimeRateObs(victims, populations)
	if got, want := len(obs), 1; got != want {
		t.Fatalf("len(obs) = %d, want %d: %#v", got, want, obs)
	}
	got := obs[0]
	wantValue := 65000.0 / 8_125_000.0 * 100000
	if math.Abs(got.Value-wantValue) > 1e-12 {
		t.Fatalf("crime rate = %.12f, want %.12f", got.Value, wantValue)
	}
	if got.Series.Key() != "crime.victims_rate_100k.assault.nsw" ||
		got.Series.Unit != "rate_per_100k" || got.Series.Frequency != "annual" ||
		got.Series.Adjustment != "original" || got.Series.SourceKey != "derived-shorted-economy" ||
		got.Series.Licence != "derived" {
		t.Fatalf("crime rate metadata wrong: %#v", got.Series)
	}
	if got.Period.Format("2006-01-02") != "2024-01-01" {
		t.Fatalf("derived crime period = %v, want victim-year Jan 1", got.Period)
	}
	if got.Series.Dimensions["comparability"] != "within-state-only" {
		t.Fatalf("comparability not carried: %#v", got.Series.Dimensions)
	}
}

func TestAssembleCrimeRateObsSkipsNonPositivePopulation(t *testing.T) {
	victims := []crimeVictimRow{{
		RegionCode: "tas", RegionName: "Tasmania", RegionType: "state",
		Period:  time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
		Offence: "robbery", Victims: 100,
	}}
	for _, populationValue := range []float64{0, -1} {
		populations := []crimePopulationRow{{
			RegionCode: "tas", Period: time.Date(2024, 4, 1, 0, 0, 0, 0, time.UTC), Population: populationValue,
		}}
		if obs := assembleCrimeRateObs(victims, populations); len(obs) != 0 {
			t.Fatalf("non-positive ERP %v must not produce a crime rate: %#v", populationValue, obs)
		}
	}
}

func TestAssembleCrimeRateObsSkipsNonFiniteInputs(t *testing.T) {
	baseVictim := crimeVictimRow{
		RegionCode: "tas", RegionName: "Tasmania", RegionType: "state",
		Period:  time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC),
		Offence: "robbery", Victims: 100,
	}
	basePopulation := crimePopulationRow{
		RegionCode: "tas", Period: time.Date(2024, 4, 1, 0, 0, 0, 0, time.UTC), Population: 500_000,
	}
	tests := []struct {
		name       string
		victims    float64
		population float64
	}{
		{"NaN ERP", 100, math.NaN()},
		{"infinite ERP", 100, math.Inf(1)},
		{"NaN victims", math.NaN(), 500_000},
		{"infinite victims", math.Inf(1), 500_000},
		{"overflowing rate", math.MaxFloat64, math.SmallestNonzeroFloat64},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			victim := baseVictim
			victim.Victims = tc.victims
			population := basePopulation
			population.Population = tc.population
			if obs := assembleCrimeRateObs([]crimeVictimRow{victim}, []crimePopulationRow{population}); len(obs) != 0 {
				t.Fatalf("non-finite input must not produce a rate: %#v", obs)
			}
		})
	}
}

func TestCrimeRateQueriesAreScopedToPinnedSourceFamilies(t *testing.T) {
	for _, want := range []string{
		"series.topic = 'crime'",
		"series.metric = 'victims'",
		"series.source_key = 'abs-recorded-crime-victims'",
		"series.region_type = 'state'",
		"series.unit = 'persons'",
		"series.frequency = 'annual'",
		"series.adjustment = 'original'",
		"series.product IN",
		"'homicide'", "'assault'", "'sexual-assault'", "'robbery'",
		"'unlawful-entry'", "'motor-vehicle-theft'", "'other-theft'",
	} {
		if !strings.Contains(crimeVictimsForRatesQuery, want) {
			t.Errorf("crime victims query missing exact-family scope %q", want)
		}
	}
	for _, want := range []string{
		"series.source_key = 'abs-population'",
		"series.region_type = 'state'",
		"series.unit = 'persons'",
		"series.topic = 'population'",
		"series.metric = 'erp'",
		"series.product = 'total'",
		"series.frequency = 'quarterly'",
		"series.adjustment = 'original'",
	} {
		if !strings.Contains(crimePopulationForRatesQuery, want) {
			t.Errorf("crime population query missing exact-family scope %q", want)
		}
	}
}
