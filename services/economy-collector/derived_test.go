package main

import (
	"math"
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
