package shorts

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
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
			// Covered suburbs must hold half the member residents before the
			// index prints one council-wide share with no coverage beside it.
			"FILTER (WHERE h.flood_planning_share_pct IS NOT NULL) >= $4 * sum(m.w)",
			"FILTER (WHERE h.bushfire_prone_share_pct IS NOT NULL) >= $4 * sum(m.w)",
			// Both numerator and denominator count only covered suburbs, so a
			// council with none divides by NULL and stays absent.
			"sum(m.w * h.flood_planning_share_pct) FILTER (WHERE h.flood_planning_share_pct IS NOT NULL)",
			"/ NULLIF(sum(m.w) FILTER (WHERE h.flood_planning_share_pct IS NOT NULL), 0)",
			"sum(m.w * h.bushfire_prone_share_pct) FILTER (WHERE h.bushfire_prone_share_pct IS NOT NULL)",
			"/ NULLIF(sum(m.w) FILTER (WHERE h.bushfire_prone_share_pct IS NOT NULL), 0)",
			"h.source_licence <> 'proprietary-tos-restricted'",
		}, []string{"COALESCE(h.flood", "COALESCE(h.bushfire"}},
		{"drops", councilDropsQuery, []string{
			// Counted from the crawl tables so sub-floor suburbs' cuts reach
			// the council total (the drops MV has already dropped them).
			"JOIN property_price_events e ON e.listing_pk = lv.id",
			// The drops views' own filters, and decision 9's "active".
			"pl.is_active", "pl.last_seen_at >= now() - interval '14 days'",
			"NULLIF(pl.address_key, '') IS NOT NULL",
			"e.observed_at >= now() - interval '30 days'", "e.drop_pct <= 0.40",
			"ORDER BY sal_code, address_key, total_abs DESC, source", // the view's address winner
			// Numerator and denominator are the same population, at both grains.
			"GROUP BY GROUPING SETS ((lga_code24, sal_code), (lga_code24))",
			"count(DISTINCT address_key)",
			"CASE WHEN x.n >= $3 THEN x.median_pct END", // no median over < 3 cuts
			"JOIN house_price_regions r ON r.sal_code = sl.sal_code",
		}, []string{
			"mv_suburb_price_drops", "mv_suburb_listing_stats", // floored / differently-scoped views
			"overlap_lgas", "pl.price", "listing_id", "SELECT pl.address_key", "SELECT address_key",
		}},
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
	asOf := time.Date(2026, 9, 24, 0, 0, 0, 0, time.UTC)
	through := asOf.Add(-time.Hour)
	// The council total comes from the query's council row (every crawled
	// member counted), not from summing the named suburbs: two suburbs with 2
	// cuts each and one with 3 give a council of 7, of which only the 3 is named.
	agg := aggregateCouncilDrops(&councilDrops{
		AsOf:  asOf,
		Total: CouncilDropSuburbRow{Dropped: 7, Tracked: 100, MedianDropPct: fp(0.04), DataThrough: &through},
		Suburbs: []CouncilDropSuburbRow{
			{SALCode: "1", Dropped: 2, Tracked: 40},
			{SALCode: "2", Dropped: 2, Tracked: 50},
			{SALCode: "3", Dropped: 3, Tracked: 10, MedianDropPct: fp(0.05)},
		},
	})
	if agg == nil || agg.Dropped != 7 || agg.Tracked != 100 || agg.DroppedShare != 0.07 || agg.SuburbsTracked != 3 {
		t.Fatalf("aggregate: %+v", agg)
	}
	if agg.MedianDropPct == nil || *agg.MedianDropPct != 0.04 {
		t.Errorf("council median is the council's own, over every cut: %v", agg.MedianDropPct)
	}
	if len(agg.Suburbs) != 1 || agg.Suburbs[0].SALCode != "3" {
		t.Errorf("only suburbs clearing the floor are named: %+v", agg.Suburbs)
	}
	if !agg.AsOf.Equal(asOf) || agg.DataThrough == nil || !agg.DataThrough.Equal(through) {
		t.Errorf("freshness not carried: as_of %v data_through %v", agg.AsOf, agg.DataThrough)
	}

	// Sub-floor suburbs alone clear the COUNCIL floor: 1 + 1 + 1 = 3.
	agg = aggregateCouncilDrops(&councilDrops{
		Total:   CouncilDropSuburbRow{Dropped: 3, Tracked: 30},
		Suburbs: []CouncilDropSuburbRow{{SALCode: "1", Dropped: 1, Tracked: 10}, {SALCode: "2", Dropped: 1, Tracked: 10}, {SALCode: "3", Dropped: 1, Tracked: 10}},
	})
	if agg == nil || agg.Dropped != 3 || len(agg.Suburbs) != 0 {
		t.Errorf("three single-cut suburbs must publish a council of 3, naming none: %+v", agg)
	}

	// Below 3 council-wide: nothing at all.
	if got := aggregateCouncilDrops(&councilDrops{Total: CouncilDropSuburbRow{Dropped: 2, Tracked: 10}}); got != nil {
		t.Errorf("2 drops published: %+v", got)
	}
	// Tracked listings with no drops: nothing (no share to publish).
	if got := aggregateCouncilDrops(&councilDrops{Total: CouncilDropSuburbRow{Dropped: 0, Tracked: 10}}); got != nil {
		t.Errorf("zero drops published: %+v", got)
	}
	if got := aggregateCouncilDrops(nil); got != nil {
		t.Errorf("no coverage published: %+v", got)
	}

	// Largest first, ties by code.
	agg = aggregateCouncilDrops(&councilDrops{
		Total: CouncilDropSuburbRow{Dropped: 15, Tracked: 30},
		Suburbs: []CouncilDropSuburbRow{
			{SALCode: "b", Dropped: 3, Tracked: 10}, {SALCode: "a", Dropped: 3, Tracked: 10}, {SALCode: "c", Dropped: 9, Tracked: 10},
		},
	})
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

