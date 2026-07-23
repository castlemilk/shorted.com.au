package main

import (
	"context"
	"flag"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// allJobModes is kept explicit so collection order is deterministic and a
// failed importer counts once in the all-mode summary. Pool-derived modes run
// after fetched inputs, with derived last because it consumes CPI/WPI/trade.
var allJobModes = []string{
	"rba", "cpi", "labour", "trade", "gdp", "approvals", "retail", "population",
	"petroleum", "govfin", "vacancies", "wages", "spending", "lending", "construction", "business", "markets", "derived",
}

func main() {
	os.Exit(run())
}

func run() int {
	mode := flag.String("mode", "all", "sources | rba | cpi | labour | trade | gdp | approvals | retail | population | petroleum | govfin | vacancies | wages | spending | lending | construction | business | markets | derived | all")
	flag.Parse()

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(envInt("ECONOMY_TIMEOUT_MIN", 20))*time.Minute)
	defer cancel()

	pool, err := connect(ctx, dbURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer pool.Close()

	client := absdata.NewClient()

	type job struct {
		name string
		fn   func(context.Context, *absdata.Client) ([]Obs, error)
	}
	jobs := map[string]job{
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
		// markets is DERIVED from the DB (shorts × exposure MV), not fetched
		// from a web source — so it takes the pool, not the client. Wrap it in
		// a client-shaped closure so it reuses the same runJob plumbing; the
		// client arg is deliberately ignored.
		"markets": {"derived-shorted-markets", func(ctx context.Context, _ *absdata.Client) ([]Obs, error) {
			return ingestMarkets(ctx, pool)
		}},
		// derived is also pool-backed. It must run after CPI, WPI, and trade in
		// all mode because those catalog/observation rows are its inputs.
		"derived": {"derived-shorted-economy", func(ctx context.Context, _ *absdata.Client) ([]Obs, error) {
			return ingestDerived(ctx, pool)
		}},
	}

	runJob := func(j job) bool {
		obs, err := j.fn(ctx, client)
		if err != nil {
			// An importer may return partial observations alongside its error
			// (e.g. petroleum: one drifted sheet must not stale the healthy
			// ones). Persist what parsed, but STILL fail the job so the drift
			// exits non-zero and gets noticed.
			if len(obs) > 0 {
				n, upErr := upsertObservations(ctx, pool, obs)
				if upErr != nil {
					log.Printf("ERROR %s partial upsert (wrote %d): %v", j.name, n, upErr)
				} else {
					log.Printf("partial %s: %d observations written despite error", j.name, n)
				}
			}
			log.Printf("ERROR %s: %v", j.name, err)
			return false
		}
		n, err := upsertObservations(ctx, pool, obs)
		if err != nil {
			log.Printf("ERROR %s upsert (wrote %d): %v", j.name, n, err)
			return false
		}
		log.Printf("ok %s: %d observations", j.name, n)
		return true
	}

	switch *mode {
	case "sources":
		if err := registerSources(ctx, pool); err != nil {
			log.Fatalf("register sources: %v", err)
		}
	case "rba", "cpi", "labour", "trade", "gdp", "approvals", "retail", "population", "petroleum", "govfin", "vacancies", "wages", "spending", "lending", "construction", "business", "markets", "derived":
		if err := registerSources(ctx, pool); err != nil {
			log.Fatalf("register sources: %v", err)
		}
		if !runJob(jobs[*mode]) {
			return 1
		}
	case "all":
		if err := registerSources(ctx, pool); err != nil {
			log.Fatalf("register sources: %v", err)
		}
		failed := 0
		// Pool-derived modes run after fetched inputs. In particular, derived
		// must run LAST because it consumes CPI, WPI, and trade rows written by
		// this same all-mode run; markets stays immediately before it.
		for _, name := range allJobModes {
			if !runJob(jobs[name]) {
				failed++
			}
		}
		if failed > 0 {
			log.Printf("%d/%d sources failed", failed, len(allJobModes))
			return 1
		}
	default:
		log.Fatalf("unknown -mode %q (want sources|rba|cpi|labour|trade|gdp|approvals|retail|population|petroleum|govfin|vacancies|wages|spending|lending|construction|business|markets|derived|all)", *mode)
	}
	return 0
}

func envInt(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
