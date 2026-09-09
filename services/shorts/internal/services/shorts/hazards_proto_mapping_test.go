package shorts

import (
	"testing"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestSuburbHazardsProtoKeepsZeroAndDropsAbsent(t *testing.T) {
	if got := suburbHazardsProto(nil); got != nil {
		t.Fatalf("nil row must map to an absent block, got %v", got)
	}
	zero := 0.0
	share := 12.5
	got := suburbHazardsProto(&shortsstore.SuburbHazardRow{
		WaterObservedSharePct: &zero,
		FloodPlanningSharePct: &share,
		WaterSource:           "dea_wo_fq_myear_3_v2_1_0",
		FloodSource:           "nsw_epi_flood",
	})
	if got.WaterObservedSharePct == nil || *got.WaterObservedSharePct != 0 {
		t.Fatalf("a measured 0%% must be present as 0, got %v", got.WaterObservedSharePct)
	}
	if got.PermanentWaterSharePct != nil || got.BushfireProneSharePct != nil {
		t.Fatalf("absent shares must stay absent")
	}
	if *got.FloodPlanningSharePct != 12.5 || got.FloodSource != "nsw_epi_flood" || got.BushfireSource != "" {
		t.Fatalf("unexpected mapping: %+v", got)
	}
}
