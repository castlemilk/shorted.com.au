package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/pkg/housingcrawl"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	// Routes NOTICEs to the housing MV capture (crawl_server.go). A no-op when no capture is active.
	cfg.ConnConfig.OnNotice = housingNotices.handle
	cfg.MaxConns = 4
	return pgxpool.NewWithConfig(ctx, cfg)
}

func contentHash(o Observation) string {
	h := sha1.Sum(fmt.Appendf(nil, "%s|%s|%s|%s|%s|%.4f",
		o.RegionCode, o.Measure, o.DwellingType, o.Period.Format("2006-01-02"), o.Source, o.Value))
	return hex.EncodeToString(h[:])
}

// upsertObservations idempotently writes facts (UNIQUE key = region, measure,
// dwelling, period, source) — re-runs update value/preliminary/fetched_at.
func upsertObservations(ctx context.Context, pool *pgxpool.Pool, obs []Observation) (int, error) {
	return upsertObservationsOn(ctx, pool, obs)
}

// batchSender is what a fact upsert needs: a pool for the ordinary path, a
// transaction when the upsert must commit together with a prune.
type batchSender interface {
	SendBatch(context.Context, *pgx.Batch) pgx.BatchResults
}

func upsertObservationsOn(ctx context.Context, db batchSender, obs []Observation) (int, error) {
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
	br := db.SendBatch(ctx, batch)
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

func loadRunLastPeriod(ctx context.Context, pool *pgxpool.Pool, source string) (*time.Time, error) {
	var lastPeriod *time.Time
	err := pool.QueryRow(ctx, `
		SELECT last_period
		FROM house_price_ingest_runs
		WHERE source = $1`, source).Scan(&lastPeriod)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return lastPeriod, nil
}

// lockOfficialJobSource serializes the cursor check and all subsequent writes
// for one source across processes. The otherwise-empty transaction owns a
// transaction-scoped advisory lock while the job uses ordinary pool operations.
func lockOfficialJobSource(ctx context.Context, pool *pgxpool.Pool, source string) (func(), error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	release := func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(releaseCtx); err != nil && err != pgx.ErrTxClosed {
			log.Printf("[%s] release source lock: %v", source, err)
		}
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, source); err != nil {
		release()
		return nil, err
	}
	return release, nil
}

// refreshSuburbReferenceViews refreshes the suburb reference views of
// migration 000139 (each SAL's latest public median, the state baselines and
// the similar-suburbs features) that the API's suburb list, profile and
// similar suburbs read instead of recomputing them per request. Their inputs
// are official data only: public-licence suburb medians, the Census and the
// amenities. So this runs after an official or Valuer-General load, -mode
// refresh and the Census/amenity loads, never after a crawl drain (the crawl
// writes only proprietary rows, which the views never read).
//
// A database without 000139 has no such function (42883): that is a skipped
// step, never a failed run, so the collector can ship before the hand-apply.
//
// The function turns a view it cannot refresh into a WARNING and carries on,
// and this pool has no notice handler, so the warning alone would never reach
// a log line or an exit code. It also returns the views it skipped, and any
// skipped view fails the run: the pages would keep serving that view's
// previous data.
func refreshSuburbReferenceViews(ctx context.Context, pool *pgxpool.Pool) error {
	skipped, err := callRefreshSuburbReferenceViews(ctx, pool)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42883" {
		log.Printf("suburb reference views not refreshed: refresh_suburb_reference_views() is absent (migration 000139 not applied)")
		return nil
	}
	if err != nil {
		return err
	}
	if len(skipped) > 0 {
		return fmt.Errorf("refresh_suburb_reference_views() skipped %d view(s), which still hold their previous data: %s",
			len(skipped), strings.Join(skipped, "; "))
	}
	log.Printf("refreshed the suburb reference views (mv_suburb_latest_price, mv_housing_state_baselines, mv_suburb_similarity_features)")
	return nil
}

// callRefreshSuburbReferenceViews runs the refresh in its own transaction so
// it can read the function's result: a multi-statement simple-protocol query
// (refreshHousingMV's shape) returns only its first statement's rows to pgx.
// SET LOCAL still precedes the call, because a function-scoped GUC cannot
// disarm the timeout already armed for the calling statement, and one
// transaction keeps one backend on the transaction pooler.
func callRefreshSuburbReferenceViews(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }() // a no-op after Commit
	if _, err := tx.Exec(ctx, `SET LOCAL statement_timeout = 0`); err != nil {
		return nil, err
	}
	var skipped []string
	if err := tx.QueryRow(ctx, `SELECT refresh_suburb_reference_views()`).Scan(&skipped); err != nil {
		return nil, err
	}
	return skipped, tx.Commit(ctx)
}

