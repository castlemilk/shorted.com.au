// Package houseprices is the `shorted house-prices` job, migrated verbatim from
// services/house-price-collector (docs/jobs-consolidation-plan.md Phase 2d).
//
// It ingests Australian house-price data from multiple tiers (ABS Data API
// backbone, RBA, state-government granular, and an optional supplementary
// crawl) into the house_prices fact store, then refreshes the housing
// materialized views. Run-mode is selected with -mode — the same flag, the same
// mode values, the same environment contract as the standalone binary, so the
// residential-rig launchers can swap `house-price-collector -mode X` for
// `shorted house-prices -mode X` with no other change.
//
// # Exit codes
//
// Most jobs in this binary have one failure code. house-prices does NOT: the
// rig launchers in services/house-price-collector/deploy/*.sh branch on
// 3 (re-warm Chrome), 4 (Chrome/CDP unusable), 5 (Kasada session cold) and
// 6 (freshness alarm) and 7 (agent infrastructure failed before any work).
// Those modes keep returning their int code internally
// and the dispatch converts it into a *runner.ExitCodeError, which main maps
// straight onto the process exit status — see exitFor.
package houseprices

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/jackc/pgx/v5/pgxpool"
)

type officialJob struct {
	name string
	fn   func(context.Context) ([]Observation, error)
}

type officialJobIO struct {
	lockSource         func(context.Context, string) (func(), error)
	loadLastPeriod     func(context.Context, string) (*time.Time, error)
	upsertRegions      func(context.Context, []Observation) error
	upsertObservations func(context.Context, []Observation) (int, error)
	updateRun          func(context.Context, string, *time.Time, int, string, string) error
}

// modeList is the -mode help/validation string, unchanged from the standalone
// binary's flag usage text.
const modeList = "official | vg-nsw | crawl | listings | details | property | agent | enqueue | freshness | purge | warmcheck | backfill-address | census | electorates | banners | amenities | lga | connectivity | funding | council-financials | crime | refresh | all"

// Job returns the `shorted house-prices` subcommand.
//
// It does NOT declare DryRun. The collector has no global -dry-run flag: the
// crawl modes each carry their OWN env-driven dry-run switch (CRAWL_DRY_RUN,
// PURGE_DRY_RUN, CRIME_DRY_RUN, …, most defaulting ON), and the ingest modes
// always write. A global `shorted -dry-run house-prices …` is therefore refused
// by the runner rather than silently writing.
func Job() runner.Job {
	return runner.Func{
		JobName: "house-prices",
		Desc:    "ingest AU house prices (ABS/RBA/state VG), suburb demographics + the residential listing crawl",
		Fn:      Run,
	}
}

// exitMeaning documents the non-1 exit codes the rig launchers branch on.
var exitMeaning = map[int]string{
	3: "re-warm the crawl Chrome profile (Kasada/Akamai clearance expired)",
	4: "crawl fetcher init failed — Chrome/CDP unusable",
	5: "REA session is cold (Kasada stub)",
	6: "crawl freshness ALARM",
	7: "agent infrastructure failed before any jobs completed",
}

// exitFor converts a mode helper's process exit code into the job's return
// value. 0 is success; anything else becomes a *runner.ExitCodeError so main
// exits with that EXACT code (deferred pool close and the runner's end-of-job
// line still run, which os.Exit here would skip).
func exitFor(mode string, code int) error {
	if code == 0 {
		return nil
	}
	if why, ok := exitMeaning[code]; ok {
		return &runner.ExitCodeError{Code: code, Err: fmt.Errorf("-mode %s: %s", mode, why)}
	}
	return &runner.ExitCodeError{Code: code, Err: fmt.Errorf("-mode %s failed", mode)}
}

