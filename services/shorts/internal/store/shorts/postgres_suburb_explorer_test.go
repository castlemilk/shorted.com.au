//go:build integration

package shorts

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// SAL codes linking the seeded house_price_regions (RICHMOND/NORWOOD/CROWNLAND)
// to their suburb_demographics rows so the suburb-explorer readers can join.
const (
	salRichmond  = "20604" // VIC, public + proprietary priced
	salNorwood   = "40001" // SA,  public + proprietary priced
	salCrownland = "29999" // VIC, proprietary-ONLY priced
	salAscotVale = "20075" // VIC, duplicate crawl + Valuer-General region keys
)

// setupSuburbExplorerSchema extends the base housing schema (from
// postgres_house_prices_test.go) with the SAL-spined suburb-explorer tables that
// ListStateSuburbs / GetSuburbProfile read, and links the seeded priced regions
// to demographics rows by sal_code. Amenity/connectivity/LGA tables are created
// empty on purpose (the readers LEFT JOIN them and COALESCE the NULLs), so the
// only variable under test is which house_prices rows the licence gate admits.
func setupSuburbExplorerSchema(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	const schema = `
	ALTER TABLE house_price_regions ADD COLUMN IF NOT EXISTS sal_code TEXT;

	CREATE TABLE IF NOT EXISTS suburb_demographics (
		sal_code                 TEXT PRIMARY KEY,
		sal_name                 TEXT NOT NULL,
		state_code               TEXT NOT NULL,
		postcode                 TEXT,
		population               INT,
		median_age               DOUBLE PRECISION,
		median_weekly_hhd_income DOUBLE PRECISION,
		pct_born_overseas        DOUBLE PRECISION,
		top_religion             TEXT,
		top_language             TEXT,
		pct_top_language         DOUBLE PRECISION,
		federal_division         TEXT,
		federal_member           TEXT,
		federal_party            TEXT,
		federal_party_ab         TEXT,
		federal_tpp_alp          DOUBLE PRECISION,
		state_district           TEXT,
		state_member             TEXT,
		state_party              TEXT,
		state_party_ab           TEXT,
		median_weekly_per_income DOUBLE PRECISION,
		median_weekly_rent       DOUBLE PRECISION,
		median_monthly_mortgage  DOUBLE PRECISION,
		pct_owned_outright       DOUBLE PRECISION,
		pct_owned_mortgage       DOUBLE PRECISION,
		pct_rented               DOUBLE PRECISION,
		dwelling_count           INT,
		census_year              INT,
		pct_english_only         DOUBLE PRECISION,
		pct_top_religion         DOUBLE PRECISION,
		pct_no_religion          DOUBLE PRECISION,
		seifa_irsd_score         INTEGER,
		seifa_irsd_decile_aus    SMALLINT,
		seifa_irsd_decile_state  SMALLINT,
		seifa_irsad_score        INTEGER,
		seifa_irsad_decile_aus   SMALLINT,
		seifa_irsad_decile_state SMALLINT,
		seifa_ier_score          INTEGER,
		seifa_ier_decile_aus     SMALLINT,
		seifa_ier_decile_state   SMALLINT,
		seifa_ieo_score          INTEGER,
		seifa_ieo_decile_aus     SMALLINT,
		seifa_ieo_decile_state   SMALLINT,
		elevation_min_m          DOUBLE PRECISION,
		elevation_median_m       DOUBLE PRECISION,
		elevation_max_m          DOUBLE PRECISION,
		land_share_below_1m      DOUBLE PRECISION,
		land_share_below_2m      DOUBLE PRECISION,
		land_share_below_5m      DOUBLE PRECISION,
		pct_low_personal_income         DOUBLE PRECISION,
		pct_high_personal_income        DOUBLE PRECISION,
		unemployment_rate               DOUBLE PRECISION,
		labour_force_participation_rate DOUBLE PRECISION,
		pct_bachelor_or_higher          DOUBLE PRECISION,
		pct_separate_house              DOUBLE PRECISION,
		pct_flat_apartment              DOUBLE PRECISION,
		pct_couple_with_children        DOUBLE PRECISION,
		pct_lone_person_household       DOUBLE PRECISION,
		banner_archetype         TEXT,
		banner_blurb             TEXT,
		banner_landmarks         JSONB,
		banner_bg_key            TEXT,
		banner_bg_url            TEXT,
		banner_generated_at      TIMESTAMPTZ
	);

	CREATE TABLE IF NOT EXISTS suburb_amenities (
		sal_code               TEXT PRIMARY KEY,
		schools_total          INT,
		supermarkets_total     INT,
		coles_count            INT,
		woolworths_count       INT,
		aldi_count             INT,
		iga_count              INT,
		pubs_bars              INT,
		parks_count            INT,
		libraries_count        INT,
		nearest_supermarket_km DOUBLE PRECISION,
		amenity_density_score  DOUBLE PRECISION,
		hospitals_count        INT,
		gp_count               INT,
		pharmacy_count         INT,
		nearest_train_km       DOUBLE PRECISION,
		nearest_hospital_km    DOUBLE PRECISION,
		dist_to_coast_km       DOUBLE PRECISION,
		schools_gov            INT,
		schools_catholic       INT,
		schools_independent    INT,
		schools_primary        INT,
		schools_secondary      INT,
		nearest_secondary_km   DOUBLE PRECISION
	);

	CREATE TABLE IF NOT EXISTS suburb_connectivity (
		sal_code                   TEXT PRIMARY KEY,
		dominant_nbn_tech          TEXT,
		connectivity_quality_score DOUBLE PRECISION
	);

	CREATE TABLE IF NOT EXISTS suburb_lga (
		sal_code   TEXT PRIMARY KEY,
		lga_code24 TEXT
	);

	CREATE TABLE IF NOT EXISTS lga (
		lga_code24          TEXT PRIMARY KEY,
		lga_name            TEXT,
		state_code          TEXT,
		area_sqkm           DOUBLE PRECISION,
		population          INT,
		fed_fag_aud         DOUBLE PRECISION,
		fed_fag_year        TEXT,
		avg_rates           DOUBLE PRECISION,
		op_surplus_ratio    DOUBLE PRECISION,
		asset_renewal_ratio DOUBLE PRECISION,
		fin_source          TEXT,
		fin_year            TEXT
	);

	CREATE MATERIALIZED VIEW mv_register_suburb_property AS
	SELECT '20604'::text AS sal_code,
	       1::int AS declaring_member_count,
	       2::int AS declared_property_count,
	       2::int AS current_property_count,
	       now() AS refreshed_at;

	CREATE MATERIALIZED VIEW mv_suburb_crime_latest AS
	SELECT '20604'::text AS sal_code, crime_type,
	       2025::smallint AS fy_ending, 0::numeric AS rate_per_100k,
	       0.04::numeric AS pct_rank, 26000::int AS population,
	       false AS small_pop, false AS unreliable,
	       'VIC'::text AS source_jurisdiction, 'test'::text AS source,
	       'CC-BY-4.0'::text AS source_licence
	FROM (VALUES ('break_ins'::text), ('violent'::text), ('motor_vehicle'::text)) crime(crime_type);
	`
	_, err := pool.Exec(ctx, schema)
	require.NoError(t, err, "failed to create suburb-explorer schema")

	// Link the priced regions to SAL codes so the readers' sal_code join resolves.
	// One Exec per statement: pgx uses the prepared protocol when args are present,
	// which forbids multiple ';'-separated commands in a single call.
	links := []struct{ region, sal string }{
		{"SUBURB:VIC-RICHMOND", salRichmond},
		{"SUBURB:SA-NORWOOD", salNorwood},
		{"SUBURB:VIC-CROWNLAND", salCrownland},
	}
	for _, l := range links {
		_, err = pool.Exec(ctx, `UPDATE house_price_regions SET sal_code = $1 WHERE region_code = $2`, l.sal, l.region)
		require.NoError(t, err)
	}

	// population > 200 so the similar-suburbs kNN includes these rows.
	const demog = `
	INSERT INTO suburb_demographics
		(sal_code, sal_name, state_code, postcode, population, median_age, median_weekly_hhd_income) VALUES
		($1, 'Richmond',  'VIC', '3121', 26000, 35, 2200),
		($2, 'Norwood',   'SA',  '5067', 7000,  40, 1900),
		($3, 'Crownland', 'VIC', '3999', 1200,  38, 1500)`
	_, err = pool.Exec(ctx, demog, salRichmond, salNorwood, salCrownland)
	require.NoError(t, err)
}

