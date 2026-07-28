// Package economy is the `shorted economy` job, migrated from
// services/economy-collector (docs/jobs-consolidation-plan.md Phase 2). The
// -mode flag, the importer set and every importer's behaviour are unchanged.
//
// It ingests the generic economic-series layer (economic_series +
// economic_observations) from ABS SDMX/XLSX, RBA CSV and DCCEEW sources, plus
// the pool-derived markets/derived/correlations projections.
//
//	-mode sources       Upsert the source registry only.
//	-mode freshness     Report per-source staleness; non-zero exit when stale.
//	-mode <importer>    Run one importer (rba, cpi, labour, trade, gdp,
//	                    approvals, retail, population, petroleum, govfin,
//	                    vacancies, wages, spending, lending, construction,
//	                    business, crime, markets, derived, correlations).
//	-mode all           Every importer in allJobModes order.
package economy

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/castlemilk/shorted.com.au/services/jobs/internal/platform"
	"github.com/castlemilk/shorted.com.au/services/jobs/internal/runner"
	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
	"github.com/jackc/pgx/v5/pgxpool"
)

// allJobModes is kept explicit so collection order is deterministic and a
// failed importer counts once in the all-mode summary. Pool-derived modes run
// after fetched inputs, with correlations last because it consumes markets and
// all derived economic observations written by the same run.
var allJobModes = []string{
	"rba", "cpi", "labour", "trade", "gdp", "approvals", "retail", "population",
	"petroleum", "govfin", "vacancies", "wages", "spending", "lending", "construction", "business", "crime", "markets", "derived", "correlations",
}

const modeList = "sources|freshness|rba|cpi|labour|trade|gdp|approvals|retail|population|petroleum|govfin|vacancies|wages|spending|lending|construction|business|crime|markets|derived|correlations|all"

// Job returns the `shorted economy` subcommand.
//
// It does NOT declare DryRun: the standalone collector never had a -dry-run
// flag and every mode writes, so the runner refuses a global -dry-run against
// it rather than letting it write silently.
func Job() runner.Job {
	return runner.Func{
		JobName: "economy",
		Desc:    "ingest the economic-series layer (ABS/RBA/DCCEEW sources + derived projections)",
		Fn:      Run,
	}
}

// Run executes the economy collector. Flags are identical to the standalone
// services/economy-collector binary.
//
// The original tool called log.Fatalf on config/connect/registry failures and
// returned an exit code from run(); inside a shared binary that would skip
// deferred cleanup (pool close) and bypass the runner's end-of-job logging, so
// every failure path returns an error with the same message text instead.
func Run(parent context.Context, args []string) error {
	fs := flag.NewFlagSet("economy", flag.ContinueOnError)
	mode := fs.String("mode", "all", "sources | freshness | rba | cpi | labour | trade | gdp | approvals | retail | population | petroleum | govfin | vacancies | wages | spending | lending | construction | business | crime | markets | derived | correlations | all")
	if err := fs.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return runner.ErrUsage
		}
		return err
	}

	ctx, cancel := context.WithTimeout(parent, time.Duration(envInt("ECONOMY_TIMEOUT_MIN", 20))*time.Minute)
	defer cancel()

	pool, err := platform.ConnectFromEnv(ctx)
	if err != nil {
		return fmt.Errorf("db connect: %w", err)
	}
	defer pool.Close()

	c := &collector{pool: pool, client: absdata.NewClient()}

	switch *mode {
	case "sources":
		return registerSourcesOrErr(ctx, pool)
	case "freshness":
		return runFreshness(ctx, pool)
	case "correlations":
		if err := registerSourcesOrErr(ctx, pool); err != nil {
			return err
		}
		return c.runCorrelations(ctx)
	case "all":
		return c.runAll(ctx)
	default:
		j, ok := c.jobs()[*mode]
		if !ok {
			return fmt.Errorf("unknown -mode %q (want %s)", *mode, modeList)
		}
		if err := registerSourcesOrErr(ctx, pool); err != nil {
			return err
		}
		return c.run(ctx, j)
	}
}

// collector bundles the two things every importer needs — the pool and the
// shared ABS/RBA HTTP client — so the mode table is built once.
type collector struct {
	pool   *pgxpool.Pool
	client *absdata.Client
}

// importer is one named ingest step. markets/derived are pool-derived rather
// than fetched, so they ignore the client argument.
type importer struct {
	name string
	fn   func(context.Context, *absdata.Client) ([]Obs, error)
}

