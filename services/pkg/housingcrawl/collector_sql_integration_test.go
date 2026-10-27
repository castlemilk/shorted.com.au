package housingcrawl

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// sqlCapture records every statement a pool runs.
type sqlCapture struct {
	mu  sync.Mutex
	sql []string
}

func (c *sqlCapture) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sql = append(c.sql, d.SQL)
	return ctx
}

func (c *sqlCapture) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (c *sqlCapture) statements() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.sql...)
}

// withoutIngestColumns returns the collector's fixture schema with the migration
// 000150 columns removed, so the test runs against the schema the collector had before
// that migration existed.
func withoutIngestColumns(schema string) string {
	var keep []string
	for _, line := range strings.Split(schema, "\n") {
		if strings.Contains(line, "ingest_receipt_key") || strings.Contains(line, "last_missed_at") {
			continue
		}
		keep = append(keep, line)
	}
	return strings.Join(keep, "\n")
}

// TestCollectorPathIssuesNoIngestColumns_Integration: a collector sweep (no ReceiptKey,
// no MinDelistInterval) runs the same statements as before migration 000150, against a
// schema that has no ingest columns. Every statement is captured. None may name
// ingest_receipt_key or last_missed_at, and the sweep must still complete: it delists a
// listing, records a price move and a new listing, exactly as the collector does.
func TestCollectorPathIssuesNoIngestColumns_Integration(t *testing.T) {
	dbURL, err := testpostgres.Admin("HOUSING_TEST_DB_URL", "HOUSING_TESTCONTAINERS")
	if err != nil {
		t.Fatalf("start the test Postgres: %v", err)
	}
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL, or HOUSING_TESTCONTAINERS=1 with -tags=testcontainers, to run the collector SQL test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	setup, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(setup.Close)
	if _, err := setup.Exec(ctx, withoutIngestColumns(applySchema)); err != nil {
		t.Fatalf("pre-000150 schema: %v", err)
	}
	if _, err := setup.Exec(ctx,
		`INSERT INTO house_price_regions (region_code, region_type, region_name, state_code, postcode)
		 VALUES ($1,'suburb','Testville','VIC','3000')`, applyTarget.RegionCode()); err != nil {
		t.Fatalf("seed region: %v", err)
	}

	capture := &sqlCapture{}
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.Tracer = capture
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	base := time.Date(2026, 10, 27, 2, 0, 0, 0, time.UTC)
	sweeps := []Sweep{
		{Status: Complete, RunTS: base, Listings: []RawListing{fixedListing("A", 1_000_000), fixedListing("B", 1_000_000)}},
		// B is missed once.
		{Status: Complete, RunTS: base.Add(time.Hour), Listings: []RawListing{fixedListing("A", 1_000_000)}},
		// A moves 20%, and B is missed again: grace 2 delists B.
		{Status: Complete, RunTS: base.Add(2 * time.Hour), Listings: []RawListing{fixedListing("A", 1_200_000), fixedListing("N", 1_000_000)}},
	}
	var delisted int
	for _, sw := range sweeps {
		sw.Source = "rea"
		sw.Target = applyTarget
		sw.Rules = testRules()
		res, err := ApplySweep(ctx, pool, sw)
		if err != nil {
			t.Fatalf("collector sweep: %v", err)
		}
		delisted += res.Delisted
	}
	if delisted != 1 {
		t.Errorf("the collector path must still delist B, delisted=%d", delisted)
	}

	for _, stmt := range capture.statements() {
		for _, column := range []string{"ingest_receipt_key", "last_missed_at"} {
			if strings.Contains(stmt, column) {
				t.Errorf("the collector path must not name %s, it ran:\n%s", column, stmt)
			}
		}
	}
	if len(capture.statements()) == 0 {
		t.Fatal("the tracer captured nothing, so the check proves nothing")
	}
}
