package economy

import (
	"testing"
	"time"
)

func vixDef() fredSeries {
	return fredSeries{"VIXCLS", "volatility", "index_close", "vix", "index", "usa", "United States", "n", true}
}

// FRED encodes a missing observation as "." — a market holiday, not a zero.
// Parsing it as a float defaults it to 0.0, which for DGS10 reads as a 0% yield
// and for VIX as a dead-calm market. "A missing input must be excluded, never
// defaulted" is the rule this guards.
func TestMonthlyLastExcludesMissingMarkers(t *testing.T) {
	obs, err := monthlyLast([]fredObservation{
		{"2026-03-30", "20.10"},
		{"2026-03-31", "."}, // holiday on the last calendar day of the month
	}, vixDef())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(obs) != 1 {
		t.Fatalf("want 1 monthly observation, got %d", len(obs))
	}
	if obs[0].Value != 20.10 {
		t.Errorf("value = %v, want 20.10 — a '.' row was parsed as a number", obs[0].Value)
	}
}

// The month's last TRADED day, not its last calendar day: the two differ
// whenever a month ends on a weekend or holiday, which is most months.
func TestMonthlyLastPicksTheLastTradedDay(t *testing.T) {
	obs, err := monthlyLast([]fredObservation{
		{"2026-01-02", "1.0"},
		{"2026-01-30", "3.0"}, // Friday — the real last print
		{"2026-01-15", "2.0"},
		{"2026-01-31", "."},   // Saturday
	}, vixDef())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(obs) != 1 || obs[0].Value != 3.0 {
		t.Fatalf("want the 30th's 3.0, got %+v", obs)
	}
	want := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if !obs[0].Period.Equal(want) {
		t.Errorf("period = %v, want the month bucket %v", obs[0].Period, want)
	}
}

// Input order is not date order — FRED can be asked descending, and a reducer
// that assumed ascending would keep the FIRST row it saw.
func TestMonthlyLastIsOrderIndependent(t *testing.T) {
	desc, err := monthlyLast([]fredObservation{
		{"2026-02-27", "9.0"},
		{"2026-02-02", "1.0"},
	}, vixDef())
	if err != nil {
		t.Fatal(err)
	}
	if desc[0].Value != 9.0 {
		t.Errorf("value = %v, want 9.0 (the later date) regardless of input order", desc[0].Value)
	}
}

func TestMonthlyLastSplitsMonthsAndSortsAscending(t *testing.T) {
	obs, err := monthlyLast([]fredObservation{
		{"2026-02-27", "2.0"},
		{"2026-01-30", "1.0"},
		{"2026-03-31", "3.0"},
	}, vixDef())
	if err != nil {
		t.Fatal(err)
	}
	if len(obs) != 3 {
		t.Fatalf("want one observation per month, got %d", len(obs))
	}
	for i := 1; i < len(obs); i++ {
		if !obs[i-1].Period.Before(obs[i].Period) {
			t.Fatalf("observations are not ascending by period: %v", obs)
		}
	}
}

// An all-missing payload is format drift, not an empty success. upsertObservations
// already refuses a zero-length batch; failing here names the series instead.
func TestMonthlyLastRefusesAnAllMissingPayload(t *testing.T) {
	if _, err := monthlyLast([]fredObservation{{"2026-03-31", "."}}, vixDef()); err == nil {
		t.Fatal("want an error when every observation is missing")
	}
}

// The catalog entry decides whether this series can ever be correlated.
// correlations.go filters overlays to monthly/quarterly in two places, so a
// series stored as "daily" would appear in the industry overlay picker and
// silently correlate against nothing.
func TestFREDSeriesAreCorrelationEligible(t *testing.T) {
	obs, err := monthlyLast([]fredObservation{{"2026-03-30", "1.0"}}, vixDef())
	if err != nil {
		t.Fatal(err)
	}
	got := obs[0].Series
	if got.Frequency != "monthly" {
		t.Errorf("frequency = %q — correlations.go only accepts monthly/quarterly overlays", got.Frequency)
	}
	if got.RegionType != "national" {
		t.Errorf("regionType = %q — eligibleCorrelationOverlay needs national to pair with an AU base", got.RegionType)
	}
	if got.RegionCode != "usa" {
		t.Errorf("regionCode = %q, want usa — the key must not read as domestic data", got.RegionCode)
	}
	if got.Dimensions["source_cadence"] != "daily" {
		t.Error("the daily upstream cadence must be recorded; monthly storage is a reduction, not the source's truth")
	}
}

