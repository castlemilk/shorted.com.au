package shorts

import (
	"database/sql"
	"reflect"
	"strings"
	"testing"
)

func TestMapExpandedCensus_NullsProduceZeroValue(t *testing.T) {
	if got := mapExpandedCensus(nullableExpandedCensus{}); !reflect.DeepEqual(got, SuburbExpandedCensusRow{}) {
		t.Fatalf("all-NULL expanded Census columns must map to zero values, got %+v", got)
	}
}

func TestMapExpandedCensus_PopulatedColumnsMapExactly(t *testing.T) {
	valid := func(value float64) sql.NullFloat64 {
		return sql.NullFloat64{Float64: value, Valid: true}
	}
	raw := nullableExpandedCensus{
		PctLowPersonalIncome:         valid(12.34),
		PctHighPersonalIncome:        valid(23.45),
		UnemploymentRate:             valid(4.56),
		LabourForceParticipationRate: valid(67.89),
		PctBachelorOrHigher:          valid(34.56),
		PctSeparateHouse:             valid(72.34),
		PctFlatApartment:             valid(18.76),
		PctCoupleWithChildren:        valid(45.67),
		PctLonePersonHousehold:       valid(22.22),
	}
	want := SuburbExpandedCensusRow{
		PctLowPersonalIncome:         12.34,
		PctHighPersonalIncome:        23.45,
		UnemploymentRate:             4.56,
		LabourForceParticipationRate: 67.89,
		PctBachelorOrHigher:          34.56,
		PctSeparateHouse:             72.34,
		PctFlatApartment:             18.76,
		PctCoupleWithChildren:        45.67,
		PctLonePersonHousehold:       22.22,
	}
	if got := mapExpandedCensus(raw); !reflect.DeepEqual(got, want) {
		t.Fatalf("mapExpandedCensus() = %+v, want %+v", got, want)
	}
}

func TestGetSuburbProfileQueryReadsNullableExpandedCensusColumns(t *testing.T) {
	source := postgresHousePricesSource(t)
	columns := []string{
		"pct_low_personal_income",
		"pct_high_personal_income",
		"unemployment_rate",
		"labour_force_participation_rate",
		"pct_bachelor_or_higher",
		"pct_separate_house",
		"pct_flat_apartment",
		"pct_couple_with_children",
		"pct_lone_person_household",
	}
	for _, column := range columns {
		if !strings.Contains(source, "d."+column) {
			t.Errorf("GetSuburbProfile query missing nullable column d.%s", column)
		}
	}
	if !strings.Contains(source, "p.ExpandedCensus = mapExpandedCensus(rawExpandedCensus)") {
		t.Fatal("GetSuburbProfile must map nullable expanded Census columns after a successful scan")
	}
}
