package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"sort"
	"strings"
	"time"
	_ "time/tzdata" // the jobs image is distroless; embed the zone session dates depend on

	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

// asxLocation is the exchange's zone, which is what a session's DATE is in.
//
// Yahoo stamps a daily bar with the session's open in UTC. 10:00 AEST is 00:00Z
// the same day, but 10:00 AEDT (October to April) is 23:00Z the PREVIOUS day.
// This provider used to take the UTC date of that timestamp, so every summer
// session was filed under the day before: Monday's bar landed on the Sunday.
// That is why prod holds Sunday-dated prices from November 2025 to March 2026.
var asxLocation = mustLoadLocation("Australia/Sydney")

func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(fmt.Sprintf("load %s: %v", name, err)) // unreachable with time/tzdata embedded
	}
	return loc
}

// chartFetcher fetches one Yahoo chart document. *stealthhttp.Client satisfies
// it; tests substitute a stub.
type chartFetcher interface {
	FetchBytes(ctx context.Context, pageURL, accept string) ([]byte, string, error)
}

// yahooRequestInterval spaces requests. Yahoo publishes no limit; four seconds
// is 900 an hour, and a full sweep of the market (~2,000 codes) fits inside
// one run at that pace.
const yahooRequestInterval = 4 * time.Second

// YahooFinanceDirectProvider reads Yahoo's v8 chart API.
type YahooFinanceDirectProvider struct {
	fetch    chartFetcher
	close    func() error
	interval time.Duration
}

// NewYahooFinanceDirectProvider builds the provider on the stealth client.
//
// It used a plain net/http client, which Yahoo answers with HTTP 429 "Too Many
// Requests" whatever the request rate: the wall is a TLS and header fingerprint
// (index_sync.go, which hit it first). Reproduced on 2026-09-27 for BHP.AX: 429
// from a plain client, 29 daily bars from this one.
func NewYahooFinanceDirectProvider() (*YahooFinanceDirectProvider, error) {
	c, err := stealthhttp.New(stealthhttp.WithTimeout(45 * time.Second))
	if err != nil {
		return nil, fmt.Errorf("yahoo: stealth client: %w", err)
	}
	return &YahooFinanceDirectProvider{fetch: c, close: c.Close, interval: yahooRequestInterval}, nil
}

// Close releases the stealth client.
func (p *YahooFinanceDirectProvider) Close() error {
	if p.close == nil {
		return nil
	}
	return p.close()
}

func (p *YahooFinanceDirectProvider) Name() string {
	return "Yahoo Finance (Direct)"
}

// GetRateLimit is the interval between requests.
func (p *YahooFinanceDirectProvider) GetRateLimit() time.Duration {
	return p.interval
}

// yahooChartResponse is the slice of the v8 chart payload this provider reads.
// Prices are pointers because Yahoo sends null for a session with no trade
// data; decoding null into a float64 left 0, which was stored as a $0 price.
type yahooChartResponse struct {
	Chart struct {
		Result []struct {
			Timestamp  []int64 `json:"timestamp"`
			Indicators struct {
				Quote []struct {
					Open   []*float64 `json:"open"`
					High   []*float64 `json:"high"`
					Low    []*float64 `json:"low"`
					Close  []*float64 `json:"close"`
					Volume []*int64   `json:"volume"`
				} `json:"quote"`
				AdjClose []struct {
					AdjClose []*float64 `json:"adjclose"`
				} `json:"adjclose"`
			} `json:"indicators"`
		} `json:"result"`
		Error *struct {
			Code        string `json:"code"`
			Description string `json:"description"`
		} `json:"error"`
	} `json:"chart"`
}

// FetchHistoricalData returns the sessions from startDate's day to endDate's
// day inclusive (UTC calendar dates; the sync passes midnight-UTC dates).
//
// A range over two years is fetched in two-year chunks, newest first. An empty
// newest chunk ends the fetch (a code Yahoo does not carry has no older
// sessions worth four more requests), and so does the first chunk to fail or
// come back empty after one with sessions: the newer sessions are kept, and
// anything older is the historical backfill's to fill.
func (p *YahooFinanceDirectProvider) FetchHistoricalData(ctx context.Context, symbol string, startDate, endDate time.Time) ([]PriceRecord, error) {
	ticker := symbol
	if !strings.HasSuffix(ticker, ".AX") {
		ticker = symbol + ".AX"
	}
	from, to := utcDay(startDate), utcDay(endDate)
	if to.Before(from) {
		return nil, NewNoDataError(symbol, fmt.Sprintf("empty range %s to %s", from.Format("2006-01-02"), to.Format("2006-01-02")))
	}

	const chunkDays = 730
	var all []PriceRecord
	for chunkTo := to; !chunkTo.Before(from); chunkTo = chunkTo.AddDate(0, 0, -(chunkDays + 1)) {
		chunkFrom := chunkTo.AddDate(0, 0, -chunkDays)
		if chunkFrom.Before(from) {
			chunkFrom = from
		}
		if chunkTo != to {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(p.GetRateLimit()):
			}
		}
		records, err := p.fetchRange(ctx, ticker, symbol, chunkFrom, chunkTo)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, ctxErr
			}
			if len(all) == 0 {
				return nil, err
			}
			if !IsNoDataError(err) {
				log.Printf("⚠️ %s: sessions before %s not fetched: %v", ticker, chunkTo.AddDate(0, 0, 1).Format("2006-01-02"), err)
			}
			break
		}
		all = append(all, records...)
	}
	return dedupeByDate(all), nil
}

