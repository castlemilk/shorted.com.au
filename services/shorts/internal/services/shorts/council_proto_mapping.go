package shorts

import (
	"math"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// attachCouncilFacts copies the 000126 council facts onto the profile's
// LgaInfo. Optional scalars keep presence: a council no source covers stays
// absent rather than reading as 0 years old or a 0% growth rate. A nil row
// (no council, or the 000126 columns not deployed) leaves the base card as is.
func attachCouncilFacts(info *shortsv1alpha1.LgaInfo, c *shortsstore.SuburbCouncilRow) {
	if info == nil || c == nil {
		return
	}
	info.Slug, info.DisplayName, info.Kind = c.Slug, c.DisplayName, c.Kind
	info.ErpYear = c.ErpYear
	info.PopGrowthPct, info.MedianAge, info.PctRented = c.PopGrowthPct, c.MedianAge, c.PctRented
	info.MedianHhdIncome, info.MedianWeeklyRent, info.MedianMortgageMonthly = c.MedianHhdIncome, c.MedianWeeklyRent, c.MedianMortgageMonthly
	info.AvgHouseholdSize = c.AvgHouseholdSize
	info.SeifaIrsadDecile, info.SeifaIrsdDecile = c.SeifaIrsadDecile, c.SeifaIrsdDecile
	info.Website, info.WikidataQid = c.Website, c.WikidataQID
	info.CentroidLat, info.CentroidLon = c.CentroidLat, c.CentroidLon
	info.DominantShare = c.DominantShare
	if c.HouseMedian != nil && c.HouseMedianPeriod != "" {
		info.CouncilHouseMedian, info.CouncilHouseMedianPeriod = c.HouseMedian, c.HouseMedianPeriod
	}
}

// councilOverlapsProto maps the other councils a suburb spans, shares rounded
// to 0.1 percentage point (the bridge is Census-2021 weighted; more digits
// would be false precision).
func councilOverlapsProto(rows []shortsstore.CouncilOverlapRow) []*shortsv1alpha1.LgaOverlap {
	if len(rows) == 0 {
		return nil
	}
	out := make([]*shortsv1alpha1.LgaOverlap, 0, len(rows))
	for _, r := range rows {
		out = append(out, &shortsv1alpha1.LgaOverlap{
			LgaCode: r.LgaCode, DisplayName: r.DisplayName, StateCode: r.StateCode,
			Slug: r.Slug, Share: math.Round(r.Share*1000) / 1000,
		})
	}
	return out
}
