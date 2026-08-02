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
// REGISTER OF INTERESTS modes — parliamentarians' declared interests. These are
// OPERATOR-RUN and deliberately EXCLUDED from -mode all: -mode all runs on every
// prod deploy, and an 804-document crawl of aph.gov.au must never fire from a
// deploy step or an unattended timer. REGISTER_DRY_RUN defaults TRUE, so each is
// a no-op until it is explicitly set false.
// See docs/feature/politicians/architecture.md §5.2.
//
//	-mode register-discover         scrape the listing pages into the manifest; downloads nothing
//	-mode register-fetch            drain the fetch queue, streaming PDFs to the content-addressed sink
//	-mode register-load             load extracted artifacts into politicians / statements / declared items
//	-mode register-resolve          securities + locations + the holding-interval fold + MV refresh
//	-mode register-freshness        read-only sentinel; non-zero exit on an alarm
//	-mode register-propose-aliases  LLM-proposed aliases for human review; publishes nothing
//	-mode register-promote-aliases  copy human-CONFIRMED proposals into the curated alias table
//	-mode register-index            push the PUBLISHED register to the Algolia politicians index
//	                                (run AFTER register-resolve — it reads the MV that resolve rebuilds)
//	-mode register-photos           resolve portrait photographs from Wikidata/Commons (never aph.gov.au — §3.1)
//	-mode register-senators         MINT senator identity + Senate terms from the APH Handbook
//	                                (the only register mode that CREATES people; run before load/photos/index)
//
// AEC FUNDING LAYER — the political donations corpus behind
// /politicians/donations. Also EXCLUDED from -mode all, for the same reason the
// register modes are: it downloads three bulk archives and snapshot-REPLACES
// every aec_* table, which is an operator's decision rather than a side effect
// of a deploy. It is a SEPARATE path from -mode aec, which only projects a
// couple of the same CSVs into the industry-intelligence evidence feed and is
// untouched by it. See docs/feature/politicians/donations.md.
//
//	-mode aec-donations   load party/receipt/donation/member/candidate returns, resolve, refresh the rollup
//	                      -dry parses and prints counts, writing nothing
//	                      AEC_SNAPSHOT_DIR=<dir> reads a local corpus instead of downloading
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
	"strings"
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

