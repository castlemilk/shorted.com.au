package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// These tests cover the fetch-INDEPENDENT brandbrain enrichment core: the
// counts/aggregate-only outbound contract, ExtractRealEstate client (POST + retry
// + decode), and aggregate-field → validated-Observation mapping. The real page
// FETCH is out of scope; the caller supplies rawHTML, which is projected locally.

// bondi is the canonical CrawlTarget used across these tests. Its capital GCCSA
// (1GSYD) is the key into the crawler's trusted ABS baseline map.
var bondi = CrawlTarget{Suburb: "bondi", Display: "Bondi", Postcode: "2026", State: "NSW", Capital: "1GSYD"}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

// Real Bondi suburb-aggregate numbers used as the canned brandbrain response.
const (
	bondiHouseMedian  = 4_275_000.0
	bondiUnitMedian   = 1_457_500.0
	bondiRentalYield  = 0.023
	bondiDaysOnMarket = 26.0
	bondiAnnualGrowth = 0.0364
)

const bondiProjectionHTML = `<html><body><script type="application/json">{"medianHousePrice":1850000}</script></body></html>`

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

	x, err := extractRealEstate(context.Background(), srv.URL, bondiProjectionHTML, bondi.reaURL(), "Bondi", "NSW")
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

func TestBrandbrain_ExtractRealEstate_SendsAggregateOnlyPayload(t *testing.T) {
	rawHTML := `<html><body><script>window.portal = {
		"listing":{"id":"listing-id-must-not-cross","address":"10 Private Street","price":"$1,234,567","agent":{"name":"Private Agent"},"vendorSecret":"private-value"},
		"suburbInsights":{"medianHousePrice":1850000,"medianUnitPrice":920000,"rentalYield":0.031,"avgDaysOnMarket":42,"auctionClearanceRate":0.67},
		"encoded":"{\"annualGrowth\":0.045,\"address\":\"Nested Private Street\"}",
		"listings_total":2,"totalResultsCount":104,"pageSize":25
	};</script></body></html>`

	originalClient := brandbrainHTTPClient
	brandbrainHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var req extractRealEstateReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		for _, want := range []string{"median_house_price", "median_unit_price", "rental_yield", "days_on_market", "clearance_rate", "annual_growth", "listings_total", "total_results", "page_size"} {
			if !strings.Contains(req.HTML, want) {
				t.Errorf("aggregate payload missing %q: %s", want, req.HTML)
			}
		}
		for _, forbidden := range []string{"listing-id-must-not-cross", "10 Private Street", "Nested Private Street", "$1,234,567", "Private Agent", "private-value", "vendorSecret"} {
			if strings.Contains(req.HTML, forbidden) {
				t.Errorf("listing-level field leaked to brandbrain: %q in %s", forbidden, req.HTML)
			}
		}

		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(bondiExtractJSON())),
		}, nil
	})}
	defer func() { brandbrainHTTPClient = originalClient }()

	if _, err := extractRealEstate(context.Background(), "http://brandbrain.test/extract", rawHTML, bondi.reaURL(), "Bondi", "NSW"); err != nil {
		t.Fatalf("extractRealEstate: %v", err)
	}
}

func TestBrandbrainMediansPayload_RejectsHostileValuesUnderAllowedKeys(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		value any
	}{
		{name: "address agent and asking price", key: "medianHousePrice", value: "Sold by Jane Agent of 12 Smith St for $2,100,000"},
		{name: "raw html", key: "medianUnitPrice", value: `<div data-listing-id="listing-99887">Private Agent</div>`},
		{name: "listing id and address", key: "daysOnMarket", value: "listing-id-99887 at 4 Ocean Rd"},
		{name: "arbitrary label", key: "rentalYield", value: "Contact Ray White Bondi"},
		{name: "boolean", key: "auctionClearanceRate", value: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			blob, err := json.Marshal(map[string]any{tt.key: tt.value})
			if err != nil {
				t.Fatal(err)
			}
			rawHTML := `<script type="application/json">` + string(blob) + `</script>`
			contract := decodeBrandbrainContract(t, brandbrainMediansPayload(rawHTML))
			if len(contract.AggregateFields) != 0 {
				t.Fatalf("hostile value under %q survived projection: %+v", tt.key, contract.AggregateFields)
			}
		})
	}
}

