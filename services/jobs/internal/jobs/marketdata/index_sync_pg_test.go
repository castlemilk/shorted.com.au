package marketdata

// Real-Postgres tests for the index sync's write. Per series, the upsert and the
// bounded clean-up share one transaction, a clean-up above the removal ceiling
// is refused, and the dry run only counts. They need a disposable server: a URL
// in INDEXSYNC_TEST_DATABASE_URL, or a container when INDEXSYNC_TESTCONTAINERS=1
// with the testcontainers tag. Without either, the tests skip. make
// test-indexsync-pg runs them and gates the deploy.
//
//	cd services/jobs && INDEXSYNC_TESTCONTAINERS=1 GOWORK=off CGO_ENABLED=0 \
//	    go test -tags=testcontainers -count=1 -run IndexSyncPG ./internal/jobs/marketdata/

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// TestMain removes the container the suite starts under INDEXSYNC_TESTCONTAINERS=1.
// It starts nothing itself.
func TestMain(m *testing.M) {
	os.Exit(testpostgres.Main(m))
}

// indexPricesTable is migration 000117's index_prices, so the upsert and the
// clean-up run against the production shape and key.
const indexPricesTable = `
CREATE TABLE index_prices (
    index_code   VARCHAR(16)      NOT NULL,
    date         DATE             NOT NULL,
    open         DOUBLE PRECISION,
    high         DOUBLE PRECISION,
    low          DOUBLE PRECISION,
    close        DOUBLE PRECISION,
    volume       BIGINT,
    created_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    CONSTRAINT index_prices_code_date_key UNIQUE (index_code, date)
)`

func indexSyncTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn, err := testpostgres.Admin("INDEXSYNC_TEST_DATABASE_URL", "INDEXSYNC_TESTCONTAINERS")
	require.NoError(t, err)
	if dsn == "" {
		t.Skip("set INDEXSYNC_TEST_DATABASE_URL, or INDEXSYNC_TESTCONTAINERS=1 with -tags=testcontainers")
	}
	ctx := context.Background()
	name := fmt.Sprintf("indexsync_%d_%d", time.Now().UnixNano()%1e9, rand.Intn(1e6))

	admin, err := pgxpool.New(ctx, dsn)
	require.NoError(t, err)
	_, err = admin.Exec(ctx, "CREATE DATABASE "+name)
	require.NoError(t, err)
	t.Cleanup(func() {
		admin.Close()
		cleanup, err := pgxpool.New(context.Background(), dsn)
		if err != nil {
			return
		}
		defer cleanup.Close()
		_, _ = cleanup.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name+" WITH (FORCE)")
	})

	cfg, err := pgxpool.ParseConfig(dsn)
	require.NoError(t, err)
	cfg.ConnConfig.Database = name
	// The production pool runs simple protocol (buildDBPoolConfig), so the
	// statements here must too.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	_, err = pool.Exec(ctx, indexPricesTable)
	require.NoError(t, err)
	return pool
}

// mustDay parses a YYYY-MM-DD date.
func mustDay(t *testing.T, d string) time.Time {
	t.Helper()
	day, err := time.Parse("2006-01-02", d)
	require.NoError(t, err, d)
	return day
}

// weekdays returns every Monday to Friday from first to last inclusive.
func weekdays(t *testing.T, first, last string) []string {
	t.Helper()
	var out []string
	for day := mustDay(t, first); !day.After(mustDay(t, last)); day = day.AddDate(0, 0, 1) {
		if wd := day.Weekday(); wd != time.Saturday && wd != time.Sunday {
			out = append(out, day.Format("2006-01-02"))
		}
	}
	return out
}

// seedDates stores one row per date for a series, closing at 1.
func seedDates(t *testing.T, pool *pgxpool.Pool, code string, dates ...string) {
	t.Helper()
	for _, d := range dates {
		_, err := pool.Exec(context.Background(),
			`INSERT INTO index_prices (index_code, date, close) VALUES ($1, $2, 1)`, code, d)
		require.NoError(t, err, d)
	}
}

