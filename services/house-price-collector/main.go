// house-price-collector ingests Australian house-price data from multiple tiers
// (ABS Data API backbone, RBA, state-government granular, and an optional
// supplementary crawl) into the house_prices fact store, then refreshes the
// housing materialized views. Run-mode is selected with -mode.
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	os.Exit(run())
}

// run executes the selected mode and returns a process exit code: 0 = ok,
// 3 = a crawl needs a human to re-warm the Chrome profile (Kasada/Akamai
// clearance expired). Wrapping the body lets deferred cleanup run before exit.
func run() int {
	mode := flag.String("mode", "all", "official | crawl | listings | agent | enqueue | purge | warmcheck | backfill-address | census | electorates | amenities | lga | connectivity | funding | council-financials | refresh | all")
	flag.Parse()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	// Configurable overall deadline — a slow, paced live listings crawl needs longer
	// than the 15-min default used by the quick official/refresh runs.
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(envInt("CRAWL_TIMEOUT_MIN", 15))*time.Minute)
	defer cancel()

	pool, err := connect(ctx, dbURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	switch *mode {
	case "official", "abs", "all":
		runOfficial(ctx, pool)
		refresh(ctx, pool)
	case "crawl":
		// Supplementary suburb crawl — opt-in only, never part of the default
		// scheduled run (it's slow, adversarial and licence-gated). Drives a HEADED,
		// persistent-profile Playwright browser, so it runs ONLY on the residential
		// cuttlefish rig under xvfb (see Dockerfile.crawl), never on Cloud Run.
		rewarm := runCrawl(ctx, pool)
		refresh(ctx, pool)
		if rewarm {
			return 3
		}
	case "listings":
		// Supplementary property-LISTING crawl — opt-in only, never part of the
		// scheduled run. Sweeps portal search-results pages for individual for-sale
		// listings, diffs asking prices across runs into price-drop events, and
		// refreshes mv_suburb_price_drops. Same residential-rig posture as -mode crawl
		// (headed host-Chrome over CDP); dry-run defaults ON. Self-refreshes internally.
		if runListings(ctx, pool) {
			return 3
		}
	case "agent":
		// Poll the brandbrain-native crawl queue for suburbs to crawl, run the
		// existing per-suburb listings sweep (residential host-Chrome over CDP),
		// and report a counts-only summary back. Residential-rig only; requires
		// BRANDBRAIN_AGENT_URL + BRANDBRAIN_AGENT_TOKEN (no-op without them).
		// runAgent returns the process exit code directly: 0 ok, 3 re-warm needed,
		// 4 fetcher init failed (wedged/cold Chrome — the runner hard-recovers).
		return runAgent(ctx, pool)
	case "enqueue":
		// Post the curated suburb catalog to the brandbrain crawl queue so pollers
		// (-mode agent) have work to claim. Requires BRANDBRAIN_AGENT_URL + _TOKEN.
		runEnqueue(ctx, pool)
	case "purge":
		// Invalidate stale queue entries via the brandbrain purge endpoint, for
		// cleaning up after a job-shape/schema refactor (e.g. clearing legacy
		// source='both' jobs after the per-source split). DRY-RUN by default;
		// criteria via PURGE_SOURCE/KIND/TIER/STATUSES + PURGE_DRY_RUN=false.
		runPurge(ctx, pool)
	case "warmcheck":
		// Preflight verifier: fetches one REA search page via the SAME fetcher a
		// real crawl uses and reports whether the dedicated Chrome's Kasada
		// clearance is actually warm, rather than trusting the operator to
		// remember to launch Chrome with a REA startup URL. See
		// crawl_warmcheck.go and deploy/run-housing-crawl.sh.
		return runWarmCheck(ctx, pool)
	case "backfill-address":
		// ONE-TIME pass (operator-run, not part of any scheduled mode): derive
		// address_key for every existing property_listings row and propagate it
		// onto property_price_events, so pre-feature listings become per-address
		// queryable too. Idempotent — safe to re-run. See crawl_backfill_address.go.
		runBackfillAddress(ctx, pool)
	case "census":
		// ABS 2021 Census GCP SAL demographics — boundary-anchored suburb rows.
		runCensus(ctx, pool)
	case "electorates":
		// AEC federal electoral representation, spatially joined per suburb.
		runElectorates(ctx, pool)
	case "amenities":
		// Per-suburb amenity/lifestyle metrics, spatially joined offline
		// (web/scripts/geo/join-amenities.mjs) and upserted into suburb_amenities.
		runAmenities(ctx, pool)
	case "lga":
		// Council/LGA dimension + suburb→council bridge (ABS LGA_2024 PiP join).
		runLGA(ctx, pool)
	case "connectivity":
		// Dominant NBN access technology per suburb (centroid→footprint join).
		runConnectivity(ctx, pool)
	case "funding":
		// Federal Financial Assistance Grants per council → lga dimension.
		runFAGs(ctx, pool)
	case "council-financials":
		// VIC LGPRF per-council financials (rates, surplus, asset renewal) → lga.
		runVICFinancials(ctx, pool)
	case "refresh":
		refresh(ctx, pool)
	default:
		log.Fatalf("unknown -mode %q (want official|crawl|listings|agent|enqueue|warmcheck|backfill-address|census|electorates|amenities|lga|connectivity|funding|council-financials|refresh|all)", *mode)
	}
	return 0
}

