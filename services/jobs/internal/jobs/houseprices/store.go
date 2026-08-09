package houseprices

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"log"
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
	for range seen {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return err
		}
	}
	return br.Close()
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
	n := 0
	for range obs {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return n, err
		}
		n++
	}
	if err := br.Close(); err != nil {
		return n, err
	}
	return n, nil
}

const updateRunSQL = `
	INSERT INTO house_price_ingest_runs (source, last_period, last_fetched_at, rows_upserted, status, detail)
	VALUES ($1, $2, now(), $3, $4, NULLIF($5, ''))
	ON CONFLICT (source) DO UPDATE SET
		last_period = CASE WHEN EXCLUDED.status = 'error' THEN house_price_ingest_runs.last_period ELSE EXCLUDED.last_period END,
		last_fetched_at = now(),
		rows_upserted = CASE WHEN EXCLUDED.status = 'error' THEN house_price_ingest_runs.rows_upserted ELSE EXCLUDED.rows_upserted END,
		status = EXCLUDED.status,
		detail = EXCLUDED.detail`

func updateRun(ctx context.Context, pool *pgxpool.Pool, source string, lastPeriod *time.Time, rows int, status, detail string) error {
	_, err := pool.Exec(ctx, updateRunSQL, source, lastPeriod, rows, status, detail)
	return err
}

func refreshHousingMV(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `SELECT refresh_housing_materialized_views()`)
	return err
}

