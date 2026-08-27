package shorts

import (
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestAttachSuburbElevationLeavesNullAbsentAndPreservesZero(t *testing.T) {
	desc := testProfileResponseWithElevationDescriptor(t)
	elevationField := desc.Fields().ByName("elevation")

	absent := dynamicpb.NewMessage(desc)
	attachSuburbElevation(absent, nil)
	if absent.Has(elevationField) {
		t.Fatal("nil store data must leave the proto elevation message absent")
	}

	zero := 0.0
	populated := dynamicpb.NewMessage(desc)
	attachSuburbElevation(populated, &shortsstore.SuburbElevationRow{
		LandShareBelow1M: &zero,
	})
	if !populated.Has(elevationField) {
		t.Fatal("present store data must attach the proto elevation message")
	}
	elevation := populated.Get(elevationField).Message()
	below1M := elevation.Descriptor().Fields().ByName("land_share_below_1m")
	below2M := elevation.Descriptor().Fields().ByName("land_share_below_2m")
	if !elevation.Has(below1M) || elevation.Get(below1M).Float() != 0 {
		t.Fatal("genuine zero share must be present and zero")
	}
	if elevation.Has(below2M) {
		t.Fatal("nil share must remain absent")
	}
}

func testProfileResponseWithElevationDescriptor(t *testing.T) protoreflect.MessageDescriptor {
	t.Helper()
	optional := descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL
	doubleType := descriptorpb.FieldDescriptorProto_TYPE_DOUBLE
	messageType := descriptorpb.FieldDescriptorProto_TYPE_MESSAGE
	optionalDouble := func(name string, number, oneofIndex int32) *descriptorpb.FieldDescriptorProto {
		return &descriptorpb.FieldDescriptorProto{
			Name: proto.String(name), Number: proto.Int32(number), Label: &optional,
			Type: &doubleType, Proto3Optional: proto.Bool(true), OneofIndex: &oneofIndex,
		}
	}
	elevation := &descriptorpb.DescriptorProto{
		Name: proto.String("SuburbElevation"),
		Field: []*descriptorpb.FieldDescriptorProto{
			optionalDouble("elevation_min_m", 1, 0),
			optionalDouble("elevation_median_m", 2, 1),
			optionalDouble("elevation_max_m", 3, 2),
			optionalDouble("land_share_below_1m", 4, 3),
			optionalDouble("land_share_below_2m", 5, 4),
			optionalDouble("land_share_below_5m", 6, 5),
		},
		OneofDecl: []*descriptorpb.OneofDescriptorProto{
			{Name: proto.String("_elevation_min_m")},
			{Name: proto.String("_elevation_median_m")},
			{Name: proto.String("_elevation_max_m")},
			{Name: proto.String("_land_share_below_1m")},
			{Name: proto.String("_land_share_below_2m")},
			{Name: proto.String("_land_share_below_5m")},
		},
	}
	response := &descriptorpb.DescriptorProto{
		Name: proto.String("GetSuburbProfileResponse"),
		Field: []*descriptorpb.FieldDescriptorProto{{
			Name: proto.String("elevation"), Number: proto.Int32(9), Label: &optional,
			Type: &messageType, TypeName: proto.String(".elevationtest.SuburbElevation"),
		}},
	}
	file, err := protodesc.NewFile(&descriptorpb.FileDescriptorProto{
		Name: proto.String("elevation_test.proto"), Package: proto.String("elevationtest"), Syntax: proto.String("proto3"),
		MessageType: []*descriptorpb.DescriptorProto{elevation, response},
	}, nil)
	if err != nil {
		t.Fatalf("build test descriptor: %v", err)
	}
	return file.Messages().ByName("GetSuburbProfileResponse")
}