// chartFor builds the parsed response for the given session stamps, each
// closing at 100 except the ones named in nullClose, which are stamped but have
// no close.
func chartFor(t *testing.T, sessions []string, nullClose ...string) indexChart {
	t.Helper()
	nulls := map[string]bool{}
	for _, d := range nullClose {
		nulls[d] = true
	}
	ch := indexChart{Currency: "AUD"}
	for _, d := range sessions {
		day := mustDay(t, d)
		ch.Sessions = append(ch.Sessions, day)
		if nulls[d] {
			continue
		}
		c := 100.0
		ch.Bars = append(ch.Bars, indexBar{Date: day, Close: &c})
	}
	return ch
}

// chartBody is the raw Yahoo payload for the same sessions, stamped at each
// 10:00 Sydney open as Yahoo stamps them, so the parser dates them as given.
func chartBody(t *testing.T, sessions []string, nullClose ...string) []byte {
	t.Helper()
	nulls := map[string]bool{}
	for _, d := range nullClose {
		nulls[d] = true
	}
	ts := []int64{}
	closes := []any{}
	for _, d := range sessions {
		day := mustDay(t, d)
		ts = append(ts, time.Date(day.Year(), day.Month(), day.Day(), 10, 0, 0, 0, sydney).Unix())
		if nulls[d] {
			closes = append(closes, nil)
		} else {
			closes = append(closes, 100.0)
		}
	}
	body := map[string]any{"chart": map[string]any{
		"result": []any{map[string]any{
			"meta":       map[string]any{"symbol": "^AXJO", "currency": "AUD"},
			"timestamp":  ts,
			"indicators": map[string]any{"quote": []any{map[string]any{"open": closes, "high": closes, "low": closes, "close": closes, "volume": closes}}},
		}},
		"error": nil,
	}}
	out, err := json.Marshal(body)
	require.NoError(t, err)
	return out
}

// stubChart stands in for the stealth client: it returns a fixed payload or
// error and counts the fetches.
type stubChart struct {
	body  []byte
	err   error
	calls int
}

func (s *stubChart) FetchBytes(_ context.Context, _, _ string) ([]byte, string, error) {
	s.calls++
	return s.body, "", s.err
}

// snapshotIndex is every row of every series, values and updated_at included,
// so "unchanged" means unchanged in the strongest sense.
func snapshotIndex(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT index_code, to_char(date, 'YYYY-MM-DD'), close::text, updated_at::text
		   FROM index_prices ORDER BY index_code, date`)
	require.NoError(t, err)
	defer rows.Close()
	var lines []string
	for rows.Next() {
		var code, date, close, updated string
		require.NoError(t, rows.Scan(&code, &date, &close, &updated))
		lines = append(lines, strings.Join([]string{code, date, close, updated}, " "))
	}
	require.NoError(t, rows.Err())
	return strings.Join(lines, "\n")
}

func indexDates(t *testing.T, pool *pgxpool.Pool, code string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT to_char(date, 'YYYY-MM-DD') FROM index_prices WHERE index_code = $1 ORDER BY date`, code)
	require.NoError(t, err)
	defer rows.Close()
	var out []string
	for rows.Next() {
		var d string
		require.NoError(t, rows.Scan(&d))
		out = append(out, d)
	}
	require.NoError(t, rows.Err())
	return out
}

// The fixture. The response covers the weekdays from Mon 7 Sep to Fri 30 Oct
// 2026 except Mon 14 Sep, a holiday it does not carry. Stored XJO rows:
//
//	kept, before the window:       Fri 4 Sep, Sun 6 Sep
//	kept, in the response:         every other weekday in the window
//	removed, weekend in window:    Sat 12 Sep, Sat 3 Oct
//	removed, holiday in window:    Mon 14 Sep
//	kept, after the window:        Mon 2 Nov, Sat 7 Nov
//
// That is 3 of 42 stored rows in the window, well under the ceiling. XAO has
// rows on the same dates, which a clean-up of XJO must never touch.
const (
	fixtureFirst = "2026-09-07"
	fixtureLast  = "2026-10-30"
	holiday      = "2026-09-14"
)

// responseSessions is the fixture's response: every weekday in the window but
// the holiday.
func responseSessions(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, d := range weekdays(t, fixtureFirst, fixtureLast) {
		if d != holiday {
			out = append(out, d)
		}
	}
	return out
}

