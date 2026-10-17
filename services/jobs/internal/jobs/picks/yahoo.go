package picks

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// Yahoo fundamentals-timeseries (plan stock-picker.md §2.7, probe 2026-09-27;
// widened by fundamentals-coverage.md §3.1).
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
// that job daily. The whole ~2,300-code universe is ~155 minutes of pacing,
// which is why the fundamentals budget is 170 minutes (§3.7).
const yahooRequestInterval = 4 * time.Second

// seriesOCFDirect is the direct-method operating cash flow series. It is not
// a column: it fills operating_cash_flow only when the reported
// OperatingCashFlow series has no point for the period (§3.2). Many ASX
// companies present their cash-flow statement on the direct method, and Yahoo
// files it under this name instead (CSL, FMG, IAG, XRO, LTR in the
// 2026-09-28 capture).
const seriesOCFDirect = "operating_cash_flow_direct"

// yahooFlowSeries are the income-statement and cash-flow series (§2.1, §3.1),
// each requested in its annual AND trailing flavour, mapped to the column it
// fills. Order is the request order.
var yahooFlowSeries = []struct{ name, column string }{
	{"TotalRevenue", "revenue"},
	{"NetIncomeCommonStockholders", "net_income"},
	{"BasicEPS", "eps_basic"},
	{"DilutedEPS", "eps_diluted"},
	{"OperatingCashFlow", "operating_cash_flow"},
	{"CashFlowsfromusedinOperatingActivitiesDirect", seriesOCFDirect},
	{"FreeCashFlow", "free_cash_flow"},
	{"GrossProfit", "gross_profit"},
	{"OperatingIncome", "operating_income"},
	{"EBITDA", "ebitda"},
	{"NormalizedEBITDA", "normalized_ebitda"},
	{"EBIT", "ebit"},
	{"InterestExpense", "interest_expense"},
	{"PretaxIncome", "pretax_income"},
	{"TaxProvision", "tax_provision"},
	{"NetInterestIncome", "net_interest_income"},
	{"CapitalExpenditure", "capital_expenditure"},
	{"CashDividendsPaid", "dividends_paid"},
	{"RepurchaseOfCapitalStock", "share_buybacks"},
}

// yahooBalanceSeries are the balance-sheet series plus the share count, each
// requested in its annual AND quarterly flavour (§3.1). The quarterly points
// become 'quarter' balance snapshots (§3.3).
var yahooBalanceSeries = []struct{ name, column string }{
	{"TotalAssets", "total_assets"},
	{"TotalLiabilitiesNetMinorityInterest", "total_liabilities"},
	{"StockholdersEquity", "total_equity"},
	{"CashAndCashEquivalents", "cash_and_equivalents"},
	{"TotalDebt", "total_debt"},
	{"CapitalLeaseObligations", "capital_lease_obligations"},
	{"NetDebt", "net_debt"},
	{"CurrentAssets", "current_assets"},
	{"CurrentLiabilities", "current_liabilities"},
	{"OrdinarySharesNumber", "shares_outstanding"},
}

// yahooSeries is one requested type and the row it fills.
type yahooSeries struct {
	typ        string // the Yahoo type, e.g. "annualTotalRevenue"
	periodType string // periodAnnual | periodTTM | periodQuarter
	periodKind string // Yahoo's periodType for the series: "12M", "TTM" or "3M"
	column     string // a fundamentalsColumns name, or seriesOCFDirect
}

// yahooSeriesList is every requested type, in request order: the flow series
// (annual, trailing), then the balance series (annual, quarterly). Nothing
// else is requested: no valuation series, no quarterly income or cash-flow
// series (§3.1; Yahoo's quarterly P&L is empty for the ASX anyway).
var yahooSeriesList = func() []yahooSeries {
	var out []yahooSeries
	for _, s := range yahooFlowSeries {
		out = append(out,
			yahooSeries{"annual" + s.name, periodAnnual, "12M", s.column},
			yahooSeries{"trailing" + s.name, periodTTM, "TTM", s.column},
		)
	}
	for _, s := range yahooBalanceSeries {
		out = append(out,
			yahooSeries{"annual" + s.name, periodAnnual, "12M", s.column},
			yahooSeries{"quarterly" + s.name, periodQuarter, "3M", s.column},
		)
	}
	return out
}()

var yahooSeriesByType = func() map[string]yahooSeries {
	m := make(map[string]yahooSeries, len(yahooSeriesList))
	for _, s := range yahooSeriesList {
		m[s.typ] = s
	}
	return m
}()

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

