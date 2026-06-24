package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// SA Valuer-General "Metropolitan Median House Sales" — quarterly suburb-level
// median house prices for metro Adelaide, published on data.sa.gov.au (CKAN,
// CC-BY). Each quarterly resource is a YoY comparison with dynamic median
// columns ("Median 4Q 2025", "Median 4Q 2024", …); active resources are exposed
// as queryable JSON via the CKAN datastore, so no spreadsheet parsing is needed.
const (
	saCKANBase   = "https://data.sa.gov.au/data/api/3/action"
	saPackageID  = "metro-median-house-sales"
	saLicence    = "CC-BY"
	saSource     = "vg_sa"
	ckanPageSize = 2000
)

// "Median 4Q 2025" → quarter 4, year 2025.
var saMedianCol = regexp.MustCompile(`^Median\s+(\d)Q\s+(\d{4})$`)

type ckanResource struct {
	ID              string `json:"id"`
	Format          string `json:"format"`
	Name            string `json:"name"`
	DatastoreActive bool   `json:"datastore_active"`
}

func fetchCKANJSON(ctx context.Context, url string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", absUA)
	req.Header.Set("Accept", "application/json")
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("CKAN %s: HTTP %d: %s", url, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// ingestSAMetroMedians iterates every datastore-backed quarterly resource and
// extracts suburb median house prices into Observations.
func ingestSAMetroMedians(ctx context.Context) ([]Observation, error) {
	var pkg struct {
		Result struct {
			Resources []ckanResource `json:"resources"`
		} `json:"result"`
	}
	if err := fetchCKANJSON(ctx, saCKANBase+"/package_show?id="+saPackageID, &pkg); err != nil {
		return nil, err
	}

	seen := map[string]bool{} // region_code|period dedupe across overlapping resources
	var obs []Observation
	active, skipped := 0, 0
	for _, r := range pkg.Result.Resources {
		if !r.DatastoreActive {
			skipped++
			continue
		}
		active++
		recs, err := fetchSADatastore(ctx, r.ID)
		if err != nil {
			log.Printf("[vg_sa] resource %s (%s): %v — skipping", r.ID, r.Name, err)
			continue
		}
		for _, rec := range recs {
			for _, o := range parseSAMetroRecord(rec) {
				key := o.RegionCode + "|" + o.Period.Format("2006-01-02")
				if seen[key] {
					continue
				}
				seen[key] = true
				obs = append(obs, o)
			}
		}
	}
	log.Printf("[vg_sa] %d active resources (%d non-datastore skipped) → %d suburb observations", active, skipped, len(obs))
	return obs, nil
}

// fetchSADatastore pages through one datastore resource's records.
func fetchSADatastore(ctx context.Context, resourceID string) ([]map[string]any, error) {
	var all []map[string]any
	for offset := 0; ; offset += ckanPageSize {
		var page struct {
			Result struct {
				Total   int              `json:"total"`
				Records []map[string]any `json:"records"`
			} `json:"result"`
		}
		url := fmt.Sprintf("%s/datastore_search?resource_id=%s&limit=%d&offset=%d", saCKANBase, resourceID, ckanPageSize, offset)
		if err := fetchCKANJSON(ctx, url, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Result.Records...)
		if len(page.Result.Records) < ckanPageSize || len(all) >= page.Result.Total {
			break
		}
	}
	return all, nil
}

// parseSAMetroRecord turns one datastore record into median_price observations
// — one per "Median <N>Q <YYYY>" column that has a value.
func parseSAMetroRecord(rec map[string]any) []Observation {
	suburb := strings.TrimSpace(ckanStr(rec["Suburb"]))
	if suburb == "" {
		return nil
	}
	regionCode := "SUBURB:SA-" + strings.ToUpper(suburb)
	var obs []Observation
	for k, v := range rec {
		m := saMedianCol.FindStringSubmatch(strings.TrimSpace(k))
		if m == nil {
			continue
		}
		valStr := strings.TrimSpace(ckanStr(v))
		if valStr == "" {
			continue
		}
		val, err := strconv.ParseFloat(valStr, 64)
		if err != nil || val <= 0 {
			continue
		}
		period, err := quarterEnd(m[2] + "-Q" + m[1]) // year-Qn
		if err != nil {
			continue
		}
		obs = append(obs, Observation{
			RegionCode: regionCode, RegionType: "suburb", RegionName: suburb, StateCode: "SA",
			Measure: "median_price", DwellingType: "house", Period: period, PeriodFreq: "Q",
			Value: val, Unit: "AUD", IsPreliminary: false,
			Source: saSource, SourceLicence: saLicence,
		})
	}
	return obs
}

// ckanStr coerces a JSON datastore cell (string | number | nil) to a string.
func ckanStr(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case json.Number:
		return x.String()
	default:
		return fmt.Sprintf("%v", x)
	}
}
