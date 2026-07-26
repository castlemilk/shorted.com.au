package houseprices

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

// crawl_brandbrain.go is the FETCH-INDEPENDENT enrichment core of the Tier-3
// crawl: given already-fetched, real-browser-rendered suburb-page HTML, it calls
// brandbrain's ExtractRealEstate RPC (an LLM extractor) and maps the suburb
// AGGREGATE fields it returns into validated EAV Observations.
//
// The page FETCH is deliberately NOT wired here — the caller will pass `rawHTML`
// from a real-browser fetch in a later step. This separation keeps the
// extraction + validation + mapping logic fully unit-testable against canned
// brandbrain responses without touching the adversarial live sites.
//
// Every value still goes through the SAME anti-poisoning gate as the raw crawl:
// median prices are checked against the trusted ABS capital-city baseline via
// validateMedian; non-price measures get simple sanity bounds. Anything that
// fails is dropped (and logged), never stored.

const defaultBrandbrainEndpoint = "https://api.brandbrain.dev/brandbrain.v1.DiscoveryService/ExtractRealEstate"

// brandbrainEndpoint returns the FULL ExtractRealEstate endpoint URL, honouring
// the BRANDBRAIN_URL override (which is expected to be the complete endpoint).
func brandbrainEndpoint() string {
	if v := os.Getenv("BRANDBRAIN_URL"); v != "" {
		return v
	}
	return defaultBrandbrainEndpoint
}

// reaExtract mirrors the ExtractRealEstate response — only the fields we use. For
// suburb pages the meaningful data is the suburb-aggregate fields carried on each
// listing object; we read them from whichever listing first provides a value.
type reaExtract struct {
	Listings   []reaListing `json:"listings"`
	AgencyName string       `json:"agency_name"`
	SourceURL  string       `json:"source_url"`
	Confidence float64      `json:"confidence"`
	Notes      string       `json:"notes"`
}

// reaListing carries the suburb-aggregate measures we map to Observations. A 0
// (or absent) value means "not present" and is skipped — never emitted as a
// zero-value Observation.
type reaListing struct {
	MedianHousePrice float64 `json:"median_house_price"`
	MedianUnitPrice  float64 `json:"median_unit_price"`
	RentalYield      float64 `json:"rental_yield"`
	DaysOnMarket     float64 `json:"days_on_market"`
	ClearanceRate    float64 `json:"clearance_rate"`
	AnnualGrowth     float64 `json:"annual_growth"`
}

// extractRealEstateReq is the protojson request body (snake_case keys).
type extractRealEstateReq struct {
	HTML       string `json:"html"`
	URL        string `json:"url"`
	SuburbHint string `json:"suburb_hint"`
	StateHint  string `json:"state_hint"`
}

// brandbrainBackoffs is the serial retry schedule for the (sometimes 502-ing
// under load) brandbrain RPC: 3 tries total, sleeping 1s/3s/6s between them.
var brandbrainBackoffs = []time.Duration{1 * time.Second, 3 * time.Second, 6 * time.Second}

// brandbrainHTTPClient is the shared client for the RPC call. It has a generous
// timeout because the extractor runs an LLM over a full rendered page.
var brandbrainHTTPClient = &http.Client{Timeout: 90 * time.Second}

// extractRealEstate POSTs the rendered HTML to brandbrain's ExtractRealEstate RPC
// and decodes the response. It retries on 5xx (brandbrain 502s under load) with
// the 1s/3s/6s backoff; 4xx and decode errors fail fast.
func extractRealEstate(ctx context.Context, endpoint, rawHTML, pageURL, suburb, state string) (*reaExtract, error) {
	if endpoint == "" {
		endpoint = brandbrainEndpoint()
	}
	body, err := json.Marshal(extractRealEstateReq{
		HTML:       rawHTML,
		URL:        pageURL,
		SuburbHint: suburb,
		StateHint:  state,
	})
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt < len(brandbrainBackoffs); attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(brandbrainBackoffs[attempt]):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("build request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")

		resp, err := brandbrainHTTPClient.Do(req)
		if err != nil {
			lastErr = err
			continue // transient (network/timeout) — retry
		}

		if resp.StatusCode >= 500 {
			drainClose(resp.Body)
			lastErr = fmt.Errorf("brandbrain %d", resp.StatusCode)
			continue // 5xx (e.g. 502 under load) — retry
		}
		if resp.StatusCode != http.StatusOK {
			snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			drainClose(resp.Body)
			return nil, fmt.Errorf("brandbrain %d: %s", resp.StatusCode, string(snippet))
		}

		var out reaExtract
		dec := json.NewDecoder(resp.Body)
		decErr := dec.Decode(&out)
		drainClose(resp.Body)
		if decErr != nil {
			return nil, fmt.Errorf("decode response: %w", decErr)
		}
		return &out, nil
	}
	return nil, fmt.Errorf("brandbrain ExtractRealEstate failed after %d attempts: %w", len(brandbrainBackoffs), lastErr)
}

func drainClose(rc io.ReadCloser) {
	_, _ = io.Copy(io.Discard, rc)
	_ = rc.Close()
}