// seedDuplicateSuburbRegion reproduces the production shape where a crawl key
// and a Valuer-General key share one SAL. The crawl key is inserted first so a
// bare LIMIT 1 deterministically exposes the wrong, proprietary-only region.
func seedDuplicateSuburbRegion(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()

	_, err := pool.Exec(ctx, `
		INSERT INTO suburb_demographics
			(sal_code, sal_name, state_code, postcode, population, median_age, median_weekly_hhd_income)
		VALUES ($1, 'Ascot Vale', 'VIC', '3032', 15000, 36, 2100)`, salAscotVale)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `
		INSERT INTO house_price_regions
			(region_code, region_type, region_name, state_code, postcode, sal_code)
		VALUES
			('SUBURB:VIC-3032-ASCOT-VALE', 'suburb', 'ASCOT VALE', 'VIC', '3032', $1),
			('SUBURB:VIC-ASCOT VALE',      'suburb', 'ASCOT VALE', 'VIC', '3032', $1)`, salAscotVale)
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `
		INSERT INTO house_prices
			(region_code, measure, dwelling_type, period, period_freq, value, unit, source, source_licence, content_hash)
		VALUES
			('SUBURB:VIC-3032-ASCOT-VALE', 'median_price', 'house', '2024-06-30', 'Q', 1500000, 'AUD', 'crawl_domain', 'proprietary-tos-restricted', 'ascot-crawl'),
			('SUBURB:VIC-ASCOT VALE',      'median_price', 'house', '2024-06-30', 'Q', 1300000, 'AUD', 'vg_vic',       'CC-BY-4.0',                  'ascot-vg')`)
	require.NoError(t, err)
}

