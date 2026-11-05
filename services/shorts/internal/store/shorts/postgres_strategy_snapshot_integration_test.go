//go:build integration

package shorts

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/calendar"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/pgsource"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/snapshot"
	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// The daily snapshot reads against a live Postgres: the newest completed session
// and the one before it, the unmigrated fallback, canonical-only and live-only
// signal events, and the source dates. Opt in with STRATEGY_SNAPSHOT_TEST_DATABASE_URL,
// or STRATEGY_SNAPSHOT_TESTCONTAINERS=1 for one container the package's TestMain removes:
//
//	cd services && GOWORK=off CGO_ENABLED=0 STRATEGY_SNAPSHOT_TESTCONTAINERS=1 \
//	    go test -count=1 -tags=integration,testcontainers -run StrategySnapshot ./shorts/internal/store/shorts/
//
// make test-strategy-snapshot-pg sets both.

// snapshotMigrationPath is migration 000156 as the deploy replays it.
const snapshotMigrationPath = "../../../../migrations/000156_strategy_engine.up.sql"

// snapshotDB returns a pool on a fresh database. The stub tables are the ones
// the reads join (index prices, company metadata, the price sweep, ASIC ingests);
// the snapshot tables come from applySnapshotMigration.
func snapshotDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn, err := testpostgres.Admin("STRATEGY_SNAPSHOT_TEST_DATABASE_URL", "STRATEGY_SNAPSHOT_TESTCONTAINERS")
	require.NoError(t, err)
	if dsn == "" {
		t.Skip("set STRATEGY_SNAPSHOT_TEST_DATABASE_URL, or STRATEGY_SNAPSHOT_TESTCONTAINERS=1")
	}
	ctx := context.Background()
	name := fmt.Sprintf("snap156_%d_%d", time.Now().UnixNano()%1e9, rand.Intn(1e6))

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
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	for _, stub := range []string{
		`CREATE TABLE index_prices (index_code text NOT NULL, date date NOT NULL, close double precision)`,
		`CREATE TABLE "company-metadata" (stock_code text PRIMARY KEY, company_name text)`,
		`CREATE TABLE sync_status (id bigserial PRIMARY KEY, environment text, hostname text,
		   checkpoint_stocks_total int, status text, started_at timestamptz, completed_at timestamptz)`,
		`CREATE TABLE asic_report_ingests (report_date date PRIMARY KEY, first_ingested_at timestamptz NOT NULL,
		   file_rows int, loaded_rows int NOT NULL)`,
	} {
		_, err := pool.Exec(ctx, stub)
		require.NoError(t, err)
	}
	return pool
}

// applySnapshotMigration runs 000156 as psql -f does.
func applySnapshotMigration(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	sql, err := os.ReadFile(snapshotMigrationPath)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), string(sql))
	require.NoError(t, err)
}

func snapDate(s string) civil.Date {
	d, err := civil.ParseDate(s)
	if err != nil {
		panic(err)
	}
	return d
}

// completeSession writes the three phases of one session as completed.
func completeSession(t *testing.T, pool *pgxpool.Pool, day string, finished time.Time) {
	t.Helper()
	for _, phase := range []string{"features", "evaluation", "events"} {
		_, err := pool.Exec(context.Background(), `
			INSERT INTO strategy_daily_runs (as_of, phase, status, engine_version, counts, finished_at)
			VALUES ($1::date, $2, 'completed', '1.0.0', '{"priced": 2}', $3)`, day, phase, finished)
		require.NoError(t, err)
	}
}

