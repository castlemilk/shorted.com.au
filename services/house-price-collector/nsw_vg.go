package main

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// NSW Valuer-General Bulk Property Sales Information (PSI) — the state publishes
// EVERY property transfer (no pre-computed medians), so we aggregate raw sales
// into suburb-level annual median HOUSE prices ourselves. Files sit behind a
// Cloudflare managed challenge, so we fetch via stealthhttp's NATIVE engine —
// its browser-realistic TLS fingerprint returns the raw .zip (verified: 200
// application/zip, 14MB). A yearly.zip is a nest: 53 weekly inner .zips, each
// ~95 semicolon-delimited .DAT files (one per LGA district). We parse B-records
// (the main sale row) and keep established houses only.
//
// Field layout (verified from live 2024 data), 0-indexed on ";" split:
//
//	[9]=suburb [10]=postcode [15]=purchase price [16]=zoning [18]=purpose
//	[19]=strata-lot (non-empty ⇒ unit/apartment). purpose="RESIDENCE" cleanly
//	marks houses; "VACANT LAND"/"COMMERCIAL"/"FARM"/… are excluded.
const (
	nswPSIBase   = "https://www.valuergeneral.nsw.gov.au/__psi/yearly/"
	nswAccept    = "application/zip,application/octet-stream,*/*"
	nswSource    = "vg_nsw"
	nswLicence   = "CC-BY" // bundled creative_commons.txt; attribute "NSW Valuer-General"
	nswMinSales  = 5       // per-year sales for a suburb's annual median
	nswMinPooled = 6       // pooled-window sales for a thin suburb's single fallback median
	nswMinPrice  = 50000.0 // drop non-market transfers ($1 family transfers, etc.)
	nswYears     = 3       // trailing complete calendar years → annual series + YoY
)

type nswSale struct {
	suburb   string
	postcode string
	price    float64
}

type nswAgg struct {
	prices    []float64
	postcodes map[string]int
}

func ingestNSWSuburbMedians(ctx context.Context) ([]Observation, error) {
	client, err := stealthhttp.New(stealthhttp.WithTimeout(120 * time.Second))
	if err != nil {
		return nil, fmt.Errorf("stealth init: %w", err)
	}

	// name → year → aggregate. Keyed by UPPER suburb name (the sal_code backfill
	// matches case-insensitively, so casing is irrelevant to the join).
	agg := map[string]map[int]*nswAgg{}
	fetched := 0
	for _, yr := range nswRecentYears(nswYears) {
		url := fmt.Sprintf("%s%d.zip", nswPSIBase, yr)
		b, _, err := client.FetchBytes(ctx, url, nswAccept)
		if err != nil {
			log.Printf("[vg_nsw] fetch %d: %v — skipping", yr, err)
			continue
		}
		if len(b) < 2 || b[0] != 'P' || b[1] != 'K' { // not a zip ⇒ challenge/HTML
			log.Printf("[vg_nsw] %d: did not return a zip (%d bytes, likely a block page) — skipping", yr, len(b))
			continue
		}
		sales, err := parseNSWYearSales(b)
		if err != nil {
			log.Printf("[vg_nsw] parse %d: %v — skipping", yr, err)
			continue
		}
		for _, s := range sales {
			name := strings.ToUpper(s.suburb)
			if agg[name] == nil {
				agg[name] = map[int]*nswAgg{}
			}
			a := agg[name][yr]
			if a == nil {
				a = &nswAgg{postcodes: map[string]int{}}
				agg[name][yr] = a
			}
			a.prices = append(a.prices, s.price)
			if s.postcode != "" {
				a.postcodes[s.postcode]++
			}
		}
		fetched++
		log.Printf("[vg_nsw] %d: %d house sales", yr, len(sales))
	}
	if fetched == 0 {
		return nil, fmt.Errorf("no NSW PSI years fetched")
	}

	years := nswRecentYears(nswYears)
	latestYr := years[len(years)-1]

	// For well-traded suburbs emit an annual median per year (series + YoY). For
	// THIN suburbs (no single year clears nswMinSales) pool the whole window into
	// one current median so the map still paints them — flagged preliminary.
	var obs []Observation
	pooledN := 0
	for name, byYear := range agg {
		emitted := false
		for yr, a := range byYear {
			if len(a.prices) < nswMinSales {
				continue
			}
			obs = append(obs, nswObs(name, yr, a.prices, modalKey(a.postcodes), false))
			emitted = true
		}
		if !emitted {
			var pooled []float64
			pc := map[string]int{}
			for _, a := range byYear {
				pooled = append(pooled, a.prices...)
				for k, v := range a.postcodes {
					pc[k] += v
				}
			}
			if len(pooled) >= nswMinPooled {
				obs = append(obs, nswObs(name, latestYr, pooled, modalKey(pc), true))
				pooledN++
			}
		}
	}
	log.Printf("[vg_nsw] %d suburb-year medians (%d thin suburbs via %dyr pool) across %d years", len(obs), pooledN, nswYears, fetched)
	return obs, nil
}