// runVICFinancials fetches the VIC LGPRF full council data set and attaches each
// council's latest-year financials to the lga dimension.
func runVICFinancials(ctx context.Context, pool *pgxpool.Pool) {
	rows, year, err := ingestVICCouncilFinancials(ctx)
	if err != nil {
		log.Printf("[council-financials] ingest error: %v", err)
		_ = updateRun(ctx, pool, vicFinSource, nil, 0, "error", err.Error())
		return
	}
	n, err := applyVICFinancials(ctx, pool, rows)
	if err != nil {
		log.Printf("[council-financials] apply error after %d: %v", n, err)
		_ = updateRun(ctx, pool, vicFinSource, nil, n, "error", err.Error())
		return
	}
	log.Printf("[council-financials] matched %d/%d VIC councils to LGPRF %s financials", n, len(rows), year)
	_ = updateRun(ctx, pool, vicFinSource, nil, n, "ok", "")
}

// runFAGs fetches the national Financial Assistance Grants and attaches each
// council's latest total to the lga dimension.
func runFAGs(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := ingestFAGs(ctx)
	if err != nil {
		log.Printf("[funding] ingest error: %v", err)
		_ = updateRun(ctx, pool, fagSource, nil, 0, "error", err.Error())
		return
	}
	n, err := applyFAGs(ctx, pool, rows)
	if err != nil {
		log.Printf("[funding] apply error after %d: %v", n, err)
		_ = updateRun(ctx, pool, fagSource, nil, n, "error", err.Error())
		return
	}
	log.Printf("[funding] matched %d/%d councils to FAG grants", n, len(rows))
	_ = updateRun(ctx, pool, fagSource, nil, n, "ok", "")
}

// runConnectivity loads the precomputed per-suburb NBN tech and upserts it into
// suburb_connectivity, recording the run cursor under "nbn_footprint".
func runConnectivity(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := ingestConnectivity()
	if err != nil {
		log.Printf("[connectivity] ingest error: %v", err)
		_ = updateRun(ctx, pool, "nbn_footprint", nil, 0, "error", err.Error())
		return
	}
	n, err := upsertConnectivity(ctx, pool, rows)
	if err != nil {
		log.Printf("[connectivity] upsert error after %d: %v", n, err)
		_ = updateRun(ctx, pool, "nbn_footprint", nil, n, "error", err.Error())
		return
	}
	log.Printf("[connectivity] upserted %d", n)
	_ = updateRun(ctx, pool, "nbn_footprint", nil, n, "ok", "")
}

// runLGA loads the precomputed council dimension + suburb→council bridge and
// upserts them (lga + suburb_lga), recording the run cursor under "abs_lga".
func runLGA(ctx context.Context, pool *pgxpool.Pool) {
	lgas, subs, err := ingestLGA()
	if err != nil {
		log.Printf("[lga] ingest error: %v", err)
		_ = updateRun(ctx, pool, "abs_lga", nil, 0, "error", err.Error())
		return
	}
	nl, err := upsertLGADimension(ctx, pool, lgas)
	if err != nil {
		log.Printf("[lga] dimension upsert error after %d: %v", nl, err)
		_ = updateRun(ctx, pool, "abs_lga", nil, nl, "error", err.Error())
		return
	}
	ns, err := upsertSuburbLGA(ctx, pool, subs)
	if err != nil {
		log.Printf("[lga] bridge upsert error after %d: %v", ns, err)
		_ = updateRun(ctx, pool, "abs_lga", nil, ns, "error", err.Error())
		return
	}
	if err := refreshLGAPopulation(ctx, pool); err != nil {
		log.Printf("[lga] population rollup failed: %v", err)
	}
	log.Printf("[lga] upserted %d councils + %d suburb links (+ population rollup)", nl, ns)
	_ = updateRun(ctx, pool, "abs_lga", nil, ns, "ok", "")
}

// runAmenities loads the precomputed per-suburb amenity metrics and upserts
// them into suburb_amenities, recording the run cursor under "local_amenities".
func runAmenities(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := ingestAmenities()
	if err != nil {
		log.Printf("[amenities] ingest error: %v", err)
		_ = updateRun(ctx, pool, "local_amenities", nil, 0, "error", err.Error())
		return
	}
	n, err := upsertAmenities(ctx, pool, rows)
	if err != nil {
		log.Printf("[amenities] upsert error after %d: %v", n, err)
		_ = updateRun(ctx, pool, "local_amenities", nil, n, "error", err.Error())
		return
	}
	log.Printf("[amenities] upserted %d", n)
	_ = updateRun(ctx, pool, "local_amenities", nil, n, "ok", "")
}

