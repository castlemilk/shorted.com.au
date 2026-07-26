package houseprices

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// These tests cover the fetch-INDEPENDENT brandbrain enrichment core: the
// ExtractRealEstate client (POST + retry + decode) and the aggregate-field →
// validated-Observation mapping. The real page FETCH is out of scope; the caller
// supplies rawHTML.

// bondi is the canonical CrawlTarget used across these tests. Its capital GCCSA
// (1GSYD) is the key into the crawler's trusted ABS baseline map.
var bondi = CrawlTarget{Suburb: "bondi", Display: "Bondi", Postcode: "2026", State: "NSW", Capital: "1GSYD"}

// Real Bondi suburb-aggregate numbers used as the canned brandbrain response.
const (
	bondiHouseMedian  = 4_275_000.0
	bondiUnitMedian   = 1_457_500.0
	bondiRentalYield  = 0.023
	bondiDaysOnMarket = 26.0
	bondiAnnualGrowth = 0.0364
)

// bondiExtractJSON is a realistic ExtractRealEstate response body (snake_case,
// protojson shape). The aggregate measures live on the listing object(s).
func bondiExtractJSON() string {
	resp := reaExtract{
		Listings: []reaListing{{
			MedianHousePrice: bondiHouseMedian,
			MedianUnitPrice:  bondiUnitMedian,
			RentalYield:      bondiRentalYield,
			DaysOnMarket:     bondiDaysOnMarket,
			AnnualGrowth:     bondiAnnualGrowth,
			// ClearanceRate intentionally absent (0) — must emit no observation.
		}},
		AgencyName: "realestate.com.au",
		SourceURL:  bondi.reaURL(),
		Confidence: 0.92,
	}
	b, _ := json.Marshal(resp)
	return string(b)
}

// newCrawlerWithBaseline returns a crawler whose ABS baseline for Sydney makes
// the capital-band validation active (Bondi's $4.275M house median sits ~2.9× the
// $1.485M Sydney median — well inside the 0.15×–8× band).
func newCrawlerWithBaseline() *crawler {
	return &crawler{baselines: map[string]float64{"1GSYD": 1_485_000.0}}
}

func TestBrandbrain_ExtractRealEstate_ParsesBondi(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", got)
		}
		var req extractRealEstateReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("server could not decode request body: %v", err)
		}
		if req.SuburbHint != "Bondi" || req.StateHint != "NSW" {
			t.Errorf("hints = %q/%q, want Bondi/NSW", req.SuburbHint, req.StateHint)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(bondiExtractJSON()))
	}))
	defer srv.Close()

	x, err := extractRealEstate(context.Background(), srv.URL, "<html>...</html>", bondi.reaURL(), "Bondi", "NSW")
	if err != nil {
		t.Fatalf("extractRealEstate: %v", err)
	}
	if len(x.Listings) != 1 {
		t.Fatalf("listings = %d, want 1", len(x.Listings))
	}
	l := x.Listings[0]
	if l.MedianHousePrice != bondiHouseMedian || l.MedianUnitPrice != bondiUnitMedian {
		t.Errorf("medians = %.0f/%.0f, want %.0f/%.0f", l.MedianHousePrice, l.MedianUnitPrice, bondiHouseMedian, bondiUnitMedian)
	}
	if l.RentalYield != bondiRentalYield || l.DaysOnMarket != bondiDaysOnMarket || l.AnnualGrowth != bondiAnnualGrowth {
		t.Errorf("metrics = %.4f/%.0f/%.4f, want %.4f/%.0f/%.4f",
			l.RentalYield, l.DaysOnMarket, l.AnnualGrowth, bondiRentalYield, bondiDaysOnMarket, bondiAnnualGrowth)
	}
}

