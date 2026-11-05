package marketdata

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/jobs/marketdata/providers"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/stealthhttp"
)

func indexSyncJob() runner.Job {
	return runner.Func{
		JobName: "index-sync",
		Desc:    "fetch benchmark index levels (XJO, XKO, XAO, XJT) into index_prices",
		Fn:      runIndexSync,
	}
}

// indexChartURL builds the Yahoo chart request for one symbol and window.
//
// Yahoo must be reached through stealthhttp, not net/http. A plain client — and
// the vendored yfinance — get "Too Many Requests" for every symbol, including
// ones the ordinary price ingest pulls daily, so this is not about volume: it
// is a TLS/header fingerprint wall. stealthhttp is the same client the
// announcements crawl already uses to get past it.
func indexChartURL(symbol string, from, to time.Time) string {
	return fmt.Sprintf(
		"https://query1.finance.yahoo.com/v8/finance/chart/%s?period1=%d&period2=%d&interval=1d",
		url.PathEscape(symbol), from.Unix(), to.Unix())
}

// chartResponse is the slice of Yahoo's payload we rely on. Deliberately
// narrow: the document is large and mostly presentational, and binding to more
// of it would make an upstream cosmetic change look like an outage.
type chartResponse struct {
	Chart struct {
		Result []struct {
			Meta struct {
				Symbol   string `json:"symbol"`
				Currency string `json:"currency"`
			} `json:"meta"`
			Timestamp  []int64 `json:"timestamp"`
			Indicators struct {
				Quote []struct {
					Open   []*float64 `json:"open"`
					High   []*float64 `json:"high"`
					Low    []*float64 `json:"low"`
					Close  []*float64 `json:"close"`
					Volume []*int64   `json:"volume"`
				} `json:"quote"`
			} `json:"indicators"`
		} `json:"result"`
		Error *struct {
			Code        string `json:"code"`
			Description string `json:"description"`
		} `json:"error"`
	} `json:"chart"`
}

// indexBar is one session of an index series.
type indexBar struct {
	Date                   time.Time
	Open, High, Low, Close *float64
	Volume                 *int64
}

// parseIndexChart turns a Yahoo chart payload into bars.
//
// A session with no close is dropped rather than stored as zero: an index level
// of 0 is not a quiet gap, it is a 100% drawdown, and it would poison any
// return computed across it.
func parseIndexChart(body []byte) ([]indexBar, string, error) {
	var doc chartResponse
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, "", fmt.Errorf("decode chart: %w", err)
	}
	if doc.Chart.Error != nil {
		return nil, "", fmt.Errorf("upstream error %s: %s", doc.Chart.Error.Code, doc.Chart.Error.Description)
	}
	if len(doc.Chart.Result) == 0 {
		return nil, "", errors.New("chart response carried no result")
	}
	res := doc.Chart.Result[0]
	if len(res.Indicators.Quote) == 0 {
		return nil, res.Meta.Currency, nil
	}
	q := res.Indicators.Quote[0]

	bars := make([]indexBar, 0, len(res.Timestamp))
	for i, ts := range res.Timestamp {
		bar := indexBar{Date: providers.SessionDate(ts)}
		at := func(xs []*float64) *float64 {
			if i < len(xs) && xs[i] != nil && !math.IsNaN(**&xs[i]) && !math.IsInf(*xs[i], 0) {
				return xs[i]
			}
			return nil
		}
		bar.Open, bar.High, bar.Low, bar.Close = at(q.Open), at(q.High), at(q.Low), at(q.Close)
		if i < len(q.Volume) && q.Volume[i] != nil {
			bar.Volume = q.Volume[i]
		}
		if bar.Close == nil {
			continue
		}
		bars = append(bars, bar)
	}
	return bars, res.Meta.Currency, nil
}

type indexSeries struct {
	Code         string
	SourceSymbol string
}