// Run executes the selected mode. Flags, environment, and exit-code semantics
// are identical to the standalone services/house-price-collector binary:
// 0 = ok; 1 = official-ingest, VG freshness, materialized-view finalization,
// or ordinary job failure; 3 = re-warm Chrome; 4 = Chrome/CDP unusable;
// 5 = REA session cold; 6 = crawl freshness alarm; and 7 = agent
// infrastructure failed before any jobs completed (also used for
// enqueue/listings finalization failures).
//
// The standalone binary called log.Fatal on a missing DATABASE_URL, a failed
// connect and an unknown -mode; inside a shared binary that would skip deferred
// cleanup and the runner's end-of-job logging, so those three paths return
// errors with the same message text instead.
func Run(parent context.Context, args []string) error {
	fs := flag.NewFlagSet("house-prices", flag.ContinueOnError)
	mode := fs.String("mode", "all", modeList)
	if err := fs.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return runner.ErrUsage
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q (house-prices takes only -mode)", fs.Arg(0))
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}

	// Configurable overall deadline. The slow, paced live-crawl modes (a full
	// queue drain walks many suburbs at 8-20s page jitter, ~2-3 min per suburb)
	// default far higher than the quick official/refresh runs: callers that set
	// no CRAWL_TIMEOUT_MIN — the bundled macOS agent's Auto-crawl among them —
	// were getting the 15-min default and self-aborting a healthy batch a few
	// suburbs in, killing the in-flight suburb's writes with it.
	// The parent context is the runner's signal context, so SIGTERM now
	// cancels the run in addition to the CRAWL_TIMEOUT_MIN ceiling. The
	// standalone binary derived from context.Background() and had no signal
	// handling at all; every crawl-internal circuit-breaker, resume cursor and
	// detached finalizer is unchanged underneath.
	ctx, cancel := context.WithTimeout(parent, time.Duration(collectorTimeoutMinutes(*mode))*time.Minute)
	defer cancel()

	pool, err := connect(ctx, dbURL)
	if err != nil {
		return fmt.Errorf("db connect: %w", err)
	}
	defer pool.Close()

	switch *mode {
	case "official", "abs", "all":
		jobs := scheduledOfficialJobs()
		total, failures := runOfficial(ctx, pool, jobs)
		freshnessExitCode := assertOfficialVGFreshness(
			ctx,
			pool,
			freshnessPoliciesForOfficialJobs(jobs, vgFreshnessPolicies),
		)
		refreshErr := refresh(ctx, pool)
		maxFailures := envInt("HOUSING_OFFICIAL_MAX_FAILURES", total-1)
		if officialLifecycleFatal(total, failures, maxFailures, refreshErr) {
			if officialRunFatal(total, failures, maxFailures) {
				return fmt.Errorf("official ingest failed policy: %d/%d sources failed (maximum %d)", failures, total, boundedOfficialMaxFailures(total, maxFailures))
			}
			return fmt.Errorf("refresh housing materialized views: %w", refreshErr)
		}
		if freshnessExitCode != 0 {
			return exitFor("official", 1)
		}
	case "vg-nsw":
		return exitFor("vg-nsw", runNSWVG(ctx, pool))
	case "crawl":
		// Supplementary suburb crawl — opt-in only, never part of the default
		// scheduled run (it's slow, adversarial and licence-gated). Drives a HEADED,
		// persistent-profile Playwright browser, so it runs ONLY on the residential
		// cuttlefish rig under xvfb (see Dockerfile.crawl), never on Cloud Run.
		rewarm := runCrawl(ctx, pool)
		refreshErr := refresh(ctx, pool)
		if rewarm {
			return exitFor("crawl", 3)
		}
		if refreshErr != nil {
			return fmt.Errorf("refresh housing materialized views: %w", refreshErr)
		}
	case "listings":
		// Supplementary property-LISTING crawl — opt-in only, never part of the
		// scheduled run. Sweeps portal search-results pages for individual for-sale
		// listings, diffs asking prices across runs into price-drop events, and
		// refreshes mv_suburb_price_drops. Same residential-rig posture as -mode crawl
		// (headed host-Chrome over CDP); dry-run defaults ON. Self-refreshes internally
		// and returns 7 if materialized-view finalization fails.
		return exitFor("listings", runListings(ctx, pool))
	case "details":
		// Supplementary listing DETAIL-page crawl — opt-in only, never part of the
		// scheduled run. Visits each active listing's own detail page to close the
		// per-portal SRP gap (REA has no geo/land/type; Domain has no agency/agents)
		// and detect delists (a dead ad 404s / redirects to a search page). Same
		// residential-rig posture as -mode listings (headed host-Chrome over CDP);
		// dry-run defaults ON. Returns the exit code directly (0 ok, 3 re-warm).
		return exitFor("details", runDetails(ctx, pool))
	case "property":
		// Supplementary address-seeded VALUATION crawl — opt-in only, never part of
		// the scheduled run. property.com.au is REA Group's per-address research
		// portal (AVM estimate + sales history + attributes + year built); this pass
		// enriches our EXISTING address corpus (seeded from distinct property_listings
		// addresses, keyed by the same address_key) rather than sweeping the market.
		// Same residential-rig posture as -mode details (headed host-Chrome over CDP,
		// Kasada+Akamai stub-guard); dry-run defaults ON. Returns the exit code
		// directly (0 ok, 3 re-warm).
		return exitFor("property", runProperty(ctx, pool))
	case "agent":
		// Poll the brandbrain-native crawl queue for suburbs to crawl, run the
		// existing per-suburb listings sweep (residential host-Chrome over CDP),
		// and report a counts-only summary back. Residential-rig only; missing
		// BrandBrain URL/token-or-control infrastructure exits 7.
		// runAgent returns the process exit code directly: 0 ok, 3 re-warm needed,
		// 4 fetcher init failed (wedged/cold Chrome — the runner hard-recovers),
		// 7 agent infrastructure or finalizer failed.
		return exitFor("agent", runAgent(ctx, pool))
	case "enqueue":
		// Post suburbs to the brandbrain crawl queue so pollers (-mode agent) have
		// work to claim. Requires BRANDBRAIN_AGENT_URL + _TOKEN. CRAWL_ENQUEUE_SELECTION
		// picks the set: "all" (default, whole catalog) or "delta" (demand-right-sizing
		// — only never-crawled/stale/churny suburbs, ranked + capped; see crawl_delta.go).
		if err := runEnqueue(ctx, pool); err != nil {
			return exitFor("enqueue", enqueueExitCode(err))
		}
	case "freshness":
		// READ-ONLY staleness guard: report per-suburb crawl freshness across the
		// catalog and ALARM (non-zero exit 6 + optional CRAWL_FRESHNESS_WEBHOOK POST)
		// when the oldest covered suburb crosses CRAWL_FRESHNESS_ALARM_HOURS — the
		// check that catches the board silently going stale. See crawl_freshness.go.
		return exitFor("freshness", runFreshness(ctx, pool))
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
		return exitFor("warmcheck", runWarmCheck(ctx, pool))
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
	case "banners":
		// Per-suburb banner archetype classification, precomputed offline and
		// upserted into suburb_demographics (banner_archetype/banner_bg_key).
		runBanners(ctx, pool)
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
	case "crime":
		// Licence-clean suburb crime pipeline: ABS CVS scaler + ABS ERP
		// denominator + state police open data (Phase 1 = NSW/BOCSAR),
		// population-weighted percentile-ranked per crime type. Operator-run,
		// yearly; DRY-RUN by default. Refreshes the housing MVs internally on write.
		runCrime(ctx, pool)
	case "refresh":
		if err := refresh(ctx, pool); err != nil {
			return fmt.Errorf("refresh housing materialized views: %w", err)
		}
	default:
		return fmt.Errorf("unknown -mode %q (want official|vg-nsw|crawl|listings|details|property|agent|enqueue|freshness|warmcheck|backfill-address|census|electorates|banners|amenities|lga|connectivity|funding|council-financials|crime|refresh|all)", *mode)
	}
	// A cancelled run must never exit 0: the old binary died on SIGTERM with
	// the default disposition (143), and the rig drain wrapper
	// (deploy/housing-crawl-common.sh) treats rc=0 + processed>0 as a healthy
	// round and LOOPS AGAIN — so a graceful unwind that returned nil here
	// would make `launchctl stop` spawn another agent round. Surface the
	// interruption as an error (exit 1); the wrapper stops on any non-zero
	// that isn't its retry codes.
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("-mode %s: run interrupted: %w", *mode, err)
	}
	return nil
}