// runElectorates loads the precomputed suburb→division join + division roll-up
// and upserts each suburb's federal representation into suburb_demographics.
func runElectorates(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := ingestElectorates()
	if err != nil {
		log.Printf("[electorates] ingest error: %v", err)
		_ = updateRun(ctx, pool, "aec_federal", nil, 0, "error", err.Error())
		return
	}
	n, err := upsertElectorates(ctx, pool, rows)
	if err != nil {
		log.Printf("[electorates] upsert error after %d: %v", n, err)
		_ = updateRun(ctx, pool, "aec_federal", nil, n, "error", err.Error())
		return
	}
	log.Printf("[electorates] upserted %d", n)
	_ = updateRun(ctx, pool, "aec_federal", nil, n, "ok", "")
}

func refresh(ctx context.Context, pool *pgxpool.Pool) {
	// Link any newly-ingested suburb regions to their ABS sal_code first, so the
	// suburb map (which reads house_prices via the sal_code bridge) paints without
	// a manual backfill step.
	if n, err := linkSuburbSalCodes(ctx, pool); err != nil {
		log.Printf("suburb sal_code link failed: %v", err)
	} else {
		log.Printf("linked %d suburb region(s) to sal_code", n)
	}
	if err := refreshHousingMV(ctx, pool); err != nil {
		log.Printf("mv refresh failed: %v", err)
		return
	}
	log.Println("refreshed mv_housing_headline")
}

// runOfficial pulls each official (ABS + RBA) source, upserts regions + facts,
// and records the run cursor.
func runOfficial(ctx context.Context, pool *pgxpool.Pool) {
	jobs := []struct {
		name string
		fn   func(context.Context) ([]Observation, error)
	}{
		{"abs_res_dwell_st", ingestRESDWELLST},
		{"abs_res_dwell", ingestRESDWELL},
		{"abs_rppi", ingestRPPI},
		{"abs_lend_housing", ingestLENDHOUSING},
		{"abs_derived_index", ingestDerivedPriceIndex},
		{"rba", ingestRBADebtToIncome},
		{"rba_f6_rates", ingestRBAMortgageRates},
		{"rba_cash_rate", ingestRBACashRate},
		{"rba_housing_credit", ingestRBAHousingCredit},
		{"rba_balance_sheet", ingestRBAHouseholdBalanceSheet},
		{"abs_wpi", ingestWPI},
		{"abs_cpi_rents", ingestCPIRents},
		{"abs_price_to_income", ingestPriceToIncome},
		{"vg_sa", ingestSAMetroMedians},
		{"vg_vic", ingestVICSuburbMedians},
		{"vg_nsw", ingestNSWSuburbMedians},
	}
	for _, j := range jobs {
		obs, err := j.fn(ctx)
		if err != nil {
			log.Printf("[%s] fetch error: %v", j.name, err)
			_ = updateRun(ctx, pool, j.name, nil, 0, "error", err.Error())
			continue
		}
		if len(obs) == 0 {
			log.Printf("[%s] no observations returned", j.name)
			_ = updateRun(ctx, pool, j.name, nil, 0, "error", "no observations")
			continue
		}
		if err := upsertRegions(ctx, pool, obs); err != nil {
			log.Printf("[%s] region upsert error: %v", j.name, err)
			_ = updateRun(ctx, pool, j.name, nil, 0, "error", err.Error())
			continue
		}
		n, err := upsertObservations(ctx, pool, obs)
		if err != nil {
			log.Printf("[%s] fact upsert error after %d: %v", j.name, n, err)
			_ = updateRun(ctx, pool, j.name, nil, n, "error", err.Error())
			continue
		}
		last := latestPeriod(obs)
		_ = updateRun(ctx, pool, j.name, last, n, "ok", "")
		log.Printf("[%s] upserted %d observations (latest %s)", j.name, n, fmtPeriod(last))
	}
}

func latestPeriod(obs []Observation) *time.Time {
	var last *time.Time
	for i := range obs {
		if last == nil || obs[i].Period.After(*last) {
			p := obs[i].Period
			last = &p
		}
	}
	return last
}

func fmtPeriod(t *time.Time) string {
	if t == nil {
		return "n/a"
	}
	return t.Format("2006-01-02")
}

// runCensus ingests ABS 2021 Census suburb demographics and upserts them into
// suburb_demographics, recording the run cursor under "abs_census".
func runCensus(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := ingestCensus(ctx)
	if err != nil {
		log.Printf("[census] ingest error: %v", err)
		_ = updateRun(ctx, pool, "abs_census", nil, 0, "error", err.Error())
		return
	}
	n, err := upsertDemographics(ctx, pool, rows)
	if err != nil {
		log.Printf("[census] upsert error after %d: %v", n, err)
		_ = updateRun(ctx, pool, "abs_census", nil, n, "error", err.Error())
		return
	}
	log.Printf("[census] upserted %d", n)
	_ = updateRun(ctx, pool, "abs_census", nil, n, "ok", "")
}
