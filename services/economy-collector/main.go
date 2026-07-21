package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

func main() {
	os.Exit(run())
}

func run() int {
	mode := flag.String("mode", "all", "sources | rba | cpi | labour | trade | gdp | petroleum | all")
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
		"rba":       {"rba-key-indicators", ingestRBA},
		"cpi":       {"abs-cpi", ingestCPI},
		"labour":    {"abs-labour-force", ingestLabour},
		"trade":     {"abs-merch-trade-state", ingestTradeByState},
		"gdp":       {"abs-state-accounts", ingestStateAccounts},
		"petroleum": {"dcceew-petroleum-statistics", ingestPetroleum},
	}

	runJob := func(j job) bool {
		obs, err := j.fn(ctx, client)
		if err != nil {
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
	case "rba", "cpi", "labour", "trade", "gdp", "petroleum":
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
		for _, name := range []string{"rba", "cpi", "labour", "trade", "gdp", "petroleum"} {
			if !runJob(jobs[name]) {
				failed++
			}
		}
		if failed > 0 {
			log.Printf("%d/6 sources failed", failed)
			return 1
		}
	default:
		log.Fatalf("unknown -mode %q (want sources|rba|cpi|labour|trade|gdp|petroleum|all)", *mode)
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

// Stubs replaced by Tasks 4-9. Each returns an error so `-mode all` fails
// loudly rather than silently skipping an unimplemented source.
var errNotImplemented = fmt.Errorf("importer not implemented yet")

func ingestCPI(ctx context.Context, c *absdata.Client) ([]Obs, error) { return nil, errNotImplemented }
func ingestLabour(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	return nil, errNotImplemented
}
func ingestTradeByState(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	return nil, errNotImplemented
}
func ingestStateAccounts(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	return nil, errNotImplemented
}
func ingestPetroleum(ctx context.Context, c *absdata.Client) ([]Obs, error) {
	return nil, errNotImplemented
}
