// influence-collector ingests Australia's public "influence layer" datasets
// (Track A of the roadmap) into the shorts database and matches the entities to
// ASX codes on an ABN/name spine. Run-mode is selected with -mode.
//
//	-mode tax    Ingest the ATO Corporate Tax Transparency dataset (11 annual
//	             reports) into corporate_tax, rebuild the ASX name mapping, and
//	             publish exact-matched industry intelligence records.
//	-mode match  Rebuild the corporate_tax → ASX name mapping only.
//	-mode sources        Upsert source registry definitions and probe reachability.
//	-mode source-registry Upsert source registry definitions only.
//	-mode source-probe    Probe source reachability only.
//	-mode tax-records     Publish exact-matched ATO facts into industry records.
//	-mode emissions       Import CER NGER exact ABN-matched emissions records.
//	-mode austender       Import AusTender exact ABN-matched contract records.
//	-mode aec             Import AEC Transparency Register exact-matched returns.
//	-mode lobbyists       Import lobbyist + FITS register exact-matched counts.
//	-mode trade           Import ABS trade-in-goods industry-level records.
//	-mode public-records  Publish already-ingested tax + external public records.
//	-mode all    sources + tax + match + public-records.
//
//	-mode register-discover  Scrape the APH Registers of Members'/Senators'
//	                         Interests listing pages into the register_documents
//	                         manifest. Downloads no PDFs.
//	-mode register-fetch     Stream queued PDFs into the content-addressed sink
//	                         (REGISTER_BUCKET, else a local cache) and record
//	                         sha256/size/storage_uri on the manifest.
//	-mode register-load      Turn extraction artifacts into normalised
//	                         statements/items and resolve each document to a
//	                         person (politicians + politician_terms).
//
// The register-* modes are deliberately EXCLUDED from -mode all: -mode all runs
// on every prod deploy, and an 804-document crawl of aph.gov.au must never fire
// from a deploy step. They also dry-run by default (REGISTER_DRY_RUN=false to
// persist).
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
	mode := flag.String("mode", "tax", "tax | match | sources | source-registry | source-probe | tax-records | emissions | austender | aec | lobbyists | trade | public-records | all | register-discover | register-fetch | register-load")
	sourceLimit := flag.Int("source-limit", defaultAusTenderResourceCap, "maximum downloadable resources per source for archive-backed collectors")
	registerLimit := flag.Int("register-limit", 0, "cap documents processed per register-* run (0 = no cap)")
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
		runSourceRegistry(ctx, pool)
		if *mode == "all" {
			runSourceProbe(ctx, pool)
		}
		runTax(ctx, pool)
		runMatchMode(ctx, pool)
		runTaxRecordsMode(ctx, pool)
		if *mode == "all" {
			runEmissionsMode(ctx, pool)
			runAusTenderMode(ctx, pool, *sourceLimit)
			runAECMode(ctx, pool, *sourceLimit)
			runLobbyistsMode(ctx, pool)
			runTradeMode(ctx, pool)
		}
	case "match":
		runMatchMode(ctx, pool)
	case "sources":
		runSourceRegistry(ctx, pool)
		runSourceProbe(ctx, pool)
	case "source-registry":
		runSourceRegistry(ctx, pool)
	case "source-probe":
		runSourceProbe(ctx, pool)
	case "tax-records":
		runTaxRecordsMode(ctx, pool)
	case "emissions":
		runSourceRegistry(ctx, pool)
		runEmissionsMode(ctx, pool)
	case "austender":
		runSourceRegistry(ctx, pool)
		runAusTenderMode(ctx, pool, *sourceLimit)
	case "aec":
		runSourceRegistry(ctx, pool)
		runAECMode(ctx, pool, *sourceLimit)
	case "lobbyists":
		runSourceRegistry(ctx, pool)
		runLobbyistsMode(ctx, pool)
	case "trade":
		runSourceRegistry(ctx, pool)
		runTradeMode(ctx, pool)
	case "public-records":
		runSourceRegistry(ctx, pool)
		runTaxRecordsMode(ctx, pool)
		runEmissionsMode(ctx, pool)
		runAusTenderMode(ctx, pool, *sourceLimit)
		runAECMode(ctx, pool, *sourceLimit)
		runLobbyistsMode(ctx, pool)
		runTradeMode(ctx, pool)
	case "register-discover":
		runRegisterDiscover(ctx, pool, *registerLimit)
	case "register-fetch":
		runRegisterFetch(ctx, pool, *registerLimit)
	case "register-load":
		runRegisterLoad(ctx, pool, *registerLimit)
	default:
		log.Fatalf("unknown -mode %q (want tax|match|sources|source-registry|source-probe|tax-records|emissions|austender|aec|lobbyists|trade|public-records|all|register-discover|register-fetch|register-load)", *mode)
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

func runSourceRegistry(ctx context.Context, pool *pgxpool.Pool) {
	n, err := upsertIndustrySourceDefinitions(ctx, pool, industrySourceDefinitions)
	if err != nil {
		log.Fatalf("[sources] registry upsert error: %v", err)
	}
	log.Printf("[sources] upserted %d industry intelligence source definitions", n)
}