// Run executes the influence collector. Flags are identical to the standalone
// services/influence-collector binary.
//
// The original tool called log.Fatalf at every failure point. Inside a shared
// binary that would skip deferred cleanup (pool close) and bypass the runner's
// end-of-job logging, so every run* mode helper returns an error instead — same
// message text, same non-zero exit, no panic-as-control-flow.
func Run(parent context.Context, args []string) error {
	fs := flag.NewFlagSet("influence", flag.ContinueOnError)
	mode := fs.String("mode", "tax", "tax | match | sources | source-registry | source-probe | tax-records | emissions | austender | aec | lobbyists | trade | aec-donations | public-records | all | register-discover | register-fetch | register-load | register-resolve | register-freshness | register-propose-aliases | register-promote-aliases | register-index | register-photos | register-handbook | register-senators")
	registerLimit := fs.Int("register-limit", 0, "cap documents processed per register mode (0 = no cap); the fetch queue is ordered parliament DESC so a cap lands on a parliament boundary")
	sourceLimit := fs.Int("source-limit", defaultAusTenderResourceCap, "maximum downloadable resources per source for archive-backed collectors")
	dry := fs.Bool("dry", false, "aec-donations: parse and report counts without writing, resolving or refreshing")
	if err := fs.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return runner.ErrUsage
		}
		return err
	}
	// A BARE mode name is the runbook's most likely typo, and without this guard
	// it is silently destructive rather than an error: `shorted influence
	// register-fetch` (dropping "-mode") parses clean, leaves mode at its "tax"
	// default, and falls into the `case "tax"` arm — ingesting the entire ATO
	// corporate-tax corpus instead of draining the register fetch queue. The
	// operator runbook is literally --args="influence,-mode,register-fetch", so
	// losing one token does it. discovery, house-prices and news already guard
	// this way.
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q (influence takes only -mode, -register-limit, -source-limit and -dry)", fs.Arg(0))
	}

	// 15-minute ceiling for the public-records collectors, same as the standalone
	// binary. The REGISTER modes get their own, much longer ceiling: they are
	// operator-run rather than scheduled, and they legitimately take longer than
	// 15 minutes — a polite serial fetch of 804 PDFs at 1.5s apart is ~20 minutes
	// by design, and load/resolve walk 769 documents and 6,133 candidates. Capping
	// them at 15 would kill a healthy run half way through and leave the manifest
	// looking like a failure.
	ceiling := 15 * time.Minute
	if strings.HasPrefix(*mode, "register-") {
		ceiling = 6 * time.Hour
	}
	// aec-downloads three archives and replaces ~209k rows; the 15-minute
	// collector ceiling would kill a healthy run mid-load and leave the funding
	// tables looking like a failure. Operator-run, like the register modes.
	if *mode == "aec-donations" {
		ceiling = 1 * time.Hour
	}
	ctx, cancel := context.WithTimeout(parent, ceiling)
	defer cancel()

	pool, err := platform.ConnectFromEnv(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()

	// steps is the ordered mode pipeline; running it through one loop gives a
	// cancellation checkpoint between every collector (a 15-minute ceiling or a
	// SIGTERM should stop the run, not start the next multi-minute download).
	var steps []func(context.Context) error
	add := func(fns ...func(context.Context) error) { steps = append(steps, fns...) }

	sourceRegistry := func(ctx context.Context) error { return runSourceRegistry(ctx, pool) }
	sourceProbe := func(ctx context.Context) error { return runSourceProbe(ctx, pool) }
	tax := func(ctx context.Context) error { return runTax(ctx, pool) }
	match := func(ctx context.Context) error { return runMatchMode(ctx, pool) }
	taxRecords := func(ctx context.Context) error { return runTaxRecordsMode(ctx, pool) }
	emissions := func(ctx context.Context) error { return runEmissionsMode(ctx, pool) }
	austender := func(ctx context.Context) error { return runAusTenderMode(ctx, pool, *sourceLimit) }
	aec := func(ctx context.Context) error { return runAECMode(ctx, pool, *sourceLimit) }
	lobbyists := func(ctx context.Context) error { return runLobbyistsMode(ctx, pool) }
	trade := func(ctx context.Context) error { return runTradeMode(ctx, pool) }
	aecDonations := func(ctx context.Context) error { return runAECDonationsMode(ctx, pool, *dry) }

	switch *mode {
	case "tax", "all":
		add(sourceRegistry)
		if *mode == "all" {
			add(sourceProbe)
		}
		add(tax, match, taxRecords)
		if *mode == "all" {
			add(emissions, austender, aec, lobbyists, trade)
		}
	case "match":
		add(match)
	case "sources":
		add(sourceRegistry, sourceProbe)
	case "source-registry":
		add(sourceRegistry)
	case "source-probe":
		add(sourceProbe)
	case "tax-records":
		add(taxRecords)
	case "emissions":
		add(sourceRegistry, emissions)
	case "austender":
		add(sourceRegistry, austender)
	case "aec":
		add(sourceRegistry, aec)
	case "lobbyists":
		add(sourceRegistry, lobbyists)
	case "trade":
		add(sourceRegistry, trade)
	case "public-records":
		add(sourceRegistry, taxRecords, emissions, austender, aec, lobbyists, trade)

	// --- AEC funding layer ------------------------------------------------
	// One step, and NEVER added to "all" above.
	case "aec-donations":
		add(aecDonations)

	// --- register of interests -------------------------------------------
	// One step each, and NEVER added to "all" above.
	case "register-discover":
		add(func(ctx context.Context) error { return runRegisterDiscover(ctx, pool, *registerLimit) })
	case "register-fetch":
		add(func(ctx context.Context) error { return runRegisterFetch(ctx, pool, *registerLimit) })
	case "register-load":
		add(func(ctx context.Context) error { return runRegisterLoad(ctx, pool, *registerLimit) })
	case "register-resolve":
		add(func(ctx context.Context) error { return runRegisterResolve(ctx, pool) })
	case "register-freshness":
		add(func(ctx context.Context) error { return runRegisterFreshnessMode(ctx, pool) })
	case "register-propose-aliases":
		add(func(ctx context.Context) error { return runRegisterProposeAliasesMode(ctx, pool, *registerLimit) })
	case "register-promote-aliases":
		add(func(ctx context.Context) error { return runRegisterPromoteAliasesMode(ctx, pool) })
	case "register-index":
		add(func(ctx context.Context) error { return runRegisterIndexMode(ctx, pool) })
	case "register-handbook":
		add(func(ctx context.Context) error { return runRegisterHandbookMode(ctx, pool) })
	case "register-senators":
		add(func(ctx context.Context) error { return runRegisterSenatorsMode(ctx, pool) })
	case "register-photos":
		add(func(ctx context.Context) error { return runRegisterPhotosMode(ctx, pool) })

	default:
		return fmt.Errorf("unknown -mode %q (want tax|match|sources|source-registry|source-probe|tax-records|emissions|austender|aec|lobbyists|trade|aec-donations|public-records|all|register-discover|register-fetch|register-load|register-resolve|register-freshness|register-propose-aliases|register-promote-aliases|register-index|register-photos|register-handbook|register-senators)", *mode)
	}

	for _, step := range steps {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := step(ctx); err != nil {
			return err
		}
	}
	return nil
}