func TestStrategySnapshot_NewestCompletedSessionAndThePreviousOne(t *testing.T) {
	pool := snapshotDB(t)
	applySnapshotMigration(t, pool)
	ctx := context.Background()
	s := &postgresStore{db: pool}

	// Nothing completed yet.
	_, err := s.ReadStrategySnapshot(ctx)
	assert.ErrorIs(t, err, ErrNoStrategySnapshot)

	completeSession(t, pool, "2026-09-24", time.Date(2026, 9, 24, 14, 0, 0, 0, time.UTC))
	completeSession(t, pool, "2026-09-25", time.Date(2026, 9, 25, 14, 0, 0, 0, time.UTC))
	// A session with only its features phase is not served.
	_, err = pool.Exec(ctx, `INSERT INTO strategy_daily_runs (as_of, phase, status, engine_version)
		VALUES ('2026-09-28', 'features', 'completed', '1.0.0')`)
	require.NoError(t, err)

	pct := 6.5
	report := snapDate("2026-09-18")
	rows := []snapshot.Row{
		{AsOf: snapDate("2026-09-25"), FeatureSet: "fs1", StockCode: "BHP", OrdinaryFresh60: true, IsOrdinary: true,
			Features: snapshot.Features{FS1: features.PriceFeatures{AsOf: snapDate("2026-09-25"), Close: 40},
				SF0: features.ShortReading{Pct: &pct, ReportDate: &report}},
			FundamentalsHash: "f1", Meta: []byte(`{"priced_sessions":120}`)},
		{AsOf: snapDate("2026-09-25"), FeatureSet: "fs1", StockCode: "CBA", OrdinaryFresh60: true, IsOrdinary: true,
			Features: snapshot.Features{FS1: features.PriceFeatures{AsOf: snapDate("2026-09-25"), Close: 150}}},
	}
	require.NoError(t, pgsource.WriteFundamentalsBlobs(ctx, pool, map[string]features.Fundamentals{
		"f1": {Hash: "f1", Blob: []byte(`{"currency":"AUD"}`)},
	}, snapDate("2026-09-25")))
	require.NoError(t, pgsource.WriteFeatureRows(ctx, pool, rows))
	require.NoError(t, pgsource.WriteRegime(ctx, pool, snapDate("2026-09-25"), engine.DefaultIndexCode,
		engine.Regime{IndexCode: engine.DefaultIndexCode, Close: floatPtr(8800), SMA50: floatPtr(8600), SMA200: floatPtr(8200), Label: engine.RegimeUptrend}))
	_, err = pool.Exec(ctx, `INSERT INTO index_prices VALUES ('XJO', '2026-09-25', 8800), ('XJO', '2026-09-28', 8700)`)
	require.NoError(t, err)

	snap, err := s.ReadStrategySnapshot(ctx)
	require.NoError(t, err)
	assert.Equal(t, "2026-09-25", snap.AsOf.String(), "the newest completed session, not the partly run 09-28")
	assert.Equal(t, "2026-09-24", snap.PrevAsOf.String())
	require.Len(t, snap.Rows, 2)
	assert.Equal(t, "BHP", snap.Rows[0].StockCode)
	assert.Equal(t, "fs1", snap.Rows[0].FeatureSet)
	require.Contains(t, snap.Blobs, "f1")
	assert.Equal(t, engine.RegimeUptrend, snap.Regime.Label)
	require.NotNil(t, snap.Regime.LatestSession)
	assert.Equal(t, "2026-09-28", snap.Regime.LatestSession.Format("2006-01-02"), "the newest index session, read live")
}

func TestStrategySnapshot_UnmigratedDatabaseIsUnavailableNotAnError(t *testing.T) {
	pool := snapshotDB(t)
	ctx := context.Background()
	s := &postgresStore{db: pool}

	_, err := s.ReadStrategySnapshot(ctx)
	assert.ErrorIs(t, err, ErrStrategySnapshotUnavailable)
	_, err = s.ListStrategySignalEvents(ctx, StrategySignalEventsFilter{StrategyID: "zanger-breakout", RulesHash: strings.Repeat("a", 64), Limit: 5})
	assert.ErrorIs(t, err, ErrStrategySnapshotUnavailable)

	status, err := s.ReadStrategyDataStatus(ctx)
	require.NoError(t, err, "the source dates read as absent, never as an error")
	assert.Empty(t, status.SnapshotAsOf)
	assert.Empty(t, status.AsicReports)
}