func collectorTimeoutMinutes(mode string) int {
	if mode == "vg-nsw" {
		return envInt("VG_NSW_TIMEOUT_MIN", 240)
	}

	defaultTimeoutMin := 15
	switch mode {
	case "agent", "listings", "crawl", "details", "property", "crime":
		defaultTimeoutMin = 240
	}
	return envInt("CRAWL_TIMEOUT_MIN", defaultTimeoutMin)
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

// runBanners loads the committed suburb archetype map and upserts each
// suburb's banner_archetype (+ seeds banner_bg_key) into suburb_demographics.
func runBanners(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := ingestBanners()
	if err != nil {
		log.Printf("[banners] ingest error: %v", err)
		_ = updateRun(ctx, pool, "suburb_archetypes", nil, 0, "error", err.Error())
		return
	}
	n, err := upsertBanners(ctx, pool, rows)
	if err != nil {
		log.Printf("[banners] upsert error after %d: %v", n, err)
		_ = updateRun(ctx, pool, "suburb_archetypes", nil, n, "error", err.Error())
		return
	}
	log.Printf("[banners] upserted %d", n)
	_ = updateRun(ctx, pool, "suburb_archetypes", nil, n, "ok", "")
}

// refresh deliberately ignores the caller's context — see below — but keeps the
// parameter so every call site reads like the rest of the pipeline.
func refresh(_ context.Context, pool *pgxpool.Pool) error {
	// Finalize on a DETACHED context (not the caller's run deadline): this links
	// + refreshes writes that already committed, and `-mode crawl` shares the
	// same long-deadline class as agent/listings — a deadline firing mid-crawl
	// must not kill the MV refresh for data that's already in.
	ctx, cancel := context.WithTimeout(context.Background(), finalizeTimeout)
	defer cancel()
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
		return err
	}
	log.Println("refreshed mv_housing_headline")
	// Official/crawl ingest refreshed the housing MVs → bust the web tier's
	// long-TTL housing caches now. Best-effort, never fails the run.
	pingRevalidate("refresh")
	return nil
}

