package shorts

import (
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// attachExpandedCensus bridges the source-proto/codegen handoff without
// editing generated files. It is a no-op for fields absent from the current
// generated descriptor and starts populating them after buf codegen.
func attachExpandedCensus(message protoreflect.Message, row shortsstore.SuburbExpandedCensusRow) {
	values := []struct {
		name  protoreflect.Name
		value float64
	}{
		{"pct_low_personal_income", row.PctLowPersonalIncome},
		{"pct_high_personal_income", row.PctHighPersonalIncome},
		{"unemployment_rate", row.UnemploymentRate},
		{"labour_force_participation_rate", row.LabourForceParticipationRate},
		{"pct_bachelor_or_higher", row.PctBachelorOrHigher},
		{"pct_separate_house", row.PctSeparateHouse},
		{"pct_flat_apartment", row.PctFlatApartment},
		{"pct_couple_with_children", row.PctCoupleWithChildren},
		{"pct_lone_person_household", row.PctLonePersonHousehold},
	}
	for _, item := range values {
		field := message.Descriptor().Fields().ByName(item.name)
		if field != nil && field.Kind() == protoreflect.DoubleKind {
			message.Set(field, protoreflect.ValueOfFloat64(item.value))
		}
	}
}
