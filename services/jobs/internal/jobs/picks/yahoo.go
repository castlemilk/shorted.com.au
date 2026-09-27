package picks

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// Yahoo fundamentals-timeseries (plan §2.7, probe 2026-09-27).
//
// It must go through pkg/stealthhttp, exactly as the price sweep does
// (marketdata/providers/yahoo_direct.go): a plain net/http client is answered
// 429 on every Yahoo endpoint whatever the rate, because the wall is a TLS and
// header fingerprint. This endpoint needs no cookie and no crumb.
const yahooTimeseriesBase = "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/"

// yahooPeriod1 is 2010-01-01T00:00:00Z. Yahoo returns at most four fiscal
// years whatever the window; the wide window only guarantees none is cut off.
const yahooPeriod1 = 1262304000

// yahooRequestInterval is the price sweep's pacing (yahooRequestInterval in
// yahoo_direct.go): 900 requests an hour, the cadence Yahoo has tolerated from
// that job daily. A 400-code run is ~27 minutes of pacing.
const yahooRequestInterval = 4 * time.Second

// yahooField maps each requested series to the row it fills. The type list is
// the plan's (§2.7), in its order; nothing else is requested.
var yahooFields = []struct {
	typ        string
	periodType string
	periodKind string // Yahoo's periodType for the series: "12M" or "TTM"
	set        func(r *PeriodRow, v *float64)
}{
	{"annualTotalRevenue", periodAnnual, "12M", func(r *PeriodRow, v *float64) { r.Revenue = v }},
	{"annualNetIncomeCommonStockholders", periodAnnual, "12M", func(r *PeriodRow, v *float64) { r.NetIncome = v }},
	{"annualDilutedEPS", periodAnnual, "12M", func(r *PeriodRow, v *float64) { r.EPSDiluted = v }},
	{"annualBasicEPS", periodAnnual, "12M", func(r *PeriodRow, v *float64) { r.EPSBasic = v }},
	{"annualOperatingCashFlow", periodAnnual, "12M", func(r *PeriodRow, v *float64) { r.OperatingCashFlow = v }},
	{"annualFreeCashFlow", periodAnnual, "12M", func(r *PeriodRow, v *float64) { r.FreeCashFlow = v }},
	{"annualOrdinarySharesNumber", periodAnnual, "12M", func(r *PeriodRow, v *float64) { r.SharesOutstanding = v }},
	{"trailingTotalRevenue", periodTTM, "TTM", func(r *PeriodRow, v *float64) { r.Revenue = v }},
	{"trailingNetIncomeCommonStockholders", periodTTM, "TTM", func(r *PeriodRow, v *float64) { r.NetIncome = v }},
	{"trailingDilutedEPS", periodTTM, "TTM", func(r *PeriodRow, v *float64) { r.EPSDiluted = v }},
	{"trailingOperatingCashFlow", periodTTM, "TTM", func(r *PeriodRow, v *float64) { r.OperatingCashFlow = v }},
	{"trailingFreeCashFlow", periodTTM, "TTM", func(r *PeriodRow, v *float64) { r.FreeCashFlow = v }},
}

// bytesFetcher is the slice of *stealthhttp.Client the fetcher uses; tests
// substitute a stub.
type bytesFetcher interface {
	FetchBytes(ctx context.Context, pageURL, accept string) ([]byte, string, error)
}

// yahooTimeseries is the primary Fetcher.
type yahooTimeseries struct {
	fetch bytesFetcher
	pace  *pacer
	now   func() time.Time
}

// newYahooTimeseries builds the fetcher on the stealth client. The returned
// close func releases the client.
func newYahooTimeseries() (*yahooTimeseries, func() error, error) {
	c, err := stealthhttp.New(stealthhttp.WithTimeout(45 * time.Second))
	if err != nil {
		return nil, nil, fmt.Errorf("yahoo: stealth client: %w", err)
	}
	return &yahooTimeseries{fetch: c, pace: newPacer(yahooRequestInterval), now: time.Now}, c.Close, nil
}

func (y *yahooTimeseries) Name() string { return sourceYahoo }

// Fundamentals implements Fetcher.
func (y *yahooTimeseries) Fundamentals(ctx context.Context, code string) ([]PeriodRow, error) {
	if err := y.pace.wait(ctx); err != nil {
		return nil, err
	}
	body, _, err := y.fetch.FetchBytes(ctx, yahooTimeseriesURL(code, y.now()), "application/json")
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if stealthhttp.StatusError(err) == 404 {
			return nil, nil // Yahoo does not carry the code: answered, nothing published
		}
		// A 429, a 5xx or a transport failure is NOT "no data".
		return nil, fmt.Errorf("yahoo %s: %w", code, err)
	}
	rows, err := parseYahooTimeseries(body)
	if err != nil {
		return nil, fmt.Errorf("yahoo %s: %w", code, err)
	}
	return rows, nil
}

