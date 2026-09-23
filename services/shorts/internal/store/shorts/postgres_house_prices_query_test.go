package shorts

import (
	"database/sql"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func postgresHousePricesSource(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("postgres_house_prices.go")
	if err != nil {
		t.Fatalf("read postgres_house_prices.go: %v", err)
	}
	return string(b)
}

func TestListStateSuburbsQuery_CrimeRanksAreLeftJoinedAndReliabilityGated(t *testing.T) {
	for _, want := range []string{
		"LEFT JOIN (",
		"MAX(pct_rank) FILTER (WHERE crime_type = 'break_ins')",
		"MAX(pct_rank) FILTER (WHERE crime_type = 'violent')",
		"MAX(pct_rank) FILTER (WHERE crime_type = 'motor_vehicle')",
		"FROM mv_suburb_crime_latest",
		"WHERE NOT small_pop AND NOT unreliable",
		"cr ON cr.sal_code = d.sal_code",
	} {
		if !strings.Contains(listStateSuburbsCrimeJoin, want) {
			t.Errorf("listStateSuburbsCrimeJoin missing %q", want)
		}
	}
}

func TestSuburbCrimeQuery_ReassertsReliabilityGateWithoutGatingZeroRates(t *testing.T) {
	if !strings.Contains(suburbCrimeQuery, "WHERE sal_code = $1 AND NOT small_pop AND NOT unreliable") {
		t.Fatal("suburbCrimeQuery must re-assert the small_pop/unreliable gate")
	}
	if strings.Contains(strings.ToLower(suburbCrimeQuery), "rate_per_100k >") {
		t.Fatal("suburbCrimeQuery must not use rate_per_100k as an availability gate")
	}
}

func TestDisplayCrimeRank_SeparatesCoveredLowRanksFromNoData(t *testing.T) {
	tests := []struct {
		name string
		rank sql.NullFloat64
		want float64
	}{
		{name: "no data", rank: sql.NullFloat64{}, want: 0},
		{name: "covered below display precision", rank: sql.NullFloat64{Float64: 0.04, Valid: true}, want: 0.1},
		{name: "covered rank rounded to one decimal", rank: sql.NullFloat64{Float64: 87.44, Valid: true}, want: 87.4},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := displayCrimeRank(tt.rank); got != tt.want {
				t.Fatalf("displayCrimeRank(%+v) = %v, want %v", tt.rank, got, tt.want)
			}
		})
	}
}

func TestGetSuburbProfileQuery_MapsPoliticianPropertyCount(t *testing.T) {
	source := postgresHousePricesSource(t)
	for _, want := range []string{
		"COALESCE(rp.declared_property_count, 0)",
		"LEFT JOIN mv_register_suburb_property rp ON rp.sal_code = d.sal_code",
		"&p.Summary.PoliticianPropertyCount",
	} {
		if !strings.Contains(source, want) {
			t.Errorf("GetSuburbProfile query/scan missing %q", want)
		}
	}
}

func TestMapSuburbSeifa_NullsProduceAbsentMessage(t *testing.T) {
	if got := mapSuburbSeifa(nullableSuburbSeifa{}); got != nil {
		t.Fatalf("all-NULL SEIFA columns must map to an absent message, got %+v", got)
	}
}

func TestMapSuburbSeifa_PopulatedColumnsMapExactly(t *testing.T) {
	valid := func(v int32) sql.NullInt32 { return sql.NullInt32{Int32: v, Valid: true} }
	raw := nullableSuburbSeifa{
		IRSD:  nullableSuburbSeifaIndex{Score: valid(900), DecileAus: valid(2), DecileState: valid(3)},
		IRSAD: nullableSuburbSeifaIndex{Score: valid(1100), DecileAus: valid(8), DecileState: valid(7)},
		IER:   nullableSuburbSeifaIndex{Score: valid(1010), DecileAus: valid(6), DecileState: valid(5)},
		IEO:   nullableSuburbSeifaIndex{Score: valid(980), DecileAus: valid(4), DecileState: valid(5)},
	}
	want := &SuburbSeifaRow{
		IRSD:  SuburbSeifaIndexRow{Score: 900, DecileAus: 2, DecileState: 3},
		IRSAD: SuburbSeifaIndexRow{Score: 1100, DecileAus: 8, DecileState: 7},
		IER:   SuburbSeifaIndexRow{Score: 1010, DecileAus: 6, DecileState: 5},
		IEO:   SuburbSeifaIndexRow{Score: 980, DecileAus: 4, DecileState: 5},
	}

	if got := mapSuburbSeifa(raw); !reflect.DeepEqual(got, want) {
		t.Fatalf("mapSuburbSeifa() = %+v, want %+v", got, want)
	}
}

