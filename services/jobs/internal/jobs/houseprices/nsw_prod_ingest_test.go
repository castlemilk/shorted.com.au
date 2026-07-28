package houseprices

// TEMP prod ingest (delete after) — ingest ONLY NSW into prod, run the sal_code
// backfills, refresh housing MVs, and report coverage. Gated on DATABASE_URL so
// it no-ops in CI. Run: DATABASE_URL=<prod> go test -run TestNSWProdIngest -v .
import (
	"context"
	"os"
	"testing"
	"time"
)

func TestNSWProdIngest(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("no DATABASE_URL — skipping prod ingest")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 480*time.Second)
	defer cancel()

	pool, err := connect(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	obs, err := ingestNSWSuburbMedians(ctx)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	t.Logf("ingested %d NSW observations", len(obs))
	if err := upsertRegions(ctx, pool, obs); err != nil {
		t.Fatalf("upsertRegions: %v", err)
	}
	n, err := upsertObservations(ctx, pool, obs)
	if err != nil {
		t.Fatalf("upsertObservations (%d done): %v", n, err)
	}
	t.Logf("upserted %d observations", n)

	// link suburb regions → sal_code + refresh MVs (the real self-wiring path)
	refresh(ctx, pool)

	// coverage report
	var regions, linked int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM house_price_regions WHERE state_code='NSW' AND region_type='suburb'`).Scan(&regions); err != nil {
		t.Fatalf("count NSW suburb regions: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM house_price_regions WHERE state_code='NSW' AND region_type='suburb' AND sal_code IS NOT NULL`).Scan(&linked); err != nil {
		t.Fatalf("count linked NSW suburb regions: %v", err)
	}
	t.Logf("NSW suburb regions: %d, linked to sal_code: %d", regions, linked)

	var pricedSuburbs int
	if err := pool.QueryRow(ctx, `
		SELECT count(DISTINCT d.sal_code) FROM suburb_demographics d
		JOIN house_price_regions r ON r.sal_code=d.sal_code AND r.region_type='suburb'
		JOIN house_prices hp ON hp.region_code=r.region_code AND hp.measure='median_price'
		WHERE d.state_code='NSW'`).Scan(&pricedSuburbs); err != nil {
		t.Fatalf("count priced NSW suburbs: %v", err)
	}
	t.Logf("NSW suburbs with a median price (map will paint): %d", pricedSuburbs)
}
