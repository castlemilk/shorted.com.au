package main

import (
	"archive/zip"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// NSW BOCSAR "Recorded Criminal Incidents by month – by suburb". A single wide
// CSV (Jan 1995 → current quarter, one column per month) inside a ZIP. We melt
// the monthly columns into Australian-financial-year buckets, crosswalk the
// (category, subcategory) lines to common crime types, and bridge the free-text
// suburb name to an ABS SAL code by name (100% match measured against the
// committed SAL registry).
const (
	nswCrimeZipURL       = "https://bocsarblob.blob.core.windows.net/bocsar-open-data/SuburbData.zip"
	nswCrimeJurisdiction = "NSW"
	nswCrimeSource       = "bocsar"
	nswCrimeLicence      = "CC-BY"
)

// crimeRaw is one (suburb, crime_type, FY) summed police count, bridged to SAL.
type crimeRaw struct {
	salCode   string
	state     string
	crimeType crimeType
	fy        int
	count     float64
}

// jurisdictionData is one police source's crosswalked, SAL-bridged output.
type jurisdictionData struct {
	jurisdiction    string
	source          string
	licence         string
	rows            []crimeRaw
	matched         int      // distinct source suburbs that bridged to a SAL
	unmatched       int      // distinct source suburbs that did not
	unmatchedSample []string // up to 20 unmatched names (diagnostics)
}

// matchRate is matched / (matched + unmatched); 1.0 when nothing to match.
func (d *jurisdictionData) matchRate() float64 {
	total := d.matched + d.unmatched
	if total == 0 {
		return 1.0
	}
	return float64(d.matched) / float64(total)
}

var monthAbbrev = map[string]int{
	"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
	"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}

var monthHeaderRe = regexp.MustCompile(`^([A-Za-z]{3})\s+(\d{4})$`)

// monthFY returns the Australian financial year (ending year) a calendar month
// falls in: Jul–Dec → year+1, Jan–Jun → year.
func monthFY(month, year int) int {
	if month >= 7 {
		return year + 1
	}
	return year
}

// fetchNSW downloads + melts BOCSAR into per-(SAL, crime_type, FY) counts.
// nameToSal maps a normalised NSW suburb name → sal_code (built from
// suburb_demographics). Only COMPLETE financial years are emitted.
func fetchNSW(ctx context.Context, nameToSal map[string]string) (*jurisdictionData, error) {
	rc, cleanup, err := openNSWZip(ctx)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	return meltNSW(rc, nameToSal)
}

// openNSWZip returns a reader over the single CSV entry in the BOCSAR ZIP,
// preferring a local file (NSW_CRIME_ZIP) over a fresh download.
func openNSWZip(ctx context.Context) (io.Reader, func(), error) {
	var path string
	var cleanupTmp func()
	if p := strings.TrimSpace(os.Getenv("NSW_CRIME_ZIP")); p != "" {
		path = p
		cleanupTmp = func() {}
	} else {
		tmp, err := os.CreateTemp("", "bocsar_*.zip")
		if err != nil {
			return nil, nil, err
		}
		cleanupTmp = func() { _ = os.Remove(tmp.Name()) }
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, nswCrimeZipURL, nil)
		if err != nil {
			_ = tmp.Close()
			cleanupTmp()
			return nil, nil, err
		}
		req.Header.Set("User-Agent", cvsUA)
		resp, err := (&http.Client{Timeout: 10 * time.Minute}).Do(req)
		if err != nil {
			_ = tmp.Close()
			cleanupTmp()
			return nil, nil, err
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			_ = tmp.Close()
			cleanupTmp()
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
			return nil, nil, fmt.Errorf("download BOCSAR: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		}
		if _, err := io.Copy(tmp, resp.Body); err != nil {
			_ = tmp.Close()
			cleanupTmp()
			return nil, nil, err
		}
		if err := tmp.Close(); err != nil {
			cleanupTmp()
			return nil, nil, err
		}
		path = tmp.Name()
	}

	zr, err := zip.OpenReader(path)
	if err != nil {
		cleanupTmp()
		return nil, nil, fmt.Errorf("open BOCSAR zip: %w", err)
	}
	var csvFile *zip.File
	for _, f := range zr.File {
		if strings.HasSuffix(strings.ToLower(f.Name), ".csv") {
			csvFile = f
			break
		}
	}
	if csvFile == nil {
		_ = zr.Close()
		cleanupTmp()
		return nil, nil, fmt.Errorf("no CSV entry in BOCSAR zip")
	}
	f, err := csvFile.Open()
	if err != nil {
		_ = zr.Close()
		cleanupTmp()
		return nil, nil, fmt.Errorf("open BOCSAR csv: %w", err)
	}
	cleanup := func() { _ = f.Close(); _ = zr.Close(); cleanupTmp() }
	return f, cleanup, nil
}

// meltNSW streams the wide BOCSAR CSV and aggregates monthly counts into
// per-(SAL, crime_type, FY) totals. CRIME_START_FY bounds the earliest emitted
// FY (default: all complete FYs).
func meltNSW(r io.Reader, nameToSal map[string]string) (*jurisdictionData, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	cr.ReuseRecord = true

	header, err := cr.Read()
	if err != nil {
		return nil, fmt.Errorf("read BOCSAR header: %w", err)
	}
	// Map each monthly column → FY, and count months per FY for completeness.
	colFY := make([]int, len(header)) // 0 = non-monthly column
	monthsPerFY := map[int]int{}
	for j := 3; j < len(header); j++ {
		m := monthHeaderRe.FindStringSubmatch(strings.TrimSpace(header[j]))
		if m == nil {
			continue
		}
		mon, ok := monthAbbrev[strings.ToLower(m[1])]
		if !ok {
			continue
		}
		year, _ := strconv.Atoi(m[2])
		fy := monthFY(mon, year)
		colFY[j] = fy
		monthsPerFY[fy]++
	}
	startFY := envInt("CRIME_START_FY", 0)
	completeFY := map[int]bool{}
	for fy, n := range monthsPerFY {
		if n == 12 && fy >= startFY {
			completeFY[fy] = true
		}
	}

	type key struct {
		sal string
		ct  crimeType
		fy  int
	}
	acc := map[key]float64{}
	seenNames := map[string]string{} // raw name → sal ("" = unmatched)
	unmatched := map[string]bool{}

	for {
		row, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read BOCSAR row: %w", err)
		}
		if len(row) < 4 {
			continue
		}
		ct, ok := nswCrimeType(row[1], row[2])
		if !ok {
			continue
		}
		name := strings.TrimSpace(row[0])
		sal, known := seenNames[name]
		if !known {
			sal = nameToSal[normCrimeSuburb(name)]
			seenNames[name] = sal
			if sal == "" {
				unmatched[name] = true
			}
		}
		if sal == "" {
			continue
		}
		for j := 3; j < len(row) && j < len(colFY); j++ {
			fy := colFY[j]
			if fy == 0 || !completeFY[fy] {
				continue
			}
			v := strings.TrimSpace(row[j])
			if v == "" || v == "0" {
				continue
			}
			n, err := strconv.ParseFloat(v, 64)
			if err != nil {
				continue
			}
			acc[key{sal, ct, fy}] += n
		}
	}

	// Emit a row for every (mapped SAL, core crime_type, complete FY) — filling
	// implicit zeros so a genuinely low-crime suburb ranks low instead of hatching.
	fys := make([]int, 0, len(completeFY))
	for fy := range completeFY {
		fys = append(fys, fy)
	}
	sals := map[string]bool{}
	for _, sal := range seenNames {
		if sal != "" {
			sals[sal] = true
		}
	}
	out := &jurisdictionData{jurisdiction: nswCrimeJurisdiction, source: nswCrimeSource, licence: nswCrimeLicence}
	for sal := range sals {
		for _, ct := range coreCrimeTypes {
			for _, fy := range fys {
				out.rows = append(out.rows, crimeRaw{
					salCode: sal, state: nswCrimeJurisdiction, crimeType: ct, fy: fy,
					count: acc[key{sal, ct, fy}],
				})
			}
		}
	}
	out.matched = len(sals)
	out.unmatched = len(unmatched)
	for n := range unmatched {
		if len(out.unmatchedSample) >= 20 {
			break
		}
		out.unmatchedSample = append(out.unmatchedSample, n)
	}
	if len(completeFY) == 0 {
		log.Printf("[crime:nsw] WARNING: no complete financial years in BOCSAR data")
	}
	return out, nil
}

var crimeSuburbPunct = regexp.MustCompile(`[^a-z0-9]+`)
var crimeSuburbParen = regexp.MustCompile(`\s*\(.*\)\s*$`)

// normCrimeSuburb normalises a suburb name for the name→SAL bridge: lower-case,
// strip a trailing parenthetical (ABS "Abbotsford (NSW)"), fold apostrophes
// (the O'Connor/O'connor landmine), collapse remaining punctuation to spaces.
func normCrimeSuburb(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = crimeSuburbParen.ReplaceAllString(s, "")
	s = strings.NewReplacer("’", "'", "`", "'").Replace(s)
	s = crimeSuburbPunct.ReplaceAllString(s, " ")
	return strings.Join(strings.Fields(s), " ")
}