func TestGetSuburbProfileQuery_ReadsNullableSeifaColumns(t *testing.T) {
	source := postgresHousePricesSource(t)
	for _, index := range []string{"irsd", "irsad", "ier", "ieo"} {
		for _, suffix := range []string{"score", "decile_aus", "decile_state"} {
			column := "d.seifa_" + index + "_" + suffix
			if !strings.Contains(source, column) {
				t.Errorf("GetSuburbProfile query missing nullable column %q", column)
			}
		}
	}
	if !strings.Contains(source, "p.Summary.Seifa = mapSuburbSeifa(rawSeifa)") {
		t.Fatal("GetSuburbProfile must map the scanned nullable columns after a successful scan")
	}
}

func TestMapSuburbElevation_NullsProduceAbsentMessage(t *testing.T) {
	if got := mapSuburbElevation(nullableSuburbElevation{}); got != nil {
		t.Fatalf("all-NULL elevation columns must map to an absent message, got %+v", got)
	}
}

func TestMapSuburbElevation_PreservesGenuineZeroShares(t *testing.T) {
	zero := sql.NullFloat64{Float64: 0, Valid: true}
	raw := nullableSuburbElevation{LandShareBelow1M: zero}

	got := mapSuburbElevation(raw)
	if got == nil || got.LandShareBelow1M == nil || *got.LandShareBelow1M != 0 {
		t.Fatalf("valid zero share must remain present and zero, got %+v", got)
	}
	if got.LandShareBelow2M != nil {
		t.Fatalf("NULL share must remain absent, got %+v", got.LandShareBelow2M)
	}
}

func TestGetSuburbProfileQuery_ReadsNullableElevationColumns(t *testing.T) {
	source := postgresHousePricesSource(t)
	for _, column := range []string{
		"d.elevation_min_m", "d.elevation_median_m", "d.elevation_max_m",
		"d.land_share_below_1m", "d.land_share_below_2m", "d.land_share_below_5m",
	} {
		if !strings.Contains(source, column) {
			t.Errorf("GetSuburbProfile query missing nullable column %q", column)
		}
	}
	if !strings.Contains(source, "p.Elevation = mapSuburbElevation(rawElevation)") {
		t.Fatal("GetSuburbProfile must map scanned nullable elevation after a successful scan")
	}
}

func TestListSuburbDropListingsQuery_DeduplicatesPhysicalAddresses(t *testing.T) {
	source := postgresHousePricesSource(t)
	for _, want := range []string{
		"SELECT DISTINCT ON (pl.address_key)",
		"NULLIF(pl.address_key, '') IS NOT NULL",
		"ORDER BY pl.address_key, e.drop_abs DESC, e.observed_at DESC",
	} {
		if !strings.Contains(source, want) {
			t.Errorf("ListSuburbDropListings physical-address dedup missing %q", want)
		}
	}
	if strings.Contains(source, "SELECT DISTINCT ON (e.listing_pk)") {
		t.Error("ListSuburbDropListings must not dedup by portal listing_pk")
	}
}

func TestListAgencyPriceStatsQuery_DoesNotReadRemovedAgentNamesColumn(t *testing.T) {
	source := postgresHousePricesSource(t)
	if !strings.Contains(source, "'{}'::text[] AS agent_names") {
		t.Fatal("agency query must return an empty compatibility array without reading agent_names from the MV")
	}
}

func TestSuburbReaders_PreferOnePublicPricedRegionPerSAL(t *testing.T) {
	querySource := postgresHousePricesSource(t)

	if strings.Contains(querySource, "LEFT JOIN house_price_regions r ON r.sal_code = d.sal_code AND r.region_type = 'suburb'") {
		t.Fatal("suburb readers must not fan demographics out across every region sharing a SAL")
	}
	for _, want := range []string{
		"const preferredSuburbRegionJoin",
		"ORDER BY (hp.value IS NOT NULL) DESC",
		"hp.period DESC NULLS LAST",
		"sr.region_code",
		"LIMIT 1",
	} {
		if !strings.Contains(querySource, want) {
			t.Errorf("preferred suburb-region join missing %q", want)
		}
	}
	if got := strings.Count(querySource, "` + preferredSuburbRegionJoin + `"); got != 2 {
		t.Errorf("preferred suburb-region join must be shared by list and profile queries; got %d uses", got)
	}
}

