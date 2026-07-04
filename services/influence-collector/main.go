// influence-collector ingests Australia's public "influence layer" datasets
// (Track A of the roadmap) into the shorts database and matches the entities to
// ASX codes on an ABN/name spine. Run-mode is selected with -mode.
//
//	-mode tax    Ingest the ATO Corporate Tax Transparency dataset (11 annual
//	             reports) into corporate_tax, then rebuild the ASX name mapping.
//	-mode match  Rebuild the corporate_tax → ASX name mapping only.
//	-mode all    tax + match (same as tax).
//
// Editorial gate: only exact-ABN or exact-normalized-name matches are ever
// inserted into entity_asx_map (match_method='name_exact'); fuzzy matching is out
// of scope here. See docs/influence-editorial-standards.md.
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	mode := flag.String("mode", "tax", "tax | match | all")
	flag.Parse()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	pool, err := connect(ctx, dbURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	switch *mode {
	case "tax", "all":
		runTax(ctx, pool)
		runMatchMode(ctx, pool)
	case "match":
		runMatchMode(ctx, pool)
	default:
		log.Fatalf("unknown -mode %q (want tax|match|all)", *mode)
	}
}

// runTax downloads + parses every annual ATO report and upserts the facts.
func runTax(ctx context.Context, pool *pgxpool.Pool) {
	rows, perYear, err := ingestTax(ctx)
	if err != nil {
		log.Fatalf("[tax] ingest error: %v", err)
	}
	n, err := upsertTaxRows(ctx, pool, rows)
	if err != nil {
		log.Fatalf("[tax] upsert error after %d rows: %v", n, err)
	}
	years := make([]int, 0, len(perYear))
	for y := range perYear {
		years = append(years, y)
	}
	sort.Ints(years)
	for _, y := range years {
		log.Printf("[tax] income_year %d: %d entities", y, perYear[y])
	}
	log.Printf("[tax] upserted %d rows across %d income years", n, len(perYear))
}

// runMatchMode rebuilds the exact-name ASX mapping and logs the outcome.
func runMatchMode(ctx context.Context, pool *pgxpool.Pool) {
	inserted, skipped, err := runMatch(ctx, pool)
	if err != nil {
		log.Fatalf("[match] error: %v", err)
	}
	log.Printf("[match] inserted %d exact name_exact mappings (%d ambiguous entities skipped)", inserted, skipped)
}
