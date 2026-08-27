package shorts

import (
	"google.golang.org/protobuf/reflect/protoreflect"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// attachSuburbElevation bridges the source-proto/codegen handoff without
// editing generated files. It is a no-op until housing.pb.go is regenerated;
// after codegen, optional scalar presence preserves genuine zero values.
func attachSuburbElevation(response protoreflect.Message, row *shortsstore.SuburbElevationRow) {
	if row == nil {
		return
	}
	field := response.Descriptor().Fields().ByName("elevation")
	if field == nil || field.Kind() != protoreflect.MessageKind {
		return
	}
	elevation := response.Mutable(field).Message()
	values := []struct {
		name  protoreflect.Name
		value *float64
	}{
		{"elevation_min_m", row.ElevationMinM},
		{"elevation_median_m", row.ElevationMedianM},
		{"elevation_max_m", row.ElevationMaxM},
		{"land_share_below_1m", row.LandShareBelow1M},
		{"land_share_below_2m", row.LandShareBelow2M},
		{"land_share_below_5m", row.LandShareBelow5M},
	}
	for _, item := range values {
		if item.value == nil {
			continue
		}
		metric := elevation.Descriptor().Fields().ByName(item.name)
		if metric != nil && metric.Kind() == protoreflect.DoubleKind {
			elevation.Set(metric, protoreflect.ValueOfFloat64(*item.value))
		}
	}
}