// afterSuburbReferenceIngest refreshes the suburb reference views once an
// ingest that feeds them (Census, amenities) succeeded, so the profile
// baselines and similar suburbs move with it instead of waiting for the next
// official run. A failed ingest is returned as is, with no refresh.
func afterSuburbReferenceIngest(ctx context.Context, pool *pgxpool.Pool, ingestErr error) error {
	if ingestErr != nil {
		return ingestErr
	}
	if err := refreshSuburbReferenceViews(ctx, pool); err != nil {
		log.Printf("suburb reference view refresh failed: %v", err)
		return err
	}
	return nil
}

// upsertDemographics idempotently writes one row per boundary suburb (PK =
// sal_code). Nullable *int/*float64 fields bind directly (pgx maps nil → NULL),
// including expanded metrics skipped because of missing headers/quality gates.
func upsertDemographics(ctx context.Context, pool *pgxpool.Pool, rows []CensusRow) (int, error) {
	const q = `
		INSERT INTO suburb_demographics
			(sal_code, sal_name, state_code, population, median_age,
			 median_weekly_hhd_income, median_weekly_per_income, median_weekly_rent,
			 median_monthly_mortgage, census_year, source, source_licence,
			 pct_born_overseas, pct_english_only, top_religion, pct_top_religion,
			 pct_no_religion, top_language, pct_top_language,
			 pct_owned_outright, pct_owned_mortgage, pct_rented, dwelling_count,
			 pct_low_personal_income, pct_high_personal_income, unemployment_rate,
			 labour_force_participation_rate, pct_bachelor_or_higher,
			 pct_separate_house, pct_flat_apartment, pct_couple_with_children,
			 pct_lone_person_household)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
		        $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
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
			pct_owned_outright       = EXCLUDED.pct_owned_outright,
			pct_owned_mortgage       = EXCLUDED.pct_owned_mortgage,
			pct_rented               = EXCLUDED.pct_rented,
			dwelling_count           = EXCLUDED.dwelling_count,
			pct_low_personal_income  = EXCLUDED.pct_low_personal_income,
			pct_high_personal_income = EXCLUDED.pct_high_personal_income,
			unemployment_rate        = EXCLUDED.unemployment_rate,
			labour_force_participation_rate = EXCLUDED.labour_force_participation_rate,
			pct_bachelor_or_higher   = EXCLUDED.pct_bachelor_or_higher,
			pct_separate_house       = EXCLUDED.pct_separate_house,
			pct_flat_apartment       = EXCLUDED.pct_flat_apartment,
			pct_couple_with_children = EXCLUDED.pct_couple_with_children,
			pct_lone_person_household = EXCLUDED.pct_lone_person_household,
			fetched_at               = now()`
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(q, r.SALCode, r.SALName, r.StateCode, r.Population, r.MedianAge,
			r.MedianWeeklyHhdIncome, r.MedianWeeklyPerIncome, r.MedianWeeklyRent,
			r.MedianMonthlyMortgage, censusYear, censusSource, censusLicence,
			r.PctBornOverseas, r.PctEnglishOnly, r.TopReligion, r.PctTopReligion,
			r.PctNoReligion, r.TopLanguage, r.PctTopLanguage,
			r.PctOwnedOutright, r.PctOwnedMortgage, r.PctRented, r.DwellingCount,
			r.PctLowPersonalIncome, r.PctHighPersonalIncome, r.UnemploymentRate,
			r.LabourForceParticipationRate, r.PctBachelorOrHigher,
			r.PctSeparateHouse, r.PctFlatApartment, r.PctCoupleWithChildren,
			r.PctLonePersonHousehold)
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

// applyFAGs writes the resolved FAG history: every council-year to
// lga_series, and each council's newest year onto lga.fed_fag_aud/year — in one
// transaction, so the scalar never disagrees with the series it came from.
func applyFAGs(ctx context.Context, pool *pgxpool.Pool, res fagResolution) (int, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	n, err := upsertLGASeriesTx(ctx, tx, res.Series)
	if err != nil {
		return n, err
	}
	codes := make([]string, 0, len(res.Latest))
	for code := range res.Latest {
		codes = append(codes, code)
	}
	sort.Strings(codes)
	batch := &pgx.Batch{}
	for _, code := range codes {
		r := res.Latest[code]
		// FAG writes only the grant columns; fin_source/fin_source_licence describe
		// the per-council FINANCIAL columns (avg_rates/op_surplus/asset_renewal) and
		// are owned by the state financials ingest (e.g. vic_lgprf), so leave them.
		batch.Queue(`UPDATE lga SET fed_fag_aud=$2, fed_fag_year=$3, fetched_at=now() WHERE lga_code24=$1`,
			code, r.Value, r.PeriodLabel)
	}
	br := tx.SendBatch(ctx, batch)
	for range codes {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return n, err
		}
	}
	if err := br.Close(); err != nil {
		return n, err
	}
	return n, tx.Commit(ctx)
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

// upsertElevation updates the Census/boundary-owned suburb spine. Nil pointers
// bind to SQL NULL, while a computed 0 m or 0% remains a genuine stored zero.
// Missing SALs are never inserted because the artifact has no identity fields.
func upsertElevation(ctx context.Context, pool *pgxpool.Pool, rows []ElevationRow) (int, error) {
	const q = `
		UPDATE suburb_demographics SET
			elevation_min_m = $2,
			elevation_median_m = $3,
			elevation_max_m = $4,
			land_share_below_1m = $5,
			land_share_below_2m = $6,
			land_share_below_5m = $7,
			fetched_at = now()
		WHERE sal_code = $1`
	batch := &pgx.Batch{}
	for _, row := range rows {
		batch.Queue(q, row.SALCode, row.ElevationMinM, row.ElevationMedianM, row.ElevationMaxM,
			row.LandShareBelow1M, row.LandShareBelow2M, row.LandShareBelow5M)
	}
	results := pool.SendBatch(ctx, batch)
	defer func() { _ = results.Close() }()
	updated := 0
	for range rows {
		tag, err := results.Exec()
		if err != nil {
			return updated, err
		}
		updated += int(tag.RowsAffected())
	}
	return updated, nil
}

// upsertHazards writes the offline hazard-exposure artifact (one row per SAL).
// Idempotent: a re-run replaces every share and source name. Rows whose SAL
// has no suburb_demographics parent are skipped by the FK, not failed — the
// artifact is keyed by the committed boundaries, which can lead the DB.
func upsertHazards(ctx context.Context, pool *pgxpool.Pool, rows []HazardRow) (int, error) {
	const q = `
		INSERT INTO suburb_hazard_exposure
			(sal_code, water_observed_share_pct, permanent_water_share_pct, water_sampled_cells, water_source,
			 flood_planning_share_pct, flood_source, bushfire_prone_share_pct, bushfire_source,
			 source_licence, computed_at)
		SELECT $1, $2, $3, $4, NULLIF($5, ''), $6, NULLIF($7, ''), $8, NULLIF($9, ''), $10, now()
		WHERE EXISTS (SELECT 1 FROM suburb_demographics WHERE sal_code = $1)
		ON CONFLICT (sal_code) DO UPDATE SET
			water_observed_share_pct  = EXCLUDED.water_observed_share_pct,
			permanent_water_share_pct = EXCLUDED.permanent_water_share_pct,
			water_sampled_cells       = EXCLUDED.water_sampled_cells,
			water_source              = EXCLUDED.water_source,
			flood_planning_share_pct  = EXCLUDED.flood_planning_share_pct,
			flood_source              = EXCLUDED.flood_source,
			bushfire_prone_share_pct  = EXCLUDED.bushfire_prone_share_pct,
			bushfire_source           = EXCLUDED.bushfire_source,
			source_licence            = EXCLUDED.source_licence,
			computed_at               = now()`
	batch := &pgx.Batch{}
	for _, row := range rows {
		batch.Queue(q, row.SALCode, row.WaterObservedSharePct, row.PermanentWaterSharePct,
			row.SampledCellCount, row.WaterSource(),
			row.FloodPlanningSharePct, row.FloodSource(),
			row.BushfireProneSharePct, row.BushfireSource(), row.Licence())
	}
	results := pool.SendBatch(ctx, batch)
	defer func() { _ = results.Close() }()
	updated := 0
	for range rows {
		tag, err := results.Exec()
		if err != nil {
			return updated, err
		}
		updated += int(tag.RowsAffected())
	}
	return updated, nil
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
		end := min(start+chunkSize, len(rows))
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

// upsertRegions writes the distinct regions referenced by obs. The store is
// housingcrawl.UpsertRegions; this converts the collector's Observations.
func upsertRegions(ctx context.Context, pool *pgxpool.Pool, obs []Observation) error {
	regions := make([]housingcrawl.Region, 0, len(obs))
	for _, o := range obs {
		regions = append(regions, housingcrawl.Region{
			RegionCode: o.RegionCode,
			RegionType: o.RegionType,
			RegionName: o.RegionName,
			StateCode:  o.StateCode,
			Postcode:   o.Postcode,
		})
	}
	return housingcrawl.UpsertRegions(ctx, pool, regions)
}

// refreshHousingMV refreshes the housing materialized views. See
// housingcrawl.RefreshHousingMV.
func refreshHousingMV(ctx context.Context, pool *pgxpool.Pool) error {
	return housingcrawl.RefreshHousingMV(ctx, pool)
}

// linkSuburbSalCodes backfills house_price_regions.sal_code for suburb regions.
// See housingcrawl.LinkSuburbSalCodes.
func linkSuburbSalCodes(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	return housingcrawl.LinkSuburbSalCodes(ctx, pool)
}
