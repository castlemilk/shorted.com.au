package houseprices

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// crawl_brandbrain.go is the FETCH-INDEPENDENT enrichment core of the Tier-3
// crawl: given already-fetched, real-browser-rendered suburb-page HTML, it
// extracts an allowlisted counts/aggregate-only projection, calls brandbrain's
// ExtractRealEstate RPC with that projection, and maps the suburb AGGREGATE
// fields it returns into validated EAV Observations. Raw portal HTML and listing
// rows never cross this boundary.
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

type brandbrainAggregateField struct {
	Name  string `json:"name"`
	Value any    `json:"value"`
}

type brandbrainMediansContract struct {
	AggregateFields []brandbrainAggregateField `json:"aggregate_fields"`
}

// brandbrainMediansPayload reduces rendered portal HTML to an allowlisted set
// of suburb aggregate metrics and result counts before it leaves the crawl rig.
// It deliberately has no raw-page fallback: schema drift may cost the dormant
// medians tier an observation, but must never silently widen the data contract
// back to listing IDs, addresses, asking prices, agents, or arbitrary fields.
func brandbrainMediansPayload(rawHTML string) string {
	contract := brandbrainMediansContract{AggregateFields: []brandbrainAggregateField{}}
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(rawHTML))
	if err == nil {
		seen := make(map[string]struct{})
		doc.Find("script").Each(func(_ int, script *goquery.Selection) {
			for _, blob := range jsonBlobs(script.Text()) {
				var value any
				if err := json.Unmarshal([]byte(blob), &value); err == nil {
					walkBrandbrainAggregates(value, &contract.AggregateFields, seen, 0)
				}
			}
		})
	}
	contract.AggregateFields = withoutAmbiguousBrandbrainMedians(contract.AggregateFields)
	payload, _ := json.Marshal(contract) // scalar allowlist values are always JSON-safe
	return string(payload)
}

func walkBrandbrainAggregates(value any, fields *[]brandbrainAggregateField, seen map[string]struct{}, depth int) {
	if depth > 40 {
		return
	}
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			child := typed[key]
			if name := brandbrainAggregateName(key); name != "" {
				number, ok := brandbrainAggregateNumber(name, child)
				if !ok {
					walkBrandbrainAggregates(child, fields, seen, depth+1)
					continue
				}
				encoded, _ := json.Marshal(number)
				dedupeKey := name + "\x00" + string(encoded)
				if _, exists := seen[dedupeKey]; !exists {
					seen[dedupeKey] = struct{}{}
					*fields = append(*fields, brandbrainAggregateField{Name: name, Value: number})
				}
			}
			walkBrandbrainAggregates(child, fields, seen, depth+1)
		}
	case []any:
		for _, child := range typed {
			walkBrandbrainAggregates(child, fields, seen, depth+1)
		}
	case string:
		trimmed := strings.TrimSpace(typed)
		if len(trimmed) > 1 && (trimmed[0] == '{' || trimmed[0] == '[') {
			var nested any
			if err := json.Unmarshal([]byte(trimmed), &nested); err == nil {
				walkBrandbrainAggregates(nested, fields, seen, depth+1)
			}
		}
	}
}

func brandbrainAggregateName(key string) string {
	normalized := strings.Map(func(r rune) rune {
		switch {
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		default:
			return -1
		}
	}, key)

	switch normalized {
	case "listingstotal":
		return "listings_total"
	case "totalresultscount", "totalresults", "actualtotalresults", "totallistings":
		return "total_results"
	case "pagesize":
		return "page_size"
	case "totalpages", "maxpagenumberavailable":
		return "total_pages"
	case "medianhouseprice", "housemedianprice", "medianpricehouse":
		return "median_house_price"
	case "medianunitprice", "unitmedianprice", "medianpriceunit", "medianapartmentprice", "apartmentmedianprice", "medianpriceapartment":
		return "median_unit_price"
	case "medianprice", "mediansaleprice", "mediansoldprice":
		return "median_sale_price"
	case "rentalyield", "grossrentalyield":
		return "rental_yield"
	case "daysonmarket", "avgdaysonmarket", "averagedaysonmarket":
		return "days_on_market"
	case "clearancerate", "auctionclearancerate":
		return "clearance_rate"
	case "annualgrowth", "annualpricegrowth", "pricegrowth", "pricegrowth12m":
		return "annual_growth"
	default:
		return ""
	}
}