func TestBrandbrain_Observations_MapsBondi(t *testing.T) {
	cr := newCrawlerWithBaseline()
	x, err := extractFromJSON(bondiExtractJSON())
	if err != nil {
		t.Fatal(err)
	}

	obs := cr.brandbrainObservations(bondi, "rea", x)

	// Index by measure|dwelling for assertion.
	type key struct{ measure, dwelling string }
	got := map[key]Observation{}
	for _, o := range obs {
		got[key{o.Measure, o.DwellingType}] = o
	}

	want := []struct {
		measure, dwelling string
		value             float64
		unit              string
	}{
		{"median_price", "house", bondiHouseMedian, "AUD"},
		{"median_price", "unit", bondiUnitMedian, "AUD"},
		{"rental_yield", "all", bondiRentalYield, "ratio"},
		{"days_on_market", "all", bondiDaysOnMarket, "count"},
		{"price_growth_12m", "all", bondiAnnualGrowth, "ratio"},
	}

	if len(obs) != len(want) {
		t.Fatalf("got %d observations, want %d: %+v", len(obs), len(want), obs)
	}
	for _, w := range want {
		o, ok := got[key{w.measure, w.dwelling}]
		if !ok {
			t.Errorf("missing observation %s/%s", w.measure, w.dwelling)
			continue
		}
		if o.Value != w.value {
			t.Errorf("%s/%s value = %v, want %v", w.measure, w.dwelling, o.Value, w.value)
		}
		if o.Unit != w.unit {
			t.Errorf("%s/%s unit = %q, want %q", w.measure, w.dwelling, o.Unit, w.unit)
		}
		// Shared fields are identical across all observations.
		if o.RegionCode != bondi.regionCode() || o.RegionType != "suburb" || o.RegionName != bondi.regionName() {
			t.Errorf("%s/%s region fields wrong: %q/%q/%q", w.measure, w.dwelling, o.RegionCode, o.RegionType, o.RegionName)
		}
		if o.StateCode != "NSW" || o.Postcode != "2026" {
			t.Errorf("%s/%s state/postcode wrong: %q/%q", w.measure, w.dwelling, o.StateCode, o.Postcode)
		}
		if o.Source != "brandbrain_rea" {
			t.Errorf("%s/%s source = %q, want brandbrain_rea", w.measure, w.dwelling, o.Source)
		}
		if o.SourceLicence != "proprietary-tos-restricted" {
			t.Errorf("%s/%s licence = %q, want proprietary-tos-restricted", w.measure, w.dwelling, o.SourceLicence)
		}
		if o.PeriodFreq != "Q" {
			t.Errorf("%s/%s period_freq = %q, want Q", w.measure, w.dwelling, o.PeriodFreq)
		}
	}

	// ClearanceRate was absent → no auction_clearance observation.
	if _, ok := got[key{"auction_clearance", "all"}]; ok {
		t.Error("absent clearance_rate must not emit an observation")
	}
}

func TestBrandbrain_Observations_DomainSource(t *testing.T) {
	cr := newCrawlerWithBaseline()
	x := &reaExtract{Listings: []reaListing{{MedianHousePrice: bondiHouseMedian}}}
	obs := cr.brandbrainObservations(bondi, "domain", x)
	if len(obs) != 1 || obs[0].Source != "brandbrain_domain" {
		t.Fatalf("domain site should map to brandbrain_domain: %+v", obs)
	}
}

func TestBrandbrain_Observations_PoisonedMedianDropped(t *testing.T) {
	cr := newCrawlerWithBaseline() // Sydney baseline 1.485M active
	// $50M for a ~$1M-band suburb: passes the absolute ceiling? No — 50M is at the
	// absolute boundary but >8× the capital median, so the capital-band gate drops
	// it. Unit median stays clean and must still come through.
	x := &reaExtract{Listings: []reaListing{{
		MedianHousePrice: 50_000_000,
		MedianUnitPrice:  bondiUnitMedian,
	}}}

	obs := cr.brandbrainObservations(bondi, "rea", x)

	for _, o := range obs {
		if o.Measure == "median_price" && o.DwellingType == "house" {
			t.Fatalf("poisoned house median $50M must be dropped, got %v", o.Value)
		}
	}
	// The clean unit median should survive.
	found := false
	for _, o := range obs {
		if o.Measure == "median_price" && o.DwellingType == "unit" && o.Value == bondiUnitMedian {
			found = true
		}
	}
	if !found {
		t.Error("clean unit median should survive the poison gate")
	}
}

