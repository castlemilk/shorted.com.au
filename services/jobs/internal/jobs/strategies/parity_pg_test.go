package strategies

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// The database suite runs RunParity against a real PostgreSQL: the sweep
// predicate, the 000080 view-side reads, the window's stale-code path and the
// verdict and info lines. The views here are plain tables with the columns the
// readers select; the features suite applies the 000130 definitions themselves.
// It runs only with an opt-in:
//
//	STRATEGIES_PARITY_TESTCONTAINERS=1 CGO_ENABLED=0 GOWORK=off \
//	  go test -tags=testcontainers -run TestParityOnPostgres ./internal/jobs/strategies/
//
// or STRATEGIES_PARITY_DATABASE_URL names a server. Without either it skips.
const parityTables = `
CREATE TABLE sync_status (environment text, hostname text, checkpoint_stocks_total int,
	status text, started_at timestamptz NOT NULL, completed_at timestamptz);
CREATE TABLE shorts ("DATE" timestamp, "PRODUCT" text, "PRODUCT_CODE" varchar,
	"REPORTED_SHORT_POSITIONS" float8, "TOTAL_PRODUCT_IN_ISSUE" float8,
	"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" float8);
CREATE TABLE stock_prices (stock_code varchar, date date, open numeric, high numeric, low numeric,
	close numeric, adjusted_close numeric, volume bigint);
CREATE TABLE index_prices (index_code text, date date, high float8, low float8, close float8);
CREATE TABLE mv_price_features (stock_code text, as_of date, close numeric, prev_close numeric,
	sma10 numeric, sma20 numeric, sma50 numeric, sma150 numeric, sma200 numeric, sma200_1m_ago numeric,
	high_52w numeric, low_52w numeric, pct_off_52w_high numeric, pct_above_52w_low numeric,
	volume bigint, avg_volume_50d numeric, volume_ratio_50d numeric, dollar_volume_20d numeric,
	base_high numeric, base_low numeric, base_depth_pct numeric, base_length_days int4,
	breakout_recent boolean, breakout_date date, ret_1m_pct numeric, ret_3m_pct numeric,
	ret_6m_pct numeric, ret_12m_pct numeric, rs_3m_pct numeric, rs_6m_pct numeric, sessions_available int4);
CREATE TABLE mv_market_regime (index_code text, as_of date, close numeric, sma50 numeric, sma200 numeric,
	pct_off_52w_high numeric, ret_1m_pct numeric, ret_3m_pct numeric, regime text);
CREATE TABLE mv_screener_data (stock_code varchar, days_to_cover numeric);
`