func seedWindowFixture(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	seedDates(t, pool, "XJO", weekdays(t, fixtureFirst, fixtureLast)...)
	seedDates(t, pool, "XJO", "2026-09-04", "2026-09-06", "2026-09-12", "2026-10-03", "2026-11-02", "2026-11-07")
	seedDates(t, pool, "XAO", "2026-09-12", "2026-09-14", "2026-10-03")
}

// windowKept is the fixture's XJO dates once a correct write has run.
func windowKept(t *testing.T) []string {
	t.Helper()
	out := []string{"2026-09-04", "2026-09-06"}
	out = append(out, responseSessions(t)...)
	return append(out, "2026-11-02", "2026-11-07")
}

// The response's 30 Oct close is the one value a write must replace.
func fixtureChart(t *testing.T) indexChart {
	t.Helper()
	ch := chartFor(t, responseSessions(t))
	require.Equal(t, "2026-10-30", ch.Bars[len(ch.Bars)-1].Date.Format("2006-01-02"))
	ch.Bars[len(ch.Bars)-1].Close = ptrFloat(555)
	return ch
}

// Rows outside the fetched window survive, weekend and holiday rows inside it go,
// the response's own rows are written, and another series is never touched.
func TestIndexSyncPGReplaceKeepsRowsOutsideTheWindow(t *testing.T) {
	pool := indexSyncTestDB(t)
	ctx := context.Background()
	seedWindowFixture(t, pool)

	written, removed, err := replaceIndexBars(ctx, pool, "XJO", fixtureChart(t))
	require.NoError(t, err)
	require.Equal(t, int64(len(responseSessions(t))), written)
	require.Equal(t, int64(3), removed, "12 Sep, 3 Oct and the 14 Sep holiday")

	require.Equal(t, windowKept(t), indexDates(t, pool, "XJO"))

	var close float64
	require.NoError(t, pool.QueryRow(ctx,
		`SELECT close FROM index_prices WHERE index_code = 'XJO' AND date = '2026-10-30'`).Scan(&close))
	require.Equal(t, 555.0, close, "the response's value replaces the stored one")

	require.Equal(t, []string{"2026-09-12", "2026-09-14", "2026-10-03"}, indexDates(t, pool, "XAO"),
		"another series keeps every row")

	// A second run of the same response has nothing left to remove.
	_, removed, err = replaceIndexBars(ctx, pool, "XJO", fixtureChart(t))
	require.NoError(t, err)
	require.Equal(t, int64(0), removed)
}

// A stored row on a date the response stamps without a close is kept. The
// response describes that session; only a missing one is stale.
func TestIndexSyncPGNullCloseSessionKeepsItsRow(t *testing.T) {
	pool := indexSyncTestDB(t)
	ctx := context.Background()
	seedDates(t, pool, "XJO", weekdays(t, fixtureFirst, fixtureLast)...)

	ch := chartFor(t, responseSessions(t), "2026-10-01")
	written, removed, err := replaceIndexBars(ctx, pool, "XJO", ch)
	require.NoError(t, err)
	require.Equal(t, int64(len(responseSessions(t))-1), written, "the null-close session is not written")
	require.Equal(t, int64(1), removed, "only the holiday, which the response does not stamp")

	dates := indexDates(t, pool, "XJO")
	require.Contains(t, dates, "2026-10-01", "a session the response stamps keeps its row")
	require.NotContains(t, dates, holiday)
}

// A clean-up above the ceiling is refused and rolled back: the upsert it shares a
// transaction with does not stick, and the series is unchanged. A response that
// carries only the first and last session of a 40-day stored window would remove
// 38 of its 40 rows.
func TestIndexSyncPGOverCeilingChangesNothing(t *testing.T) {
	pool := indexSyncTestDB(t)
	ctx := context.Background()
	seedDates(t, pool, "XJO", weekdays(t, fixtureFirst, fixtureLast)...)
	before := snapshotIndex(t, pool)

	gappy := chartFor(t, []string{fixtureFirst, fixtureLast})
	_, _, err := replaceIndexBars(ctx, pool, "XJO", gappy)
	require.True(t, errors.Is(err, errRemovalCeiling), "got %v", err)
	require.Equal(t, before, snapshotIndex(t, pool))

	stale, inWindow, err := countStaleIndexRows(ctx, pool, "XJO", gappy)
	require.NoError(t, err)
	require.Equal(t, int64(38), stale)
	require.Equal(t, int64(40), inWindow)
}

