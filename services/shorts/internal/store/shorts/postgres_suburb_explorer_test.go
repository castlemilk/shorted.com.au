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
		pct_no_religion          DOUBLE PRECISION
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

	// CROWNLAND is priced ONLY by a proprietary row: it must still list (LEFT
	// join on demographics) but with a gated-out, zeroed price.
	require.Contains(t, byCode, salCrownland, "CROWNLAND should still be listed")
	assert.Equal(t, 0.0, byCode[salCrownland].LatestMedianPrice,
		"proprietary-only suburb must report 0, not the ToS-restricted value")
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

	// State baseline = avg latest public median across priced VIC suburbs
	// (RICHMOND 1,250,000; CROWNLAND excluded — proprietary only).
	assert.InDelta(t, 1250000.0, p.StateMedianPrice, 0.5, "state baseline must exclude proprietary")
	// National baseline = avg over all priced suburbs (RICHMOND + NORWOOD).
	assert.InDelta(t, 1100000.0, p.NationalMedianPrice, 0.5, "national baseline must exclude proprietary")

	for _, pv := range proprietaryValues {
		assert.NotEqual(t, pv, p.Summary.LatestMedianPrice, "proprietary median leaked into profile headline")
		assert.NotEqual(t, pv, p.StateMedianPrice, "proprietary median leaked into state baseline")
		assert.NotEqual(t, pv, p.NationalMedianPrice, "proprietary median leaked into national baseline")
	}
}