// proprietaryValues are the ToS-restricted medians seeded by loadHousingTestData;
// none may ever surface through a public read path.
var proprietaryValues = []float64{9999999, 8888888, 7777777}

// TestHousingLicenceGate_StateSuburbs asserts ListStateSuburbs reports each
// suburb's PUBLIC latest median (not the proprietary crawl value), and that a
// suburb whose only price is proprietary reports 0 rather than leaking it.
func TestHousingLicenceGate_StateSuburbs(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	setupSuburbExplorerSchema(t, pool)
	s := &postgresStore{db: pool}

	rows, err := s.ListStateSuburbs("VIC", "", 0)
	require.NoError(t, err)
	require.NotEmpty(t, rows)

	byCode := map[string]*SuburbSummaryRow{}
	for _, r := range rows {
		byCode[r.SALCode] = r
		assert.Equal(t, "VIC", r.StateCode, "VIC filter returned a non-VIC suburb: %s", r.SALName)
		for _, pv := range proprietaryValues {
			assert.NotEqual(t, pv, r.LatestMedianPrice,
				"proprietary median leaked into ListStateSuburbs for %s", r.SALName)
		}
	}

	require.Contains(t, byCode, salRichmond, "RICHMOND should be listed for VIC")
	assert.InDelta(t, 1250000.0, byCode[salRichmond].LatestMedianPrice, 0.5,
		"RICHMOND must report its public latest median")
	assert.Equal(t, 0.1, byCode[salRichmond].CrimeBreakInsRank,
		"a covered rank below display precision must remain distinguishable from no data")
	assert.Equal(t, 0.1, byCode[salRichmond].CrimeViolentRank,
		"a covered rank below display precision must remain distinguishable from no data")
	assert.Equal(t, 0.1, byCode[salRichmond].CrimeMotorVehicleRank,
		"a covered rank below display precision must remain distinguishable from no data")

	// CROWNLAND is priced ONLY by a proprietary row: it must still list (LEFT
	// join on demographics) but with a gated-out, zeroed price.
	require.Contains(t, byCode, salCrownland, "CROWNLAND should still be listed")
	assert.Equal(t, 0.0, byCode[salCrownland].LatestMedianPrice,
		"proprietary-only suburb must report 0, not the ToS-restricted value")
	assert.Zero(t, byCode[salCrownland].CrimeBreakInsRank,
		"a suburb without crime data must retain the no-data sentinel")
	assert.Zero(t, byCode[salCrownland].CrimeViolentRank,
		"a suburb without crime data must retain the no-data sentinel")
	assert.Zero(t, byCode[salCrownland].CrimeMotorVehicleRank,
		"a suburb without crime data must retain the no-data sentinel")
}