// A write that fails after the upsert leaves nothing behind: the upsert and the
// delete are one transaction. The trigger makes the delete fail.
func TestIndexSyncPGFailedDeleteRollsBackTheUpsert(t *testing.T) {
	pool := indexSyncTestDB(t)
	ctx := context.Background()
	seedWindowFixture(t, pool)
	before := snapshotIndex(t, pool)

	_, err := pool.Exec(ctx, `CREATE FUNCTION refuse_index_delete() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'delete refused for test'; END $$`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `CREATE TRIGGER refuse_index_delete BEFORE DELETE ON index_prices
		FOR EACH ROW EXECUTE FUNCTION refuse_index_delete()`)
	require.NoError(t, err)

	_, _, err = replaceIndexBars(ctx, pool, "XJO", fixtureChart(t))
	require.Error(t, err)
	require.False(t, errors.Is(err, errRemovalCeiling))
	require.Equal(t, before, snapshotIndex(t, pool), "the 30 Oct close and updated_at are as they were")
}

// An empty response writes and removes nothing, and so does one with no close.
func TestIndexSyncPGEmptyResponseDeletesNothing(t *testing.T) {
	pool := indexSyncTestDB(t)
	ctx := context.Background()
	seedWindowFixture(t, pool)
	before := snapshotIndex(t, pool)

	written, removed, err := replaceIndexBars(ctx, pool, "XJO", indexChart{})
	require.NoError(t, err)
	require.Equal(t, int64(0), written)
	require.Equal(t, int64(0), removed)

	// Stamps with no close are not a usable response either.
	noClose := chartFor(t, responseSessions(t), responseSessions(t)...)
	written, removed, err = replaceIndexBars(ctx, pool, "XJO", noClose)
	require.NoError(t, err)
	require.Equal(t, int64(0), written)
	require.Equal(t, int64(0), removed)
	require.Equal(t, before, snapshotIndex(t, pool))
}

// The dry run counts what the write would remove, with the same bounds, and
// writes nothing: no row is removed and no value or updated_at changes.
func TestIndexSyncPGDryRunCountsAndWritesNothing(t *testing.T) {
	pool := indexSyncTestDB(t)
	ctx := context.Background()
	seedWindowFixture(t, pool)
	before := snapshotIndex(t, pool)

	stale, inWindow, err := countStaleIndexRows(ctx, pool, "XJO", fixtureChart(t))
	require.NoError(t, err)
	require.Equal(t, int64(3), stale)
	require.Equal(t, int64(42), inWindow)
	require.Equal(t, before, snapshotIndex(t, pool), "a dry run changes nothing")

	// The count agrees with the write it previews.
	_, removed, err := replaceIndexBars(ctx, pool, "XJO", fixtureChart(t))
	require.NoError(t, err)
	require.Equal(t, stale, removed)
}

