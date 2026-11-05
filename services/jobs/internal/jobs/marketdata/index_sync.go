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

	"github.com/jackc/pgx/v5"
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

// indexChart is one parsed response.
//
// Bars are the sessions that carry a close: the only rows a write stores.
// Sessions is every session stamp in the response, null close included. A
// session Yahoo stamps without a close is still a session it describes, so the
// clean-up must not remove a stored row on that date.
type indexChart struct {
	Currency string
	Bars     []indexBar
	Sessions []time.Time
}

// parseIndexChart turns a Yahoo chart payload into bars.
//
// A session with no close is dropped from Bars rather than stored as zero: an
// index level of 0 is not a quiet gap, it is a 100% drawdown, and it would
// poison any return computed across it. It stays in Sessions.
func parseIndexChart(body []byte) (indexChart, error) {
	var doc chartResponse
	if err := json.Unmarshal(body, &doc); err != nil {
		return indexChart{}, fmt.Errorf("decode chart: %w", err)
	}
	if doc.Chart.Error != nil {
		return indexChart{}, fmt.Errorf("upstream error %s: %s", doc.Chart.Error.Code, doc.Chart.Error.Description)
	}
	if len(doc.Chart.Result) == 0 {
		return indexChart{}, errors.New("chart response carried no result")
	}
	res := doc.Chart.Result[0]
	ch := indexChart{Currency: res.Meta.Currency}
	for _, ts := range res.Timestamp {
		ch.Sessions = append(ch.Sessions, providers.SessionDate(ts))
	}
	if len(res.Indicators.Quote) == 0 {
		return ch, nil
	}
	q := res.Indicators.Quote[0]

	at := func(xs []*float64, i int) *float64 {
		if i < len(xs) && xs[i] != nil && !math.IsNaN(*xs[i]) && !math.IsInf(*xs[i], 0) {
			return xs[i]
		}
		return nil
	}
	for i, ts := range res.Timestamp {
		bar := indexBar{Date: providers.SessionDate(ts)}
		bar.Open, bar.High, bar.Low, bar.Close = at(q.Open, i), at(q.High, i), at(q.Low, i), at(q.Close, i)
		if i < len(q.Volume) && q.Volume[i] != nil {
			bar.Volume = q.Volume[i]
		}
		if bar.Close == nil {
			continue
		}
		ch.Bars = append(ch.Bars, bar)
	}
	return ch, nil
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

// execer is what the index upsert needs. A pool and a transaction both have it.
type execer interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// queryer is what the window count needs. A pool and a transaction both have it.
type queryer interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
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

// indexRemovalCeilingPct caps what one series' write may remove, as a share of
// the stored rows inside the fetched window. The legitimate re-date removes
// about one row in ten (the weekend rows the old dating filed in daylight-saving
// months); a response with gaps in it would remove far more. A write over the
// ceiling is refused and rolled back.
const indexRemovalCeilingPct = 15

// errRemovalCeiling is returned when a write would remove more than the ceiling.
var errRemovalCeiling = errors.New("removal above the ceiling")

// staleIndexWindow counts one series' stored rows inside the fetched window,
// and how many of them the response's session stamps do not carry. The stamps
// arrive as one comma-separated string, which is the one form every pgx protocol
// mode encodes the same way. Rows outside the window are history this response
// does not describe, so they are never counted or removed.
//
// The count is taken first, in the write's transaction, so the ceiling is
// judged against the same rows the DELETE then removes.
const staleIndexWindow = `SELECT
	count(*) FILTER (WHERE date <> ALL(string_to_array($4, ',')::date[])),
	count(*)
FROM index_prices WHERE index_code = $1 AND date BETWEEN $2 AND $3`

const staleIndexDelete = `DELETE FROM index_prices
WHERE index_code = $1 AND date BETWEEN $2 AND $3
	AND date <> ALL(string_to_array($4, ',')::date[])`

// chartWindow is the first and last session stamp of a response and every stamp
// as the comma-separated list the stale-row queries read.
func chartWindow(ch indexChart) (first, last time.Time, dates string) {
	first, last = ch.Sessions[0], ch.Sessions[0]
	days := make([]string, 0, len(ch.Sessions))
	for _, d := range ch.Sessions {
		if d.Before(first) {
			first = d
		}
		if d.After(last) {
			last = d
		}
		days = append(days, d.Format("2006-01-02"))
	}
	return first, last, strings.Join(days, ",")
}

// windowCounts returns the stored rows inside the response's window and how many
// of them the response does not carry.
func windowCounts(ctx context.Context, db queryer, code string, ch indexChart) (stale, inWindow int64, err error) {
	first, last, dates := chartWindow(ch)
	if err := db.QueryRow(ctx, staleIndexWindow, code, first, last, dates).Scan(&stale, &inWindow); err != nil {
		return 0, 0, fmt.Errorf("count %s window: %w", code, err)
	}
	return stale, inWindow, nil
}

// overCeiling reports whether removing stale rows out of inWindow is above the
// ceiling. Integer arithmetic, so no rounding decides a boundary case.
func overCeiling(stale, inWindow int64) bool {
	return stale*100 > indexRemovalCeilingPct*inWindow
}

// replaceIndexBars writes one series' sessions and removes the stale rows the
// old UTC dating left inside the window: the weekend rows it filed under a
// Saturday or Sunday, and any holiday row the response no longer carries. The
// upsert and the clean-up run in one transaction, so a failure leaves the series
// as it was. A response with no usable close writes and removes nothing, and a
// clean-up above the ceiling is refused with errRemovalCeiling.
func replaceIndexBars(ctx context.Context, pool *pgxpool.Pool, code string, ch indexChart) (written, removed int64, err error) {
	if len(ch.Bars) == 0 || len(ch.Sessions) == 0 {
		return 0, 0, nil
	}
	first, last, dates := chartWindow(ch)
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, fmt.Errorf("begin %s: %w", code, err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // a no-op once committed

	stale, inWindow, err := windowCounts(ctx, tx, code, ch)
	if err != nil {
		return 0, 0, err
	}
	if overCeiling(stale, inWindow) {
		return 0, 0, fmt.Errorf("%s %s..%s: %w: would remove %d of %d stored rows (limit %d%%)",
			code, first.Format("2006-01-02"), last.Format("2006-01-02"), errRemovalCeiling,
			stale, inWindow, indexRemovalCeilingPct)
	}
	written, err = upsertIndexBars(ctx, tx, code, ch.Bars)
	if err != nil {
		return 0, 0, err
	}
	tag, err := tx.Exec(ctx, staleIndexDelete, code, first, last, dates)
	if err != nil {
		return 0, 0, fmt.Errorf("remove stale %s rows: %w", code, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, fmt.Errorf("commit %s: %w", code, err)
	}
	return written, tag.RowsAffected(), nil
}

// countStaleIndexRows is the dry run's view of replaceIndexBars for the same
// response: the rows it would remove and the stored rows in the window. It
// writes nothing.
func countStaleIndexRows(ctx context.Context, pool *pgxpool.Pool, code string, ch indexChart) (stale, inWindow int64, err error) {
	if len(ch.Sessions) == 0 {
		return 0, 0, nil
	}
	return windowCounts(ctx, pool, code, ch)
}

// chartFetcher fetches one Yahoo chart document. *stealthhttp.Client satisfies
// it; tests substitute a stub.
type chartFetcher interface {
	FetchBytes(ctx context.Context, pageURL, accept string) ([]byte, string, error)
}

// syncIndexSeries fetches one series and, unless dryRun, writes it. A fetch or
// parse failure is logged and reported as failed, so the other series still
// run. A clean-up refused by the ceiling is logged and reported as failed too,
// and its error wraps errRemovalCeiling so the caller can count it as refused. A
// database error is returned: it is not a property of this series' upstream data.
func syncIndexSeries(ctx context.Context, pool *pgxpool.Pool, fetch chartFetcher, s indexSeries, from, to time.Time, dryRun bool) (failed bool, err error) {
	body, _, err := fetch.FetchBytes(ctx, indexChartURL(s.SourceSymbol, from, to), "application/json")
	if err != nil {
		// One unavailable series must not fail the others. XJT in particular
		// only exists from 2019, so a long window legitimately 400s for it
		// while every other series succeeds.
		log.Printf("index-sync: %s (%s) fetch failed: %v", s.Code, s.SourceSymbol, err)
		return true, nil
	}
	ch, err := parseIndexChart(body)
	if err != nil {
		log.Printf("index-sync: %s (%s) parse failed: %v", s.Code, s.SourceSymbol, err)
		return true, nil
	}
	if len(ch.Bars) == 0 {
		log.Printf("index-sync: %s returned no sessions", s.Code)
		return false, nil
	}
	first, last, _ := chartWindow(ch)
	span := first.Format("2006-01-02") + ".." + last.Format("2006-01-02")

	if dryRun {
		stale, inWindow, err := countStaleIndexRows(ctx, pool, s.Code, ch)
		if err != nil {
			return false, err
		}
		verdict := "within"
		if overCeiling(stale, inWindow) {
			verdict = "OVER"
		}
		log.Printf("index-sync: [dry-run] %s %s %d sessions %s; would remove %d of %d stored rows in that window (%s the %d%% ceiling)",
			s.Code, ch.Currency, len(ch.Bars), span, stale, inWindow, verdict, indexRemovalCeilingPct)
		return false, nil
	}

	written, removed, err := replaceIndexBars(ctx, pool, s.Code, ch)
	if errors.Is(err, errRemovalCeiling) {
		log.Printf("index-sync: %s refused, nothing written: %v", s.Code, err)
		return true, err
	}
	if err != nil {
		return false, err
	}
	log.Printf("index-sync: %s %d sessions written (%s), %d stale rows removed", s.Code, written, span, removed)
	return false, nil
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

	return syncIndexRegistry(ctx, pool, client, registry, *only, from, to, *dryRun)
}

// syncIndexRegistry runs syncIndexSeries over the registry, one series at a
// time, and decides the run's exit.
//
// A series whose fetch fails is a failure that leaves the others running. Every
// attempted series failing is an outage worth a non-zero exit, counted against
// the attempted series, so a run for one code (-code XJT) exits non-zero when
// that code fails. A clean-up the ceiling refused also fails the run, after the
// other series have been written: a refusal means the response had gaps in it,
// and nothing else in the run would tell anyone the series has stopped
// updating. A scheduled run that exits 0 with a refused series is silent.
func syncIndexRegistry(ctx context.Context, pool *pgxpool.Pool, fetch chartFetcher, registry []indexSeries, only string, from, to time.Time, dryRun bool) error {
	var attempted, failures, refused int
	for _, s := range registry {
		if only != "" && s.Code != only {
			continue
		}
		attempted++
		failed, err := syncIndexSeries(ctx, pool, fetch, s, from, to, dryRun)
		if errors.Is(err, errRemovalCeiling) {
			refused++
			failed, err = true, nil
		}
		if err != nil {
			return err
		}
		if failed {
			failures++
		}
	}
	if attempted == 0 {
		return fmt.Errorf("no index series %q in index_metadata", only)
	}
	if failures > 0 && failures == attempted {
		return fmt.Errorf("every index series failed (%d)", failures)
	}
	if refused > 0 {
		return fmt.Errorf("%d series refused by the removal ceiling; nothing written for them", refused)
	}
	return nil
}
