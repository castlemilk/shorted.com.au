package influence

import "testing"

func TestParseCEREmissionsCSV(t *testing.T) {
	data := []byte(`Organisation name,Identifying details,Total scope 1 emissions (t CO2-e),Total scope 2 emissions (t CO2-e),Net energy consumed (GJ),Important notes
AGL ENERGY LIMITED,ABN 74 115 061 375,"34,593,456","264,610","163,709,739",Includes operated facilities.
BAD ENTITY,No ABN,100,200,300,Skipped row.
ORIGIN ENERGY LIMITED,30145327543,1 200,345,900,
`)

	rows, err := parseCEREmissionsCSV(data, 2025, "https://example.test/nger.csv")
	if err != nil {
		t.Fatalf("parseCEREmissionsCSV: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 valid ABN rows, got %d: %+v", len(rows), rows)
	}

	first := rows[0]
	if first.ABN != "74115061375" {
		t.Fatalf("first ABN = %q", first.ABN)
	}
	if first.ReportingYearEnd != 2025 {
		t.Fatalf("reporting year = %d", first.ReportingYearEnd)
	}
	if first.Scope1 != 34593456 || first.Scope2 != 264610 {
		t.Fatalf("scope values = %v/%v", first.Scope1, first.Scope2)
	}
	if first.NetEnergyConsumed != 163709739 {
		t.Fatalf("net energy = %v", first.NetEnergyConsumed)
	}
	if first.SourceURL != "https://example.test/nger.csv" {
		t.Fatalf("source URL = %q", first.SourceURL)
	}

	second := rows[1]
	if second.ABN != "30145327543" {
		t.Fatalf("second ABN = %q", second.ABN)
	}
	if second.Scope1 != 1200 || second.Scope2 != 345 {
		t.Fatalf("second scope values = %v/%v", second.Scope1, second.Scope2)
	}
}

func TestParseCEREmissionsCSVRejectsMissingColumns(t *testing.T) {
	_, err := parseCEREmissionsCSV([]byte("Organisation name,Identifying details\nAGL,74115061375\n"), 2025, "https://example.test/nger.csv")
	if err == nil {
		t.Fatal("expected missing-column error")
	}
}