// insertRuleVersion adds one registry row. The live canonical row is the only
// one the partial unique index allows per strategy.
func insertRuleVersion(t *testing.T, pool *pgxpool.Pool, hash, strategy, label, kind, status string, liveFrom *string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO strategy_rule_versions (rules_hash, strategy_id, label, kind, engine_major, feature_set,
		    canonical_json, status, live_from)
		VALUES ($1, $2, $3, $4, 1, 'fs1', '{}'::jsonb, $5, $6::date)`, hash, strategy, label, kind, status, liveFrom)
	require.NoError(t, err)
}

func insertEvent(t *testing.T, pool *pgxpool.Pool, hash, strategy, code, asOf, from, to string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO strategy_signal_events (rules_hash, engine_version, strategy_id, stock_code, as_of, from_status, to_status, score, evidence)
		VALUES ($1, '1.0.0', $2, $3, $4::date, $5, $6, 70, '{"r":"PU","v":[9.5,null],"p":[null,0.8],"close":10.2,"pivot":9.5}')`,
		hash, strategy, code, asOf, from, to)
	require.NoError(t, err)
}

// Events are served for the live canonical version only from its live_from; a
// draft, a variant and a superseded version's other hash never leak through a
// query for another hash.
func TestStrategySignalEvents_CanonicalAndLiveOnly(t *testing.T) {
	pool := snapshotDB(t)
	applySnapshotMigration(t, pool)
	ctx := context.Background()
	s := &postgresStore{db: pool}

	live := strings.Repeat("1", 64)
	draft := strings.Repeat("2", 64)
	variant := strings.Repeat("3", 64)
	from := "2026-09-01"
	insertRuleVersion(t, pool, live, "zanger-breakout", "v0", "canonical", "live", &from)
	insertRuleVersion(t, pool, draft, "zanger-breakout", "v1", "canonical", "draft", nil)
	insertRuleVersion(t, pool, variant, "zanger-breakout", "custom", "variant", "draft", nil)
	_, err := pool.Exec(ctx, `INSERT INTO "company-metadata" VALUES ('BHP', 'BHP Group')`)
	require.NoError(t, err)

	insertEvent(t, pool, live, "zanger-breakout", "BHP", "2026-08-28", "none", "setup") // before live_from: not served
	insertEvent(t, pool, live, "zanger-breakout", "BHP", "2026-09-22", "setup", "triggered")
	insertEvent(t, pool, live, "zanger-breakout", "CBA", "2026-09-23", "watch", "setup")
	insertEvent(t, pool, draft, "zanger-breakout", "BHP", "2026-09-22", "setup", "triggered")
	insertEvent(t, pool, variant, "zanger-breakout", "BHP", "2026-09-22", "setup", "triggered")

	all, err := s.ListStrategySignalEvents(ctx, StrategySignalEventsFilter{StrategyID: "zanger-breakout", RulesHash: live, Limit: 10})
	require.NoError(t, err)
	require.Len(t, all, 2)
	assert.Equal(t, "CBA", all[0].StockCode, "newest first")
	assert.Equal(t, "BHP Group", all[1].CompanyName)
	assert.Equal(t, "setup", all[1].FromStatus)
	assert.Equal(t, "triggered", all[1].ToStatus)
	assert.Contains(t, all[1].Evidence, `"pivot": 9.5`, "jsonb text keeps its own spacing")
	assert.Contains(t, all[1].Evidence, `"r": "PU"`, "one status character per rule, stored as one string")

	for _, h := range []string{draft, variant} {
		none, err := s.ListStrategySignalEvents(ctx, StrategySignalEventsFilter{StrategyID: "zanger-breakout", RulesHash: h, Limit: 10})
		require.NoError(t, err)
		assert.Empty(t, none, "a draft or variant hash reads no events")
	}

	since := snapDate("2026-09-23")
	recent, err := s.ListStrategySignalEvents(ctx, StrategySignalEventsFilter{StrategyID: "zanger-breakout", RulesHash: live, Since: &since, Limit: 10})
	require.NoError(t, err)
	require.Len(t, recent, 1)
	assert.Equal(t, "CBA", recent[0].StockCode)

	stock, err := s.ListStrategySignalEvents(ctx, StrategySignalEventsFilter{StrategyID: "zanger-breakout", RulesHash: live, StockCode: "BHP", Limit: 10})
	require.NoError(t, err)
	require.Len(t, stock, 1)

	page, err := s.ListStrategySignalEvents(ctx, StrategySignalEventsFilter{StrategyID: "zanger-breakout", RulesHash: live, AfterID: all[0].ID, Limit: 10})
	require.NoError(t, err)
	require.Len(t, page, 1)
	assert.Equal(t, all[1].ID, page[0].ID, "the keyset page below the first row")
}