// GetHousingRegions serves every region_type from one query, and the ABS
// gccsa/rest_of_state rows carry BOTH 'established_house' and 'attached' for
// the same region and quarter while suburb rows carry only 'house'. Without an
// explicit dwelling-type filter the latest-median LATERAL broke that tie
// arbitrarily and returned the ATTACHED (unit) median, so every capital city
// published a headline understated by up to 43% (Greater Sydney read $848k
// against an established-house median of $1.485m at 2026-Q1).
func TestHousingRegionsQuery_PicksHousesNotUnits(t *testing.T) {
	source := postgresHousePricesSource(t)

	marker := "SELECT value, period FROM house_prices hp"
	idx := strings.Index(source, marker)
	if idx < 0 {
		t.Fatal("GetHousingRegions latest-median LATERAL not found")
	}
	lateral := source[idx:]
	if end := strings.Index(lateral, ") lp ON true"); end >= 0 {
		lateral = lateral[:end]
	}

	if !strings.Contains(lateral, "hp.dwelling_type IN ('house', 'established_house')") {
		t.Error("latest-median LATERAL must restrict to house dwelling types; " +
			"without it the attached/unit median wins the period tie")
	}
	if !strings.Contains(lateral, "ORDER BY hp.period DESC, hp.dwelling_type") {
		t.Error("latest-median LATERAL needs a deterministic tiebreak after period")
	}
	if strings.Contains(lateral, "'attached'") {
		t.Error("latest-median LATERAL must not select attached-dwelling medians")
	}
}

// TestAddressPriceDropsQuery_ComparesOnlyTheSameAdvertChain pins the rules that
// stop the address board fabricating cuts. Measured 2026-09-23, the old query
// (earliest ask at the address from ANY listing, bedrooms only) listed 247 of
// 1,374 addresses with no price_drop event behind them — e.g. a fixed ask
// against the low end of a later range guide shown as -24%.
func TestAddressPriceDropsQuery_ComparesOnlyTheSameAdvertChain(t *testing.T) {
	q := addressPriceDropsQuery
	for _, want := range []string{
		// Comparable kinds, mirroring the collector's comparableKinds.
		"(e.price_kind IN ('fixed', 'offers_over') AND c.price_kind IN ('fixed', 'offers_over'))",
		"(e.price_kind = c.price_kind AND c.price_kind IN ('range_low', 'range_high'))",
		// Never the other portal's concurrent advert.
		"epl.last_seen_at < c.first_seen_at - interval '14 days'",
		// Same dwelling at a collapsed address.
		"(c.bedrooms = 0 OR COALESCE(epl.bedrooms, 0) = c.bedrooms)",
		// A listing-level move keeps its own earlier ask; an address-relist
		// move's prev_price is another advert's and is not trusted.
		"e.observed_at > epl.first_seen_at AS listing_level",
		"WHERE event_type IN ('price_drop', 'price_rise') AND listing_level",
		// Only addresses the collector actually saw cut, under the MVs' cap.
		"event_type = 'price_drop' AND drop_pct <= 0.40 AS is_cut",
		"WHERE f.has_drop",
		// The MVs' liveness, not the old 21 days.
		"pl.last_seen_at >= now() - interval '14 days'",
		// A same-portal earlier advert joins only once it has ended (a
		// relist), never while it is live alongside this one.
		"(epl.source = c.latest_source AND epl.last_seen_at < c.first_seen_at)",
		// Every live advert is judged on its own chain and the address keeps
		// the deepest qualifying cut — chosen on prices, not on which portal
		// the crawl swept last.
		"GROUP BY advert",
		"SELECT DISTINCT ON (c.address_key)",
		"ORDER BY c.address_key, drop_pct DESC, drop_abs DESC, c.latest_source ASC, c.listing_pk DESC",
		// A stale advert superseded by a later same-portal relist is not live.
		"AND nx.first_seen_at > pl.last_seen_at",
	} {
		if !strings.Contains(q, want) {
			t.Errorf("addressPriceDropsQuery missing %q", want)
		}
	}
	// Picking ONE "current" advert per address by last_seen_at is what hid
	// real cuts depending on sweep order (reviewer, 2026-09-24: 79 addresses).
	if strings.Contains(q, "DISTINCT ON (pl.address_key)") {
		t.Error("addressPriceDropsQuery must not pick one advert per address before judging chains")
	}
	if strings.Contains(q, "OR epl.source = c.latest_source\n") {
		t.Error("a same-portal advert must not join the chain while it is still live")
	}
	if strings.Contains(q, "21 days") {
		t.Error("addressPriceDropsQuery must use the 14-day liveness every listing MV uses")
	}
}

