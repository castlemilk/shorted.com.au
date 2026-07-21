package main

import (
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
