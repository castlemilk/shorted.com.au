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
// Cloudflare managed challenge that does not clear from Cloud Run. The dedicated
// `-mode vg-nsw` path therefore runs on approved residential egress and fetches
// with stealthhttp's browser-realistic NATIVE engine; it must not be turned into
// a datacenter challenge-bypass attempt. A yearly.zip is a nest: 53 weekly inner
// .zips, each ~95 semicolon-delimited .DAT files (one per LGA district). We parse
// B-records (the main sale row) and keep established houses only.
//
// Field layout (verified from live 2024 data), 0-indexed on ";" split:
//
//	[2]=property id [9]=suburb [10]=postcode [11]=area [12]=area unit (M=m²,
//	H=ha) [15]=purchase price [16]=zoning [17]=nature (R=residence, V=vacant,
//	3=other) [18]=purpose [19]=strata-lot (non-empty ⇒ unit/apartment)
//	[22]=interest of sale (%) [23]=dealing number. purpose="RESIDENCE"
//	marks houses; "VACANT LAND"/"COMMERCIAL"/"FARM"/… are excluded.
//
// A median of every RESIDENCE transfer is not a median house price: one
// contract that buys a row of houses for a tower site is lodged as one B-record
// PER PROPERTY, each carrying the whole contract price, so a single $110.5M
// amalgamation outvoted St Leonards' real house sales (and Rhodes read $22.5M).
// selectNSWHouseSales therefore keeps only a single-property, whole-interest,
// residence-natured sale outside the business/industrial/special-purpose zones,
// and not a development-sized lot in a medium/high-density zone.
const (
	nswPSIBase   = "https://www.valuergeneral.nsw.gov.au/__psi/yearly/"
	nswAccept    = "application/zip,application/octet-stream,*/*"
	nswSource    = "vg_nsw"
	nswLicence   = "CC-BY" // bundled creative_commons.txt; attribute "NSW Valuer-General"
	nswMinSales  = 5       // per-year sales for a suburb's annual median
	nswMinPooled = 6       // pooled-window sales for a thin suburb's single fallback median
	nswMinPrice  = 50000.0 // drop non-market transfers ($1 family transfers, etc.)
	nswYears     = 3       // trailing complete calendar years → annual series + YoY

	// A non-strata residence on more than this much land in a medium/high-density
	// zone (R1/R3/R4) is priced as a development site, not as a house: those
	// zones are drawn for 450–900 m² lots, and a lot this size is what a
	// developer amalgamates for a unit block.
	nswDevSiteMinSqm = 2000.0
)

// nswNonHouseZonePrefixes are zone codes whose land cannot sell as an
// established house except as a commercial or development site: business
// (B1–B8, pre-2023), mixed use (MU1), industrial (IN1–IN4) and special purpose
// (SP1–SP5). The E prefix is deliberately absent: the 2023 employment-zones
// reform re-used it (pre-2023 E4 "Environmental Living" is ordinary housing
// across Pittwater and Sutherland; post-2023 E4 is General Industrial), and the
// PSI years straddle the change.
var nswNonHouseZonePrefixes = []string{"B", "MU", "IN", "SP"}

// nswMultiDwellingPurposes mark a RESIDENCE/DWELLING purpose that is more than
// one dwelling, or a dwelling bundled with a commercial use.
var nswMultiDwellingPurposes = []string{
	"DWELLINGS", "RESIDENCES", "FLATS", "UNITS", "APARTMENT", "MULTI", "BOARDING",
	"DEVELOPMENT", "COMMERCIAL", "SHOP", "OFFICE", "INDUSTRIAL",
}

type nswSale struct {
	suburb   string
	postcode string
	price    float64
}

// nswBRecord is one parsed B-record (the main sale row), before any house
// filter: dealing membership has to be counted over every record, including
// the vacant lots and non-residence components of a multi-property contract.
type nswBRecord struct {
	propertyID string
	dealing    string
	suburb     string
	postcode   string
	price      float64
	priceOK    bool
	areaSqm    float64 // 0 = not recorded
	zoning     string
	nature     string
	purpose    string
	strataLot  string
	interest   string
}

type nswAgg struct {
	prices    []float64
	postcodes map[string]int
}

type nswFetcher interface {
	FetchBytes(context.Context, string, string) ([]byte, string, error)
}

func ingestNSWSuburbMedians(ctx context.Context) ([]Observation, error) {
	client, err := stealthhttp.New(stealthhttp.WithTimeout(120 * time.Second))
	if err != nil {
		return nil, fmt.Errorf("stealth init: %w", err)
	}
	return ingestNSWSuburbMediansWithFetcher(ctx, client, nswRecentYears(nswYears))
}

