package shorts

import (
	"testing"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

func TestAttachExpandedCensusMapsEveryPopulatedProfileField(t *testing.T) {
	message := dynamicExpandedCensusMessage(t)
	row := shortsstore.SuburbExpandedCensusRow{
		PctLowPersonalIncome: 12.34, PctHighPersonalIncome: 23.45,
		UnemploymentRate: 4.56, LabourForceParticipationRate: 67.89,
		PctBachelorOrHigher: 34.56, PctSeparateHouse: 72.34,
		PctFlatApartment: 18.76, PctCoupleWithChildren: 45.67,
		PctLonePersonHousehold: 22.22,
	}

	attachExpandedCensus(message, row)
	wants := map[protoreflect.Name]float64{
		"pct_low_personal_income": 12.34, "pct_high_personal_income": 23.45,
		"unemployment_rate": 4.56, "labour_force_participation_rate": 67.89,
		"pct_bachelor_or_higher": 34.56, "pct_separate_house": 72.34,
		"pct_flat_apartment": 18.76, "pct_couple_with_children": 45.67,
		"pct_lone_person_household": 22.22,
	}
	for name, want := range wants {
		field := message.Descriptor().Fields().ByName(name)
		if got := message.Get(field).Float(); got != want {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
}

func dynamicExpandedCensusMessage(t *testing.T) protoreflect.Message {
	t.Helper()
	names := []string{
		"pct_low_personal_income", "pct_high_personal_income", "unemployment_rate",
		"labour_force_participation_rate", "pct_bachelor_or_higher", "pct_separate_house",
		"pct_flat_apartment", "pct_couple_with_children", "pct_lone_person_household",
	}
	fields := make([]*descriptorpb.FieldDescriptorProto, 0, len(names))
	for i, name := range names {
		fields = append(fields, &descriptorpb.FieldDescriptorProto{
			Name: proto.String(name), Number: proto.Int32(int32(i + 1)),
			Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(),
			Type:  descriptorpb.FieldDescriptorProto_TYPE_DOUBLE.Enum(),
		})
	}
	file, err := protodesc.NewFile(&descriptorpb.FileDescriptorProto{
		Name: proto.String("census_expanded_test.proto"), Package: proto.String("censustest"),
		Syntax: proto.String("proto3"),
		MessageType: []*descriptorpb.DescriptorProto{{
			Name: proto.String("SuburbDemographics"), Field: fields,
		}},
	}, nil)
	if err != nil {
		t.Fatalf("build dynamic descriptor: %v", err)
	}
	return dynamicpb.NewMessage(file.Messages().ByName("SuburbDemographics"))
}