func TestBrandbrain_Observations_NonPriceOutOfBoundsDropped(t *testing.T) {
	cr := newCrawlerWithBaseline()
	x := &reaExtract{Listings: []reaListing{{
		RentalYield:   0.5,   // >0.2 → drop
		ClearanceRate: 1.5,   // >1.0 → drop
		AnnualGrowth:  2.0,   // >1.0 → drop
		DaysOnMarket:  400.0, // >365 → drop
	}}}
	obs := cr.brandbrainObservations(bondi, "rea", x)
	if len(obs) != 0 {
		t.Fatalf("all four out-of-bounds metrics must be dropped, got %+v", obs)
	}
}

func TestBrandbrain_Observations_ZeroFieldEmitsNothing(t *testing.T) {
	cr := newCrawlerWithBaseline()
	// A listing with every aggregate field zero/absent.
	x := &reaExtract{Listings: []reaListing{{}}}
	if obs := cr.brandbrainObservations(bondi, "rea", x); len(obs) != 0 {
		t.Fatalf("a fully-empty listing must emit no observations, got %+v", obs)
	}
	// nil extract / no listings → nothing.
	if obs := cr.brandbrainObservations(bondi, "rea", nil); obs != nil {
		t.Fatalf("nil extract must emit no observations, got %+v", obs)
	}
	if obs := cr.brandbrainObservations(bondi, "rea", &reaExtract{}); obs != nil {
		t.Fatalf("empty listings must emit no observations, got %+v", obs)
	}
}

func TestBrandbrain_ExtractRealEstate_RetriesOn5xx(t *testing.T) {
	// Speed up the backoff schedule for the test, restore afterwards.
	orig := brandbrainBackoffs
	brandbrainBackoffs = []time.Duration{1 * time.Millisecond, 1 * time.Millisecond, 1 * time.Millisecond}
	defer func() { brandbrainBackoffs = orig }()

	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n == 1 {
			http.Error(w, "upstream overloaded", http.StatusBadGateway) // 502 first
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(bondiExtractJSON()))
	}))
	defer srv.Close()

	x, err := extractRealEstate(context.Background(), srv.URL, "<html>", bondi.reaURL(), "Bondi", "NSW")
	if err != nil {
		t.Fatalf("extractRealEstate should succeed after a 502 retry: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("expected 2 calls (502 then 200), got %d", got)
	}
	if len(x.Listings) != 1 || x.Listings[0].MedianHousePrice != bondiHouseMedian {
		t.Errorf("retry response not parsed correctly: %+v", x)
	}
}

func TestBrandbrain_ExtractRealEstate_GivesUpAfterAll5xx(t *testing.T) {
	orig := brandbrainBackoffs
	brandbrainBackoffs = []time.Duration{1 * time.Millisecond, 1 * time.Millisecond, 1 * time.Millisecond}
	defer func() { brandbrainBackoffs = orig }()

	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		http.Error(w, "still down", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	if _, err := extractRealEstate(context.Background(), srv.URL, "<html>", bondi.reaURL(), "Bondi", "NSW"); err == nil {
		t.Fatal("expected error after exhausting retries on persistent 5xx")
	}
	if got := atomic.LoadInt32(&calls); got != int32(len(brandbrainBackoffs)) {
		t.Errorf("expected %d attempts, got %d", len(brandbrainBackoffs), got)
	}
}

// extractFromJSON is a tiny test helper that decodes a canned response body the
// same way extractRealEstate's decoder does (without a live server).
func extractFromJSON(s string) (*reaExtract, error) {
	var x reaExtract
	if err := json.Unmarshal([]byte(s), &x); err != nil {
		return nil, err
	}
	return &x, nil
}
