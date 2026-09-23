package shorts

import (
	"database/sql"
	"strings"
	"testing"
)

func TestSuburbPlanningQueryReadsEveryFamilyInOrderAndGatesTheLicence(t *testing.T) {
	last := -1
	for _, family := range ZoneFamilies {
		at := strings.Index(suburbPlanningQuery, "zone_"+family+"_share_pct")
		if at < 0 {
			t.Fatalf("query does not read zone_%s_share_pct", family)
		}
		if at < last {
			t.Fatalf("zone_%s_share_pct is out of ZoneFamilies order; the scan would misassign it", family)
		}
		last = at
	}
	if !strings.Contains(suburbPlanningQuery, "source_licence <> 'proprietary-tos-restricted'") {
		t.Fatal("planning read path must be licence-gated")
	}
}

func TestBuildSuburbPlanningRowKeepsZeroDropsAbsentAndSortsShares(t *testing.T) {
	shares := make([]sql.NullFloat64, len(ZoneFamilies))
	shares[0] = sql.NullFloat64{Float64: 20, Valid: true} // res_low
	shares[1] = sql.NullFloat64{Float64: 55, Valid: true} // res_medium_high
	shares[3] = sql.NullFloat64{Float64: 0, Valid: true}  // industrial, measured 0
	shares[6] = sql.NullFloat64{Float64: 20, Valid: true} // open_space ties res_low
	row := buildSuburbPlanningRow(&SuburbPlanningRow{DominantZoneFamily: "res_medium_high"}, shares, planningScan{
		Coverage:  sql.NullFloat64{Float64: 95, Valid: true},
		Heritage:  sql.NullFloat64{Float64: 0, Valid: true}, // heritage share measured 0
		Items:     sql.NullInt32{Int32: 0, Valid: true},
		FSRMapped: sql.NullFloat64{Float64: 0, Valid: true}, // FSR mapped nowhere: a measured 0
		HMapped:   sql.NullFloat64{Float64: 4.5, Valid: true},
	})
	if row == nil {
		t.Fatal("a zoned suburb must produce a block")
	}
	got := []string{}
	for _, s := range row.ZoneShares {
		got = append(got, s.Family)
	}
	if strings.Join(got, ",") != "res_medium_high,res_low,open_space" {
		t.Fatalf("zone shares = %v; want non-zero families, largest first, ties in family order", got)
	}
	if row.HeritageSharePct == nil || *row.HeritageSharePct != 0 || row.HeritageItemCount == nil || *row.HeritageItemCount != 0 {
		t.Fatalf("measured zeros must survive: %+v", row)
	}
	if row.NSWHeightMedianM != nil || row.NSWFSRMedian != nil {
		t.Fatalf("absent NSW controls must stay nil")
	}
	if row.NSWFSRMappedPct == nil || *row.NSWFSRMappedPct != 0 || row.NSWHeightMappedPct == nil ||
		*row.NSWHeightMappedPct != 4.5 || row.NSWMinLotMappedPct != nil {
		t.Fatalf("mapped shares must keep presence: %+v", row)
	}
}

func TestBuildSuburbPlanningRowCollapsesAnEmptyRowToNil(t *testing.T) {
	shares := make([]sql.NullFloat64, len(ZoneFamilies))
	row := buildSuburbPlanningRow(&SuburbPlanningRow{ZoningSource: "nsw_epi_land_zoning"}, shares, planningScan{
		Coverage: sql.NullFloat64{Float64: 0, Valid: true},
	})
	if row != nil {
		t.Fatalf("a suburb no instrument reaches must render no card, got %+v", row)
	}
}

func TestBuildSuburbPlanningRowKeepsAPartialCoverageOnItsOwn(t *testing.T) {
	// The Rocks: the scheme layers zone 2.9% of it, so the build stored the
	// coverage and nothing else. The card must still say so.
	shares := make([]sql.NullFloat64, len(ZoneFamilies))
	row := buildSuburbPlanningRow(&SuburbPlanningRow{ZoningSource: "nsw_epi_land_zoning"}, shares, planningScan{
		Coverage: sql.NullFloat64{Float64: 2.926, Valid: true},
	})
	if row == nil || row.ZoningCoveragePct == nil || *row.ZoningCoveragePct != 2.926 || len(row.ZoneShares) != 0 {
		t.Fatalf("a partial coverage must survive on its own, got %+v", row)
	}
}