func nswObs(name string, year int, prices []float64, postcode string, preliminary bool) Observation {
	return Observation{
		RegionCode: "SUBURB:NSW-" + name, RegionType: "suburb",
		RegionName: nswTitleCase(name), StateCode: "NSW", Postcode: postcode,
		Measure: "median_price", DwellingType: "house",
		Period: time.Date(year, 12, 31, 0, 0, 0, 0, time.UTC), PeriodFreq: "A",
		Value: medianFloat(prices), Unit: "AUD", IsPreliminary: preliminary,
		Source: nswSource, SourceLicence: nswLicence,
	}
}

// parseNSWYearSales walks the nested yearly zip and returns established-house sales.
func parseNSWYearSales(outer []byte) ([]nswSale, error) {
	zr, err := zip.NewReader(bytes.NewReader(outer), int64(len(outer)))
	if err != nil {
		return nil, err
	}
	var sales []nswSale
	for _, wf := range zr.File {
		if !strings.HasSuffix(strings.ToLower(wf.Name), ".zip") {
			continue
		}
		rc, err := wf.Open()
		if err != nil {
			continue
		}
		wb, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			continue
		}
		wzr, err := zip.NewReader(bytes.NewReader(wb), int64(len(wb)))
		if err != nil {
			continue
		}
		for _, df := range wzr.File {
			if !strings.HasSuffix(strings.ToUpper(df.Name), ".DAT") {
				continue
			}
			dc, err := df.Open()
			if err != nil {
				continue
			}
			db, err := io.ReadAll(dc)
			_ = dc.Close()
			if err != nil {
				continue
			}
			sales = append(sales, parseNSWDAT(db)...)
		}
	}
	return sales, nil
}

// parseNSWDAT extracts house sales from one ";"-delimited .DAT file's B-records.
func parseNSWDAT(dat []byte) []nswSale {
	var out []nswSale
	for _, line := range strings.Split(string(dat), "\n") {
		if !strings.HasPrefix(line, "B;") {
			continue
		}
		f := strings.Split(line, ";")
		if len(f) < 20 {
			continue
		}
		suburb := strings.TrimSpace(f[9])
		if suburb == "" {
			continue
		}
		if strings.TrimSpace(f[19]) != "" { // strata lot ⇒ unit/apartment, not a house
			continue
		}
		purpose := strings.ToUpper(strings.TrimSpace(f[18]))
		if !strings.Contains(purpose, "RESIDENCE") && !strings.Contains(purpose, "DWELLING") {
			continue
		}
		price, err := strconv.ParseFloat(strings.TrimSpace(f[15]), 64)
		if err != nil || price < nswMinPrice {
			continue
		}
		out = append(out, nswSale{suburb: suburb, postcode: strings.TrimSpace(f[10]), price: price})
	}
	return out
}

// nswRecentYears returns the last n COMPLETE calendar years (excludes the current,
// partial year so annual medians are stable). now() is fine in a service binary.
func nswRecentYears(n int) []int {
	last := time.Now().UTC().Year() - 1
	years := make([]int, 0, n)
	for i := n - 1; i >= 0; i-- {
		years = append(years, last-i)
	}
	return years
}

func medianFloat(v []float64) float64 {
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	n := len(s)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

func modalKey(m map[string]int) string {
	best, bestN := "", -1
	for k, v := range m {
		if v > bestN {
			best, bestN = k, v
		}
	}
	return best
}

// nswTitleCase renders an UPPER suburb name in Title Case for display/provenance;
// the sal_code join is case-insensitive so this never affects matching.
func nswTitleCase(upper string) string {
	words := strings.Fields(strings.ToLower(upper))
	for i, w := range words {
		r := []rune(w)
		if len(r) > 0 {
			r[0] = unicode.ToUpper(r[0])
		}
		words[i] = string(r)
	}
	return strings.Join(words, " ")
}
