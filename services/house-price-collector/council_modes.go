package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/absdata"
)

// Run functions for the council fact modes (council_abs.go, council_wikidata.go).
// Each loads the lga dimension first — every source is keyed onto it, and the
// lga_series FK would reject anything else — writes in one transaction, and
// records its cursor through recordLGARun.

// runERPLGA: ABS ERP by council → lga.population/erp_year/pop_growth_pct +
// lga_series. Also clears the population of any council ERP does not cover,
// so no Census suburb-sum from the retired derivation survives beside ERP.
func runERPLGA(ctx context.Context, pool *pgxpool.Pool) error {
	ix, err := loadLGAIndex(ctx, pool)
	if err != nil {
		return recordLGARun(ctx, pool, erpSource, nil, 0, err)
	}
	series, pops, err := ingestERPLGA(ctx, absdata.NewClient(), ix, time.Now().UTC())
	if err != nil {
		return recordLGARun(ctx, pool, erpSource, nil, 0, err)
	}
	n, cleared, err := applyERPLGA(ctx, pool, series, pops)
	if err == nil {
		log.Printf("[erp-lga] %d councils: ERP %d; %d series rows; %d stale non-ERP populations cleared",
			len(pops), pops[0].Year, n, cleared)
	}
	return recordLGARun(ctx, pool, erpSource, latestSeriesPeriod(series), n, err)
}

// clearNonERPPopulationSQL removes a population no ERP row vouches for: the
// retired Census suburb-sum derivation wrote lga.population without erp_year,
// and leaving it would show a 2021 sum beside 2025 ERP for the councils ERP
// does not cover.
const clearNonERPPopulationSQL = `UPDATE lga SET population = NULL, pop_growth_pct = NULL
		WHERE erp_year IS NULL AND (population IS NOT NULL OR pop_growth_pct IS NOT NULL)`

func applyERPLGA(ctx context.Context, pool *pgxpool.Pool, series []LGASeriesRow, pops []LGAPopulation) (int, int64, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	n, cleared, err := applyERPLGATx(ctx, tx, series, pops)
	if err != nil {
		return n, 0, err
	}
	return n, cleared, tx.Commit(ctx)
}

func applyERPLGATx(ctx context.Context, tx pgx.Tx, series []LGASeriesRow, pops []LGAPopulation) (int, int64, error) {
	n, err := upsertLGASeriesTx(ctx, tx, series)
	if err != nil {
		return n, 0, err
	}
	batch := &pgx.Batch{}
	for _, p := range pops {
		batch.Queue(`UPDATE lga SET population = $2, erp_year = $3, pop_growth_pct = $4, fetched_at = now()
			WHERE lga_code24 = $1`, p.LGACode, p.Population, p.Year, p.PopGrowthPct)
	}
	if err := execBatch(ctx, tx, batch, len(pops)); err != nil {
		return n, 0, err
	}
	tag, err := tx.Exec(ctx, clearNonERPPopulationSQL)
	if err != nil {
		return n, 0, err
	}
	return n, tag.RowsAffected(), nil
}

// runCensusLGA: ABS Census 2021 council medians, tenure and SEIFA → lga.
func runCensusLGA(ctx context.Context, pool *pgxpool.Pool) error {
	ix, err := loadLGAIndex(ctx, pool)
	if err != nil {
		return recordLGARun(ctx, pool, censusLGASource, nil, 0, err)
	}
	rows, err := ingestCensusLGA(ctx, absdata.NewClient(), ix)
	if err != nil {
		return recordLGARun(ctx, pool, censusLGASource, nil, 0, err)
	}
	n, err := applyCensusLGA(ctx, pool, rows)
	if err == nil {
		log.Printf("[census-lga] updated %d councils from Census 2021 + SEIFA 2021", n)
	}
	census := time.Date(2021, time.August, 10, 0, 0, 0, 0, time.UTC) // Census night
	return recordLGARun(ctx, pool, censusLGASource, &census, n, err)
}

func applyCensusLGA(ctx context.Context, pool *pgxpool.Pool, rows []LGACensus) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(`UPDATE lga SET median_age = $2, median_hhd_income = $3, median_mortgage_monthly = $4,
				median_weekly_rent = $5, avg_household_size = $6, pct_rented = $7,
				seifa_irsad_decile = $8, seifa_irsd_decile = $9, fetched_at = now()
			WHERE lga_code24 = $1`,
			r.LGACode, r.MedianAge, r.MedianHhdIncome, r.MedianMortgageMonthly, r.MedianWeeklyRent,
			r.AvgHouseholdSize, r.PctRented, r.SeifaIRSADDecile, r.SeifaIRSDDecile)
	}
	if err := execBatch(ctx, tx, batch, len(rows)); err != nil {
		return 0, err
	}
	return len(rows), tx.Commit(ctx)
}

// runCouncilRegional: ABS Data by Region council-level transfer medians and
// counts + FY dwelling approvals → lga_series.
func runCouncilRegional(ctx context.Context, pool *pgxpool.Pool) error {
	ix, err := loadLGAIndex(ctx, pool)
	if err != nil {
		return recordLGARun(ctx, pool, regionalSource, nil, 0, err)
	}
	rows, err := ingestCouncilRegional(ctx, absdata.NewClient(), ix)
	if err != nil {
		return recordLGARun(ctx, pool, regionalSource, nil, 0, err)
	}
	n, err := upsertLGASeries(ctx, pool, rows)
	if err == nil {
		log.Printf("[council-regional] %d series rows across %d councils", n, countCouncils(rows))
	}
	return recordLGARun(ctx, pool, regionalSource, latestSeriesPeriod(rows), n, err)
}

// runBuildingApprovalsLGA: ABS monthly dwelling approvals by council →
// lga_series, incrementally from the run cursor.
func runBuildingApprovalsLGA(ctx context.Context, pool *pgxpool.Pool) error {
	ix, err := loadLGAIndex(ctx, pool)
	if err != nil {
		return recordLGARun(ctx, pool, baLGASource, nil, 0, err)
	}
	cursor, err := loadRunLastPeriod(ctx, pool, baLGASource)
	if err != nil {
		return recordLGARun(ctx, pool, baLGASource, nil, 0, err)
	}
	rows, err := ingestBuildingApprovalsLGA(ctx, absdata.NewClient(), ix, time.Now().UTC(), cursor)
	if err != nil {
		return recordLGARun(ctx, pool, baLGASource, cursor, 0, err)
	}
	last := latestSeriesPeriod(rows)
	if cursor != nil && last != nil && last.Before(*cursor) {
		err := fmt.Errorf("latest month regressed from %s to %s", fmtPeriod(cursor), fmtPeriod(last))
		return recordLGARun(ctx, pool, baLGASource, cursor, 0, err)
	}
	n, err := upsertLGASeries(ctx, pool, rows)
	if err == nil {
		log.Printf("[building-approvals-lga] %d series rows across %d councils, latest %s", n, countCouncils(rows), fmtPeriod(last))
	}
	return recordLGARun(ctx, pool, baLGASource, last, n, err)
}

// execBatch sends a batch of n statements on tx and surfaces the first error.
func execBatch(ctx context.Context, tx pgx.Tx, batch *pgx.Batch, n int) error {
	br := tx.SendBatch(ctx, batch)
	for i := 0; i < n; i++ {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return err
		}
	}
	return br.Close()
}
