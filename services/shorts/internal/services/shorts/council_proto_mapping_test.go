package shorts

import (
	"testing"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestAttachCouncilFactsKeepsPresence(t *testing.T) {
	base := &shortsv1alpha1.LgaInfo{LgaCode: "11570", LgaName: "Canterbury-Bankstown", Population: 390000}
	attachCouncilFacts(base, nil)
	if base.Slug != "" || base.MedianAge != nil || base.Population != 390000 {
		t.Fatalf("a nil row must leave the base card untouched: %+v", base)
	}

	zero, age, share, median := 0.0, 36.0, 0.4946, 1399999.0
	income := int32(1556)
	info := &shortsv1alpha1.LgaInfo{LgaCode: "11570"}
	attachCouncilFacts(info, &shortsstore.SuburbCouncilRow{
		Slug: "canterbury-bankstown", DisplayName: "Canterbury-Bankstown", Kind: "council", ErpYear: 2025,
		PopGrowthPct: &zero, MedianAge: &age, MedianHhdIncome: &income, DominantShare: &share,
		Website: "https://www.cbcity.nsw.gov.au/", WikidataQID: "Q24070750",
		HouseMedian: &median, HouseMedianPeriod: "2023-24",
	})
	if info.PopGrowthPct == nil || *info.PopGrowthPct != 0 {
		t.Errorf("a measured 0%% growth must be present as 0, got %v", info.PopGrowthPct)
	}
	if info.PctRented != nil || info.SeifaIrsadDecile != nil || info.CentroidLat != nil {
		t.Errorf("absent facts must stay absent: %+v", info)
	}
	if info.GetMedianHhdIncome() != 1556 || info.GetDominantShare() != 0.4946 || info.Slug != "canterbury-bankstown" ||
		info.GetCouncilHouseMedian() != median || info.CouncilHouseMedianPeriod != "2023-24" || info.ErpYear != 2025 {
		t.Errorf("unexpected mapping: %+v", info)
	}

	// A median without its period is never shown undated.
	undated := &shortsv1alpha1.LgaInfo{}
	attachCouncilFacts(undated, &shortsstore.SuburbCouncilRow{HouseMedian: &median})
	if undated.CouncilHouseMedian != nil {
		t.Error("a council median with no period must be dropped")
	}
}

func TestCouncilOverlapsProto(t *testing.T) {
	if got := councilOverlapsProto(nil); got != nil {
		t.Fatalf("no overlaps must map to nil, got %v", got)
	}
	got := councilOverlapsProto([]shortsstore.CouncilOverlapRow{
		{LgaCode: "12930", DisplayName: "Georges River", StateCode: "NSW", Slug: "georges-river", Share: 0.27823},
	})
	if len(got) != 1 || got[0].Share != 0.278 || got[0].Slug != "georges-river" || got[0].DisplayName != "Georges River" {
		t.Errorf("overlaps = %+v", got)
	}
}