// TestHousingLicenceGate_SuburbProfile asserts GetSuburbProfile serves the
// public headline median AND computes its state/national baselines from public
// medians only — the LATERAL, YoY and both baseline subqueries are all gated.
func TestHousingLicenceGate_SuburbProfile(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	setupSuburbExplorerSchema(t, pool)
	s := &postgresStore{db: pool}

	p, err := s.GetSuburbProfile(salRichmond)
	require.NoError(t, err)
	require.NotNil(t, p)

	assert.InDelta(t, 1250000.0, p.Summary.LatestMedianPrice, 0.5,
		"headline median must be the public value")
	assert.Equal(t, int32(2), p.Summary.PoliticianPropertyCount,
		"profile summary must carry the register MV's declared-property count")

	// State baseline = median latest public median across priced VIC suburbs
	// (RICHMOND 1,250,000; CROWNLAND excluded — proprietary only).
	assert.InDelta(t, 1250000.0, p.StateMedianPrice, 0.5, "state baseline must exclude proprietary")
	// No national price baseline: none exists openly, and the old one averaged
	// three VG states under an "AU" label.
	assert.Zero(t, p.NationalMedianPrice, "the national price baseline must stay withheld")

	for _, pv := range proprietaryValues {
		assert.NotEqual(t, pv, p.Summary.LatestMedianPrice, "proprietary median leaked into profile headline")
		assert.NotEqual(t, pv, p.StateMedianPrice, "proprietary median leaked into state baseline")
		assert.NotEqual(t, pv, p.NationalMedianPrice, "proprietary median leaked into national baseline")
	}
}

func TestListStateSuburbs_DuplicateSALChoosesPublicPricedRegionOnce(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	setupSuburbExplorerSchema(t, pool)
	seedDuplicateSuburbRegion(t, pool)
	s := &postgresStore{db: pool}

	rows, err := s.ListStateSuburbs("VIC", "Ascot Vale", 50)
	require.NoError(t, err)
	require.Len(t, rows, 1, "one demographic suburb must not fan out per matching region key")
	assert.Equal(t, salAscotVale, rows[0].SALCode)
	assert.Equal(t, "SUBURB:VIC-ASCOT VALE", rows[0].RegionCode)
	assert.InDelta(t, 1300000.0, rows[0].LatestMedianPrice, 0.5)
}

func TestGetSuburbProfile_DuplicateSALChoosesPublicPricedRegion(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	setupSuburbExplorerSchema(t, pool)
	seedDuplicateSuburbRegion(t, pool)
	s := &postgresStore{db: pool}

	profile, err := s.GetSuburbProfile(salAscotVale)
	require.NoError(t, err)
	require.NotNil(t, profile)
	assert.Equal(t, "SUBURB:VIC-ASCOT VALE", profile.Summary.RegionCode)
	assert.InDelta(t, 1300000.0, profile.Summary.LatestMedianPrice, 0.5)
}