func scheduledOfficialJobs() []officialJob {
	return []officialJob{
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
	}
}

func freshnessPoliciesForOfficialJobs(jobs []officialJob, policies []vgFreshnessPolicy) []vgFreshnessPolicy {
	attempted := make(map[string]struct{}, len(jobs))
	for _, job := range jobs {
		attempted[job.name] = struct{}{}
	}
	applicable := make([]vgFreshnessPolicy, 0, len(policies))
	for _, policy := range policies {
		if _, ok := attempted[policy.source]; ok {
			applicable = append(applicable, policy)
		}
	}
	return applicable
}

// runOfficial attempts exactly the supplied jobs. Sources omitted for this
// environment are neither counted nor treated as failures.
func runOfficial(ctx context.Context, pool *pgxpool.Pool, jobs []officialJob) (total, failures int) {
	total = len(jobs)
	for _, job := range jobs {
		if !runOfficialJob(ctx, pool, job) {
			failures++
		}
	}
	return total, failures
}

func runOfficialJob(ctx context.Context, pool *pgxpool.Pool, job officialJob) bool {
	return runOfficialJobWith(ctx, job, officialJobIO{
		lockSource: func(ctx context.Context, source string) (func(), error) {
			return lockOfficialJobSource(ctx, pool, source)
		},
		loadLastPeriod: func(ctx context.Context, source string) (*time.Time, error) {
			return loadRunLastPeriod(ctx, pool, source)
		},
		upsertRegions: func(ctx context.Context, obs []Observation) error {
			return upsertRegions(ctx, pool, obs)
		},
		upsertObservations: func(ctx context.Context, obs []Observation) (int, error) {
			return upsertObservations(ctx, pool, obs)
		},
		updateRun: func(ctx context.Context, source string, lastPeriod *time.Time, rows int, status, detail string) error {
			return updateRun(ctx, pool, source, lastPeriod, rows, status, detail)
		},
	})
}

