package shorts

import (
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// suburbHazardsProto maps the store row onto the proto block. Optional scalars
// keep presence, so a measured 0% survives as 0 and an uncovered suburb stays
// absent — the map's null mask and the profile card both depend on that.
func suburbHazardsProto(row *shortsstore.SuburbHazardRow) *shortsv1alpha1.SuburbHazardExposure {
	if row == nil {
		return nil
	}
	return &shortsv1alpha1.SuburbHazardExposure{
		WaterObservedSharePct:  row.WaterObservedSharePct,
		PermanentWaterSharePct: row.PermanentWaterSharePct,
		FloodPlanningSharePct:  row.FloodPlanningSharePct,
		BushfireProneSharePct:  row.BushfireProneSharePct,
		WaterSource:            row.WaterSource,
		FloodSource:            row.FloodSource,
		BushfireSource:         row.BushfireSource,
	}
}