// A SAL with both a crawl key and a Valuer-General key must be listed ONCE by
// the similar-suburbs kNN, priced from its public region, and the kNN's LIMIT
// must still bound the result. The bare region join this replaced returned
// Lane Cove North and Pyrmont twice each for Bondi (8 rows for a 6-row ask).
func TestSimilarSuburbs_DuplicateSALListedOnceWithinLimit(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	setupSuburbExplorerSchema(t, pool)
	seedDuplicateSuburbRegion(t, pool)
	s := &postgresStore{db: pool}
	ctx := context.Background()

	// Every other seeded suburb is a candidate: Norwood, Crownland, Ascot Vale.
	all, err := s.similarSuburbs(ctx, salRichmond, 6)
	require.NoError(t, err)
	require.Len(t, all, 3, "one row per candidate suburb, however many region keys it carries")
	seen := map[string]int{}
	for _, r := range all {
		seen[r.SALCode]++
	}
	for sal, n := range seen {
		assert.Equal(t, 1, n, "SAL %s listed %d times", sal, n)
	}

	// Ascot Vale is Richmond's nearest neighbour (age 36 vs 35, income 2,100
	// vs 2,200), so a LIMIT of 1 must return exactly it, priced publicly.
	top, err := s.similarSuburbs(ctx, salRichmond, 1)
	require.NoError(t, err)
	require.Len(t, top, 1, "the kNN LIMIT must bound the priced result")
	assert.Equal(t, salAscotVale, top[0].SALCode)
	assert.Equal(t, "SUBURB:VIC-ASCOT VALE", top[0].RegionCode)
	assert.InDelta(t, 1300000.0, top[0].LatestMedianPrice, 0.5,
		"the public Valuer-General median wins over the proprietary crawl key")
}

func TestGetSuburbProfile_MapsNullableSEIFA(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	setupSuburbExplorerSchema(t, pool)
	s := &postgresStore{db: pool}

	_, err := pool.Exec(context.Background(), `
		UPDATE suburb_demographics SET
			seifa_irsd_score = 900, seifa_irsd_decile_aus = 2, seifa_irsd_decile_state = 3,
			seifa_irsad_score = 1100, seifa_irsad_decile_aus = 8, seifa_irsad_decile_state = 7,
			seifa_ier_score = 1010, seifa_ier_decile_aus = 6, seifa_ier_decile_state = 5,
			seifa_ieo_score = 980, seifa_ieo_decile_aus = 4, seifa_ieo_decile_state = 5
		WHERE sal_code = $1`, salRichmond)
	require.NoError(t, err)

	populated, err := s.GetSuburbProfile(salRichmond)
	require.NoError(t, err)
	require.NotNil(t, populated.Summary.Seifa)
	assert.Equal(t, SuburbSeifaIndexRow{Score: 900, DecileAus: 2, DecileState: 3}, populated.Summary.Seifa.IRSD)
	assert.Equal(t, SuburbSeifaIndexRow{Score: 1100, DecileAus: 8, DecileState: 7}, populated.Summary.Seifa.IRSAD)
	assert.Equal(t, SuburbSeifaIndexRow{Score: 1010, DecileAus: 6, DecileState: 5}, populated.Summary.Seifa.IER)
	assert.Equal(t, SuburbSeifaIndexRow{Score: 980, DecileAus: 4, DecileState: 5}, populated.Summary.Seifa.IEO)

	absent, err := s.GetSuburbProfile(salNorwood)
	require.NoError(t, err)
	assert.Nil(t, absent.Summary.Seifa, "all-NULL source columns must remain distinguishable from decile zero")
}

