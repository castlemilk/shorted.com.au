package shorts

import (
	"os"
	"strings"
	"testing"
)

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

func TestSuburbReaders_PreferOnePublicPricedRegionPerSAL(t *testing.T) {
	source, err := os.ReadFile("postgres_house_prices.go")
	if err != nil {
		t.Fatal(err)
	}
	querySource := string(source)

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