func loadIndexRegistry(ctx context.Context, pool *pgxpool.Pool) ([]indexSeries, error) {
	rows, err := pool.Query(ctx,
		`SELECT index_code, source_symbol FROM index_metadata WHERE source = 'yahoo' ORDER BY index_code`)
	if err != nil {
		return nil, fmt.Errorf("read index registry: %w", err)
	}
	defer rows.Close()
	var out []indexSeries
	for rows.Next() {
		var s indexSeries
		if err := rows.Scan(&s.Code, &s.SourceSymbol); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// execer is what the index writes need. A pool and a transaction both have it,
// and the upsert and the clean-up of one series share a transaction.
type execer interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

func upsertIndexBars(ctx context.Context, db execer, code string, bars []indexBar) (int64, error) {
	var written int64
	for _, b := range bars {
		tag, err := db.Exec(ctx, `
			INSERT INTO index_prices (index_code, date, open, high, low, close, volume)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (index_code, date) DO UPDATE SET
				open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
				close = EXCLUDED.close, volume = EXCLUDED.volume, updated_at = now()`,
			code, b.Date, b.Open, b.High, b.Low, b.Close, b.Volume)
		if err != nil {
			return written, fmt.Errorf("upsert %s %s: %w", code, b.Date.Format("2006-01-02"), err)
		}
		written += tag.RowsAffected()
	}
	return written, nil
}

// staleIndexRows selects one series' stored rows that a fetch should have
// replaced: dated inside the fetched window and absent from the response. The
// response's dates arrive as one comma-separated string, which is the one form
// every pgx protocol mode encodes the same way. Rows outside the window are
// history this response does not describe, so they are never selected.
const staleIndexRows = `index_code = $1 AND date BETWEEN $2 AND $3
	AND date <> ALL(string_to_array($4, ',')::date[])`

// barWindow is the first and last session of a response and every session it
// carries, as the comma-separated list staleIndexRows reads.
func barWindow(bars []indexBar) (first, last time.Time, dates string) {
	first, last = bars[0].Date, bars[0].Date
	days := make([]string, 0, len(bars))
	for _, b := range bars {
		if b.Date.Before(first) {
			first = b.Date
		}
		if b.Date.After(last) {
			last = b.Date
		}
		days = append(days, b.Date.Format("2006-01-02"))
	}
	return first, last, strings.Join(days, ",")
}

// replaceIndexBars writes one series' sessions and removes the stale rows the
// old UTC dating left inside the window: the weekend rows it filed under a
// Saturday or Sunday, and any holiday row the response no longer carries. Both
// happen in one transaction, so a failure leaves the series as it was. An empty
// response writes and removes nothing.
func replaceIndexBars(ctx context.Context, pool *pgxpool.Pool, code string, bars []indexBar) (written, removed int64, err error) {
	if len(bars) == 0 {
		return 0, 0, nil
	}
	first, last, dates := barWindow(bars)
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("begin %s: %w", code, err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // a no-op once committed
	written, err = upsertIndexBars(ctx, tx, code, bars)
	if err != nil {
		return 0, 0, err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM index_prices WHERE `+staleIndexRows, code, first, last, dates)
	if err != nil {
		return 0, 0, fmt.Errorf("remove stale %s rows: %w", code, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, fmt.Errorf("commit %s: %w", code, err)
	}
	return written, tag.RowsAffected(), nil
}

// countStaleIndexRows is the dry run's count of what replaceIndexBars would
// remove for the same response. It writes nothing.
func countStaleIndexRows(ctx context.Context, pool *pgxpool.Pool, code string, bars []indexBar) (int64, error) {
	if len(bars) == 0 {
		return 0, nil
	}
	first, last, dates := barWindow(bars)
	var n int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM index_prices WHERE `+staleIndexRows,
		code, first, last, dates).Scan(&n); err != nil {
		return 0, fmt.Errorf("count stale %s rows: %w", code, err)
	}
	return n, nil
}

func runIndexSync(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("market-data index-sync", flag.ContinueOnError)
	years := fs.Int("years", 2, "How many years back to fetch")
	dryRun := fs.Bool("dry-run", false, "Fetch and report without writing")
	only := fs.String("code", "", "Sync a single index code (e.g. XJO); default all")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return runner.ErrUsage
		}
		return err
	}

	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	// buildDBPoolConfig, not pgxpool.New: it sets
	// QueryExecModeSimpleProtocol, which is not optional against Supabase's
	// TRANSACTION pooler. The pooler hands a statement to whichever backend is
	// free, so pgx's prepared-statement cache goes out of step with the server
	// almost immediately.
	//
	// Written without it, this job failed in production in exactly that shape:
	// XAO wrote 506 sessions, then XJO's first upsert returned
	//
	//   prepared statement "stmtcache_549a4a..." does not exist (SQLSTATE 26000)
	//
	// and the retry returned "already exists" (SQLSTATE 42P05) — the cache and
	// the backend disagreeing in both directions. Partial success first is what
	// makes it nasty: the failure looks like bad data on one series rather than
	// a connection posture that was wrong from the start.
	poolConfig, err := buildDBPoolConfig(cfg)
	if err != nil {
		return fmt.Errorf("pool config: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer pool.Close()

	registry, err := loadIndexRegistry(ctx, pool)
	if err != nil {
		return err
	}
	if len(registry) == 0 {
		return errors.New("index_metadata is empty — has migration 000117 been applied?")
	}

	client, err := stealthhttp.New(stealthhttp.WithTimeout(45 * time.Second))
	if err != nil {
		return fmt.Errorf("stealth client: %w", err)
	}
	defer client.Close()

	to := time.Now().UTC()
	from := to.AddDate(-*years, 0, 0)

	var failures int
	for _, s := range registry {
		if *only != "" && s.Code != *only {
			continue
		}
		body, _, err := client.FetchBytes(ctx, indexChartURL(s.SourceSymbol, from, to), "application/json")
		if err != nil {
			// One unavailable series must not fail the others. XJT in
			// particular only exists from 2019, so a long window legitimately
			// 400s for it while every other series succeeds.
			log.Printf("index-sync: %s (%s) fetch failed: %v", s.Code, s.SourceSymbol, err)
			failures++
			continue
		}
		bars, currency, err := parseIndexChart(body)
		if err != nil {
			log.Printf("index-sync: %s (%s) parse failed: %v", s.Code, s.SourceSymbol, err)
			failures++
			continue
		}
		if len(bars) == 0 {
			log.Printf("index-sync: %s returned no sessions", s.Code)
			continue
		}
		if *dryRun {
			stale, err := countStaleIndexRows(ctx, pool, s.Code, bars)
			if err != nil {
				return err
			}
			log.Printf("index-sync: [dry-run] %s %s %d sessions %s..%s; would remove %d stored rows in that window",
				s.Code, currency, len(bars), bars[0].Date.Format("2006-01-02"),
				bars[len(bars)-1].Date.Format("2006-01-02"), stale)
			continue
		}
		written, removed, err := replaceIndexBars(ctx, pool, s.Code, bars)
		if err != nil {
			return err
		}
		log.Printf("index-sync: %s %d sessions written (%s..%s), %d stale rows removed", s.Code, written,
			bars[0].Date.Format("2006-01-02"), bars[len(bars)-1].Date.Format("2006-01-02"), removed)
	}

	// Every series failing is an outage worth a non-zero exit; some failing is
	// the expected steady state while XJT's history is shorter than the window.
	if failures > 0 && failures == len(registry) {
		return fmt.Errorf("every index series failed (%d)", failures)
	}
	return nil
}
