package influence

// upsertIndustryRecords against a real Postgres: a record the source
// re-publishes unchanged is not rewritten, and a changed one is.
//
// INFLUENCE_TEST_DATABASE_URL only, never DATABASE_URL: services/.env holds
// the production URL, and this test writes (in a throwaway schema).

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newIndustryRecordsDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("INFLUENCE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set INFLUENCE_TEST_DATABASE_URL (a local database, never prod) to run the industry records upsert test")
	}
	if strings.Contains(url, "supabase") || strings.Contains(url, "pooler") {
		t.Fatalf("INFLUENCE_TEST_DATABASE_URL points at a hosted database; this test writes")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("industry_records_test_%d", time.Now().UnixNano())
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(admin.Close)
	if _, err := admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+schema+` CASCADE`) })

	// The package directory, which `go test` runs in (runtime.Caller reports an
	// import path under the machine-wide -trimpath).
	migration, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", "000075_add_industry_intelligence_sources.up.sql"))
	if err != nil {
		t.Fatalf("read 000075: %v", err)
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ", public"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect (schema): %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("apply 000075: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO industry_intelligence_sources (source_key, display_name, signal_kind, publisher, source_url, collection_method)
		VALUES ('test-source', 'Test', 'public_money', 'Test', 'https://example.gov.au', 'api')
		ON CONFLICT (source_key) DO NOTHING`); err != nil {
		t.Fatalf("seed source: %v", err)
	}
	return pool
}

func TestUpsertIndustryRecordsLeavesUnchangedRecordsAlone(t *testing.T) {
	pool := newIndustryRecordsDB(t)
	ctx := context.Background()

	value := 1234.5
	start := time.Date(2025, 7, 1, 0, 0, 0, 0, time.UTC)
	end := time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC)
	records := []IndustryRecord{
		{SourceKey: "test-source", SourceRecordID: "r1", SignalKind: "public_money", Industry: "Materials",
			StockCode: "BHP", EntityABN: "49004028077", MetricKey: "grant", MetricLabel: "Grant",
			MetricValue: &value, Unit: "AUD", PeriodStart: &start, PeriodEnd: &end, AsOf: end,
			Title: "A grant", Summary: "A grant to BHP.", SourceURL: "https://example.gov.au/r1", Confidence: 1,
			Metadata: map[string]any{"b": 2, "a": "x"}},
		{SourceKey: "test-source", SourceRecordID: "r2", SignalKind: "public_money", Industry: "Materials",
			MetricKey: "grant", MetricLabel: "Grant", AsOf: end, SourceURL: "https://example.gov.au/r2", Confidence: 0.5},
	}
	if n, err := upsertIndustryRecords(ctx, pool, "test-source", records); err != nil || n != 2 {
		t.Fatalf("first upsert: n=%d err=%v", n, err)
	}
	versions := func() map[string]string {
		rows, err := pool.Query(ctx, `SELECT source_record_id, xmin::text || '/' || updated_at::text FROM industry_intelligence_records ORDER BY 1`)
		if err != nil {
			t.Fatalf("read versions: %v", err)
		}
		defer rows.Close()
		out := map[string]string{}
		for rows.Next() {
			var id, v string
			if err := rows.Scan(&id, &v); err != nil {
				t.Fatalf("scan: %v", err)
			}
			out[id] = v
		}
		return out
	}
	before := versions()

	// The same records again, metadata keys in another order: nothing changes.
	again := append([]IndustryRecord(nil), records...)
	again[0].Metadata = map[string]any{"a": "x", "b": 2}
	if n, err := upsertIndustryRecords(ctx, pool, "test-source", again); err != nil || n != 2 {
		t.Fatalf("re-upsert: n=%d err=%v (n counts records sent, unchanged ones included)", n, err)
	}
	if after := versions(); fmt.Sprint(after) != fmt.Sprint(before) {
		t.Fatalf("an unchanged record was rewritten:\nbefore %v\nafter  %v", before, after)
	}

	// A changed summary on r2 is written; r1 stays.
	again[1].Summary = "Revised."
	if _, err := upsertIndustryRecords(ctx, pool, "test-source", again); err != nil {
		t.Fatalf("changed upsert: %v", err)
	}
	after := versions()
	if after["r1"] != before["r1"] {
		t.Errorf("r1 did not change and must not be rewritten")
	}
	if after["r2"] == before["r2"] {
		t.Errorf("r2 changed and must be rewritten")
	}
	var summary string
	if err := pool.QueryRow(ctx, `SELECT summary FROM industry_intelligence_records WHERE source_record_id = 'r2'`).Scan(&summary); err != nil || summary != "Revised." {
		t.Fatalf("r2 summary = %q, %v", summary, err)
	}
}