func (c *collector) jobs() map[string]importer {
	return map[string]importer{
		"rba":          {"rba-key-indicators", ingestRBA},
		"cpi":          {"abs-cpi", ingestCPI},
		"labour":       {"abs-labour-force", ingestLabour},
		"trade":        {"abs-merch-trade-state", ingestTradeByState},
		"gdp":          {"abs-state-accounts", ingestStateAccounts},
		"approvals":    {"abs-building-approvals", ingestApprovals},
		"retail":       {"abs-retail-trade", ingestRetail},
		"population":   {"abs-population", ingestPopulation},
		"petroleum":    {"dcceew-petroleum-statistics", ingestPetroleum},
		"govfin":       {"abs-government-finance", ingestGovFin},
		"vacancies":    {"abs-job-vacancies", ingestVacancies},
		"wages":        {"abs-wage-price-index", ingestWPI},
		"spending":     {"abs-household-spending", ingestSpending},
		"lending":      {"abs-lending-indicators", ingestLending},
		"construction": {"abs-construction-work-done", ingestConstruction},
		"business":     {"abs-business-indicators", ingestBusiness},
		"crime":        {"abs-recorded-crime-victims", ingestCrime},
		// markets is DERIVED from the DB (shorts × exposure MV), not fetched
		// from a web source — so it takes the pool, not the client. Wrap it in
		// a client-shaped closure so it reuses the same run plumbing; the
		// client arg is deliberately ignored.
		"markets": {"derived-shorted-markets", func(ctx context.Context, _ *absdata.Client) ([]Obs, error) {
			return ingestMarkets(ctx, c.pool)
		}},
		// derived is also pool-backed. It must run after CPI, WPI, and trade in
		// all mode because those catalog/observation rows are its inputs.
		"derived": {"derived-shorted-economy", func(ctx context.Context, _ *absdata.Client) ([]Obs, error) {
			return ingestDerived(ctx, c.pool)
		}},
	}
}

// run executes one importer and persists whatever it produced.
func (c *collector) run(ctx context.Context, j importer) error {
	obs, err := j.fn(ctx, c.client)
	if err != nil {
		// An importer may return partial observations alongside its error
		// (e.g. petroleum: one drifted sheet must not stale the healthy
		// ones). Persist what parsed, but STILL fail the job so the drift
		// exits non-zero and gets noticed.
		if len(obs) > 0 {
			n, upErr := upsertObservations(ctx, c.pool, obs)
			if upErr != nil {
				log.Printf("ERROR %s partial upsert (wrote %d): %v", j.name, n, upErr)
			} else {
				log.Printf("partial %s: %d observations written despite error", j.name, n)
			}
		}
		return fmt.Errorf("%s: %w", j.name, err)
	}
	n, err := upsertObservations(ctx, c.pool, obs)
	if err != nil {
		return fmt.Errorf("%s upsert (wrote %d): %w", j.name, n, err)
	}
	log.Printf("ok %s: %d observations", j.name, n)
	return nil
}

func (c *collector) runCorrelations(ctx context.Context) error {
	n, err := ingestCorrelations(ctx, c.pool)
	if err != nil {
		return fmt.Errorf("correlations: %w", err)
	}
	log.Printf("ok correlations: %d rows", n)
	return nil
}

// runAll walks allJobModes, tallying failures rather than stopping: one drifted
// upstream source must not block the other nineteen. Cancellation (SIGTERM or
// the ECONOMY_TIMEOUT_MIN ceiling) DOES stop the walk — there is no point
// starting another multi-minute download.
func (c *collector) runAll(ctx context.Context) error {
	if err := registerSourcesOrErr(ctx, c.pool); err != nil {
		return err
	}
	jobs := c.jobs()
	failed := 0
	for i, name := range allJobModes {
		if err := ctx.Err(); err != nil {
			// Keep the failure tally visible even when the run is cut short —
			// a bare ctx.Err() would hide how much of the walk had failed.
			return fmt.Errorf("cancelled after %d/%d steps, %d failed: %w",
				i, len(allJobModes), failed, err)
		}
		var err error
		if name == "correlations" {
			err = c.runCorrelations(ctx)
		} else {
			err = c.run(ctx, jobs[name])
		}
		if err != nil {
			log.Printf("ERROR %v", err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d/%d sources failed", failed, len(allJobModes))
	}
	return nil
}

func registerSourcesOrErr(ctx context.Context, pool *pgxpool.Pool) error {
	if err := registerSources(ctx, pool); err != nil {
		return fmt.Errorf("register sources: %w", err)
	}
	return nil
}

// runFreshness prints the per-source staleness report and fails the job when any
// non-frozen source is past its threshold (the standalone binary exited 1).
func runFreshness(ctx context.Context, pool *pgxpool.Pool) error {
	results, err := collectFreshness(ctx, pool, time.Now())
	if err != nil {
		return fmt.Errorf("freshness: %w", err)
	}
	if stale := writeFreshnessReport(os.Stdout, results); stale > 0 {
		return fmt.Errorf("%d stale economic sources", stale)
	}
	return nil
}

// envInt keeps the standalone collector's semantics: only a positive integer
// overrides the default (platform.GetEnvInt would accept 0/negative and give
// the run a zero-length timeout).
func envInt(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