// runTax downloads + parses every annual ATO report and upserts the facts.
func runTax(ctx context.Context, pool *pgxpool.Pool) error {
	rows, perYear, err := ingestTax(ctx)
	if err != nil {
		return fmt.Errorf("[tax] ingest error: %w", err)
	}
	n, err := upsertTaxRows(ctx, pool, rows)
	if err != nil {
		return fmt.Errorf("[tax] upsert error after %d rows: %w", n, err)
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
	return nil
}

// runMatchMode rebuilds the exact-name ASX mapping and logs the outcome.
func runMatchMode(ctx context.Context, pool *pgxpool.Pool) error {
	inserted, skipped, err := runMatch(ctx, pool)
	if err != nil {
		return fmt.Errorf("[match] error: %w", err)
	}
	log.Printf("[match] inserted %d exact name_exact mappings (%d ambiguous entities skipped)", inserted, skipped)
	return nil
}

func runSourceRegistry(ctx context.Context, pool *pgxpool.Pool) error {
	n, err := upsertIndustrySourceDefinitions(ctx, pool, industrySourceDefinitions)
	if err != nil {
		return fmt.Errorf("[sources] registry upsert error: %w", err)
	}
	log.Printf("[sources] upserted %d industry intelligence source definitions", n)
	return nil
}

func runSourceProbe(ctx context.Context, pool *pgxpool.Pool) error {
	client := newProbeHTTPClient()
	for _, source := range industrySourceDefinitions {
		runID, err := insertIndustryCollectionRun(ctx, pool, source.SourceKey)
		if err != nil {
			return fmt.Errorf("[sources] start probe run for %s: %w", source.SourceKey, err)
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
			return fmt.Errorf("[sources] finish probe run for %s: %w", source.SourceKey, err)
		}

		if probeErr != nil {
			log.Printf("[sources] %s probe failed: %v", source.SourceKey, probeErr)
			continue
		}
		log.Printf("[sources] %s probe succeeded (HTTP %d)", source.SourceKey, statusCode)
	}
	return nil
}

func runTaxRecordsMode(ctx context.Context, pool *pgxpool.Pool) error {
	runID, err := insertIndustryCollectionRun(ctx, pool, taxSource)
	if err != nil {
		return fmt.Errorf("[tax-records] start collection run: %w", err)
	}

	inserted, err := syncIndustryTaxRecords(ctx, pool)
	if err != nil {
		finishErr := finishIndustryCollectionRun(ctx, pool, runID, "failed", 0, 0, 1, compactError(err), map[string]any{
			"projection": "corporate_tax_to_industry_intelligence_records",
		})
		if finishErr != nil {
			log.Printf("[tax-records] failed to finish collection run after error: %v", finishErr)
		}
		return fmt.Errorf("[tax-records] sync error: %w", err)
	}

	if err := finishIndustryCollectionRun(ctx, pool, runID, "succeeded", int(inserted), int(inserted), 0, "", map[string]any{
		"projection": "corporate_tax_to_industry_intelligence_records",
	}); err != nil {
		return fmt.Errorf("[tax-records] finish collection run: %w", err)
	}
	log.Printf("[tax-records] upserted %d exact-matched ATO industry intelligence records", inserted)
	return nil
}

func runEmissionsMode(ctx context.Context, pool *pgxpool.Pool) error {
	runID, err := insertIndustryCollectionRun(ctx, pool, emissionsSource)
	if err != nil {
		return fmt.Errorf("[emissions] start collection run: %w", err)
	}
	rows, err := ingestCEREmissions(ctx)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[emissions]", err, map[string]any{
			"source_url": cerLatestURL,
		})
		return fmt.Errorf("[emissions] ingest error: %w", err)
	}
	imported, skipped, err := syncIndustryEmissionRecords(ctx, pool, rows)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[emissions]", err, map[string]any{
			"source_url": cerLatestURL,
		})
		return fmt.Errorf("[emissions] sync error: %w", err)
	}
	status := "succeeded"
	if imported == 0 && skipped > 0 {
		status = "partial"
	}
	if err := finishIndustryCollectionRun(ctx, pool, runID, status, len(rows), imported, 0, "", map[string]any{
		"source_url":       cerLatestURL,
		"skipped_unmapped": skipped,
	}); err != nil {
		return fmt.Errorf("[emissions] finish collection run: %w", err)
	}
	log.Printf("[emissions] parsed %d CER rows, imported %d exact ABN-matched records (%d unmapped)", len(rows), imported, skipped)
	return nil
}