// non-price measure sanity bounds (the analogue of validateMedian for the
// aggregate metrics that aren't dollar medians).
const (
	minRentalYield   = 0.0
	maxRentalYield   = 0.2 // 20% gross yield is already absurd for AU residential
	minClearanceRate = 0.0
	maxClearanceRate = 1.0
	minAnnualGrowth  = -0.5
	maxAnnualGrowth  = 1.0
	minDaysOnMarket  = 0.0
	maxDaysOnMarket  = 365.0
)

// brandbrainSource maps a site key ("rea"/"domain", or any other) to the
// canonical Source string for brandbrain-extracted observations.
func brandbrainSource(site string) string {
	if site == "domain" {
		return "brandbrain_domain"
	}
	return "brandbrain_rea"
}

// firstNonZero returns the first non-zero value produced by sel across listings,
// since the suburb-aggregate fields are carried (redundantly) on listing objects
// and not every listing necessarily populates every metric.
func firstNonZero(listings []reaListing, sel func(reaListing) float64) float64 {
	for _, l := range listings {
		if v := sel(l); v != 0 {
			return v
		}
	}
	return 0
}

// brandbrainObservations maps the suburb-aggregate fields from a brandbrain
// extraction into validated EAV Observations for one CrawlTarget.
//
//   - median_house_price / median_unit_price → median_price (house|unit), AUD,
//     gated through validateMedian against the trusted ABS capital baseline.
//   - rental_yield / days_on_market / clearance_rate / annual_growth → their
//     respective measures (all dwellings), gated by simple sanity bounds.
//
// site is "rea" or "domain" (anything else maps to brandbrain_rea). Zero/absent
// fields and out-of-bounds values are skipped (the latter logged).
func (cr *crawler) brandbrainObservations(t CrawlTarget, site string, x *reaExtract) []Observation {
	if x == nil || len(x.Listings) == 0 {
		return nil
	}
	source := brandbrainSource(site)
	baseline := cr.baselines[t.Capital] // 0 == unknown -> capital-band check skipped

	// base returns an Observation with all the shared region/period/source fields
	// populated; the caller fills measure/dwelling/value/unit.
	base := func(measure, dwelling string, value float64, unit string) Observation {
		return Observation{
			RegionCode:    t.regionCode(),
			RegionType:    "suburb",
			RegionName:    t.regionName(),
			StateCode:     t.State,
			Postcode:      t.Postcode,
			Measure:       measure,
			DwellingType:  dwelling,
			Period:        currentQuarterEnd(),
			PeriodFreq:    "Q",
			Value:         value,
			Unit:          unit,
			IsPreliminary: false,
			Source:        source,
			// ToS-restricted: gated out of any commercial/republished surface via
			// the house_prices.source_licence column.
			SourceLicence: "proprietary-tos-restricted",
		}
	}

	var obs []Observation

	// --- median prices (anti-poisoning capital-band gate) ---
	if v := firstNonZero(x.Listings, func(l reaListing) float64 { return l.MedianHousePrice }); v != 0 {
		if res := validateMedian(v, baseline); res.ok {
			obs = append(obs, base("median_price", "house", v, "AUD"))
		} else {
			log.Printf("[brandbrain] %s: dropped house median $%.0f (%s)", t.Display, v, res.reason)
		}
	}
	if v := firstNonZero(x.Listings, func(l reaListing) float64 { return l.MedianUnitPrice }); v != 0 {
		if res := validateMedian(v, baseline); res.ok {
			obs = append(obs, base("median_price", "unit", v, "AUD"))
		} else {
			log.Printf("[brandbrain] %s: dropped unit median $%.0f (%s)", t.Display, v, res.reason)
		}
	}

	// --- non-price measures (simple sanity bounds) ---
	if v := firstNonZero(x.Listings, func(l reaListing) float64 { return l.RentalYield }); v != 0 {
		if inBounds(v, minRentalYield, maxRentalYield) {
			obs = append(obs, base("rental_yield", "all", v, "ratio"))
		} else {
			log.Printf("[brandbrain] %s: dropped rental_yield %.4f (out of bounds)", t.Display, v)
		}
	}
	if v := firstNonZero(x.Listings, func(l reaListing) float64 { return l.DaysOnMarket }); v != 0 {
		if inBounds(v, minDaysOnMarket, maxDaysOnMarket) {
			obs = append(obs, base("days_on_market", "all", v, "count"))
		} else {
			log.Printf("[brandbrain] %s: dropped days_on_market %.0f (out of bounds)", t.Display, v)
		}
	}
	if v := firstNonZero(x.Listings, func(l reaListing) float64 { return l.ClearanceRate }); v != 0 {
		if inBounds(v, minClearanceRate, maxClearanceRate) {
			obs = append(obs, base("auction_clearance", "all", v, "ratio"))
		} else {
			log.Printf("[brandbrain] %s: dropped auction_clearance %.4f (out of bounds)", t.Display, v)
		}
	}
	if v := firstNonZero(x.Listings, func(l reaListing) float64 { return l.AnnualGrowth }); v != 0 {
		if inBounds(v, minAnnualGrowth, maxAnnualGrowth) {
			obs = append(obs, base("price_growth_12m", "all", v, "ratio"))
		} else {
			log.Printf("[brandbrain] %s: dropped price_growth_12m %.4f (out of bounds)", t.Display, v)
		}
	}

	return obs
}

func inBounds(v, lo, hi float64) bool {
	return v >= lo && v <= hi
}
