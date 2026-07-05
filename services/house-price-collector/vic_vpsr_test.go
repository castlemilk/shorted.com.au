package main

import (
	"bytes"
	"context"
	"os"
	"testing"
	"time"

	"github.com/xuri/excelize/v2"
)

func vicFixture(t *testing.T) []byte {
	t.Helper()
	f := excelize.NewFile()
	sh := f.GetSheetName(0)
	set := func(cell string, value any) {
		t.Helper()
		if err := f.SetCellValue(sh, cell, value); err != nil {
			t.Fatalf("set %s: %v", cell, err)
		}
	}
	// header: Locality + scattered year columns (mimics the real wide layout)
	set("A1", "Locality")
	set("C1", "2020")
	set("E1", "2021")
	// data rows
	set("A2", "ABBOTSFORD")
	set("C2", 862500)
	set("E2", 925000)
	set("A3", "TESTBURG")
	set("C3", "-")         // no data -> skip
	set("E3", "^ 595000")  // low-count footnote -> preliminary
	set("A4", "1,234,000") // a numeric-looking non-suburb row label is fine; only data cols read
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestParseVICSuburbMedians(t *testing.T) {
	obs, err := parseVICSuburbMedians(vicFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	get := func(region string, year int) (Observation, bool) {
		for _, o := range obs {
			if o.RegionCode == region && o.Period.Year() == year {
				return o, true
			}
		}
		return Observation{}, false
	}

	ab2020, ok := get("SUBURB:VIC-ABBOTSFORD", 2020)
	if !ok || ab2020.Value != 862500 || ab2020.StateCode != "VIC" || ab2020.Measure != "median_price" ||
		ab2020.DwellingType != "house" || ab2020.PeriodFreq != "A" || ab2020.Source != "vg_vic" {
		t.Errorf("ABBOTSFORD 2020: %+v ok=%v", ab2020, ok)
	}
	if ab2020.Period != time.Date(2020, 12, 31, 0, 0, 0, 0, time.UTC) {
		t.Errorf("annual period should be year-end, got %v", ab2020.Period)
	}
	tb2021, ok := get("SUBURB:VIC-TESTBURG", 2021)
	if !ok || tb2021.Value != 595000 || !tb2021.IsPreliminary {
		t.Errorf("TESTBURG 2021 (^595000): %+v ok=%v want 595000 preliminary", tb2021, ok)
	}
	if _, ok := get("SUBURB:VIC-TESTBURG", 2020); ok {
		t.Errorf("TESTBURG 2020 was '-', should be skipped")
	}
}

// TestLiveVICSmoke hits the real CF-challenged land.vic.gov.au via stealthhttp.
// Gated behind RUN_LIVE=1.
func TestLiveVICSmoke(t *testing.T) {
	if os.Getenv("RUN_LIVE") != "1" {
		t.Skip("set RUN_LIVE=1 to hit the live VIC fetch")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	obs, err := ingestVICSuburbMedians(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) < 1000 {
		t.Fatalf("expected many VIC suburb-year medians, got %d", len(obs))
	}
	t.Logf("live VIC: %d suburb-year observations", len(obs))
}
