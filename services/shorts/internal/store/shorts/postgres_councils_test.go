package shorts

import (
	"strings"
	"testing"
	"time"
)

func fp(v float64) *float64 { return &v }

// The council queries answer to three rules: council facts stay council-level,
// NULL is never 0, and crawl data is read only as aggregates. Each assertion
// here names the clause that enforces one of them.
func TestCouncilQueryShapes(t *testing.T) {
	cases := []struct {
		name, query string
		want        []string
		forbid      []string
	}{
		{"summary", councilSummaryQuery, []string{
			"l.kind IN ('council', 'unincorporated')", // pseudo areas never get a page
			"l.slug IS NOT NULL",
			"s.measure = 'house_median_price'",
			"s.source_licence <> 'proprietary-tos-restricted'",
			"ORDER BY s.period DESC",
			"s.measure = 'dwelling_approvals_total'",
			"INTERVAL '12 months'",
			"ORDER BY c.population DESC, c.name, c.lga_code24", // deterministic
		}, []string{"property_listings", "COALESCE(l.pop_growth_pct", "COALESCE(l.seifa"}},
		{"members", councilMembersCTE, []string{
			"jsonb_to_recordset(",
			"o.lga_code24 = sl.lga_code24 OR o.share >= $3", // dominant always, straddlers from 5%
			"COALESCE(d.population, 0)::float8 * o.share",   // residents contributed
			"NULLIF(sl.overlap_lgas, '[]'::jsonb)",          // pre-overlap bridge rows still count
		}, nil},
		{"hazards", councilHazardRollupQuery, []string{
			// Both numerator and denominator count only covered suburbs, so a
			// council with none divides by NULL and stays absent.
			"sum(m.w * h.flood_planning_share_pct) FILTER (WHERE h.flood_planning_share_pct IS NOT NULL)",
			"/ NULLIF(sum(m.w) FILTER (WHERE h.flood_planning_share_pct IS NOT NULL), 0)",
			"sum(m.w * h.bushfire_prone_share_pct) FILTER (WHERE h.bushfire_prone_share_pct IS NOT NULL)",
			"/ NULLIF(sum(m.w) FILTER (WHERE h.bushfire_prone_share_pct IS NOT NULL), 0)",
			"h.source_licence <> 'proprietary-tos-restricted'",
		}, []string{"COALESCE(h.flood", "COALESCE(h.bushfire"}},
		{"drops", councilSuburbDropsQuery, []string{
			"mv_suburb_price_drops", "mv_suburb_listing_stats",
			"COALESCE(pd.total_active_listings, st.for_sale_count)",
			"JOIN house_price_regions r ON r.sal_code = sl.sal_code",
			"ORDER BY sl.lga_code24, d.sal_code",
		}, []string{"property_listings", "property_price_events", "overlap_lgas", "address"}},
		{"identity", councilIdentityQuery, []string{
			"lg.state_code = $1 AND lg.slug = $2",
			"lg.kind IN ('council', 'unincorporated')",
			"ls.measure = 'house_median_price'",
			"ls.source_licence <> 'proprietary-tos-restricted'",
		}, []string{"COALESCE(lg.pop_growth_pct", "COALESCE(lg.median_age"}},
		{"series", councilSeriesQuery, []string{
			"source_licence <> 'proprietary-tos-restricted'", "ORDER BY measure, source, period",
		}, nil},
		{"suburbs", councilSuburbsQuery, []string{
			"sr.region_type = 'suburb'", // the suburb's OWN price series
			"h.source_licence <> 'proprietary-tos-restricted'",
			"ORDER BY COALESCE(d.population, 0) DESC, d.sal_name, d.sal_code",
		}, []string{"lga_series", "house_median_price", "COALESCE(h.", "COALESCE(r.value"}},
		{"crime", councilCrimeQuery, []string{
			"NOT c.small_pop AND NOT c.unreliable",
			"c.population * m.share",
		}, nil},
		{"straddle neighbours", councilStraddleNeighboursQuery, []string{
			"o1.lga_code24 = $1 AND o2.lga_code24 <> $1",
		}, nil},
		{"neighbour identity", councilNeighbourIdentityQuery, []string{
			"kind IN ('council', 'unincorporated')", "<> 'pseudo'",
		}, nil},
	}
	for _, c := range cases {
		for _, w := range c.want {
			if !strings.Contains(c.query, w) {
				t.Errorf("%s query missing %q", c.name, w)
			}
		}
		for _, f := range c.forbid {
			if strings.Contains(c.query, f) {
				t.Errorf("%s query must not contain %q", c.name, f)
			}
		}
	}
	if councilMemberMinShare != 0.05 {
		t.Errorf("member floor %v: the contract names straddlers from 5%%", councilMemberMinShare)
	}
	if councilDropsMinCount != 3 {
		t.Errorf("drops floor %d: crawl aggregates publish at k>=3", councilDropsMinCount)
	}
}