// A variant that is live or superseded, and a canonical version with no live_from,
// serve no events: the join admits canonical versions only, and only from live_from.
func TestStrategySignalEvents_VariantAndUnDatedVersionsAreNeverServed(t *testing.T) {
	pool := snapshotDB(t)
	applySnapshotMigration(t, pool)
	ctx := context.Background()
	s := &postgresStore{db: pool}

	live := strings.Repeat("4", 64)
	variantLive := strings.Repeat("5", 64)
	superseded := strings.Repeat("6", 64)
	undated := strings.Repeat("7", 64)
	from := "2026-09-01"
	insertRuleVersion(t, pool, live, "zanger-breakout", "v0", "canonical", "live", &from)
	insertRuleVersion(t, pool, variantLive, "zanger-breakout", "custom", "variant", "live", &from)
	insertRuleVersion(t, pool, superseded, "zanger-breakout", "v-old", "canonical", "superseded", &from)
	insertRuleVersion(t, pool, undated, "zanger-breakout", "v-undated", "canonical", "superseded", nil)
	_, err := pool.Exec(ctx, `INSERT INTO "company-metadata" VALUES ('BHP', 'BHP Group')`)
	require.NoError(t, err)

	insertEvent(t, pool, live, "zanger-breakout", "BHP", "2026-09-22", "setup", "triggered")
	insertEvent(t, pool, variantLive, "zanger-breakout", "BHP", "2026-09-22", "setup", "triggered")
	insertEvent(t, pool, superseded, "zanger-breakout", "BHP", "2026-09-22", "setup", "triggered")
	insertEvent(t, pool, undated, "zanger-breakout", "BHP", "2026-09-22", "setup", "triggered")

	// The positive control: a superseded canonical version is served from its live_from.
	old, err := s.ListStrategySignalEvents(ctx, StrategySignalEventsFilter{StrategyID: "zanger-breakout", RulesHash: superseded, Limit: 10})
	require.NoError(t, err)
	assert.Len(t, old, 1, "a superseded canonical version is served from its live_from")

	for name, h := range map[string]string{"variant that is live": variantLive, "canonical with no live_from": undated} {
		none, err := s.ListStrategySignalEvents(ctx, StrategySignalEventsFilter{StrategyID: "zanger-breakout", RulesHash: h, Limit: 10})
		require.NoError(t, err)
		assert.Empty(t, none, name)
	}
}

// Before the first session completes the ASIC reports are still read: the daily
// job holds the sessions while the ingest log already has the reports.
func TestStrategyDataStatus_AsicReportsWithoutACompletedSession(t *testing.T) {
	pool := snapshotDB(t)
	applySnapshotMigration(t, pool)
	ctx := context.Background()
	s := &postgresStore{db: pool}

	_, err := pool.Exec(ctx, `INSERT INTO asic_report_ingests VALUES ('2026-10-28', now(), 100, 100)`)
	require.NoError(t, err)
	st, err := s.ReadStrategyDataStatus(ctx)
	require.NoError(t, err)
	assert.Empty(t, st.SnapshotAsOf, "no session has completed")
	require.Len(t, st.AsicReports, 1, "the ingest log is read regardless of the snapshot")
	assert.Equal(t, "2026-10-28", st.AsicReports[0].ReportDate.String())
}

// A completed session without its regime row is not served as an unknown regime:
// the read answers ErrNoStrategySnapshot, so the service falls back loudly.
func TestStrategySnapshot_CompletedSessionWithoutRegimeIsNotServed(t *testing.T) {
	pool := snapshotDB(t)
	applySnapshotMigration(t, pool)
	ctx := context.Background()
	s := &postgresStore{db: pool}

	completeSession(t, pool, "2026-09-25", time.Date(2026, 9, 25, 14, 0, 0, 0, time.UTC))
	require.NoError(t, pgsource.WriteFeatureRows(ctx, pool, []snapshot.Row{
		{AsOf: snapDate("2026-09-25"), FeatureSet: "fs1", StockCode: "BHP", OrdinaryFresh60: true, IsOrdinary: true,
			Features: snapshot.Features{FS1: features.PriceFeatures{AsOf: snapDate("2026-09-25"), Close: 40}}},
	}))
	_, err := s.ReadStrategySnapshot(ctx)
	assert.ErrorIs(t, err, ErrNoStrategySnapshot)
}

