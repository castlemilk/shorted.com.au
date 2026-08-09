package houseprices

import (
	"os"
	"strings"
	"testing"
)

func TestUpdateRunSQLConflictContract(t *testing.T) {
	got := strings.Join(strings.Fields(updateRunSQL), " ")
	want := strings.Join(strings.Fields(`
		INSERT INTO house_price_ingest_runs (source, last_period, last_fetched_at, rows_upserted, status, detail)
		VALUES ($1, $2, now(), $3, $4, NULLIF($5, ''))
		ON CONFLICT (source) DO UPDATE SET
			last_period = CASE WHEN EXCLUDED.status = 'error' THEN house_price_ingest_runs.last_period ELSE EXCLUDED.last_period END,
			last_fetched_at = now(),
			rows_upserted = CASE WHEN EXCLUDED.status = 'error' THEN house_price_ingest_runs.rows_upserted ELSE EXCLUDED.rows_upserted END,
			status = EXCLUDED.status,
			detail = EXCLUDED.detail
	`), " ")

	if got != want {
		t.Fatalf("updateRunSQL conflict contract mismatch\n got: %s\nwant: %s", got, want)
	}

	sourceBytes, err := os.ReadFile("store.go")
	if err != nil {
		t.Fatal(err)
	}
	source := string(sourceBytes)
	if !strings.Contains(source, "pool.Exec(ctx, updateRunSQL,") {
		t.Fatal("updateRun must execute updateRunSQL")
	}
}
