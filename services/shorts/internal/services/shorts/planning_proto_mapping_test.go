package shorts

import (
	"testing"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestSuburbPlanningProtoKeepsZeroDropsAbsentAndOrdersShares(t *testing.T) {
	if got := suburbPlanningProto(nil); got != nil {
		t.Fatalf("nil row must map to an absent block, got %v", got)
	}
	cov, zero, height := 97.5, 0.0, 9.5
	items := int32(4)
	got := suburbPlanningProto(&shortsstore.SuburbPlanningRow{
		ZoneShares: []shortsstore.ZoneFamilyShareRow{
			{Family: "res_low", SharePct: 70},
			{Family: "open_space", SharePct: 27.5},
		},
		ZoningCoveragePct:  &cov,
		DominantZoneFamily: "res_low",
		HeritageSharePct:   &zero,
		HeritageItemCount:  &items,
		NSWHeightMedianM:   &height,
		Instruments:        []string{"Ku-ring-gai Local Environmental Plan 2015"},
		ZoningSource:       "nsw_epi_land_zoning",
		HeritageSource:     "nsw_epi_heritage",
		SourceLicence:      "CC-BY-4.0",
	})
	if len(got.ZoneShares) != 2 || got.ZoneShares[0].Family != "res_low" || got.ZoneShares[1].SharePct != 27.5 {
		t.Fatalf("zone shares = %+v", got.ZoneShares)
	}
	if got.HeritageSharePct == nil || *got.HeritageSharePct != 0 {
		t.Fatalf("a measured 0%% heritage share must be present as 0")
	}
	if got.NswFsrMedian != nil || got.NswMinLotMedianM2 != nil || got.NswHeightMaxM != nil {
		t.Fatalf("absent NSW controls must stay absent")
	}
	if got.GetHeritageItemCount() != 4 || got.GetNswHeightMedianM() != 9.5 || got.GetDominantZoneFamily() != "res_low" {
		t.Fatalf("unexpected mapping: %+v", got)
	}
	if len(got.Instruments) != 1 || got.SourceLicence != "CC-BY-4.0" || got.ZoningSource != "nsw_epi_land_zoning" {
		t.Fatalf("instruments/sources lost: %+v", got)
	}
}
