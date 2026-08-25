// Package absdata provides shared fetch + parse clients for ABS SDMX-CSV and
// RBA statistical-table CSV data. Extracted from house-price-collector; both
// endpoints WAF-block bare requests, so the User-Agent header is mandatory.
package absdata

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	absBase   = "https://data.api.abs.gov.au/rest/data"
	UserAgent = "shorted-data/1.0 (+https://shorted.com.au)"
	csvAccept = "application/vnd.sdmx.data+csv;labels=both"
	// Licence is the licence string for all ABS open data.
	Licence = "CC-BY-4.0"
)

// Client fetches ABS SDMX-CSV and RBA CSV tables. attempts/backoff are the
// retry policy (see retry.go); the zero value falls back to the defaults, so a
// Client built by anything other than NewClient still retries.
type Client struct {
	http     *http.Client
	attempts int
	backoff  time.Duration
}

func NewClient() *Client {
	return &Client{
		http:     &http.Client{Timeout: 60 * time.Second},
		attempts: defaultAttempts,
		backoff:  defaultBackoff,
	}
}

// get issues a retrying GET with the caller's headers. It returns the last
// response even on failure so callers keep their own error wording.
func (c *Client) get(ctx context.Context, url string, header http.Header) (*http.Response, error) {
	return getWithRetry(ctx, c.http, url, header, c.attempts, c.backoff)
}

// FetchSDMXCSV GETs one ABS dataflow as SDMX-CSV (labels=both) and returns raw
// CSV rows. key is the dotted dimension key ("1.AUS.Q" style; "all" allowed).
func (c *Client) FetchSDMXCSV(ctx context.Context, dataflow, key, startPeriod string) ([][]string, error) {
	url := fmt.Sprintf("%s/ABS,%s/%s?startPeriod=%s", absBase, dataflow, key, startPeriod)
	resp, err := c.get(ctx, url, http.Header{
		"User-Agent": {UserAgent},
		"Accept":     {csvAccept},
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("ABS %s/%s: HTTP %d: %s", dataflow, key, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	r := csv.NewReader(resp.Body)
	r.FieldsPerRecord = -1
	return r.ReadAll()
}

// ColIndex maps SDMX-CSV header names to column indexes. labels=both headers
// look like "REGION: Region" — the map key is the code part before the colon.
func ColIndex(header []string) map[string]int {
	idx := make(map[string]int, len(header))
	for i, h := range header {
		name := strings.TrimSpace(strings.SplitN(h, ":", 2)[0])
		idx[name] = i
	}
	return idx
}

// Code returns the code half of a "code: label" cell (or the cell verbatim).
func Code(cell string) string {
	return strings.TrimSpace(strings.SplitN(cell, ":", 2)[0])
}

// Label returns the label half of a "code: label" cell (or the cell verbatim).
func Label(cell string) string {
	parts := strings.SplitN(cell, ":", 2)
	if len(parts) == 2 {
		return strings.TrimSpace(parts[1])
	}
	return strings.TrimSpace(cell)
}

// Cell is bounds-safe row access.
func Cell(row []string, idx int) string {
	if idx < 0 || idx >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[idx])
}

// ApplyMult scales a value by the SDMX UNIT_MULT cell (10^mult).
func ApplyMult(val float64, multCell string) float64 {
	code := Code(multCell)
	if code == "" {
		return val
	}
	m, err := strconv.Atoi(code)
	if err != nil {
		return val
	}
	return val * math.Pow10(m)
}