func runSourceProbe(ctx context.Context, pool *pgxpool.Pool) {
	client := newProbeHTTPClient()
	for _, source := range industrySourceDefinitions {
		runID, err := insertIndustryCollectionRun(ctx, pool, source.SourceKey)
		if err != nil {
			log.Fatalf("[sources] start probe run for %s: %v", source.SourceKey, err)
		}

		statusCode, probeErr := probeIndustrySource(ctx, client, source)
		status := classifyProbeStatus(probeErr)
		errorMessage := compactError(probeErr)
		recordsFailed := 0
		if probeErr != nil {
			recordsFailed = 1
		}

		metadata := map[string]any{
			"probe_url":         probeURLForSource(source),
			"probe_status_code": statusCode,
			"collection_method": source.CollectionMethod,
		}
		if err := finishIndustryCollectionRun(ctx, pool, runID, status, 1, 0, recordsFailed, errorMessage, metadata); err != nil {
			log.Fatalf("[sources] finish probe run for %s: %v", source.SourceKey, err)
		}

		if probeErr != nil {
			log.Printf("[sources] %s probe failed: %v", source.SourceKey, probeErr)
			continue
		}
		log.Printf("[sources] %s probe succeeded (HTTP %d)", source.SourceKey, statusCode)
	}
}

func runTaxRecordsMode(ctx context.Context, pool *pgxpool.Pool) {
	runID, err := insertIndustryCollectionRun(ctx, pool, taxSource)
	if err != nil {
		log.Fatalf("[tax-records] start collection run: %v", err)
	}

	inserted, err := syncIndustryTaxRecords(ctx, pool)
	if err != nil {
		finishErr := finishIndustryCollectionRun(ctx, pool, runID, "failed", 0, 0, 1, compactError(err), map[string]any{
			"projection": "corporate_tax_to_industry_intelligence_records",
		})
		if finishErr != nil {
			log.Printf("[tax-records] failed to finish collection run after error: %v", finishErr)
		}
		log.Fatalf("[tax-records] sync error: %v", err)
	}

	if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", int(inserted), int(inserted), 0, "", map[string]any{
		"projection": "corporate_tax_to_industry_intelligence_records",
	}); err != nil {
		log.Fatalf("[tax-records] finish collection run: %v", err)
	}
	log.Printf("[tax-records] upserted %d exact-matched ATO industry intelligence records", inserted)
}

func runEmissionsMode(ctx context.Context, pool *pgxpool.Pool) {
	runID, err := insertIndustryCollectionRun(ctx, pool, emissionsSource)
	if err != nil {
		log.Fatalf("[emissions] start collection run: %v", err)
	}
	rows, err := ingestCEREmissions(ctx)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[emissions]", err, map[string]any{
			"source_url": cerLatestURL,
		})
		log.Fatalf("[emissions] ingest error: %v", err)
	}
	imported, skipped, err := syncIndustryEmissionRecords(ctx, pool, rows)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[emissions]", err, map[string]any{
			"source_url": cerLatestURL,
		})
		log.Fatalf("[emissions] sync error: %v", err)
	}
	status := "succeeded"
	if imported == 0 && skipped > 0 {
		status = "partial"
	}
	if err := finishIndustryCollectionRun(ctx, pool, runID, status, len(rows), imported, 0, "", map[string]any{
		"source_url":       cerLatestURL,
		"skipped_unmapped": skipped,
	}); err != nil {
		log.Fatalf("[emissions] finish collection run: %v", err)
	}
	log.Printf("[emissions] parsed %d CER rows, imported %d exact ABN-matched records (%d unmapped)", len(rows), imported, skipped)
}

func runAusTenderMode(ctx context.Context, pool *pgxpool.Pool, sourceLimit int) {
	runID, err := insertIndustryCollectionRun(ctx, pool, austenderSource)
	if err != nil {
		log.Fatalf("[austender] start collection run: %v", err)
	}
	rows, resources, err := ingestAusTender(ctx, sourceLimit)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[austender]", err, map[string]any{
			"dataset_url":    austenderHistoricalDataset,
			"package_url":    austenderHistoricalPackage,
			"resource_limit": sourceLimit,
		})
		log.Fatalf("[austender] ingest error: %v", err)
	}
	imported, skipped, err := syncIndustryContractRecords(ctx, pool, rows)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[austender]", err, map[string]any{
			"dataset_url":    austenderHistoricalDataset,
			"package_url":    austenderHistoricalPackage,
			"resource_limit": sourceLimit,
		})
		log.Fatalf("[austender] sync error: %v", err)
	}
	status := "succeeded"
	if imported == 0 && skipped > 0 {
		status = "partial"
	}
	if err := finishIndustryCollectionRun(ctx, pool, runID, status, len(rows), imported, 0, "", map[string]any{
		"dataset_url":      austenderHistoricalDataset,
		"package_url":      austenderHistoricalPackage,
		"resources_seen":   resources,
		"resource_limit":   sourceLimit,
		"skipped_unmapped": skipped,
	}); err != nil {
		log.Fatalf("[austender] finish collection run: %v", err)
	}
	log.Printf("[austender] parsed %d contract rows from %d resources, imported %d exact ABN-matched records (%d unmapped)", len(rows), resources, imported, skipped)
}

func finishCollectionRunAfterFailure(ctx context.Context, pool *pgxpool.Pool, runID, label string, err error, metadata map[string]any) {
	if finishErr := finishIndustryCollectionRun(ctx, pool, runID, "failed", 0, 0, 1, compactError(err), metadata); finishErr != nil {
		log.Printf("%s failed to finish collection run after error: %v", label, finishErr)
	}
}
