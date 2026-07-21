package main

import "testing"

// gspFixture mirrors the real ABS,ANA_SFD(1.0.0) SDMX-CSV shape (probed
// 2026-07-21): MEASURE, DATA_ITEM, SECTOR, TSEST, REGION, FREQ, TIME_PERIOD,
// OBS_VALUE, UNIT_MULT. There is no dedicated "Gross State Product" dataflow
// in the ABS Data API (catalogue 5220.0 is Excel-only) — ANA_SFD (State
// Final Demand, chain volume measures) is the closest state-level national
// accounts series actually available, so gdp.go ingests that. See the
// comment on gspFlow in gdp.go for the full justification.
func gspFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "MEASURE: Measure", "DATA_ITEM: Data Item", "SECTOR: Sector", "TSEST: Adjustment Type", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "UNIT_MULT: Unit of Multiplier"},
		// The row we want: chain volume measures, state final demand total, all sectors, seasonally adjusted, NSW, quarterly.
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "SFD: STATE FINAL DEMAND", "SSS: All sectors", "20: Seasonally Adjusted", "1: New South Wales", "Q: Quarterly", "2025-Q4", "215548", "NA: Not Applicable", "0: Units"},
		// Wrong data item (a component, not the SFD total) — filtered.
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "GFC: Gross fixed capital formation", "SSS: All sectors", "20: Seasonally Adjusted", "1: New South Wales", "Q: Quarterly", "2025-Q4", "50000", "NA: Not Applicable", "0: Units"},
		// Wrong sector (a sub-sector split, not the all-sectors total) — filtered.
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "SFD: STATE FINAL DEMAND", "GSS: Public", "20: Seasonally Adjusted", "1: New South Wales", "Q: Quarterly", "2025-Q4", "40000", "NA: Not Applicable", "0: Units"},
		// Wrong TSEST (original, not seasonally adjusted) — filtered.
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "SFD: STATE FINAL DEMAND", "SSS: All sectors", "10: Original", "1: New South Wales", "Q: Quarterly", "2025-Q4", "216000", "NA: Not Applicable", "0: Units"},
		// Wrong measure (percentage change, not the level) — filtered.
		{"ABS:ANA_SFD(1.0.0)", "PCT_VCH: Chain volume measures - Percentage changes", "SFD: STATE FINAL DEMAND", "SSS: All sectors", "20: Seasonally Adjusted", "1: New South Wales", "Q: Quarterly", "2025-Q4", "1.8", "NA: Not Applicable", "0: Units"},
	}
}

func TestParseStateAccounts(t *testing.T) {
	obs, err := parseStateAccounts(gspFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 1 {
		t.Fatalf("want 1 obs, got %d: %#v", len(obs), obs)
	}
	// UNIT_MULT reports "0: Units" for this dataflow (a metadata gap — see
	// gdp.go), so the value is scaled by the hardcoded $-million convention
	// documented there: 215548 * 1e6.
	if obs[0].Series.Key() != "gdp.state_final_demand_chain_volume.total.nsw.seasadj" || obs[0].Value != 2.15548e11 {
		t.Fatalf("unexpected: key=%s value=%v", obs[0].Series.Key(), obs[0].Value)
	}
	if obs[0].Series.Dimensions["abs_dataflow"] != "ANA_SFD" {
		t.Fatalf("expected abs_dataflow ANA_SFD, got %#v", obs[0].Series.Dimensions)
	}
}

func TestParseStateAccountsMissingColumn(t *testing.T) {
	rows := [][]string{
		{"DATAFLOW", "MEASURE: Measure", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE"},
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "1: New South Wales", "Q: Quarterly", "2025-Q4", "215548"},
	}
	if _, err := parseStateAccounts(rows); err == nil {
		t.Fatal("expected error on missing DATA_ITEM/SECTOR/TSEST columns, got nil (schema drift should fail closed)")
	}
}