// yahooTimeseriesURL builds the one GET per code. The type list is joined with
// literal commas (sub-delimiters are legal in a query, and it is the exact
// request the probe made); period2 is a year ahead so a just-published period
// is never outside the window.
func yahooTimeseriesURL(code string, now time.Time) string {
	types := make([]string, len(yahooFields))
	for i, f := range yahooFields {
		types[i] = f.typ
	}
	return fmt.Sprintf("%s%s?type=%s&period1=%d&period2=%d",
		yahooTimeseriesBase,
		url.PathEscape(strings.ToUpper(code)+".AX"),
		strings.Join(types, ","),
		yahooPeriod1,
		now.AddDate(1, 0, 0).Unix(),
	)
}

// yahooPoint is one entry of a series. Entries can be null (skipped). The raw
// value is a json.Number so an out-of-range literal (1e400) is rejected as one
// value rather than failing the whole document's decode.
type yahooPoint struct {
	AsOfDate      string `json:"asOfDate"`
	PeriodType    string `json:"periodType"`
	CurrencyCode  string `json:"currencyCode"`
	ReportedValue struct {
		Raw json.Number `json:"raw"`
	} `json:"reportedValue"`
}

type yahooDoc struct {
	Timeseries struct {
		Result []map[string]json.RawMessage `json:"result"`
		Error  json.RawMessage              `json:"error"`
	} `json:"timeseries"`
}

type yahooMeta struct {
	Type []string `json:"type"`
}

// parseYahooTimeseries turns one timeseries document into rows: annual series
// into period_type 'annual', trailing series into 'ttm', one row per
// (period_type, asOfDate), with period_end = asOfDate exactly as Yahoo reports
// it. Each row's currency is its points' currencyCode (the REPORTING currency:
// BHP is USD); a row whose points disagree on currency is dropped rather than
// stored under one of them. Values that are not finite, or not a plausible
// statement line, are left NULL here and counted by sanitizeRows.
func parseYahooTimeseries(body []byte) ([]PeriodRow, error) {
	var doc yahooDoc
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("parse timeseries: %w", err)
	}
	if e := strings.TrimSpace(string(doc.Timeseries.Error)); e != "" && e != "null" {
		return nil, fmt.Errorf("timeseries error: %s", truncate(e, 200))
	}

	type key struct {
		periodType string
		end        time.Time
	}
	rows := map[key]*PeriodRow{}
	conflicted := map[key]bool{}

	for _, entry := range doc.Timeseries.Result {
		var meta yahooMeta
		if raw, ok := entry["meta"]; !ok || json.Unmarshal(raw, &meta) != nil || len(meta.Type) == 0 {
			continue
		}
		field := -1
		for i, f := range yahooFields {
			if f.typ == meta.Type[0] {
				field = i
				break
			}
		}
		raw, ok := entry[meta.Type[0]]
		if field < 0 || !ok {
			continue // a series we did not ask for, or one with no points
		}
		var points []*yahooPoint
		if err := json.Unmarshal(raw, &points); err != nil {
			return nil, fmt.Errorf("parse %s: %w", meta.Type[0], err)
		}
		f := yahooFields[field]
		for _, p := range points {
			if p == nil || p.ReportedValue.Raw == "" {
				continue
			}
			if p.PeriodType != "" && p.PeriodType != f.periodKind {
				// An annual series carrying a 3M point (or the reverse) is not
				// the series we think it is. Refuse it rather than file a
				// half-year figure as a full year.
				continue
			}
			end, err := time.Parse("2006-01-02", p.AsOfDate)
			if err != nil {
				continue
			}
			v, ok := parseNumber(p.ReportedValue.Raw)
			if !ok {
				continue
			}
			k := key{f.periodType, end}
			row := rows[k]
			if row == nil {
				row = &PeriodRow{PeriodType: f.periodType, PeriodEnd: end, Source: sourceYahoo}
				rows[k] = row
			}
			cur := strings.ToUpper(strings.TrimSpace(p.CurrencyCode))
			switch {
			case cur == "":
			case row.Currency == "":
				row.Currency = cur
			case row.Currency != cur:
				conflicted[k] = true
			}
			f.set(row, v)
		}
	}

	out := make([]PeriodRow, 0, len(rows))
	for k, r := range rows {
		if conflicted[k] {
			log.Printf("picks: yahoo %s %s mixes currencies across series; row dropped", k.periodType, k.end.Format("2006-01-02"))
			continue
		}
		out = append(out, *r)
	}
	sortRows(out)
	return out, nil
}

// parseNumber reads a JSON number, refusing anything ParseFloat cannot
// represent exactly as a finite float64 (it returns ±Inf with ErrRange for
// 1e400).
func parseNumber(n json.Number) (*float64, bool) {
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil {
		return nil, false
	}
	return &f, true
}

// sortRows orders rows by period type, then period end, so writes and logs are
// deterministic.
func sortRows(rows []PeriodRow) {
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].PeriodType != rows[j].PeriodType {
			return rows[i].PeriodType < rows[j].PeriodType
		}
		return rows[i].PeriodEnd.Before(rows[j].PeriodEnd)
	})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
