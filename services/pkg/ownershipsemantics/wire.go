package ownershipsemantics

import (
	"encoding/json"
	"fmt"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// ToProto converts a validated observation to the independent interchange
// contract. It neither publishes the observation nor projects legacy voting
// fields. JSON field names deliberately match the domain contract; strict
// decoding makes a future mismatch an error instead of dropping metadata.
func ToProto(in Input) (*shortsv1alpha1.OwnershipSemanticInput, error) {
	if err := Validate(in); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return nil, fmt.Errorf("encode semantic input: %w", err)
	}
	out := new(shortsv1alpha1.OwnershipSemanticInput)
	if err := (protojson.UnmarshalOptions{DiscardUnknown: false}).Unmarshal(raw, out); err != nil {
		return nil, fmt.Errorf("semantic wire mapping: %w", err)
	}
	return out, nil
}

// FromProto validates every observation and rejects unknown binary fields,
// including inside repeated messages. Silent loss would change extraction
// evidence and the immutable payload hash. Cross-revision references are
// additionally checked by Store.Append when the observation is persisted.
func FromProto(in *shortsv1alpha1.OwnershipSemanticInput) (Input, error) {
	if in == nil {
		return Input{}, fmt.Errorf("semantic wire input is nil")
	}
	if err := rejectUnknownWireFields(in.ProtoReflect(), "input"); err != nil {
		return Input{}, err
	}
	raw, err := (protojson.MarshalOptions{UseProtoNames: true}).Marshal(in)
	if err != nil {
		return Input{}, fmt.Errorf("decode semantic wire input: %w", err)
	}
	return DecodeInput(raw)
}

func rejectUnknownWireFields(message protoreflect.Message, path string) error {
	if len(message.GetUnknown()) > 0 {
		return fmt.Errorf("%s: unknown protobuf fields require a compatible contract reader", path)
	}
	var result error
	message.Range(func(field protoreflect.FieldDescriptor, value protoreflect.Value) bool {
		childPath := path + "." + string(field.Name())
		switch {
		case field.IsMap():
			if field.MapValue().Message() != nil {
				value.Map().Range(func(key protoreflect.MapKey, child protoreflect.Value) bool {
					result = rejectUnknownWireFields(child.Message(), fmt.Sprintf("%s[%v]", childPath, key.Interface()))
					return result == nil
				})
			}
		case field.IsList():
			if field.Message() != nil {
				list := value.List()
				for index := 0; index < list.Len(); index++ {
					if result = rejectUnknownWireFields(list.Get(index).Message(), fmt.Sprintf("%s[%d]", childPath, index)); result != nil {
						break
					}
				}
			}
		case field.Message() != nil:
			result = rejectUnknownWireFields(value.Message(), childPath)
		}
		return result == nil
	})
	return result
}
