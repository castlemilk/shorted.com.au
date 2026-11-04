package pgsource

import (
	"encoding/json"
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// The body is what a feature row freezes: its hash must not move when only a
// provenance timestamp does, or every re-fetch would write a new blob.
func TestEncodeFundamentalsHashIgnoresProvenance(t *testing.T) {
	when := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	later := when.Add(72 * time.Hour)
	rev := 100.0
	g1 := &engine.Growth{RevenueYoYPct: &rev, FetchedAt: &when}
	g2 := &engine.Growth{RevenueYoYPct: &rev, FetchedAt: &later}
	a, err := EncodeFundamentals(g1, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := EncodeFundamentals(g2, nil)
	if err != nil {
		t.Fatal(err)
	}
	if a.Hash != b.Hash || string(a.Blob) != string(b.Blob) {
		t.Fatalf("a re-fetch with the same figures changed the blob: %s vs %s", a.Hash, b.Hash)
	}
	if g1.FetchedAt == nil {
		t.Fatal("encoding must not clear the caller's own row")
	}
}

// A changed figure must change the hash.
func TestEncodeFundamentalsHashFollowsFigures(t *testing.T) {
	one, two := 1.0, 2.0
	a, _ := EncodeFundamentals(&engine.Growth{EPSYoYPct: &one}, nil)
	b, _ := EncodeFundamentals(&engine.Growth{EPSYoYPct: &two}, nil)
	if a.Hash == b.Hash {
		t.Fatal("different growth figures hashed alike")
	}
}

// The extras apply their appended columns to the growth row they belong to.
func TestEncodeFundamentalsAppliesTheGrowthBasis(t *testing.T) {
	e := &FundamentalsExtras{HasGrowthRow: true, RevenueBasisSource: "filing", EPSBasisSource: "vendor"}
	f, err := EncodeFundamentals(&engine.Growth{}, e)
	if err != nil {
		t.Fatal(err)
	}
	body, err := DecodeFundamentals(f.Blob)
	if err != nil {
		t.Fatal(err)
	}
	if body.Growth == nil || body.Growth.RevenueBasisSource != "filing" || body.Growth.EPSBasisSource != "vendor" {
		t.Fatalf("decoded growth basis = %+v", body.Growth)
	}
	if body.Quality != nil {
		t.Error("no quality row was given, so none is encoded")
	}
}

func TestDecodeFundamentalsEmptyBlob(t *testing.T) {
	body, err := DecodeFundamentals(nil)
	if err != nil || body.Growth != nil || body.Quality != nil {
		t.Fatalf("empty blob: %+v, %v", body, err)
	}
	if _, err := DecodeFundamentals([]byte("{")); err == nil {
		t.Fatal("a malformed blob must be an error")
	}
}

// The blob is plain JSON a reader can open without this package.
func TestFundamentalsBodyIsPlainJSON(t *testing.T) {
	f, _ := EncodeFundamentals(&engine.Growth{}, nil)
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(f.Blob, &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw["growth"]; !ok {
		t.Errorf("blob keys = %v, want growth", raw)
	}
}

func TestMonthlyForwardFill(t *testing.T) {
	obs := []features.RatePoint{
		{Date: civil.Date{Year: 2024, Month: 3, Day: 15}, Rate: 4.35}, // mid-month first observation
		{Date: civil.Date{Year: 2024, Month: 5, Day: 1}, Rate: 4.10},
	}
	got := monthlyForwardFill(obs, civil.Date{Year: 2024, Month: 6, Day: 30})
	want := []features.RatePoint{
		{Date: civil.Date{Year: 2024, Month: 3, Day: 1}, Rate: 4.35},
		{Date: civil.Date{Year: 2024, Month: 4, Day: 1}, Rate: 4.35},
		{Date: civil.Date{Year: 2024, Month: 5, Day: 1}, Rate: 4.10},
		{Date: civil.Date{Year: 2024, Month: 6, Day: 1}, Rate: 4.10},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d points, want %d: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("point %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	if monthlyForwardFill(nil, civil.Date{Year: 2024, Month: 6, Day: 1}) != nil {
		t.Error("no observations, no points")
	}
}

func TestMonthlyForwardFillAcrossTheYearEnd(t *testing.T) {
	obs := []features.RatePoint{{Date: civil.Date{Year: 2023, Month: 11, Day: 1}, Rate: 4.35}}
	got := monthlyForwardFill(obs, civil.Date{Year: 2024, Month: 1, Day: 1})
	if len(got) != 3 || got[2].Date != (civil.Date{Year: 2024, Month: 1, Day: 1}) {
		t.Fatalf("year rollover: %+v", got)
	}
}
