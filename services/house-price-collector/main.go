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
	mode := flag.String("mode", "all", "official | crawl | census | refresh | all")
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
	case "official", "abs", "all":
		runOfficial(ctx, pool)
		refresh(ctx, pool)
	case "crawl":
		// Supplementary suburb crawl — opt-in only, never part of the default
		// scheduled run (it's slow, adversarial and licence-gated).
		runCrawl(ctx, pool)
		refresh(ctx, pool)
	case "census":
		// ABS 2021 Census GCP SAL demographics — boundary-anchored suburb rows.
		runCensus(ctx, pool)
	case "refresh":
		refresh(ctx, pool)
	default:
		log.Fatalf("unknown -mode %q (want official|crawl|census|refresh|all)", *mode)
	}
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

func refresh(ctx context.Context, pool *pgxpool.Pool) {
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
		{"rba", ingestRBADebtToIncome},
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
