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

func TestAttachSuburbSeifaMapsAllIndexesAndLeavesNilAbsent(t *testing.T) {
	desc := testSuburbSummaryWithSeifaDescriptor(t)
	seifaField := desc.Fields().ByName("seifa")

	absent := dynamicpb.NewMessage(desc)
	attachSuburbSeifa(absent, nil)
	if absent.Has(seifaField) {
		t.Fatal("nil store data must leave the proto SEIFA message absent")
	}

	populated := dynamicpb.NewMessage(desc)
	attachSuburbSeifa(populated, &shortsstore.SuburbSeifaRow{
		IRSD:  shortsstore.SuburbSeifaIndexRow{Score: 900, DecileAus: 2, DecileState: 3},
		IRSAD: shortsstore.SuburbSeifaIndexRow{Score: 1100, DecileAus: 8, DecileState: 7},
		IER:   shortsstore.SuburbSeifaIndexRow{Score: 1010, DecileAus: 6, DecileState: 5},
		IEO:   shortsstore.SuburbSeifaIndexRow{Score: 980, DecileAus: 4, DecileState: 5},
	})
	if !populated.Has(seifaField) {
		t.Fatal("populated store data must attach the proto SEIFA message")
	}

	want := map[protoreflect.Name][3]int64{
		"irsd":  {900, 2, 3},
		"irsad": {1100, 8, 7},
		"ier":   {1010, 6, 5},
		"ieo":   {980, 4, 5},
	}
	seifa := populated.Get(seifaField).Message()
	for name, values := range want {
		indexField := seifa.Descriptor().Fields().ByName(name)
		index := seifa.Get(indexField).Message()
		got := [3]int64{
			index.Get(index.Descriptor().Fields().ByName("score")).Int(),
			index.Get(index.Descriptor().Fields().ByName("decile_aus")).Int(),
			index.Get(index.Descriptor().Fields().ByName("decile_state")).Int(),
		}
		if got != values {
			t.Errorf("%s = %v, want %v", name, got, values)
		}
	}
}

func testSuburbSummaryWithSeifaDescriptor(t *testing.T) protoreflect.MessageDescriptor {
	t.Helper()
	optional := descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL
	int32Type := descriptorpb.FieldDescriptorProto_TYPE_INT32
	messageType := descriptorpb.FieldDescriptorProto_TYPE_MESSAGE
	field := func(name string, number int32, fieldType descriptorpb.FieldDescriptorProto_Type, typeName string) *descriptorpb.FieldDescriptorProto {
		f := &descriptorpb.FieldDescriptorProto{
			Name: proto.String(name), Number: proto.Int32(number), Label: &optional, Type: &fieldType,
		}
		if typeName != "" {
			f.TypeName = proto.String(typeName)
		}
		return f
	}
	index := &descriptorpb.DescriptorProto{
		Name: proto.String("SuburbSeifaIndex"),
		Field: []*descriptorpb.FieldDescriptorProto{
			field("score", 1, int32Type, ""),
			field("decile_aus", 2, int32Type, ""),
			field("decile_state", 3, int32Type, ""),
		},
	}
	seifa := &descriptorpb.DescriptorProto{
		Name: proto.String("SuburbSeifa"),
		Field: []*descriptorpb.FieldDescriptorProto{
			field("irsd", 1, messageType, ".seifatest.SuburbSeifaIndex"),
			field("irsad", 2, messageType, ".seifatest.SuburbSeifaIndex"),
			field("ier", 3, messageType, ".seifatest.SuburbSeifaIndex"),
			field("ieo", 4, messageType, ".seifatest.SuburbSeifaIndex"),
		},
	}
	summary := &descriptorpb.DescriptorProto{
		Name: proto.String("SuburbSummary"),
		Field: []*descriptorpb.FieldDescriptorProto{
			field("seifa", 32, messageType, ".seifatest.SuburbSeifa"),
		},
	}
	file, err := protodesc.NewFile(&descriptorpb.FileDescriptorProto{
		Name: proto.String("seifa_test.proto"), Package: proto.String("seifatest"), Syntax: proto.String("proto3"),
		MessageType: []*descriptorpb.DescriptorProto{index, seifa, summary},
	}, nil)
	if err != nil {
		t.Fatalf("build test descriptor: %v", err)
	}
	return file.Messages().ByName("SuburbSummary")
}
