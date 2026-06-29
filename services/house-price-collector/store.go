package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Observation is one house-price datapoint: a region × measure × dwelling ×
// period × source value, normalised across heterogeneous sources.
type Observation struct {
	RegionCode    string
	RegionType    string // national | state | gccsa | rest_of_state | suburb | lga
	RegionName    string
	StateCode     string
	Postcode      string
	Measure       string // mean_price | median_price | total_value | price_index | transfer_count | ...
	DwellingType  string // established_house | attached | all
	Period        time.Time
	PeriodFreq    string // Q | M | A
	Value         float64
	Unit          string // AUD | index | ratio | count
	IsPreliminary bool
	Source        string
	SourceLicence string
}

func connect(ctx context.Context, dbURL string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		return nil, err
	}
	// SimpleProtocol keeps the Supabase transaction pooler (port 6543) happy.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	cfg.MaxConns = 4
	return pgxpool.NewWithConfig(ctx, cfg)
}

func contentHash(o Observation) string {
	h := sha1.Sum(fmt.Appendf(nil, "%s|%s|%s|%s|%s|%.4f",
		o.RegionCode, o.Measure, o.DwellingType, o.Period.Format("2006-01-02"), o.Source, o.Value))
	return hex.EncodeToString(h[:])
}

// upsertRegions writes the distinct regions referenced by obs (the fact table's
// FK target), deriving each region's metadata from the first observation seen.
func upsertRegions(ctx context.Context, pool *pgxpool.Pool, obs []Observation) error {
	seen := map[string]Observation{}
	for _, o := range obs {
		if _, ok := seen[o.RegionCode]; !ok {
			seen[o.RegionCode] = o
		}
	}
	batch := &pgx.Batch{}
	for _, o := range seen {
		batch.Queue(`
			INSERT INTO house_price_regions (region_code, region_type, region_name, state_code, postcode)
			VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''))
			ON CONFLICT (region_code) DO UPDATE SET
				region_type = EXCLUDED.region_type,
				region_name = EXCLUDED.region_name,
				state_code  = COALESCE(EXCLUDED.state_code, house_price_regions.state_code),
				postcode    = COALESCE(EXCLUDED.postcode, house_price_regions.postcode)`,
			o.RegionCode, o.RegionType, o.RegionName, o.StateCode, o.Postcode)
	}
	br := pool.SendBatch(ctx, batch)
	defer br.Close()
	for range seen {
		if _, err := br.Exec(); err != nil {
			return err
		}
	}
	return nil
}

// upsertObservations idempotently writes facts (UNIQUE key = region, measure,
// dwelling, period, source) — re-runs update value/preliminary/fetched_at.
func upsertObservations(ctx context.Context, pool *pgxpool.Pool, obs []Observation) (int, error) {
	const q = `
		INSERT INTO house_prices
			(region_code, measure, dwelling_type, period, period_freq, value, unit,
			 is_preliminary, source, source_licence, content_hash)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		ON CONFLICT (region_code, measure, dwelling_type, period, source)
		DO UPDATE SET value = EXCLUDED.value, unit = EXCLUDED.unit,
			is_preliminary = EXCLUDED.is_preliminary,
			content_hash = EXCLUDED.content_hash, fetched_at = now()`
	batch := &pgx.Batch{}
	for _, o := range obs {
		batch.Queue(q, o.RegionCode, o.Measure, o.DwellingType, o.Period, o.PeriodFreq,
			o.Value, o.Unit, o.IsPreliminary, o.Source, o.SourceLicence, contentHash(o))
	}
	br := pool.SendBatch(ctx, batch)
	defer br.Close()
	n := 0
	for range obs {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// upsertDemographics idempotently writes one row per boundary suburb (PK =
// sal_code). v1 populates identity + population + the five G02 medians; the
// tenure/dwelling columns are left to default NULL until those tables are
// mapped. Nullable *int/*float64 fields bind directly (pgx maps nil → NULL).
func upsertDemographics(ctx context.Context, pool *pgxpool.Pool, rows []CensusRow) (int, error) {
	const q = `
		INSERT INTO suburb_demographics
			(sal_code, sal_name, state_code, population, median_age,
			 median_weekly_hhd_income, median_weekly_per_income, median_weekly_rent,
			 median_monthly_mortgage, census_year, source, source_licence,
			 pct_born_overseas, pct_english_only, top_religion, pct_top_religion,
			 pct_no_religion, top_language, pct_top_language)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
		ON CONFLICT (sal_code) DO UPDATE SET
			sal_name                 = EXCLUDED.sal_name,
			state_code               = EXCLUDED.state_code,
			population               = EXCLUDED.population,
			median_age               = EXCLUDED.median_age,
			median_weekly_hhd_income = EXCLUDED.median_weekly_hhd_income,
			median_weekly_per_income = EXCLUDED.median_weekly_per_income,
			median_weekly_rent       = EXCLUDED.median_weekly_rent,
			median_monthly_mortgage  = EXCLUDED.median_monthly_mortgage,
			census_year              = EXCLUDED.census_year,
			source                   = EXCLUDED.source,
			source_licence           = EXCLUDED.source_licence,
			pct_born_overseas        = EXCLUDED.pct_born_overseas,
			pct_english_only         = EXCLUDED.pct_english_only,
			top_religion             = EXCLUDED.top_religion,
			pct_top_religion         = EXCLUDED.pct_top_religion,
			pct_no_religion          = EXCLUDED.pct_no_religion,
			top_language             = EXCLUDED.top_language,
			pct_top_language         = EXCLUDED.pct_top_language,
			fetched_at               = now()`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.SALCode, r.SALName, r.StateCode, r.Population, r.MedianAge,
			r.MedianWeeklyHhdIncome, r.MedianWeeklyPerIncome, r.MedianWeeklyRent,
			r.MedianMonthlyMortgage, censusYear, censusSource, censusLicence,
			r.PctBornOverseas, r.PctEnglishOnly, r.TopReligion, r.PctTopReligion,
			r.PctNoReligion, r.TopLanguage, r.PctTopLanguage)
	}
	br := pool.SendBatch(ctx, batch)
	defer br.Close()
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func updateRun(ctx context.Context, pool *pgxpool.Pool, source string, lastPeriod *time.Time, rows int, status, detail string) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO house_price_ingest_runs (source, last_period, last_fetched_at, rows_upserted, status, detail)
		VALUES ($1, $2, now(), $3, $4, NULLIF($5, ''))
		ON CONFLICT (source) DO UPDATE SET
			last_period = EXCLUDED.last_period, last_fetched_at = now(),
			rows_upserted = EXCLUDED.rows_upserted, status = EXCLUDED.status, detail = EXCLUDED.detail`,
		source, lastPeriod, rows, status, detail)
	return err
}

func refreshHousingMV(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `SELECT refresh_housing_materialized_views()`)
	return err
}