func TestLgaCrossStateEmbedded(t *testing.T) {
	if len(lgaCrossState) < 50 {
		t.Fatalf("embedded cross-border adjacency has %d councils", len(lgaCrossState))
	}
	has := func(m map[string][]string, a, b string) bool {
		for _, x := range m[a] {
			if x == b {
				return true
			}
		}
		return false
	}
	// Albury (NSW) <-> Wodonga (VIC), across the Murray: a cross-border pair,
	// never a same-state one.
	if !has(lgaCrossState, "10050", "27170") || !has(lgaCrossState, "27170", "10050") {
		t.Errorf("Albury <-> Wodonga missing from cross_state: %v / %v", lgaCrossState["10050"], lgaCrossState["27170"])
	}
	if has(lgaAdjacency, "10050", "27170") {
		t.Error("Albury -> Wodonga must not be listed as a same-state neighbour")
	}
	// The ACT's only neighbours are across its border.
	if len(lgaCrossState["89399"]) == 0 || len(lgaAdjacency["89399"]) != 0 {
		t.Errorf("Unincorporated ACT: cross %v, same-state %v", lgaCrossState["89399"], lgaAdjacency["89399"])
	}
	for a, list := range lgaCrossState {
		for _, b := range list {
			if a[0] == b[0] {
				t.Errorf("%s -> %s is same-state but listed as cross-border", a, b)
			}
			if !has(lgaCrossState, b, a) {
				t.Errorf("%s -> %s is one-way", a, b)
			}
		}
	}
}

// councilNeighbours is otherwise covered only by the integration-tagged
// TestCouncilHubCrossBorderNeighbours, which no CI job runs. This pins its
// geometry half: disabling the cross-state merge used to pass every unit test.
func TestCouncilBorderNeighboursMergesCrossState(t *testing.T) {
	got := councilBorderNeighbours("10050") // Albury (NSW)
	wodonga := got["27170"]
	if wodonga == nil || !wodonga.CrossState || !wodonga.SharesBorder {
		t.Fatalf("Albury -> Wodonga = %+v, want a cross-state border neighbour", wodonga)
	}
	sameState := 0
	for code, n := range got {
		if code[0] == '1' {
			sameState++
			if n.CrossState {
				t.Errorf("%s is NSW but flagged cross-state", code)
			}
		}
	}
	if sameState == 0 {
		t.Error("Albury has no same-state neighbours; the topology merge was dropped")
	}
	// The ACT is all border: every neighbour is across it.
	act := councilBorderNeighbours("89399")
	if len(act) == 0 {
		t.Fatal("Unincorporated ACT has no neighbours")
	}
	for code, n := range act {
		if !n.CrossState {
			t.Errorf("ACT -> %s not flagged cross-state", code)
		}
	}
}

func TestSortCouncilNeighboursPutsSameStateFirst(t *testing.T) {
	rows := []CouncilNeighbourRow{
		{LgaCode: "27170", DisplayName: "Wodonga", CrossState: true},
		{LgaCode: "16350", DisplayName: "Greater Hume"},
		{LgaCode: "21890", DisplayName: "Indigo", CrossState: true},
		{LgaCode: "14920", DisplayName: "Federation"},
	}
	sortCouncilNeighbours(rows)
	var got []string
	for _, r := range rows {
		got = append(got, r.DisplayName)
	}
	if want := []string{"Federation", "Greater Hume", "Indigo", "Wodonga"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
}

func TestFallbackOnUndefinedTableOnlyForAMissingRelation(t *testing.T) {
	missing := &pgconn.PgError{Code: "42P01"}
	calls := 0
	fb := func(error) (string, error) { calls++; return "live", nil }

	if got, err := fallbackOnUndefinedTable(func() (string, error) { return "", missing }, fb); err != nil || got != "live" || calls != 1 {
		t.Fatalf("missing view: got %q/%v after %d fallback calls, want the live query once", got, err, calls)
	}
	timeout := &pgconn.PgError{Code: "57014"}
	if _, err := fallbackOnUndefinedTable(func() (string, error) { return "", timeout }, fb); !errors.Is(err, timeout) || calls != 1 {
		t.Fatalf("a timeout must surface, not fall back: err %v, fallback calls %d", err, calls)
	}
	if got, err := fallbackOnUndefinedTable(func() (string, error) { return "mv", nil }, fb); err != nil || got != "mv" || calls != 1 {
		t.Fatalf("healthy view: got %q/%v, fallback calls %d", got, err, calls)
	}
}