// The source dates: the newest completed price sweep, the snapshot session and
// its priced count, and the newest ten ASIC reports.
func TestStrategyDataStatus_SourceDates(t *testing.T) {
	pool := snapshotDB(t)
	applySnapshotMigration(t, pool)
	ctx := context.Background()
	s := &postgresStore{db: pool}

	completeSession(t, pool, "2026-09-25", time.Date(2026, 9, 25, 14, 0, 0, 0, time.UTC))
	_, err := pool.Exec(ctx, `INSERT INTO sync_status (environment, hostname, checkpoint_stocks_total, status, started_at, completed_at)
		VALUES (NULL, NULL, 2000, 'completed', '2026-09-25 06:00+00', '2026-09-25 07:30+00')`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO index_prices VALUES ('XJO', '2026-09-25', 8800)`)
	require.NoError(t, err)
	for i := 0; i < 12; i++ {
		day := fmt.Sprintf("2026-09-%02d", i+1)
		_, err := pool.Exec(ctx, `INSERT INTO asic_report_ingests VALUES ($1::date, now(), 100, $2)`, day, 100-i)
		require.NoError(t, err)
	}

	st, err := s.ReadStrategyDataStatus(ctx)
	require.NoError(t, err)
	assert.Equal(t, "2026-09-25", st.LatestSession)
	require.NotNil(t, st.PricesCompletedAt)
	assert.Equal(t, "2026-09-25", st.SnapshotAsOf)
	assert.Equal(t, 2, st.PricedCodes)
	require.Len(t, st.AsicReports, 10, "the newest ten")
	assert.Equal(t, "2026-09-12", st.AsicReports[0].ReportDate.String())
	require.NotNil(t, st.AsicReports[0].FileRows)
	assert.Equal(t, 100, *st.AsicReports[0].FileRows)
	assert.Equal(t, 89, st.AsicReports[0].LoadedRows, "the newest report's loaded codes")
}

func floatPtr(v float64) *float64 { return &v }

// A report's publication date is the one the stored short reading used: the
// calendar of the index sessions and the shorts table's report dates, even for a
// report that has no ingest row (loaded outside the ASIC recorder).
func TestStrategyDataStatus_AvailabilityUsesTheShortsReportDates(t *testing.T) {
	pool := snapshotDB(t)
	applySnapshotMigration(t, pool)
	ctx := context.Background()
	s := &postgresStore{db: pool}

	completeSession(t, pool, "2026-10-30", time.Date(2026, 10, 30, 14, 0, 0, 0, time.UTC))
	_, err := pool.Exec(ctx, `INSERT INTO sync_status (environment, hostname, checkpoint_stocks_total, status, started_at, completed_at)
		VALUES (NULL, NULL, 2000, 'completed', '2026-10-30 06:00+00', '2026-10-30 07:30+00')`)
	require.NoError(t, err)

	var xjo []civil.Date
	for d := (civil.Date{Year: 2026, Month: time.October, Day: 19}); d.Before((civil.Date{Year: 2026, Month: time.November, Day: 3})); d = d.AddDays(1) {
		if wd := time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC).Weekday(); wd == time.Saturday || wd == time.Sunday {
			continue
		}
		xjo = append(xjo, d)
		_, err := pool.Exec(ctx, `INSERT INTO index_prices VALUES ('XJO', $1::date, 8800)`, d.String())
		require.NoError(t, err)
	}
	// Two report dates in shorts; only the older has an ingest row.
	_, err = pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS shorts (
		"DATE" timestamp without time zone, "PRODUCT" text, "PRODUCT_CODE" text,
		"REPORTED_SHORT_POSITIONS" double precision, "TOTAL_PRODUCT_IN_ISSUE" double precision,
		"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" double precision)`)
	require.NoError(t, err)
	var shorts []civil.Date
	for _, day := range []string{"2026-10-21", "2026-10-28"} {
		_, err := pool.Exec(ctx, `INSERT INTO shorts ("PRODUCT_CODE", "PRODUCT", "DATE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
			VALUES ('AAA', 'AAA LTD', $1::date, 5.0)`, day)
		require.NoError(t, err)
		shorts = append(shorts, snapDate(day))
	}
	_, err = pool.Exec(ctx, `INSERT INTO asic_report_ingests VALUES ('2026-10-21', now(), 100, 100)`)
	require.NoError(t, err)

	st, err := s.ReadStrategyDataStatus(ctx)
	require.NoError(t, err)
	var got *civil.Date
	for _, r := range st.AsicReports {
		if r.ReportDate.String() == "2026-10-21" {
			got = r.AvailableDate
		}
	}
	require.NotNil(t, got, "the ingested report is listed")
	want, ok := calendar.New(xjo, shorts, calendar.PublicationLagSessions).PublishedOn(snapDate("2026-10-21"))
	require.True(t, ok)
	assert.Equal(t, want.String(), got.String(), "the stored reading's calendar, from the shorts report dates")
}

