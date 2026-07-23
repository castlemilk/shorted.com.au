package shorts

import (
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
