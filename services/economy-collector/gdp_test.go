package main

import "testing"

// sfdFixture mirrors the real ABS,ANA_SFD(1.0.0) SDMX-CSV shape (probed
// 2026-07-21): MEASURE, DATA_ITEM, SECTOR, TSEST, REGION, FREQ, TIME_PERIOD,
// OBS_VALUE, UNIT_MULT. There is no dedicated "Gross State Product" dataflow
// in the ABS Data API (catalogue 5220.0 is Excel-only) — ANA_SFD (State
// Final Demand, chain volume measures) is the closest state-level national
// accounts series actually available, so gdp.go ingests that. See the
// comment on sfdFlow in gdp.go for the full justification.
func sfdFixture() [][]string {
	return [][]string{
		{"DATAFLOW", "MEASURE: Measure", "DATA_ITEM: Data Item", "SECTOR: Sector", "TSEST: Adjustment Type", "REGION: Region", "FREQ: Frequency", "TIME_PERIOD: Time Period", "OBS_VALUE", "UNIT_MEASURE: Unit of Measure", "UNIT_MULT: Unit of Multiplier"},
		// The row we want: chain volume measures, state final demand total, all sectors, seasonally adjusted, NSW, quarterly.
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "SFD: STATE FINAL DEMAND", "SSS: All sectors", "20: Seasonally Adjusted", "1: New South Wales", "Q: Quarterly", "2025-Q4", "215548", "NA: Not Applicable", "0: Units"},
		// A second state (VIC) — kept, alongside the NSW row.
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "SFD: STATE FINAL DEMAND", "SSS: All sectors", "20: Seasonally Adjusted", "2: Victoria", "Q: Quarterly", "2025-Q4", "171658", "NA: Not Applicable", "0: Units"},
		// Wrong data item (a component, not the SFD total) — filtered.
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "GFC: Gross fixed capital formation", "SSS: All sectors", "20: Seasonally Adjusted", "1: New South Wales", "Q: Quarterly", "2025-Q4", "50000", "NA: Not Applicable", "0: Units"},
		// Wrong sector (a sub-sector split, not the all-sectors total) — filtered.
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "SFD: STATE FINAL DEMAND", "GSS: Public", "20: Seasonally Adjusted", "1: New South Wales", "Q: Quarterly", "2025-Q4", "40000", "NA: Not Applicable", "0: Units"},
		// Wrong TSEST (original, not seasonally adjusted) — filtered.
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "SFD: STATE FINAL DEMAND", "SSS: All sectors", "10: Original", "1: New South Wales", "Q: Quarterly", "2025-Q4", "216000", "NA: Not Applicable", "0: Units"},
		// Wrong measure (percentage change, not the level) — filtered.
		{"ABS:ANA_SFD(1.0.0)", "PCT_VCH: Chain volume measures - Percentage changes", "SFD: STATE FINAL DEMAND", "SSS: All sectors", "20: Seasonally Adjusted", "1: New South Wales", "Q: Quarterly", "2025-Q4", "1.8", "NA: Not Applicable", "0: Units"},
		// Unmapped region code (9 = "No state details", not in lfStates) — filtered.
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "SFD: STATE FINAL DEMAND", "SSS: All sectors", "20: Seasonally Adjusted", "9: No state details", "Q: Quarterly", "2025-Q4", "1000", "NA: Not Applicable", "0: Units"},
		// Wrong FREQ (annual, not quarterly) — filtered.
		{"ABS:ANA_SFD(1.0.0)", "VCH: Chain volume measures", "SFD: STATE FINAL DEMAND", "SSS: All sectors", "20: Seasonally Adjusted", "1: New South Wales", "A: Annual", "2025", "860000", "NA: Not Applicable", "0: Units"},
	}
}

func TestParseStateAccounts(t *testing.T) {
	obs, err := parseStateAccounts(sfdFixture())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 2 {
		t.Fatalf("want 2 obs (NSW + VIC), got %d: %#v", len(obs), obs)
	}
	byKey := map[string]Obs{}
	for _, o := range obs {
		byKey[o.Series.Key()] = o
	}
	// UNIT_MULT reports "0: Units" for this dataflow (a metadata gap — see
	// gdp.go), so the value is scaled by the hardcoded $-million convention
	// documented there: 215548 * 1e6.
	nsw, ok := byKey["gdp.state_final_demand_chain_volume.total.nsw.seasadj"]
	if !ok || nsw.Value != 2.15548e11 {
		t.Fatalf("unexpected NSW obs: %#v", byKey)
	}
	if nsw.Series.Dimensions["abs_dataflow"] != "ANA_SFD" {
		t.Fatalf("expected abs_dataflow ANA_SFD, got %#v", nsw.Series.Dimensions)
	}
	vic, ok := byKey["gdp.state_final_demand_chain_volume.total.vic.seasadj"]
	if !ok || vic.Value != 1.71658e11 {
		t.Fatalf("unexpected VIC obs: %#v", byKey)
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