// linkSuburbSalCodes backfills house_price_regions.sal_code for suburb regions by
// matching the region NAME to an ABS SAL name — the same logic as migrations 000056
// (exact) + 000068 (parenthetical-stripped fallback for ABS names like
// "Abbotsford (NSW)"). Run every ingest so newly-added suburbs (any state)
// self-link without a manual SQL step. Idempotent: only touches NULL sal_codes.
func linkSuburbSalCodes(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	var total int64
	tag, err := pool.Exec(ctx, `
		UPDATE house_price_regions r SET sal_code = d.sal_code
		FROM suburb_demographics d
		WHERE r.sal_code IS NULL AND r.region_type = 'suburb' AND r.state_code = d.state_code
		  AND upper(trim(r.region_name)) = upper(trim(d.sal_name))`)
	if err != nil {
		return total, fmt.Errorf("sal link (exact): %w", err)
	}
	total += tag.RowsAffected()
	tag, err = pool.Exec(ctx, `
		UPDATE house_price_regions r SET sal_code = d.sal_code
		FROM suburb_demographics d
		WHERE r.sal_code IS NULL AND r.region_type = 'suburb' AND r.state_code = d.state_code
		  AND upper(trim(r.region_name)) = upper(trim(regexp_replace(d.sal_name, '\s*\(.*\)\s*$', '')))`)
	if err != nil {
		return total, fmt.Errorf("sal link (stripped): %w", err)
	}
	total += tag.RowsAffected()
	return total, nil
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
	defer func() { _ = br.Close() }()
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// upsertElectorates updates each matched suburb's federal representation columns.
func upsertElectorates(ctx context.Context, pool *pgxpool.Pool, rows []ElectorateRow) (int, error) {
	const q = `
		UPDATE suburb_demographics SET
			federal_division = $2, federal_member = $3, federal_party = $4,
			federal_party_ab = $5, federal_tpp_alp = $6, state_district = $7,
			state_member = $8, state_party = $9, state_party_ab = $10, fetched_at = now()
		WHERE sal_code = $1`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.SALCode, r.FederalDivision, r.FederalMember, r.FederalParty, r.FederalPartyAb,
			r.FederalTppAlp, r.StateDistrict, r.StateMember, r.StateParty, r.StatePartyAb)
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// applyFAGs matches each council's Financial Assistance Grant (by normalised
// name + state) to the lga dimension and updates fed_fag_aud/year.
func applyFAGs(ctx context.Context, pool *pgxpool.Pool, rows []FagRow) (int, error) {
	type lgaKey struct{ norm, state string }
	idx := map[lgaKey]string{}
	q, err := pool.Query(ctx, `SELECT lga_code24, lga_name, state_code FROM lga`)
	if err != nil {
		return 0, err
	}
	for q.Next() {
		var code, name, state string
		if err := q.Scan(&code, &name, &state); err != nil {
			q.Close()
			return 0, err
		}
		idx[lgaKey{normCouncil(name), state}] = code
	}
	q.Close()
	// A mid-stream read error surfaces only via Err() (Next() just returns false);
	// without this the match index is silently truncated and the run still reports ok.
	if err := q.Err(); err != nil {
		return 0, err
	}

	batch := &pgx.Batch{}
	matched := 0
	for _, r := range rows {
		code, ok := idx[lgaKey{normCouncil(r.LGAName), r.StateCode}]
		if !ok {
			continue
		}
		// FAG writes only the grant columns; fin_source/fin_source_licence describe
		// the per-council FINANCIAL columns (avg_rates/op_surplus/asset_renewal) and
		// are owned by the state financials ingest (e.g. vic_lgprf), so leave them.
		batch.Queue(`UPDATE lga SET fed_fag_aud=$2, fed_fag_year=$3, fetched_at=now() WHERE lga_code24=$1`,
			code, r.TotalAud, r.Year)
		matched++
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	for i := 0; i < matched; i++ {
		if _, err := br.Exec(); err != nil {
			return i, err
		}
	}
	return matched, nil
}

// upsertConnectivity writes each suburb's dominant NBN tech + quality proxy.
func upsertConnectivity(ctx context.Context, pool *pgxpool.Pool, rows []ConnectivityRow) (int, error) {
	const q = `
		INSERT INTO suburb_connectivity (sal_code, dominant_nbn_tech, connectivity_quality_score)
		VALUES ($1, $2, $3)
		ON CONFLICT (sal_code) DO UPDATE SET
			dominant_nbn_tech = EXCLUDED.dominant_nbn_tech,
			connectivity_quality_score = EXCLUDED.connectivity_quality_score, fetched_at = now()`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.SALCode, r.Tech, r.Score)
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// refreshLGAPopulation derives each council's population by summing its member
// suburbs' Census populations (SALs tile the LGA) — no external fetch needed.
func refreshLGAPopulation(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, `
		UPDATE lga SET population = sub.pop FROM (
			SELECT sl.lga_code24, SUM(sd.population)::int AS pop
			FROM suburb_lga sl JOIN suburb_demographics sd ON sd.sal_code = sl.sal_code
			WHERE sd.population IS NOT NULL
			GROUP BY sl.lga_code24
		) sub WHERE lga.lga_code24 = sub.lga_code24`)
	return err
}

// upsertLGADimension writes the LGA (council) dimension rows.
func upsertLGADimension(ctx context.Context, pool *pgxpool.Pool, rows []LGARow) (int, error) {
	const q = `
		INSERT INTO lga (lga_code24, lga_name, state_code, area_sqkm)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (lga_code24) DO UPDATE SET
			lga_name = EXCLUDED.lga_name, state_code = EXCLUDED.state_code,
			area_sqkm = EXCLUDED.area_sqkm, fetched_at = now()`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.Code, r.Name, r.StateCode, r.AreaSqkm)
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// upsertSuburbLGA writes the suburb→dominant-council bridge.
func upsertSuburbLGA(ctx context.Context, pool *pgxpool.Pool, rows []SuburbLGARow) (int, error) {
	const q = `
		INSERT INTO suburb_lga (sal_code, lga_code24) VALUES ($1, $2)
		ON CONFLICT (sal_code) DO UPDATE SET lga_code24 = EXCLUDED.lga_code24`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.SALCode, r.LGACode)
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// upsertAmenities idempotently writes one suburb_amenities row per suburb
// (PK = sal_code). Nil pointer fields bind to NULL; explicit 0 counts persist.
func upsertAmenities(ctx context.Context, pool *pgxpool.Pool, rows []AmenityRow) (int, error) {
	const q = `
		INSERT INTO suburb_amenities (
			sal_code, schools_total, schools_primary, schools_secondary, schools_gov,
			schools_catholic, schools_independent, nearest_secondary_km,
			supermarkets_total, coles_count, woolworths_count, aldi_count, iga_count,
			nearest_supermarket_km, pubs_bars, clubs, parks_count, green_space_ratio,
			libraries_count, nearest_train_km, hospitals_count, gp_count, pharmacy_count,
			nearest_hospital_km, dist_to_coast_km, grocery_access_score,
			amenity_density_score, walkability_score, family_friendly_score, source, source_licence)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
			$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
		ON CONFLICT (sal_code) DO UPDATE SET
			schools_total = EXCLUDED.schools_total, schools_primary = EXCLUDED.schools_primary,
			schools_secondary = EXCLUDED.schools_secondary, schools_gov = EXCLUDED.schools_gov,
			schools_catholic = EXCLUDED.schools_catholic, schools_independent = EXCLUDED.schools_independent,
			nearest_secondary_km = EXCLUDED.nearest_secondary_km,
			supermarkets_total = EXCLUDED.supermarkets_total, coles_count = EXCLUDED.coles_count,
			woolworths_count = EXCLUDED.woolworths_count, aldi_count = EXCLUDED.aldi_count,
			iga_count = EXCLUDED.iga_count, nearest_supermarket_km = EXCLUDED.nearest_supermarket_km,
			pubs_bars = EXCLUDED.pubs_bars, clubs = EXCLUDED.clubs, parks_count = EXCLUDED.parks_count,
			green_space_ratio = EXCLUDED.green_space_ratio, libraries_count = EXCLUDED.libraries_count,
			nearest_train_km = EXCLUDED.nearest_train_km, hospitals_count = EXCLUDED.hospitals_count,
			gp_count = EXCLUDED.gp_count, pharmacy_count = EXCLUDED.pharmacy_count,
			nearest_hospital_km = EXCLUDED.nearest_hospital_km, dist_to_coast_km = EXCLUDED.dist_to_coast_km,
			grocery_access_score = EXCLUDED.grocery_access_score,
			amenity_density_score = EXCLUDED.amenity_density_score,
			walkability_score = EXCLUDED.walkability_score,
			family_friendly_score = EXCLUDED.family_friendly_score,
			source = EXCLUDED.source, source_licence = EXCLUDED.source_licence, fetched_at = now()`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.SALCode, r.SchoolsTotal, r.SchoolsPrimary, r.SchoolsSecondary, r.SchoolsGov,
			r.SchoolsCatholic, r.SchoolsIndependent, r.NearestSecondaryKm, r.SupermarketsTotal,
			r.ColesCount, r.WoolworthsCount, r.AldiCount, r.IgaCount, r.NearestSupermarketKm,
			r.PubsBars, r.Clubs, r.ParksCount, r.GreenSpaceRatio, r.LibrariesCount, r.NearestTrainKm,
			r.HospitalsCount, r.GpCount, r.PharmacyCount, r.NearestHospitalKm, r.DistToCoastKm,
			r.GroceryAccessScore, r.AmenityDensityScore, r.WalkabilityScore, r.FamilyFriendlyScore,
			"local_insights", "mixed")
	}
	br := pool.SendBatch(ctx, batch)
	defer func() { _ = br.Close() }()
	n := 0
	for range rows {
		if _, err := br.Exec(); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// upsertCrime idempotently writes the scaled + ranked suburb crime rows (PK =
// sal_code, crime_type, fy_ending, pooled). Re-running a source is a no-op; a
// newer source release overlays newer FYs.
func upsertCrime(ctx context.Context, pool *pgxpool.Pool, rows []CrimeStatRow) (int, error) {
	const q = `
		INSERT INTO suburb_crime_stats
			(sal_code, crime_type, fy_ending, pooled, raw_offence_count,
			 adjusted_offence_count, rate_per_100k, pct_rank, population, scale_factor,
			 small_pop, unreliable, source_jurisdiction, source, source_licence)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		ON CONFLICT (sal_code, crime_type, fy_ending, pooled) DO UPDATE SET
			raw_offence_count      = EXCLUDED.raw_offence_count,
			adjusted_offence_count = EXCLUDED.adjusted_offence_count,
			rate_per_100k          = EXCLUDED.rate_per_100k,
			pct_rank               = EXCLUDED.pct_rank,
			population             = EXCLUDED.population,
			scale_factor           = EXCLUDED.scale_factor,
			small_pop              = EXCLUDED.small_pop,
			unreliable             = EXCLUDED.unreliable,
			source_jurisdiction    = EXCLUDED.source_jurisdiction,
			source                 = EXCLUDED.source,
			source_licence         = EXCLUDED.source_licence,
			fetched_at             = now()`
	// Chunk the send: crime is ~527k rows, and a single pgx.Batch that large
	// pipelines every statement in one round-trip which STALLS through Supabase's
	// PgBouncer transaction pooler (observed hanging at 0 rows). Send in bounded
	// chunks so each is a manageable pooled transaction, with progress logging.
	const chunkSize = 2000
	n := 0
	for start := 0; start < len(rows); start += chunkSize {
		end := start + chunkSize
		if end > len(rows) {
			end = len(rows)
		}
		batch := &pgx.Batch{}
		for _, r := range rows[start:end] {
			batch.Queue(q, r.SalCode, r.CrimeType, r.FYEnding, r.Pooled, r.RawCount,
				r.AdjustedCount, r.RatePer100k, r.PctRank, r.Population, r.ScaleFactor,
				r.SmallPop, r.Unreliable, r.Jurisdiction, r.Source, r.SourceLicence)
		}
		br := pool.SendBatch(ctx, batch)
		for range rows[start:end] {
			if _, err := br.Exec(); err != nil {
				_ = br.Close()
				return n, err
			}
			n++
		}
		if err := br.Close(); err != nil {
			return n, err
		}
		if n%50000 == 0 || end == len(rows) {
			log.Printf("[crime] upsert progress: %d/%d rows", n, len(rows))
		}
	}
	return n, nil
}

// SuburbCrimeYear is one suburb's single-FY crime datapoint (read path — used by
// the shorts service's GetSuburbProfile once the Phase-3 read wiring lands).
type SuburbCrimeYear struct {
	FYEnding    int
	CrimeType   string
	RatePer100k float64
	PctRank     float64
	SmallPop    bool
}

// getSuburbCrime returns a suburb's single-FY crime series ordered by FY.
func getSuburbCrime(ctx context.Context, pool *pgxpool.Pool, salCode string) ([]SuburbCrimeYear, error) {
	rows, err := pool.Query(ctx, `
		SELECT fy_ending, crime_type, rate_per_100k, pct_rank, small_pop
		FROM suburb_crime_stats
		WHERE sal_code = $1 AND NOT pooled AND pct_rank IS NOT NULL
		ORDER BY fy_ending, crime_type`, salCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SuburbCrimeYear
	for rows.Next() {
		var y SuburbCrimeYear
		if err := rows.Scan(&y.FYEnding, &y.CrimeType, &y.RatePer100k, &y.PctRank, &y.SmallPop); err != nil {
			return nil, err
		}
		out = append(out, y)
	}
	return out, rows.Err()
}