// yahooTimeseriesURL builds the ONE GET per code (§3.1). The type list is
// joined with literal commas (sub-delimiters are legal in a query, and it is
// the exact request the probes made); period2 is a year ahead so a
// just-published period is never outside the window.
func yahooTimeseriesURL(code string, now time.Time) string {
	types := make([]string, len(yahooSeriesList))
	for i, s := range yahooSeriesList {
		types[i] = s.typ
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

// yahooValue is one parsed point waiting for its row's currency decision.
type yahooValue struct {
	v        float64
	currency string
}

// parseYahooTimeseries turns one timeseries document into rows: annual series
// into period_type 'annual', trailing series into 'ttm', quarterly balance
// series into 'quarter' snapshots; one row per (period_type, asOfDate), with
// period_end = asOfDate exactly as Yahoo reports it.
//
// Currency, per field (§3.4): each row's currency is the REPORTING currency
// its MONETARY points agree on (the most common currencyCode among them; a tie
// goes to the revenue line's currency, then net income's, then the
// alphabetically first). A monetary point in another currency is NOT stored
// under the row's: that field is nulled and named in Rejected (a
// currency_conflict, counted by the gates), and the rest of the row stands.
// EPS and share counts ignore currencyCode (Yahoo labels XRO's older EPS
// points NZD beside AUD revenue, although the values are AUD-converted like
// every other XRO figure; the fx_converted gate withholds them all); a row
// with no monetary point takes its per-share points' currency.
//
// Operating cash flow (§3.2): the reported OperatingCashFlow series; else the
// direct-method series for the same period. The FCF-minus-capex derivation
// runs later (deriveOperatingCashFlow), after the sanity gates.
//
// Values that are not finite, or not a plausible statement line, are left
// NULL here and counted by sanitizeRows.
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
	acc := map[key]map[string]yahooValue{}

	for _, entry := range doc.Timeseries.Result {
		var meta yahooMeta
		if raw, ok := entry["meta"]; !ok || json.Unmarshal(raw, &meta) != nil || len(meta.Type) == 0 {
			continue
		}
		series, known := yahooSeriesByType[meta.Type[0]]
		raw, ok := entry[meta.Type[0]]
		if !known || !ok {
			continue // a series we did not ask for, or one with no points
		}
		var points []*yahooPoint
		if err := json.Unmarshal(raw, &points); err != nil {
			return nil, fmt.Errorf("parse %s: %w", meta.Type[0], err)
		}
		for _, p := range points {
			if p == nil || p.ReportedValue.Raw == "" {
				continue
			}
			if p.PeriodType != "" && p.PeriodType != series.periodKind {
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
			k := key{series.periodType, end}
			if acc[k] == nil {
				acc[k] = map[string]yahooValue{}
			}
			acc[k][series.column] = yahooValue{v: *v, currency: strings.ToUpper(strings.TrimSpace(p.CurrencyCode))}
		}
	}

	out := make([]PeriodRow, 0, len(acc))
	for k, vals := range acc {
		row := PeriodRow{PeriodType: k.periodType, PeriodEnd: k.end, Source: sourceYahoo}
		row.Currency = rowCurrency(vals)
		for _, c := range fundamentalsColumns { // column order: Rejected is deterministic
			pv, ok := vals[c.name]
			if !ok {
				continue
			}
			if k.periodType == periodQuarter && !c.isBalance() {
				continue // a snapshot carries balance lines only
			}
			if c.isMonetary() && pv.currency != "" && pv.currency != row.Currency {
				row.reject(c.name)
				continue
			}
			v := pv.v
			c.set(&row, &v)
		}
		if d, ok := vals[seriesOCFDirect]; ok && k.periodType != periodQuarter &&
			row.OperatingCashFlow == nil && !row.isRejected("operating_cash_flow") &&
			(d.currency == "" || d.currency == row.Currency) {
			v := d.v
			row.OperatingCashFlow = &v
		}
		out = append(out, row)
	}
	sortRows(out)
	return out, nil
}

// rowCurrency is the §3.4 row-currency decision for one row's points.
func rowCurrency(vals map[string]yahooValue) string {
	pick := func(monetary bool) string {
		votes := map[string]int{}
		for name, pv := range vals {
			if pv.currency == "" {
				continue
			}
			isMonetary := name == seriesOCFDirect
			if c, ok := columnNamed(name); ok {
				isMonetary = c.isMonetary()
			}
			if isMonetary == monetary {
				votes[pv.currency]++
			}
		}
		if len(votes) == 0 {
			return ""
		}
		best := 0
		for _, n := range votes {
			if n > best {
				best = n
			}
		}
		var tied []string
		for cur, n := range votes {
			if n == best {
				tied = append(tied, cur)
			}
		}
		if len(tied) == 1 {
			return tied[0]
		}
		for _, anchor := range []string{"revenue", "net_income"} {
			if pv, ok := vals[anchor]; ok {
				for _, t := range tied {
					if t == pv.currency {
						return t
					}
				}
			}
		}
		sort.Strings(tied)
		return tied[0]
	}
	if cur := pick(true); cur != "" {
		return cur
	}
	return pick(false)
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
