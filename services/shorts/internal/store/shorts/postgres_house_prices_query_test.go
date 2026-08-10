package shorts

import (
	"database/sql"
	"os"
	"strings"
	"testing"
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