func TestDeriveCouncilRates(t *testing.T) {
	r := &CouncilSummaryRow{Population: 100_000, FagYear: "2025-26", HouseMedianPeriod: "2023-24", ApprovalsThrough: "2026-07"}
	deriveCouncilRates(r, fp(50), fp(5_000_000), fp(900_000), fp(1_200), 12)
	if *r.DensityPerSqkm != 2000 || *r.FagPerResident != 50 || *r.ApprovalsPer1000 != 12 || *r.HouseMedian != 900_000 {
		t.Fatalf("rates: %+v", r)
	}

	// A partial approvals window is not "the last 12 months".
	r = &CouncilSummaryRow{Population: 100_000, ApprovalsThrough: "2026-07"}
	deriveCouncilRates(r, nil, nil, nil, fp(1_200), 11)
	if r.ApprovalsPer1000 != nil || r.ApprovalsThrough != "" {
		t.Errorf("11 months published as a 12-month rate: %+v", r)
	}
	// No ERP: nothing per resident, nothing per km2 — never a 0.
	r = &CouncilSummaryRow{FagYear: "2025-26"}
	deriveCouncilRates(r, fp(50), fp(5_000_000), nil, fp(10), 12)
	if r.DensityPerSqkm != nil || r.FagPerResident != nil || r.ApprovalsPer1000 != nil || r.FagYear != "" {
		t.Errorf("rates without population: %+v", r)
	}
	// A median without its period is not published.
	r = &CouncilSummaryRow{Population: 1}
	deriveCouncilRates(r, nil, nil, fp(900_000), nil, 0)
	if r.HouseMedian != nil {
		t.Errorf("undated council median: %+v", r)
	}
}

func TestAggregateCouncilDropsFloorsAtTheCouncilAndNamesOnlyClearingSuburbs(t *testing.T) {
	// Two suburbs with 2 drops each: neither may be named, but the council's 4
	// clear the floor.
	agg := aggregateCouncilDrops([]CouncilDropSuburbRow{
		{SALCode: "1", Dropped: 2, Tracked: 40, MedianDropPct: fp(0.05)},
		{SALCode: "2", Dropped: 2, Tracked: 60},
	})
	if agg == nil || agg.Dropped != 4 || agg.Tracked != 100 || agg.DroppedShare != 0.04 {
		t.Fatalf("aggregate: %+v", agg)
	}
	if len(agg.Suburbs) != 0 || agg.MedianDropPct != nil {
		t.Errorf("suburbs under the floor were named or their medians used: %+v", agg)
	}

	// Below 3 council-wide: nothing at all.
	if got := aggregateCouncilDrops([]CouncilDropSuburbRow{{SALCode: "1", Dropped: 2, Tracked: 10}}); got != nil {
		t.Errorf("2 drops published: %+v", got)
	}
	// Tracked listings with no drops: nothing (no share to publish).
	if got := aggregateCouncilDrops([]CouncilDropSuburbRow{{SALCode: "1", Dropped: 0, Tracked: 10}}); got != nil {
		t.Errorf("zero drops published: %+v", got)
	}
	if got := aggregateCouncilDrops(nil); got != nil {
		t.Errorf("no coverage published: %+v", got)
	}

	// Median of the clearing suburbs' own medians; largest first, ties by code.
	agg = aggregateCouncilDrops([]CouncilDropSuburbRow{
		{SALCode: "b", Dropped: 3, Tracked: 10, MedianDropPct: fp(0.02)},
		{SALCode: "a", Dropped: 3, Tracked: 10, MedianDropPct: fp(0.06)},
		{SALCode: "c", Dropped: 9, Tracked: 10, MedianDropPct: fp(0.03)},
	})
	if agg.MedianDropPct == nil || *agg.MedianDropPct != 0.03 {
		t.Errorf("median of medians: %v", agg.MedianDropPct)
	}
	if got := []string{agg.Suburbs[0].SALCode, agg.Suburbs[1].SALCode, agg.Suburbs[2].SALCode}; strings.Join(got, "") != "cab" {
		t.Errorf("suburb order %v", got)
	}
}