func TestParityOnPostgres(t *testing.T) {
	dsn, err := testpostgres.Admin("STRATEGIES_PARITY_DATABASE_URL", "STRATEGIES_PARITY_TESTCONTAINERS")
	if err != nil {
		t.Fatal(err)
	}
	if dsn == "" {
		t.Skip("set STRATEGIES_PARITY_TESTCONTAINERS=1 (with -tags=testcontainers) or STRATEGIES_PARITY_DATABASE_URL")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() { _ = admin.Close(ctx) }()

	schema := fmt.Sprintf("strategies_parity_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	defer func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse dsn: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	if _, err := pool.Exec(ctx, parityTables); err != nil {
		t.Fatalf("create tables: %v", err)
	}
	var today time.Time
	if err := admin.QueryRow(ctx, `SELECT CURRENT_DATE`).Scan(&today); err != nil {
		t.Fatalf("current date: %v", err)
	}
	d := civil.DateOf(today)

	// Two qualifying rows: OLD's newest is outside the 60-day window, so only
	// the whole-history read can see it; NEW is inside the window.
	if _, err := pool.Exec(ctx, `
		INSERT INTO shorts VALUES
		  ($1::date, 'OLD LIMITED ORDINARY', 'OLD', 1000, 500000000, 0.5),
		  ($2::date, 'NEW LIMITED ORDINARY', 'NEW', 2000, 500000000, 0.8)`,
		today.AddDate(0, 0, -90), today.AddDate(0, 0, -1)); err != nil {
		t.Fatalf("seed shorts: %v", err)
	}

	now := time.Now()
	type syncRow struct {
		env, host, status string
		checkpoint        int
		started           time.Time
		completed         *time.Time
	}
	at := func(t time.Time) *time.Time { return &t }
	cases := []struct {
		name         string
		refreshStart time.Time
		rows         []syncRow
		conclusive   bool
		reason       string
	}{
		{
			// The newest sweep is still running; a newer ASIC row reads completed
			// and must be ignored.
			name: "sweep still running", refreshStart: now,
			rows: []syncRow{
				{status: "completed", checkpoint: 1800, started: now.Add(-48 * time.Hour), completed: at(now.Add(-47 * time.Hour))},
				{status: "running", checkpoint: 1800, started: now.Add(-time.Hour)},
				{env: "ci", host: "runner", status: "completed", checkpoint: 0, started: now, completed: at(now)},
			},
			reason: "sweep_running",
		},
		{
			// The newest sweep completed before the refresh; a newer ASIC row
			// reads running and must be ignored.
			name: "sweep completed before the refresh", refreshStart: now,
			rows: []syncRow{
				{status: "completed", checkpoint: 1800, started: now.Add(-3 * time.Hour), completed: at(now.Add(-2 * time.Hour))},
				{env: "ci", host: "runner", status: "running", checkpoint: 0, started: now},
			},
			conclusive: true,
		},
		{
			// The sweep finished after the refresh began.
			name: "sweep finished after the refresh", refreshStart: now.Add(-30 * time.Minute),
			rows: []syncRow{
				{status: "completed", checkpoint: 1800, started: now.Add(-time.Hour), completed: at(now.Add(-10 * time.Minute))},
				{env: "ci", host: "runner", status: "running", checkpoint: 0, started: now},
			},
			reason: "sweep_after_refresh",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := pool.Exec(ctx, `DELETE FROM sync_status`); err != nil {
				t.Fatal(err)
			}
			for _, r := range c.rows {
				if _, err := pool.Exec(ctx, `INSERT INTO sync_status (environment, hostname, checkpoint_stocks_total, status, started_at, completed_at)
					VALUES (NULLIF($1, ''), NULLIF($2, ''), $3, $4, $5, $6)`,
					r.env, r.host, r.checkpoint, r.status, r.started, r.completed); err != nil {
					t.Fatalf("seed sync_status: %v", err)
				}
			}
			var lines []string
			logf := func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }
			res, err := RunParity(ctx, pool, c.refreshStart, logf)
			if err != nil {
				t.Fatalf("RunParity: %v", err)
			}
			if res.D != d {
				t.Errorf("session = %s, want %s", res.D, d)
			}
			if res.Conclusive != c.conclusive || res.Reason != c.reason {
				t.Errorf("verdict = (%v, %q), want (%v, %q)", res.Conclusive, res.Reason, c.conclusive, c.reason)
			}
			// The comparison runs either way. The only disagreement is the empty
			// regime view; OLD, outside the window, must still match its view row.
			if res.OnlyView != 0 || res.OnlyGo != 0 || res.Fields["regime_row"] != 1 || len(res.Fields) != 1 {
				t.Errorf("comparison = only_view %d only_go %d fields %v, want only the missing regime row",
					res.OnlyView, res.OnlyGo, res.Fields)
			}
			if len(lines) != 2 || !strings.HasPrefix(lines[0], "strategy_parity_info d=") || !strings.HasPrefix(lines[1], "strategy_parity d=") {
				t.Fatalf("log lines = %q, want the info line then the verdict line", lines)
			}
			suffix := "conclusive=true"
			if !c.conclusive {
				suffix = "conclusive=false inconclusive=" + c.reason
			}
			if !strings.HasSuffix(lines[1], suffix) {
				t.Errorf("verdict line = %q, want suffix %q", lines[1], suffix)
			}
		})
	}
}