const maxBrandbrainNumericStringLength = 32

func brandbrainAggregateNumber(name string, value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, !math.IsNaN(typed) && !math.IsInf(typed, 0)
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" || len(trimmed) > maxBrandbrainNumericStringLength {
			return 0, false
		}
		if strings.HasPrefix(name, "median_") {
			if !isBrandbrainMoneyString(trimmed) {
				return 0, false
			}
			number, ok := toMoney(trimmed)
			return number, ok && !math.IsNaN(number) && !math.IsInf(number, 0)
		}
		number, err := strconv.ParseFloat(trimmed, 64)
		return number, err == nil && !math.IsNaN(number) && !math.IsInf(number, 0)
	default:
		return 0, false
	}
}

func isBrandbrainMoneyString(value string) bool {
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9':
		case r == '$', r == ',', r == '.', r == ' ', r == '\t', r == 'm', r == 'M', r == 'k', r == 'K':
		default:
			return false
		}
	}
	return true
}

func withoutAmbiguousBrandbrainMedians(fields []brandbrainAggregateField) []brandbrainAggregateField {
	medianValues := make(map[string]float64)
	ambiguous := make(map[string]bool)
	for _, field := range fields {
		if !strings.HasPrefix(field.Name, "median_") {
			continue
		}
		value, ok := field.Value.(float64)
		if !ok {
			ambiguous[field.Name] = true
			continue
		}
		if previous, exists := medianValues[field.Name]; exists && previous != value {
			ambiguous[field.Name] = true
		} else {
			medianValues[field.Name] = value
		}
	}
	if len(ambiguous) == 0 {
		return fields
	}
	filtered := make([]brandbrainAggregateField, 0, len(fields))
	for _, field := range fields {
		if !ambiguous[field.Name] {
			filtered = append(filtered, field)
		}
	}
	return filtered
}

// brandbrainBackoffs is the serial retry schedule for the (sometimes 502-ing
// under load) brandbrain RPC: 3 tries total, sleeping 1s/3s/6s between them.
var brandbrainBackoffs = []time.Duration{1 * time.Second, 3 * time.Second, 6 * time.Second}

// brandbrainHTTPClient is the shared client for the RPC call. It has a generous
// timeout because the extractor still runs an LLM over the aggregate projection.
var brandbrainHTTPClient = &http.Client{Timeout: 90 * time.Second}

var errBrandbrainProjectionEmpty = errors.New("brandbrain aggregate projection is empty")

// extractRealEstate POSTs an aggregate-only projection to brandbrain's
// ExtractRealEstate RPC and decodes the response. It retries on 5xx (brandbrain
// 502s under load) with the 1s/3s/6s backoff; 4xx and decode errors fail fast.
func extractRealEstate(ctx context.Context, endpoint, rawHTML, pageURL, suburb, state string) (*reaExtract, error) {
	if endpoint == "" {
		endpoint = brandbrainEndpoint()
	}
	projection := brandbrainMediansPayload(rawHTML)
	var contract brandbrainMediansContract
	if err := json.Unmarshal([]byte(projection), &contract); err != nil {
		return nil, fmt.Errorf("decode local aggregate projection: %w", err)
	}
	if len(contract.AggregateFields) == 0 {
		return nil, errBrandbrainProjectionEmpty
	}
	body, err := json.Marshal(extractRealEstateReq{
		HTML:       projection,
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