func runOfficialJobWith(ctx context.Context, job officialJob, io officialJobIO) bool {
	unlock, err := io.lockSource(ctx, job.name)
	if err != nil {
		log.Printf("[%s] acquire source lock: %v", job.name, err)
		return false
	}
	defer unlock()

	persistedPeriod, err := io.loadLastPeriod(ctx, job.name)
	if err != nil {
		log.Printf("[%s] load persisted cursor: %v", job.name, err)
		return false
	}
	obs, err := job.fn(ctx)
	if err != nil {
		log.Printf("[%s] fetch error: %v", job.name, err)
		_ = io.updateRun(ctx, job.name, persistedPeriod, 0, "error", err.Error())
		return false
	}
	if len(obs) == 0 {
		log.Printf("[%s] no observations returned", job.name)
		_ = io.updateRun(ctx, job.name, persistedPeriod, 0, "error", "no observations")
		return false
	}
	last := latestPeriod(obs)
	if persistedPeriod != nil && last != nil && last.Before(*persistedPeriod) {
		detail := fmt.Sprintf("latest period regressed from %s to %s", fmtPeriod(persistedPeriod), fmtPeriod(last))
		log.Printf("[%s] %s", job.name, detail)
		_ = io.updateRun(ctx, job.name, persistedPeriod, 0, "error", detail)
		return false
	}
	if err := io.upsertRegions(ctx, obs); err != nil {
		log.Printf("[%s] region upsert error: %v", job.name, err)
		_ = io.updateRun(ctx, job.name, persistedPeriod, 0, "error", err.Error())
		return false
	}
	n, err := io.upsertObservations(ctx, obs)
	if err != nil {
		log.Printf("[%s] fact upsert error after %d: %v", job.name, n, err)
		_ = io.updateRun(ctx, job.name, persistedPeriod, n, "error", err.Error())
		return false
	}
	if err := io.updateRun(ctx, job.name, last, n, "ok", ""); err != nil {
		log.Printf("[%s] persist successful run cursor: %v", job.name, err)
		return false
	}
	log.Printf("[%s] upserted %d observations (latest %s)", job.name, n, fmtPeriod(last))
	return true
}

func runNSWVGRig(ingest func() bool, assertFreshness func() int, refreshViews func()) int {
	if !ingest() {
		return 1
	}
	freshnessExitCode := assertFreshness()
	refreshViews()
	if freshnessExitCode != 0 {
		return 1
	}
	return 0
}

func runNSWVG(ctx context.Context, pool *pgxpool.Pool) int {
	var policies []vgFreshnessPolicy
	for _, policy := range vgFreshnessPolicies {
		if policy.source == nswSource {
			policies = append(policies, policy)
		}
	}
	var refreshErr error
	exitCode := runNSWVGRig(
		func() bool {
			return runOfficialJob(ctx, pool, officialJob{name: nswSource, fn: ingestNSWSuburbMedians})
		},
		func() int {
			return assertOfficialVGFreshness(ctx, pool, policies)
		},
		func() {
			refreshErr = refresh(ctx, pool)
		},
	)
	if exitCode != 0 || refreshErr != nil {
		return 1
	}
	return 0
}

func boundedOfficialMaxFailures(total, configured int) int {
	if total <= 0 || configured < 0 {
		return 0
	}
	if configured >= total {
		return total - 1
	}
	return configured
}

// officialRunFatal is the pure lifecycle decision shared by configured and
// default policy. The bound ensures even an oversized setting cannot make a
// total upstream failure look successful.
func officialRunFatal(total, failures, maxFailures int) bool {
	if total <= 0 {
		return true
	}
	return failures > boundedOfficialMaxFailures(total, maxFailures)
}

func officialLifecycleFatal(total, failures, maxFailures int, refreshErr error) bool {
	return refreshErr != nil || officialRunFatal(total, failures, maxFailures)
}

func enqueueExitCode(err error) int {
	if err != nil {
		return 7
	}
	return 0
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