// TestDropsQueries_OrderByEndsOnAUniqueKey: every ranking the drops surfaces
// serve ends on the row's unique key, so ties at a board's cut-off can no
// longer reorder between instances and cache fills (a 5-way tie sat at rank
// 16-25 on 2026-09-23).
func TestDropsQueries_OrderByEndsOnAUniqueKey(t *testing.T) {
	for sort, clause := range addressPriceDropsSorts {
		if !strings.HasSuffix(clause, ", address_key ASC") {
			t.Errorf("address sort %q = %q must end on address_key", sort, clause)
		}
	}
	for sort, clause := range suburbPriceDropsSorts {
		if !strings.HasSuffix(clause, ", st.region_code ASC") {
			t.Errorf("suburb sort %q = %q must end on st.region_code", sort, clause)
		}
	}
	for _, sort := range []string{"count", "avg", "max", "share", "asking", "sold"} {
		if _, ok := suburbPriceDropsSorts[sort]; !ok {
			t.Errorf("suburb sort %q missing", sort)
		}
	}
	source := postgresHousePricesSource(t)
	for _, want := range []string{
		`const tiebreak = ", source ASC, agency_id ASC, state_code ASC"`,
		"ORDER BY t.drop_pct DESC, t.observed_at DESC, t.address_key ASC",
		"ORDER BY (state_code = 'AU') DESC, dropped_count DESC, state_code ASC",
	} {
		if !strings.Contains(source, want) {
			t.Errorf("drops ORDER BY missing %q", want)
		}
	}
}

// TestSuburbShareSort_FloorsThinSuburbs: 'share' ranks only suburbs with enough
// recently-swept listings for a ratio to mean anything; 1 cut of 3 would
// otherwise top the board at 33%.
func TestSuburbShareSort_FloorsThinSuburbs(t *testing.T) {
	want := "CASE WHEN COALESCE(d.total_active_listings, 0) >= 20 THEN d.dropped_share END DESC NULLS LAST"
	if !strings.HasPrefix(suburbPriceDropsSorts["share"], want) {
		t.Fatalf("share sort = %q, want prefix %q", suburbPriceDropsSorts["share"], want)
	}
}

// TestListSuburbDropListings_UsesTheMVsLiveness: the drill-down and the
// aggregate board it opens from agree on who is on the market. At 21 days vs
// the MVs' window, 59 of 209 board suburbs opened an empty drill-down.
func TestListSuburbDropListings_UsesTheMVsLiveness(t *testing.T) {
	source := postgresHousePricesSource(t)
	start := strings.Index(source, "func (s *postgresStore) ListSuburbDropListings(")
	end := strings.Index(source[start:], "\n}\n")
	body := source[start : start+end]
	if !strings.Contains(body, "pl.last_seen_at >= now() - interval '14 days'") {
		t.Fatal("ListSuburbDropListings must gate liveness at 14 days")
	}
	if strings.Contains(body, "21 days") {
		t.Fatal("ListSuburbDropListings still carries the old 21-day liveness")
	}
}

// TestGetPriceDropsOverview_ReadsCoverageTolerantly: the coverage columns come
// from 000124, read through to_jsonb so the query also survives the older MV.
func TestGetPriceDropsOverview_ReadsCoverageTolerantly(t *testing.T) {
	source := postgresHousePricesSource(t)
	for _, want := range []string{
		"COALESCE((to_jsonb(m) ->> 'suburbs_swept_14d')::int, 0)",
		"COALESCE((to_jsonb(m) ->> 'catalog_suburbs')::int, 0)",
		"FROM mv_state_price_drops m",
	} {
		if !strings.Contains(source, want) {
			t.Errorf("GetPriceDropsOverview missing %q", want)
		}
	}
}

// TestHousingMVRefreshQuery_ReadsTheBookkeepingTable and the missing-table
// tolerance: a database before 000124 must read as "no refresh recorded".
func TestHousingMVRefreshQuery_ReadsTheBookkeepingTable(t *testing.T) {
	if !strings.Contains(housingMVRefreshQuery, "FROM housing_mv_refresh") ||
		!strings.Contains(housingMVRefreshQuery, "WHERE mv_name = ANY($1)") {
		t.Fatalf("unexpected housingMVRefreshQuery: %s", housingMVRefreshQuery)
	}
	if !isUndefinedTable(&pgconn.PgError{Code: "42P01"}) {
		t.Fatal("42P01 must be recognised as undefined_table")
	}
	if isUndefinedTable(&pgconn.PgError{Code: "42703"}) || isUndefinedTable(errors.New("x")) {
		t.Fatal("only 42P01 is undefined_table")
	}
}

// TestGetDropIndexSeriesQuery_WithheldMedianReadsAsZero: median_drop_pct is
// nullable since 000124 (withheld below 3 dropped addresses); a NULL must scan
// as the documented 0, and computed_at is read for as_of.
func TestGetDropIndexSeriesQuery_WithheldMedianReadsAsZero(t *testing.T) {
	source := postgresHousePricesSource(t)
	for _, want := range []string{"COALESCE(median_drop_pct, 0)", "computed_at\n\t\tFROM housing_drop_index_daily"} {
		if !strings.Contains(source, want) {
			t.Errorf("GetDropIndexSeries query missing %q", want)
		}
	}
}
