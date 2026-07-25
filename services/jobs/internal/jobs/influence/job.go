// Package influence is the `shorted influence` job, migrated verbatim from
// services/influence-collector (see docs/jobs-consolidation-plan.md Phase 1).
// The -mode flag and every mode's behaviour are unchanged.
//
// It ingests Australia's public "influence layer" datasets
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
// Editorial gate: only exact-ABN or exact-normalized-name matches are ever
// inserted into entity_asx_map (match_method='name_exact'); fuzzy matching is out
// of scope here. See docs/influence-editorial-standards.md.
package influence

import (
	"context"
	"flag"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Job returns the `shorted influence` subcommand.
func Job() runner.Job {
	return runner.Func{
		JobName: "influence",
		Desc:    "ingest Australia's public influence-layer datasets (ATO tax, CER, AusTender, AEC, lobbyists, ABS trade)",
		Fn:      Run,
	}
}

// abortError is what fatalf/fatal panic with. The original tool called
// log.Fatalf at every failure point; inside a shared binary that would skip
// deferred cleanup (pool close) and bypass the runner's end-of-job logging, so
// the same call sites now unwind to Run, which turns them back into an error
// (still a non-zero exit, same message text).
type abortError struct{ msg string }

func (e *abortError) Error() string { return e.msg }

func fatalf(format string, args ...any) {
	panic(&abortError{msg: fmt.Sprintf(format, args...)})
}

func fatal(msg string) {
	panic(&abortError{msg: msg})
}

// Run executes the influence collector. Flags are identical to the standalone
// services/influence-collector binary.
func Run(parent context.Context, args []string) (err error) {
	fs := flag.NewFlagSet("influence", flag.ContinueOnError)
	mode := fs.String("mode", "tax", "tax | match | sources | source-registry | source-probe | tax-records | emissions | austender | aec | lobbyists | trade | public-records | all")
	sourceLimit := fs.Int("source-limit", defaultAusTenderResourceCap, "maximum downloadable resources per source for archive-backed collectors")
	if err := fs.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return runner.ErrUsage
		}
		return err
	}

	defer func() {
		if r := recover(); r != nil {
			if ae, ok := r.(*abortError); ok {
				err = ae
				return
			}
			panic(r)
		}
	}()

	// 15-minute ceiling, same as the standalone binary.
	ctx, cancel := context.WithTimeout(parent, 15*time.Minute)
	defer cancel()

	pool, poolErr := platform.ConnectFromEnv(ctx)
	if poolErr != nil {
		return poolErr
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
	default:
		return fmt.Errorf("unknown -mode %q (want tax|match|sources|source-registry|source-probe|tax-records|emissions|austender|aec|lobbyists|trade|public-records|all)", *mode)
	}
	return nil
}

// runTax downloads + parses every annual ATO report and upserts the facts.
func runTax(ctx context.Context, pool *pgxpool.Pool) {
	rows, perYear, err := ingestTax(ctx)
	if err != nil {
		fatalf("[tax] ingest error: %v", err)
	}
	n, err := upsertTaxRows(ctx, pool, rows)
	if err != nil {
		fatalf("[tax] upsert error after %d rows: %v", n, err)
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
		fatalf("[match] error: %v", err)
	}
	log.Printf("[match] inserted %d exact name_exact mappings (%d ambiguous entities skipped)", inserted, skipped)
}

func runSourceRegistry(ctx context.Context, pool *pgxpool.Pool) {
	n, err := upsertIndustrySourceDefinitions(ctx, pool, industrySourceDefinitions)
	if err != nil {
		fatalf("[sources] registry upsert error: %v", err)
	}
	log.Printf("[sources] upserted %d industry intelligence source definitions", n)
}