// The API serves the canonical version the table marks live, with its live_from:
// a draft and a superseded row are never read as live.
func TestStrategySnapshot_LiveRuleVersions(t *testing.T) {
	pool := snapshotDB(t)
	applySnapshotMigration(t, pool)
	ctx := context.Background()
	s := &postgresStore{db: pool}

	v0From, v1From := "2026-11-12", "2026-11-16"
	insertRuleVersion(t, pool, strings.Repeat("1", 64), "zanger-breakout", "v0", "canonical", "superseded", &v0From)
	insertRuleVersion(t, pool, strings.Repeat("2", 64), "zanger-breakout", "v1", "canonical", "live", &v1From)
	insertRuleVersion(t, pool, strings.Repeat("3", 64), "zanger-breakout", "v2", "canonical", "draft", nil)

	rows, err := s.ReadLiveRuleVersions(ctx)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, LiveRuleVersion{StrategyID: "zanger-breakout", RulesHash: strings.Repeat("2", 64), Label: "v1", LiveFrom: "2026-11-16"}, rows[0])
}

// The version RPCs state every canonical row's status and dates, the draft
// included, and never a variant.
func TestStrategySnapshot_CanonicalRuleVersions(t *testing.T) {
	pool := snapshotDB(t)
	applySnapshotMigration(t, pool)
	ctx := context.Background()
	s := &postgresStore{db: pool}

	v0From, v0Super, v1From := "2026-11-12", "2026-11-16", "2026-11-16"
	v0Hash, v1Hash, v2Hash := strings.Repeat("1", 64), strings.Repeat("2", 64), strings.Repeat("3", 64)
	insertRuleVersion(t, pool, v0Hash, "zanger-breakout", "v0", "canonical", "superseded", &v0From)
	_, err := pool.Exec(ctx, `UPDATE strategy_rule_versions SET superseded_on = $1::date WHERE rules_hash = $2`, v0Super, v0Hash)
	require.NoError(t, err)
	insertRuleVersion(t, pool, v1Hash, "zanger-breakout", "v1", "canonical", "live", &v1From)
	insertRuleVersion(t, pool, v2Hash, "zanger-breakout", "v2", "canonical", "draft", nil)
	insertRuleVersion(t, pool, strings.Repeat("4", 64), "zanger-breakout", "v0-variant", "variant", "draft", nil)

	rows, err := s.ReadCanonicalRuleVersions(ctx)
	require.NoError(t, err)
	require.Len(t, rows, 3, "variants are never read")
	byHash := map[string]CanonicalRuleVersion{}
	for _, r := range rows {
		byHash[r.RulesHash] = r
	}
	assert.Equal(t, CanonicalRuleVersion{RulesHash: v0Hash, StrategyID: "zanger-breakout", Label: "v0", Status: "superseded", LiveFrom: v0From, SupersededOn: v0Super}, byHash[v0Hash])
	assert.Equal(t, CanonicalRuleVersion{RulesHash: v1Hash, StrategyID: "zanger-breakout", Label: "v1", Status: "live", LiveFrom: v1From}, byHash[v1Hash])
	assert.Equal(t, CanonicalRuleVersion{RulesHash: v2Hash, StrategyID: "zanger-breakout", Label: "v2", Status: "draft"}, byHash[v2Hash])
}
