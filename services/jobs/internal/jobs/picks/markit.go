package picks

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ASX / Markit Digital key statistics (plan §2.7): the fallback source. Plain
// HTTPS works (no bot wall observed on asx.api.markitdigital.com, probe
// 2026-09-27). It carries four annual revenue / net income rows and is fresher
// than Yahoo's annual series for small caps, which is the only reason it is
// asked at all (see needsFallback).
//
// Only incomeStatement[] is taken. The endpoint's earningsPerShare, cashFlow
// and numOfShares are a TTM EPS in the TRADING currency (BHP: 2.76 AUD against
// Yahoo's 1.93 USD), a cash flow in millions and a current share count, none
// with a period end: storing them in a period row would put an AUD EPS beside
// USD revenue, or date a current figure to a past period. Growth across that
// would be FX, not growth.
const markitBase = "https://asx.api.markitdigital.com/asx-research/1.0/companies/"

// markitRequestInterval paces the fallback. It is asked for a minority of
// codes and has no fingerprint wall; one a second keeps it well-mannered.
const markitRequestInterval = time.Second

// markitMaxBody bounds the read: the payload is ~1KB.
const markitMaxBody = 1 << 20

// Markit sentinels: -32768 is "missing" (LKE and IMU 2026A revenue), and
// -99999.99 is "not meaningful" on ratios. Both are NULL, never a value.
const (
	markitMissing       = -32768.0
	markitNotMeaningful = -99999.99
)

// excelEpoch is day 0 of the Excel serial dates Markit uses for period ends
// (46203 = 2026-06-30). 1899-12-30, not 1900-01-01, because of Excel's
// fictional 1900-02-29.
var excelEpoch = time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)

// Serial-date bounds: 1990-01-01 .. 2100-01-01. Anything outside is not a
// balance date.
const (
	minExcelSerial = 32874
	maxExcelSerial = 73051
)

type markitKeyStatistics struct {
	client  *http.Client
	baseURL string
	pace    *pacer
}

func newMarkitKeyStatistics() *markitKeyStatistics {
	return &markitKeyStatistics{
		client:  &http.Client{Timeout: 30 * time.Second},
		baseURL: markitBase,
		pace:    newPacer(markitRequestInterval),
	}
}

func (m *markitKeyStatistics) Name() string { return sourceMarkit }

// Fundamentals implements Fetcher.
func (m *markitKeyStatistics) Fundamentals(ctx context.Context, code string) ([]PeriodRow, error) {
	if err := m.pace.wait(ctx); err != nil {
		return nil, err
	}
	u := m.baseURL + url.PathEscape(strings.ToUpper(code)) + "/key-statistics"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("markit %s: build request: %w", code, err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Referer", "https://www.asx.com.au/")
	req.Header.Set("User-Agent", "shorted-picks/1.0 (+https://shorted.com.au)")

	resp, err := m.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("markit %s: %w", code, err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, markitMaxBody))
	if err != nil {
		return nil, fmt.Errorf("markit %s: read: %w", code, err)
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, nil // not a company Markit covers: answered, nothing published
	case resp.StatusCode == http.StatusBadRequest && strings.Contains(strings.ToLower(string(body)), "symbol not found"):
		// What Markit actually answers for a code it does not know (seen
		// 2026-09-27: HTTP 400 {"error":{"code":400,"message":"Bad Request:
		// Symbol not found"}}). A definitive "not covered", not a failure. Any
		// other 400 stays an error.
		return nil, nil
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("markit %s: HTTP %d: %s", code, resp.StatusCode, truncate(strings.TrimSpace(string(body)), 200))
	}
	rows, err := parseMarkitKeyStatistics(body)
	if err != nil {
		return nil, fmt.Errorf("markit %s: %w", code, err)
	}
	return rows, nil
}

type markitDoc struct {
	Data *struct {
		IncomeStatement []struct {
			Revenue        *json.Number `json:"revenue"`
			NetIncome      *json.Number `json:"netIncome"`
			Period         string       `json:"period"`
			FPeriodEndDate *json.Number `json:"fPeriodEndDate"`
			CurCode        string       `json:"curCode"`
		} `json:"incomeStatement"`
	} `json:"data"`
}

// parseMarkitKeyStatistics maps incomeStatement[] to annual rows. Only ACTUAL
// periods ("2026A") are taken: a forecast ("2027E"/"F") is never filed as a
// reported year. The period end is the Excel serial fPeriodEndDate; sentinel
// values become NULL; a row with no currency, no valid date or no value at all
// is dropped.
func parseMarkitKeyStatistics(body []byte) ([]PeriodRow, error) {
	var doc markitDoc
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("parse key-statistics: %w", err)
	}
	if doc.Data == nil {
		return nil, nil
	}
	seen := map[time.Time]bool{}
	var out []PeriodRow
	for _, is := range doc.Data.IncomeStatement {
		if !strings.HasSuffix(strings.ToUpper(strings.TrimSpace(is.Period)), "A") {
			continue
		}
		end, ok := excelSerialDate(is.FPeriodEndDate)
		if !ok || seen[end] {
			continue
		}
		cur := strings.ToUpper(strings.TrimSpace(is.CurCode))
		if cur == "" {
			continue // growth compares currencies; an unknown one cannot be stored
		}
		row := PeriodRow{
			PeriodType: periodAnnual,
			PeriodEnd:  end,
			Currency:   cur,
			Revenue:    markitValue(is.Revenue),
			NetIncome:  markitValue(is.NetIncome),
			Source:     sourceMarkit,
		}
		if !row.hasValues() {
			continue
		}
		seen[end] = true
		out = append(out, row)
	}
	sortRows(out)
	return out, nil
}

// markitValue reads one value, mapping both sentinels and anything unparseable
// to NULL.
func markitValue(n *json.Number) *float64 {
	if n == nil {
		return nil
	}
	f, err := strconv.ParseFloat(string(*n), 64)
	if err != nil || f == markitMissing || f == markitNotMeaningful {
		return nil
	}
	return &f
}

// excelSerialDate converts an Excel serial day number to a date. Fractions
// (a time of day) are truncated; sentinels and out-of-range serials fail.
func excelSerialDate(n *json.Number) (time.Time, bool) {
	if n == nil {
		return time.Time{}, false
	}
	f, err := strconv.ParseFloat(string(*n), 64)
	if err != nil || f < minExcelSerial || f > maxExcelSerial {
		return time.Time{}, false
	}
	return excelEpoch.AddDate(0, 0, int(f)), true
}
