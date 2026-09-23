// Package absdata provides shared fetch + parse clients for ABS SDMX-CSV and
// RBA statistical-table CSV data. Extracted from house-price-collector; both
// endpoints WAF-block bare requests, so the User-Agent header is mandatory.
package absdata

import (
	"context"
	"encoding/csv"
	"errors"
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
	base     string // SDMX data endpoint; empty = the live ABS API (tests override)
}

func NewClient() *Client {
	return &Client{
		http:     &http.Client{Timeout: 60 * time.Second},
		attempts: defaultAttempts,
		backoff:  defaultBackoff,
	}
}

// WithBaseURL returns a copy of c that fetches SDMX data from base instead of
// the live ABS API — for tests that serve captured fixtures.
func (c *Client) WithBaseURL(base string) *Client {
	cp := *c
	cp.base = strings.TrimRight(base, "/")
	return &cp
}

// get issues a retrying GET with the caller's headers. It returns the last
// response even on failure so callers keep their own error wording.
func (c *Client) get(ctx context.Context, url string, header http.Header) (*http.Response, error) {
	return getWithRetry(ctx, c.http, url, header, c.attempts, c.backoff)
}

// FetchSDMXCSV GETs one ABS dataflow as SDMX-CSV (labels=both) and returns raw
// CSV rows. key is the dotted dimension key ("1.AUS.Q" style; "all" allowed).
func (c *Client) FetchSDMXCSV(ctx context.Context, dataflow, key, startPeriod string) ([][]string, error) {
	base := c.base
	if base == "" {
		base = absBase
	}
	url := fmt.Sprintf("%s/ABS,%s/%s?startPeriod=%s", base, dataflow, key, startPeriod)
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
		return nil, &StatusError{
			Status: resp.StatusCode,
			msg:    fmt.Sprintf("ABS %s/%s: HTTP %d: %s", dataflow, key, resp.StatusCode, strings.TrimSpace(string(body))),
		}
	}
	r := csv.NewReader(resp.Body)
	r.FieldsPerRecord = -1
	return r.ReadAll()
}

// StatusError is a non-200 ABS response. The message keeps the historical
// "ABS <flow>/<key>: HTTP <n>: <body>" wording; Status lets a caller tell "this
// dataflow does not exist (yet)" — ABS answers 404 for a flow it has not
// published — from a real failure, without matching on the text.
type StatusError struct {
	Status int
	msg    string
}

func (e *StatusError) Error() string { return e.msg }

// IsNotFound reports whether err is an ABS 404 (unknown dataflow or key).
func IsNotFound(err error) bool {
	var se *StatusError
	return errors.As(err, &se) && se.Status == http.StatusNotFound
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
