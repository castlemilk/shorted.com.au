package main

import (
	"testing"
	"time"
)

func rbaFixture() [][]string {
	return [][]string{
		{"F1.1 INTEREST RATES AND YIELDS"},
		{"Series ID", "FIRMMCRT"},
		{"03/06/2026", "3.60"},
		{"04/06/2026", ""},
	}
}

func TestParseRBASeries(t *testing.T) {
	obs, err := parseRBASeries(rbaFixture(), "f1.1-data.csv", "monthly", []rbaSpec{
		{seriesID: "FIRMMCRT", metric: "cash_rate_target", unit: "percent"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 1 {
		t.Fatalf("want 1 obs (blank cell skipped), got %d", len(obs))
	}
	o := obs[0]
	if o.Series.Key() != "rates.cash_rate_target.aus" || o.Value != 3.60 {
		t.Fatalf("unexpected obs: %+v", o)
	}
	if o.Series.Frequency != "monthly" {
		t.Fatalf("frequency: %v", o.Series.Frequency)
	}
	if !o.Period.Equal(time.Date(2026, 6, 3, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("period: %v", o.Period)
	}
	if _, err := parseRBASeries(rbaFixture(), "f1.1-data.csv", "monthly", []rbaSpec{{seriesID: "MISSING", metric: "x", unit: "y"}}); err == nil {
		t.Fatal("want error for missing series")
	}
}

func rbaFXFixture() [][]string {
	return [][]string{
		{"F11.1 EXCHANGE RATES"},
		{"Series ID", "FXRUSD"},
		{"03-Jun-2026", "0.6800"},
	}
}

func TestParseRBASeries_FXDailyFrequency(t *testing.T) {
	obs, err := parseRBASeries(rbaFXFixture(), "f11.1-data.csv", "daily", []rbaSpec{
		{seriesID: "FXRUSD", metric: "aud_usd", unit: "usd"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 1 {
		t.Fatalf("want 1 obs, got %d", len(obs))
	}
	o := obs[0]
	if o.Series.Frequency != "daily" {
		t.Fatalf("want frequency daily, got %v", o.Series.Frequency)
	}
	if o.Value != 0.6800 {
		t.Fatalf("unexpected value: %v", o.Value)
	}
}