func TestBrandbrainMediansPayload_ParsesMoneyStringToNumber(t *testing.T) {
	rawHTML := `<script type="application/json">{"medianHousePrice":"$1,850,000"}</script>`
	contract := decodeBrandbrainContract(t, brandbrainMediansPayload(rawHTML))
	if len(contract.AggregateFields) != 1 {
		t.Fatalf("aggregate fields = %+v, want one parsed median", contract.AggregateFields)
	}
	field := contract.AggregateFields[0]
	if field.Name != "median_house_price" || field.Value != float64(1_850_000) {
		t.Fatalf("parsed field = %+v, want numeric median_house_price=1850000", field)
	}
}

func TestBrandbrainMediansPayload_RejectsContextualMedianKeys(t *testing.T) {
	rawHTML := `<script type="application/json">{
		"medianHousePrice12MonthsAgo":1620000,
		"nearbySuburbMedianHousePrice":1710000,
		"medianPriceHouse2019":1450000,
		"daysOnMarket":42
	}</script>`
	contract := decodeBrandbrainContract(t, brandbrainMediansPayload(rawHTML))
	if len(contract.AggregateFields) != 1 || contract.AggregateFields[0].Name != "days_on_market" {
		t.Fatalf("contextual medians must not be projected as current medians: %+v", contract.AggregateFields)
	}
}

func TestBrandbrainMediansPayload_DropsAmbiguousCanonicalMedian(t *testing.T) {
	rawHTML := `<script type="application/json">{
		"medianHousePrice":1850000,
		"houseMedianPrice":1620000,
		"rentalYield":0.031
	}</script>`
	contract := decodeBrandbrainContract(t, brandbrainMediansPayload(rawHTML))
	if len(contract.AggregateFields) != 1 || contract.AggregateFields[0].Name != "rental_yield" {
		t.Fatalf("distinct house medians must remove the ambiguous canonical field: %+v", contract.AggregateFields)
	}
}

func TestBrandbrain_ExtractRealEstate_SkipsEmptyProjection(t *testing.T) {
	originalClient := brandbrainHTTPClient
	var calls int32
	brandbrainHTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		atomic.AddInt32(&calls, 1)
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(bondiExtractJSON())),
		}, nil
	})}
	defer func() { brandbrainHTTPClient = originalClient }()

	if _, err := extractRealEstate(context.Background(), "http://brandbrain.test/extract", "<html><body>no aggregate scripts</body></html>", bondi.reaURL(), "Bondi", "NSW"); err == nil || !strings.Contains(err.Error(), "aggregate projection is empty") {
		t.Fatalf("extractRealEstate error = %v, want empty-projection error", err)
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Fatalf("empty projection made %d HTTP call(s), want 0", got)
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

	x, err := extractRealEstate(context.Background(), srv.URL, bondiProjectionHTML, bondi.reaURL(), "Bondi", "NSW")
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

	if _, err := extractRealEstate(context.Background(), srv.URL, bondiProjectionHTML, bondi.reaURL(), "Bondi", "NSW"); err == nil {
		t.Fatal("expected error after exhausting retries on persistent 5xx")
	}
	if got := atomic.LoadInt32(&calls); got != int32(len(brandbrainBackoffs)) {
		t.Errorf("expected %d attempts, got %d", len(brandbrainBackoffs), got)
	}
}

func decodeBrandbrainContract(t *testing.T, payload string) brandbrainMediansContract {
	t.Helper()
	var contract brandbrainMediansContract
	if err := json.Unmarshal([]byte(payload), &contract); err != nil {
		t.Fatalf("decode aggregate projection: %v (payload %q)", err, payload)
	}
	return contract
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
