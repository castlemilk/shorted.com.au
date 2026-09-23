package shorts

import (
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// suburbPlanningProto maps the store row onto the proto block. Optional
// scalars keep presence: an uncovered value stays absent, a measured 0 is 0.
func suburbPlanningProto(row *shortsstore.SuburbPlanningRow) *shortsv1alpha1.SuburbPlanning {
	if row == nil {
		return nil
	}
	out := &shortsv1alpha1.SuburbPlanning{
		ZoningCoveragePct:  row.ZoningCoveragePct,
		DominantZoneFamily: row.DominantZoneFamily,
		HeritageSharePct:   row.HeritageSharePct,
		HeritageItemCount:  row.HeritageItemCount,
		NswHeightMedianM:   row.NSWHeightMedianM,
		NswHeightMaxM:      row.NSWHeightMaxM,
		NswFsrMedian:       row.NSWFSRMedian,
		NswMinLotMedianM2:  row.NSWMinLotMedianM2,
		Instruments:        row.Instruments,
		ZoningSource:       row.ZoningSource,
		HeritageSource:     row.HeritageSource,
		SourceLicence:      row.SourceLicence,
	}
	for _, share := range row.ZoneShares {
		out.ZoneShares = append(out.ZoneShares, &shortsv1alpha1.ZoneFamilyShare{
			Family:   share.Family,
			SharePct: share.SharePct,
		})
	}
	return out
}
