package shorts

import (
	"google.golang.org/protobuf/reflect/protoreflect"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// attachSuburbSeifa bridges the source-proto/codegen handoff without editing
// generated files. Before housing.pb.go is regenerated, the field descriptor is
// absent and this is a no-op. Once codegen runs, the same mapping populates the
// strongly typed SuburbSummary.seifa field through its generated descriptor.
func attachSuburbSeifa(summary protoreflect.Message, row *shortsstore.SuburbSeifaRow) {
	if row == nil {
		return
	}
	seifaField := summary.Descriptor().Fields().ByName("seifa")
	if seifaField == nil || seifaField.Kind() != protoreflect.MessageKind {
		return
	}
	seifa := summary.Mutable(seifaField).Message()
	indexes := []struct {
		name  protoreflect.Name
		value shortsstore.SuburbSeifaIndexRow
	}{
		{"irsd", row.IRSD},
		{"irsad", row.IRSAD},
		{"ier", row.IER},
		{"ieo", row.IEO},
	}
	for _, index := range indexes {
		field := seifa.Descriptor().Fields().ByName(index.name)
		if field == nil || field.Kind() != protoreflect.MessageKind {
			continue
		}
		message := seifa.Mutable(field).Message()
		setSeifaInt32(message, "score", index.value.Score)
		setSeifaInt32(message, "decile_aus", index.value.DecileAus)
		setSeifaInt32(message, "decile_state", index.value.DecileState)
	}
}

func setSeifaInt32(message protoreflect.Message, name protoreflect.Name, value int32) {
	field := message.Descriptor().Fields().ByName(name)
	if field != nil && field.Kind() == protoreflect.Int32Kind {
		message.Set(field, protoreflect.ValueOfInt32(value))
	}
}