func ingestNSWSuburbMediansWithFetcher(ctx context.Context, fetcher nswFetcher, years []int) ([]Observation, error) {
	// name → year → aggregate. Keyed by UPPER suburb name (the sal_code backfill
	// matches case-insensitively, so casing is irrelevant to the join).
	agg := map[string]map[int]*nswAgg{}
	fetchedYears := make([]int, 0, len(years))
	missingYears := make([]int, 0, len(years))
	for _, yr := range years {
		url := fmt.Sprintf("%s%d.zip", nswPSIBase, yr)
		b, _, err := fetcher.FetchBytes(ctx, url, nswAccept)
		if err != nil {
			log.Printf("[vg_nsw] fetch %d: %v — skipping", yr, err)
			missingYears = append(missingYears, yr)
			continue
		}
		if len(b) < 2 || b[0] != 'P' || b[1] != 'K' { // not a zip ⇒ challenge/HTML
			log.Printf("[vg_nsw] %d: did not return a zip (%d bytes, likely a block page) — skipping", yr, len(b))
			missingYears = append(missingYears, yr)
			continue
		}
		sales, err := parseNSWYearSales(b)
		if err != nil {
			log.Printf("[vg_nsw] parse %d: %v — skipping", yr, err)
			missingYears = append(missingYears, yr)
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
		fetchedYears = append(fetchedYears, yr)
		log.Printf("[vg_nsw] %d: %d house sales", yr, len(sales))
	}
	if len(fetchedYears) != len(years) {
		return nil, fmt.Errorf(
			"incomplete NSW PSI coverage: fetched %d/%d requested years; missing %v",
			len(fetchedYears), len(years), missingYears,
		)
	}

	obs := buildNSWObservations(agg, fetchedYears)
	pooledN := 0
	for _, o := range obs {
		if o.IsPreliminary {
			pooledN++
		}
	}
	log.Printf("[vg_nsw] %d suburb-year medians (%d thin suburbs via %dyr pool) across %d years", len(obs), pooledN, nswYears, len(fetchedYears))
	return obs, nil
}

func buildNSWObservations(agg map[string]map[int]*nswAgg, fetchedYears []int) []Observation {
	if len(fetchedYears) == 0 {
		return nil
	}
	latestYr := fetchedYears[0]
	for _, year := range fetchedYears[1:] {
		if year > latestYr {
			latestYr = year
		}
	}

	// For well-traded suburbs emit an annual median per year (series + YoY). For
	// THIN suburbs (no single year clears nswMinSales) pool the whole window into
	// one current median so the map still paints them — flagged preliminary.
	var obs []Observation
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
			}
		}
	}
	return obs
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
	var records []nswBRecord
	weeklyArchives := 0
	for _, wf := range zr.File {
		if !strings.HasSuffix(strings.ToLower(wf.Name), ".zip") {
			continue
		}
		weeklyArchives++
		rc, err := wf.Open()
		if err != nil {
			return nil, fmt.Errorf("open weekly archive %s: %w", wf.Name, err)
		}
		wb, readErr := io.ReadAll(rc)
		closeErr := rc.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read weekly archive %s: %w", wf.Name, readErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close weekly archive %s: %w", wf.Name, closeErr)
		}
		wzr, err := zip.NewReader(bytes.NewReader(wb), int64(len(wb)))
		if err != nil {
			return nil, fmt.Errorf("parse weekly archive %s: %w", wf.Name, err)
		}
		datFiles := 0
		for _, df := range wzr.File {
			if !strings.HasSuffix(strings.ToUpper(df.Name), ".DAT") {
				continue
			}
			datFiles++
			dc, err := df.Open()
			if err != nil {
				return nil, fmt.Errorf("open %s in %s: %w", df.Name, wf.Name, err)
			}
			db, readErr := io.ReadAll(dc)
			closeErr := dc.Close()
			if readErr != nil {
				return nil, fmt.Errorf("read %s in %s: %w", df.Name, wf.Name, readErr)
			}
			if closeErr != nil {
				return nil, fmt.Errorf("close %s in %s: %w", df.Name, wf.Name, closeErr)
			}
			records = append(records, parseNSWBRecords(db)...)
		}
		if datFiles == 0 {
			return nil, fmt.Errorf("weekly archive %s contains no DAT files", wf.Name)
		}
	}
	if weeklyArchives == 0 {
		return nil, fmt.Errorf("NSW PSI year contains no weekly zip archives")
	}
	// Selected over the whole year, not per file, so a multi-property contract
	// whose records were lodged in different weeks is still recognised.
	sales := selectNSWHouseSales(records)
	if len(sales) == 0 {
		return nil, fmt.Errorf("NSW PSI year contains no qualifying house sales")
	}
	return sales, nil
}