func TestRollupCouncilSuburbs(t *testing.T) {
	period := time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC)
	suburbs := []CouncilSuburbRow{
		{SALCode: "1", Population: 1000, Share: 1, Dominant: true, VGMedian: fp(1_000_000), VGMedianPeriod: &period, BushfireSharePct: fp(10)},
		{SALCode: "2", Population: 3000, Share: 1, Dominant: true, VGMedian: fp(2_000_000), VGMedianPeriod: &period, BushfireSharePct: fp(0)},
		{SALCode: "3", Population: 1000, Share: 1, Dominant: true, VGMedian: fp(3_000_000), VGMedianPeriod: &period},
		// A straddler with 10% of its people here: weighted by 1,000 x 0.1, and
		// its (high) median stays out of the council's price rollup.
		{SALCode: "4", Population: 1000, Share: 0.1, Dominant: false, VGMedian: fp(9_000_000), VGMedianPeriod: &period, BushfireSharePct: fp(100)},
	}
	r := rollupCouncilSuburbs(suburbs)
	if r.MemberSuburbs != 4 || r.DominantSuburbs != 3 {
		t.Errorf("counts: %+v", r)
	}
	// (1000*10 + 3000*0 + 100*100) / (1000 + 3000 + 100)
	if want := 20000.0 / 4100.0; r.BushfireSharePct == nil || *r.BushfireSharePct != want || r.BushfireCoveredSuburbs != 3 {
		t.Errorf("bushfire rollup %v (covered %d), want %v", r.BushfireSharePct, r.BushfireCoveredSuburbs, want)
	}
	if r.FloodSharePct != nil || r.FloodCoveredSuburbs != 0 {
		t.Errorf("no member covered for flood: must be absent, got %v", r.FloodSharePct)
	}
	if r.PricedSuburbs != 3 || *r.MedianMin != 1_000_000 || *r.MedianMax != 3_000_000 || *r.MedianOfMedians != 2_000_000 {
		t.Errorf("price rollup: %+v", r)
	}
}

func TestCouncilRepresentationWeightsByResidentsContributed(t *testing.T) {
	suburbs := []CouncilSuburbRow{
		{Population: 3000, Share: 1, FederalDivision: "Watson", FederalMember: "A", StateDistrict: "Lakemba"},
		{Population: 1000, Share: 1, FederalDivision: "Blaxland", FederalMember: "B", StateDistrict: "Lakemba"},
		{Population: 10000, Share: 0.1, FederalDivision: "Blaxland", StateDistrict: ""},
		{Population: 500, Share: 1}, // no seat recorded: out of numerator and denominator
	}
	fed, state := councilRepresentation(suburbs)
	if len(fed) != 2 || fed[0].Name != "Watson" || fed[0].PopulationShare != 0.6 || fed[1].PopulationShare != 0.4 || fed[1].SuburbCount != 2 {
		t.Errorf("federal: %+v", fed)
	}
	if len(state) != 1 || state[0].Name != "Lakemba" || state[0].PopulationShare != 1 || state[0].SuburbCount != 2 {
		t.Errorf("state: %+v", state)
	}
}

func TestLgaAdjacencyEmbedded(t *testing.T) {
	if len(lgaAdjacency) < 500 {
		t.Fatalf("embedded adjacency has %d councils", len(lgaAdjacency))
	}
	for a, list := range lgaAdjacency {
		for _, b := range list {
			found := false
			for _, back := range lgaAdjacency[b] {
				found = found || back == a
			}
			if !found {
				t.Errorf("%s -> %s is one-way", a, b)
			}
		}
	}
}