// The per-series step, end to end against a stub fetcher: a failed fetch, an
// upstream error and an empty response change nothing; a dry run changes nothing
// even for a response that would write; a refused clean-up is a failed series;
// and a real run writes.
func TestIndexSyncPGSeriesStepWritesOnlyWhenItShould(t *testing.T) {
	pool := indexSyncTestDB(t)
	ctx := context.Background()
	series := indexSeries{Code: "XJO", SourceSymbol: "^AXJO"}
	from, to := mustDay(t, "2024-01-01"), mustDay(t, "2026-11-05")

	seedWindowFixture(t, pool)
	before := snapshotIndex(t, pool)

	failed, err := syncIndexSeries(ctx, pool, &stubChart{err: errors.New("HTTP 400")}, series, from, to, false)
	require.NoError(t, err)
	require.True(t, failed, "a failed fetch is a failed series")
	require.Equal(t, before, snapshotIndex(t, pool))

	upstream := []byte(`{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found"}}}`)
	failed, err = syncIndexSeries(ctx, pool, &stubChart{body: upstream}, series, from, to, false)
	require.NoError(t, err)
	require.True(t, failed)
	require.Equal(t, before, snapshotIndex(t, pool))

	failed, err = syncIndexSeries(ctx, pool, &stubChart{body: chartBody(t, nil)}, series, from, to, false)
	require.NoError(t, err)
	require.False(t, failed, "an empty window is not a failure")
	require.Equal(t, before, snapshotIndex(t, pool))

	// A dry run of a response that would write changes nothing.
	fetch := &stubChart{body: chartBody(t, responseSessions(t))}
	failed, err = syncIndexSeries(ctx, pool, fetch, series, from, to, true)
	require.NoError(t, err)
	require.False(t, failed)
	require.Equal(t, 1, fetch.calls)
	require.Equal(t, before, snapshotIndex(t, pool), "-dry-run writes nothing")

	// A gappy response is refused: a failed series that reports the ceiling, not a write.
	failed, err = syncIndexSeries(ctx, pool, &stubChart{body: chartBody(t, []string{fixtureFirst, fixtureLast})}, series, from, to, false)
	require.True(t, errors.Is(err, errRemovalCeiling), "got %v", err)
	require.True(t, failed)
	require.Equal(t, before, snapshotIndex(t, pool))

	// The real run writes what the window fixture expects.
	failed, err = syncIndexSeries(ctx, pool, &stubChart{body: chartBody(t, responseSessions(t))}, series, from, to, false)
	require.NoError(t, err)
	require.False(t, failed)
	require.Equal(t, windowKept(t), indexDates(t, pool, "XJO"))
}

// seqChart returns its payloads in order, one per fetch, so one run can see a
// different response for each series.
type seqChart struct {
	bodies [][]byte
	calls  int
}

func (s *seqChart) FetchBytes(_ context.Context, _, _ string) ([]byte, string, error) {
	body := s.bodies[s.calls]
	s.calls++
	return body, "", nil
}

// A refused clean-up fails the run, and the run still writes the other series.
// Without this the scheduled CronJob exits 0 on a gappy response and nothing
// tells anyone XJO has stopped updating.
func TestIndexSyncPGRefusalFailsTheRun(t *testing.T) {
	pool := indexSyncTestDB(t)
	ctx := context.Background()
	// XJO: 42 stored rows in the window, 3 stale (the window fixture's XJO rows).
	seedDates(t, pool, "XJO", weekdays(t, fixtureFirst, fixtureLast)...)
	seedDates(t, pool, "XJO", "2026-09-12", "2026-10-03")
	// XAO needs enough rows in the window that its own clean-up is under the
	// ceiling: every weekday of the window, plus the two weekend rows.
	seedDates(t, pool, "XAO", weekdays(t, fixtureFirst, fixtureLast)...)
	seedDates(t, pool, "XAO", "2026-09-12", "2026-10-03")
	xjoBefore := indexDates(t, pool, "XJO")

	registry := []indexSeries{{Code: "XJO", SourceSymbol: "^AXJO"}, {Code: "XAO", SourceSymbol: "^AXAO"}}
	from, to := mustDay(t, "2024-01-01"), mustDay(t, "2026-11-05")
	fetch := &seqChart{bodies: [][]byte{
		chartBody(t, []string{fixtureFirst, fixtureLast}), // gappy: XJO is refused
		chartBody(t, responseSessions(t)),                 // XAO writes
	}}

	err := syncIndexRegistry(ctx, pool, fetch, registry, "", from, to, false)
	require.Error(t, err, "a refused series must fail the run")
	require.Contains(t, err.Error(), "refused")
	require.Equal(t, 2, fetch.calls)
	require.Equal(t, xjoBefore, indexDates(t, pool, "XJO"), "the refused series is unchanged")
	require.Equal(t, responseSessions(t), indexDates(t, pool, "XAO"), "the other series is still written")

	// The same registry with a response that writes cleanly exits 0.
	clean := &seqChart{bodies: [][]byte{chartBody(t, responseSessions(t)), chartBody(t, responseSessions(t))}}
	require.NoError(t, syncIndexRegistry(ctx, pool, clean, registry, "", from, to, false))
}

func ptrFloat(v float64) *float64 { return &v }