// parseNSWDAT extracts house sales from one ";"-delimited .DAT file's B-records.
// A yearly ingest selects over the whole year's records instead (see
// parseNSWYearSales), so a contract lodged across weekly files is still seen
// whole.
func parseNSWDAT(dat []byte) []nswSale {
	return selectNSWHouseSales(parseNSWBRecords(dat))
}

// parseNSWBRecords parses every well-formed B-record of one .DAT file.
func parseNSWBRecords(dat []byte) []nswBRecord {
	var out []nswBRecord
	for _, line := range strings.Split(string(dat), "\n") {
		if !strings.HasPrefix(line, "B;") {
			continue
		}
		f := strings.Split(line, ";")
		if len(f) < 20 {
			continue
		}
		field := func(i int) string {
			if i < len(f) {
				return strings.TrimSpace(f[i])
			}
			return ""
		}
		price, err := strconv.ParseFloat(field(15), 64)
		out = append(out, nswBRecord{
			propertyID: field(2),
			dealing:    field(23),
			suburb:     field(9),
			postcode:   field(10),
			price:      price,
			priceOK:    err == nil,
			areaSqm:    nswAreaSqm(field(11), field(12)),
			zoning:     strings.ToUpper(field(16)),
			nature:     strings.ToUpper(field(17)),
			purpose:    strings.ToUpper(field(18)),
			strataLot:  field(19),
			interest:   field(22),
		})
	}
	return out
}

// nswAreaSqm normalises the PSI area to square metres (0 when unrecorded).
func nswAreaSqm(area, unit string) float64 {
	v, err := strconv.ParseFloat(area, 64)
	if err != nil || v <= 0 {
		return 0
	}
	if strings.EqualFold(unit, "H") {
		return v * 10000
	}
	return v
}

// selectNSWHouseSales keeps the records that are one established house sold
// whole, at a market price. Multi-property contracts are recognised over ALL
// the given records first — a dealing number on more than one distinct
// property is a bundle whose price is the contract total — and every record of
// such a dealing is dropped. A record lodged twice for the same property and
// dealing counts once.
func selectNSWHouseSales(records []nswBRecord) []nswSale {
	properties := map[string]map[string]struct{}{}
	for _, r := range records {
		if r.dealing == "" {
			continue
		}
		if properties[r.dealing] == nil {
			properties[r.dealing] = map[string]struct{}{}
		}
		properties[r.dealing][r.propertyID] = struct{}{}
	}
	seen := map[string]struct{}{}
	var out []nswSale
	for _, r := range records {
		if !nswIsHouseSale(r) {
			continue
		}
		if r.dealing != "" {
			if len(properties[r.dealing]) > 1 {
				continue
			}
			key := r.dealing + "|" + r.propertyID
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
		}
		out = append(out, nswSale{suburb: r.suburb, postcode: r.postcode, price: r.price})
	}
	return out
}

// nswIsHouseSale is the per-record half of the filter (see selectNSWHouseSales
// for the per-dealing half).
func nswIsHouseSale(r nswBRecord) bool {
	if r.suburb == "" || r.strataLot != "" { // strata lot ⇒ unit/apartment, not a house
		return false
	}
	if !r.priceOK || r.price < nswMinPrice {
		return false
	}
	if r.nature != "" && r.nature != "R" { // V = vacant land, 3 = other (incl. whole buildings)
		return false
	}
	if !strings.Contains(r.purpose, "RESIDENCE") && !strings.Contains(r.purpose, "DWELLING") {
		return false
	}
	for _, p := range nswMultiDwellingPurposes {
		if strings.Contains(r.purpose, p) {
			return false
		}
	}
	// A part-interest transfer prices a share, not the house. The field carries
	// a percentage only for those; whole sales read 0, 100 or blank.
	if r.interest != "" && r.interest != "0" && r.interest != "100" {
		return false
	}
	for _, prefix := range nswNonHouseZonePrefixes {
		if nswZoneHasPrefix(r.zoning, prefix) {
			return false
		}
	}
	switch r.zoning {
	case "R1", "R3", "R4":
		if r.areaSqm > nswDevSiteMinSqm {
			return false
		}
	}
	return true
}

// nswZoneHasPrefix reports whether zone is prefix followed by a digit ("B4",
// "SP2", "MU1"), so "R2" never matches "RU" and "B" never matches a word.
func nswZoneHasPrefix(zone, prefix string) bool {
	if !strings.HasPrefix(zone, prefix) || len(zone) == len(prefix) {
		return false
	}
	return unicode.IsDigit(rune(zone[len(prefix)]))
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