// Keys are what the frontend overlay registry pins. If Key() changes shape the
// UI silently loses its overlays, so the exact strings are asserted here.
func TestFREDSeriesKeys(t *testing.T) {
	want := map[string]string{
		"VIXCLS":       "volatility.index_close.vix.usa",
		"DGS2":         "rates.treasury_yield.2y.usa",
		"DGS10":        "rates.treasury_yield.10y.usa",
		"DTWEXBGS":     "fx.usd_index.broad.usa",
		"DCOILWTICO":   "commodities.crude_oil.wti.usa",
		"DCOILBRENTEU": "commodities.crude_oil.brent.eur",
		"DEXCHUS":      "fx.spot_rate.cny_usd.chn",
		"DEXJPUS":      "fx.spot_rate.jpy_usd.jpn",
		"DEXUSEU":      "fx.spot_rate.usd_eur.eur",
	}
	for _, def := range fredSeriesDefs {
		obs, err := monthlyLast([]fredObservation{{"2026-03-30", "1.0"}}, def)
		if err != nil {
			t.Fatalf("%s: %v", def.ID, err)
		}
		if got := obs[0].Series.Key(); got != want[def.ID] {
			t.Errorf("%s key = %q, want %q", def.ID, got, want[def.ID])
		}
	}
}


// VIX is ingested but must never reach a public read surface. The licence is
// the reason (FRED: "Copyright, 2016, Chicago Board Options Exchange, Inc.
// Reprinted with permission" — granted to FRED, not onward), and the mechanism
// is migration 000121's internal_only flag.
//
// Asserted per-series rather than "at least one is internal", because the
// failure that matters is VIX silently flipping public, and a loose assertion
// would pass while the Fed series carried the flag instead.
func TestOnlyVIXIsInternal(t *testing.T) {
	want := map[string]bool{
		"VIXCLS":       true,  // CBOE copyright
		"DGS2":         false, // H.15, Federal Reserve, no copyright notice
		"DGS10":        false, // H.15
		"DTWEXBGS":     false, // H.10
		"DCOILWTICO":   false, // EIA, no copyright notice (probed 2026-09-09)
		"DCOILBRENTEU": false, // EIA
		"DEXCHUS":      false, // H.10
		"DEXJPUS":      false, // H.10
		"DEXUSEU":      false, // H.10
	}
	for _, def := range fredSeriesDefs {
		expected, known := want[def.ID]
		if !known {
			t.Fatalf("%s has no licence decision recorded — a new FRED series needs one before it ships", def.ID)
		}
		if def.InternalOnly != expected {
			t.Errorf("%s InternalOnly = %v, want %v", def.ID, def.InternalOnly, expected)
		}
		// The flag has to survive into the catalog row, or it is decoration.
		obs, err := monthlyLast([]fredObservation{{"2026-03-30", "1.0"}}, def)
		if err != nil {
			t.Fatalf("%s: %v", def.ID, err)
		}
		if obs[0].Series.InternalOnly != expected {
			t.Errorf("%s: SeriesDef.InternalOnly = %v, want %v — the flag did not reach the row",
				def.ID, obs[0].Series.InternalOnly, expected)
		}
	}
}

// Visibility is a property of the row, not of its identity. If it ever entered
// Key(), flipping a series to internal would fork its history into a second
// series_key and orphan every observation already written under the old one.
func TestInternalOnlyDoesNotAffectTheSeriesKey(t *testing.T) {
	pub := SeriesDef{Topic: "rates", Metric: "treasury_yield", Product: "10y", RegionCode: "usa"}
	priv := pub
	priv.InternalOnly = true
	if pub.Key() != priv.Key() {
		t.Errorf("key changed with visibility: %q vs %q", pub.Key(), priv.Key())
	}
}


// The RBA already publishes AUD/USD as rates.aud_usd.aus (FXRUSD, rba.go:36).
// Importing FRED's DEXUSAL alongside it would put two series behind one fact,
// differing on fixing time and rounding, with nothing saying which a caller
// should believe. Asserted rather than left to a comment, because the next
// person adding FX pairs will be reading this list and not rba.go.
func TestNoDuplicateAudUsd(t *testing.T) {
	for _, def := range fredSeriesDefs {
		if def.ID == "DEXUSAL" {
			t.Error("DEXUSAL duplicates rates.aud_usd.aus from the RBA (rba.go FXRUSD)")
		}
		obs, err := monthlyLast([]fredObservation{{"2026-03-30", "1.0"}}, def)
		if err != nil {
			t.Fatalf("%s: %v", def.ID, err)
		}
		if got := obs[0].Series.Key(); got == "rates.aud_usd.aus" {
			t.Errorf("%s produces %q, which the RBA importer already owns", def.ID, got)
		}
	}
}