func runSourceProbe(ctx context.Context, pool *pgxpool.Pool) {
	client := newProbeHTTPClient()
	for _, source := range industrySourceDefinitions {
		runID, err := insertIndustryCollectionRun(ctx, pool, source.SourceKey)
		if err != nil {
			fatalf("[sources] start probe run for %s: %v", source.SourceKey, err)
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
			fatalf("[sources] finish probe run for %s: %v", source.SourceKey, err)
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
		fatalf("[tax-records] start collection run: %v", err)
	}

	inserted, err := syncIndustryTaxRecords(ctx, pool)
	if err != nil {
		finishErr := finishIndustryCollectionRun(ctx, pool, runID, "failed", 0, 0, 1, compactError(err), map[string]any{
			"projection": "corporate_tax_to_industry_intelligence_records",
		})
		if finishErr != nil {
			log.Printf("[tax-records] failed to finish collection run after error: %v", finishErr)
		}
		fatalf("[tax-records] sync error: %v", err)
	}

	if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", int(inserted), int(inserted), 0, "", map[string]any{
		"projection": "corporate_tax_to_industry_intelligence_records",
	}); err != nil {
		fatalf("[tax-records] finish collection run: %v", err)
	}
	log.Printf("[tax-records] upserted %d exact-matched ATO industry intelligence records", inserted)
}

func runEmissionsMode(ctx context.Context, pool *pgxpool.Pool) {
	runID, err := insertIndustryCollectionRun(ctx, pool, emissionsSource)
	if err != nil {
		fatalf("[emissions] start collection run: %v", err)
	}
	rows, err := ingestCEREmissions(ctx)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[emissions]", err, map[string]any{
			"source_url": cerLatestURL,
		})
		fatalf("[emissions] ingest error: %v", err)
	}
	imported, skipped, err := syncIndustryEmissionRecords(ctx, pool, rows)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[emissions]", err, map[string]any{
			"source_url": cerLatestURL,
		})
		fatalf("[emissions] sync error: %v", err)
	}
	status := "succeeded"
	if imported == 0 && skipped > 0 {
		status = "partial"
	}
	if err := finishIndustryCollectionRun(ctx, pool, runID, status, len(rows), imported, 0, "", map[string]any{
		"source_url":       cerLatestURL,
		"skipped_unmapped": skipped,
	}); err != nil {
		fatalf("[emissions] finish collection run: %v", err)
	}
	log.Printf("[emissions] parsed %d CER rows, imported %d exact ABN-matched records (%d unmapped)", len(rows), imported, skipped)
}

func runAusTenderMode(ctx context.Context, pool *pgxpool.Pool, sourceLimit int) {
	runID, err := insertIndustryCollectionRun(ctx, pool, austenderSource)
	if err != nil {
		fatalf("[austender] start collection run: %v", err)
	}
	rows, resources, err := ingestAusTender(ctx, sourceLimit)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[austender]", err, map[string]any{
			"dataset_url":    austenderHistoricalDataset,
			"package_url":    austenderHistoricalPackage,
			"resource_limit": sourceLimit,
		})
		fatalf("[austender] ingest error: %v", err)
	}
	imported, skipped, err := syncIndustryContractRecords(ctx, pool, rows)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[austender]", err, map[string]any{
			"dataset_url":    austenderHistoricalDataset,
			"package_url":    austenderHistoricalPackage,
			"resource_limit": sourceLimit,
		})
		fatalf("[austender] sync error: %v", err)
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
		fatalf("[austender] finish collection run: %v", err)
	}
	log.Printf("[austender] parsed %d contract rows from %d resources, imported %d exact ABN-matched records (%d unmapped)", len(rows), resources, imported, skipped)
}

func finishCollectionRunAfterFailure(ctx context.Context, pool *pgxpool.Pool, runID, label string, err error, metadata map[string]any) {
	if finishErr := finishIndustryCollectionRun(ctx, pool, runID, "failed", 0, 0, 1, compactError(err), metadata); finishErr != nil {
		log.Printf("%s failed to finish collection run after error: %v", label, finishErr)
	}
}