// The profile's reference prices are ABS established-house medians for the
// suburb's state (capital + rest of state), not an average of suburb medians;
// the state baseline is a MEDIAN, so one development-site outlier cannot move
// it; and the household cards get dwelling/resident-weighted state shares that
// skip suburbs withheld by the ingest floors.
func TestSuburbProfileBaselines_ABSMediansAndStateCensusShares(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	setupSuburbExplorerSchema(t, pool)
	ctx := context.Background()

	_, err := pool.Exec(ctx, `
		INSERT INTO house_price_regions (region_code, region_type, region_name, state_code) VALUES
			('2GMEL', 'gccsa',         'Greater Melbourne', 'VIC'),
			('2RVIC', 'rest_of_state', 'Rest of Vic.',      'VIC'),
			('SUBURB:VIC-OUTLIER', 'suburb', 'OUTLIER', 'VIC'),
			('SUBURB:VIC-MIDDLE',  'suburb', 'MIDDLE',  'VIC')`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO house_prices
			(region_code, measure, dwelling_type, period, period_freq, value, unit, source, source_licence, content_hash) VALUES
			('2GMEL', 'median_price', 'established_house', '2025-12-31', 'Q', 840000, 'AUD', 'abs_res_dwell', 'CC-BY-4.0', 'a1'),
			('2GMEL', 'median_price', 'established_house', '2026-03-31', 'Q', 850000, 'AUD', 'abs_res_dwell', 'CC-BY-4.0', 'a2'),
			('2RVIC', 'median_price', 'established_house', '2026-03-31', 'Q', 625000, 'AUD', 'abs_res_dwell', 'CC-BY-4.0', 'a3'),
			('2GMEL', 'median_price', 'attached',          '2026-03-31', 'Q', 999000, 'AUD', 'abs_res_dwell', 'CC-BY-4.0', 'a4'), -- above the house median on purpose: it must not be read
			('SUBURB:VIC-OUTLIER', 'median_price', 'house', '2024-06-30', 'A', 110500000, 'AUD', 'vg_vic', 'CC-BY-4.0', 'o1'),
			('SUBURB:VIC-MIDDLE',  'median_price', 'house', '2024-06-30', 'A', 1000000,   'AUD', 'vg_vic', 'CC-BY-4.0', 'm1')`)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `REFRESH MATERIALIZED VIEW mv_housing_headline`)
	require.NoError(t, err)

	// Richmond: 1,000 dwellings, 20% rented; Crownland: 3,000 dwellings, 40%
	// rented. The dwelling-weighted VIC share is 35%, not the plain mean 30%.
	// A third VIC suburb below the floor (NULL shares) must not dilute it.
	_, err = pool.Exec(ctx, `
		UPDATE suburb_demographics SET dwelling_count = 1000, pct_rented = 20, unemployment_rate = 3
		WHERE sal_code = $1`, salRichmond)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		UPDATE suburb_demographics SET dwelling_count = 3000, pct_rented = 40, unemployment_rate = 6
		WHERE sal_code = $1`, salCrownland)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `
		INSERT INTO suburb_demographics (sal_code, sal_name, state_code, population, dwelling_count, median_weekly_hhd_income)
		VALUES ('29998', 'Tiny', 'VIC', 40, 900, 900)`)
	require.NoError(t, err)

	s := &postgresStore{db: pool}
	p, err := s.GetSuburbProfile(salRichmond)
	require.NoError(t, err)
	require.NotNil(t, p)

	assert.Equal(t, 850000.0, p.CapitalMedianPrice, "capital reference is the LATEST ABS established-house median")
	assert.Equal(t, "Greater Melbourne", p.CapitalRegionName)
	assert.Equal(t, "2GMEL", p.CapitalRegionCode)
	assert.Equal(t, 625000.0, p.RestOfStateMedianPrice)
	assert.Equal(t, "Rest of Vic.", p.RestOfStateRegionName)
	require.NotNil(t, p.ABSMedianPeriod)
	assert.Equal(t, "2026-03-31", p.ABSMedianPeriod.Format("2006-01-02"))

	// VIC public suburb medians: 1.0M, 1.25M, 110.5M -> median 1.25M (a mean
	// would be ~37.6M).
	assert.InDelta(t, 1250000.0, p.StateMedianPrice, 0.5, "state price baseline must be a median, immune to one outlier")

	assert.InDelta(t, 35.0, p.StateCensus.PctRented, 1e-9, "tenure is dwelling-weighted over suburbs that carry it")
	// Unemployment is resident-weighted: (26000*3 + 1200*6) / 27200.
	assert.InDelta(t, (26000*3.0+1200*6.0)/27200.0, p.StateCensus.UnemploymentRate, 1e-9)
	assert.Zero(t, p.StateCensus.PctBachelorOrHigher, "a share no suburb carries is not computable, not 0%")
	// VIC incomes 2200, 1500, 900 -> median 1500.
	assert.InDelta(t, 1500.0, p.StateMedianHhdIncome, 0.5, "state income reference is the median suburb")

	// A state with no ABS regions seeded gets empty references, not another state's.
	norwood, err := s.GetSuburbProfile(salNorwood)
	require.NoError(t, err)
	assert.Zero(t, norwood.CapitalMedianPrice)
	assert.Empty(t, norwood.CapitalRegionName)
	assert.Nil(t, norwood.ABSMedianPeriod)
}