func runAusTenderMode(ctx context.Context, pool *pgxpool.Pool, sourceLimit int) error {
	runID, err := insertIndustryCollectionRun(ctx, pool, austenderSource)
	if err != nil {
		return fmt.Errorf("[austender] start collection run: %w", err)
	}
	rows, resources, err := ingestAusTender(ctx, sourceLimit)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[austender]", err, map[string]any{
			"dataset_url":    austenderHistoricalDataset,
			"package_url":    austenderHistoricalPackage,
			"resource_limit": sourceLimit,
		})
		return fmt.Errorf("[austender] ingest error: %w", err)
	}
	imported, skipped, err := syncIndustryContractRecords(ctx, pool, rows)
	if err != nil {
		finishCollectionRunAfterFailure(ctx, pool, runID, "[austender]", err, map[string]any{
			"dataset_url":    austenderHistoricalDataset,
			"package_url":    austenderHistoricalPackage,
			"resource_limit": sourceLimit,
		})
		return fmt.Errorf("[austender] sync error: %w", err)
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
		return fmt.Errorf("[austender] finish collection run: %w", err)
	}
	log.Printf("[austender] parsed %d contract rows from %d resources, imported %d exact ABN-matched records (%d unmapped)", len(rows), resources, imported, skipped)
	return nil
}

func finishCollectionRunAfterFailure(ctx context.Context, pool *pgxpool.Pool, runID, label string, err error, metadata map[string]any) {
	if finishErr := finishIndustryCollectionRun(ctx, pool, runID, "failed", 0, 0, 1, compactError(err), metadata); finishErr != nil {
		log.Printf("%s failed to finish collection run after error: %v", label, finishErr)
	}
}