// fetchRange requests one window. period1/period2 are padded by two days on
// each side, because an AEDT session's timestamp falls on the previous UTC day,
// and the result is then cut back to [from, to] by SESSION date.
func (p *YahooFinanceDirectProvider) fetchRange(ctx context.Context, ticker, symbol string, from, to time.Time) ([]PriceRecord, error) {
	q := url.Values{}
	q.Set("interval", "1d")
	q.Set("period1", fmt.Sprint(from.AddDate(0, 0, -2).Unix()))
	q.Set("period2", fmt.Sprint(to.AddDate(0, 0, 2).Unix()))
	q.Set("includePrePost", "false")
	u := "https://query1.finance.yahoo.com/v8/finance/chart/" + url.PathEscape(ticker) + "?" + q.Encode()

	body, _, err := p.fetch.FetchBytes(ctx, u, "application/json")
	if err != nil {
		if stealthhttp.StatusError(err) == 404 {
			return nil, NewNoDataError(symbol, "yahoo: HTTP 404")
		}
		// A 429, a 5xx or a transport failure is NOT "no data". Reporting it as
		// such is what lets the failure tracker block a live stock for 30 days.
		return nil, fmt.Errorf("yahoo %s: %w", ticker, err)
	}
	records, err := parseYahooChart(body, symbol)
	if err != nil {
		return nil, err
	}
	var out []PriceRecord
	for _, r := range records {
		if !r.Date.Before(from) && !r.Date.After(to) {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return nil, NewNoDataError(symbol, fmt.Sprintf("no sessions from %s to %s", from.Format("2006-01-02"), to.Format("2006-01-02")))
	}
	return out, nil
}

// parseYahooChart turns a chart document into one record per session with a
// close. Each record's Date is the session date in Sydney, at midnight UTC,
// which is what the stock_prices DATE column stores.
func parseYahooChart(body []byte, symbol string) ([]PriceRecord, error) {
	var doc yahooChartResponse
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("yahoo %s: parse: %w", symbol, err)
	}
	if e := doc.Chart.Error; e != nil {
		if strings.EqualFold(e.Code, "Not Found") {
			return nil, NewNoDataError(symbol, "yahoo: "+e.Description)
		}
		return nil, fmt.Errorf("yahoo %s: %s: %s", symbol, e.Code, e.Description)
	}
	if len(doc.Chart.Result) == 0 || len(doc.Chart.Result[0].Indicators.Quote) == 0 {
		return nil, NewNoDataError(symbol, "yahoo: no quote data")
	}
	res := doc.Chart.Result[0]
	quote := res.Indicators.Quote[0]
	var adj []*float64
	if len(res.Indicators.AdjClose) > 0 {
		adj = res.Indicators.AdjClose[0].AdjClose
	}
	at := func(s []*float64, i int) *float64 {
		if i < len(s) {
			return s[i]
		}
		return nil
	}

	var out []PriceRecord
	for i, ts := range res.Timestamp {
		closePrice := at(quote.Close, i)
		if closePrice == nil {
			continue // no trade data for the session: store nothing rather than $0
		}
		orClose := func(v *float64) float64 {
			if v == nil {
				return *closePrice
			}
			return *v
		}
		var volume int64
		if i < len(quote.Volume) && quote.Volume[i] != nil {
			volume = *quote.Volume[i]
		}
		adjClose := *closePrice
		if a := at(adj, i); a != nil && *a > 0 {
			adjClose = *a
		}
		out = append(out, PriceRecord{
			StockCode:     symbol,
			Date:          SessionDate(ts),
			Open:          orClose(at(quote.Open, i)),
			High:          orClose(at(quote.High, i)),
			Low:           orClose(at(quote.Low, i)),
			Close:         *closePrice,
			AdjustedClose: adjClose,
			Volume:        volume,
		})
	}
	return out, nil
}

// SessionDate is the ASX session a Yahoo bar timestamp belongs to: its
// calendar date in Sydney, as midnight UTC.
func SessionDate(ts int64) time.Time {
	t := time.Unix(ts, 0).In(asxLocation)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// utcDay truncates t to its UTC calendar date.
func utcDay(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// dedupeByDate keeps one record per date (chunks can overlap) and sorts them.
func dedupeByDate(records []PriceRecord) []PriceRecord {
	byDate := make(map[time.Time]PriceRecord, len(records))
	for _, r := range records {
		byDate[r.Date] = r
	}
	out := make([]PriceRecord, 0, len(byDate))
	for _, r := range byDate {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Date.Before(out[j].Date) })
	return out
}
