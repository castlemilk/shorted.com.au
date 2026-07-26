package houseprices

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestLiveSAMetroSmoke hits the real data.sa.gov.au CKAN API. Gated behind
// RUN_LIVE=1 so normal `go test` stays offline/fast.
func TestLiveSAMetroSmoke(t *testing.T) {
	if os.Getenv("RUN_LIVE") != "1" {
		t.Skip("set RUN_LIVE=1 to hit the live SA CKAN API")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	obs, err := ingestSAMetroMedians(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) < 100 {
		t.Fatalf("expected many SA suburb observations, got %d", len(obs))
	}
	for _, o := range obs {
		if o.Source != "vg_sa" || o.Measure != "median_price" || o.Value <= 0 || o.RegionType != "suburb" {
			t.Fatalf("bad live obs: %+v", o)
		}
	}
	t.Logf("live SA: %d suburb observations", len(obs))
}

func TestParseSAMetroRecord(t *testing.T) {
	rec := map[string]any{
		"_id":            float64(2),
		"City":           "ADELAIDE",
		"Suburb":         "NORTH ADELAIDE",
		"Sales 4Q 2024":  "14",
		"Median 4Q 2024": "2500000",
		"Sales 4Q 2025":  "10",
		"Median 4Q 2025": "1674000",
		"Median Change":  "-0.33",
	}
	obs := parseSAMetroRecord(rec)
	if len(obs) != 2 {
		t.Fatalf("got %d obs want 2 (two median columns)", len(obs))
	}
	byPeriod := map[string]Observation{}
	for _, o := range obs {
		if o.RegionCode != "SUBURB:SA-NORTH ADELAIDE" || o.StateCode != "SA" ||
			o.Measure != "median_price" || o.DwellingType != "house" || o.Unit != "AUD" || o.Source != "vg_sa" {
			t.Errorf("bad obs metadata: %+v", o)
		}
		byPeriod[o.Period.Format("2006-01-02")] = o
	}
	if got := byPeriod["2024-12-31"].Value; got != 2500000 {
		t.Errorf("4Q2024 median got %g want 2500000", got)
	}
	if got := byPeriod["2025-12-31"].Value; got != 1674000 {
		t.Errorf("4Q2025 median got %g want 1674000", got)
	}

	// blank median + missing suburb edge cases
	blank := parseSAMetroRecord(map[string]any{"Suburb": "ASHTON", "Median 4Q 2025": nil, "Median 4Q 2024": ""})
	if len(blank) != 0 {
		t.Errorf("blank medians should yield 0 obs, got %d", len(blank))
	}
	if len(parseSAMetroRecord(map[string]any{"Suburb": "  "})) != 0 {
		t.Errorf("empty suburb should yield 0 obs")
	}
}
