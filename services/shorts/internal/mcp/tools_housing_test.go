package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// ---------------------------------------------------------------------------
// The licence guard
// ---------------------------------------------------------------------------

// housingOutputAllowlist is the FULL set of JSON field names each housing tool
// may emit, written out rather than derived, so adding a field to a projection
// is a deliberate act that fails this test until someone justifies it.
//
// The justification each entry needs is a licence one. Housing responses mix
// two incompatible sources:
//
//   - ABS / RBA / Valuer-General / AEC / BOCSAR — CC-BY, publishable with
//     attribution. Anything here may be republished, including to a third-party
//     model that will quote it.
//   - REA / Domain / property.com.au — source_licence
//     'proprietary-tos-restricted'. Raw rows are NEVER republished; only
//     derived aggregates are a publishable surface
//     (docs/feature/housing/data-sources.md, README rule 1).
//
// So the crawl-derived entries below (the listings_* fields, and the drop
// aggregates) are counts and medians only, computed over at least kAnonFloor
// underlying listings. What is deliberately absent, and must stay absent:
//
//   - max_drop_pct / max_drop_abs — an extremum is one restricted listing's
//     exact price movement wearing an aggregate's clothes. `SuburbPriceDrop`
//     carries both; this surface publishes neither.
//   - dropped_value — the summed AUD reduction, which is the same disclosure
//     one arithmetic step further away.
//   - any address, listing URL, agency, bedroom count or portal name — those
//     live on ListSuburbDropListings / ListAddressPriceDrops / GetPropertyHistory,
//     none of which is wrapped by a tool.
//   - avg_asking / avg_sold / median_sold on the drops rows — means over a
//     restricted population that add nothing a median does not, and sold-price
//     medians whose count is not separately floored here.
var housingOutputAllowlist = map[string][]string{
	"GetHousingOverviewOutput": {
		"as_of", "count", "metrics", "source", "note",
		// metrics[]
		"region", "region_code", "region_type", "state", "measure",
		"dwelling_type", "value", "unit", "period", "qoq_pct", "yoy_pct",
		"preliminary",
	},
	"GetHousePriceSeriesOutput": {
		"region_code", "region", "measure", "dwelling_type", "unit",
		"source", "source_licence", "count", "points", "note",
		// points[]
		"period", "value", "preliminary",
	},
	"GetSuburbProfileOutput": {
		"sal_code", "suburb", "state", "postcode",
		"median_price", "median_price_period", "median_price_yoy_pct",
		"population", "median_age", "median_weekly_household_income",
		"median_weekly_rent", "median_monthly_mortgage", "pct_rented",
		"pct_born_overseas", "top_language", "pct_top_language", "census_year",
		"seifa_irsad_decile_aus", "seifa_irsad_decile_state",
		"federal_division", "federal_member", "federal_party",
		"state_district", "state_member", "state_party",
		"council", "state_median_price", "national_median_price",
		"crime_break_ins_rank", "crime_violent_rank",
		"crime_motor_vehicle_rank", "crime_jurisdiction",
		"listings_for_sale_count", "listings_median_asking",
		"listings_sold_count", "listings_median_sold", "listings_note",
		"note",
	},
	"ListSuburbPriceDropsOutput": {
		"state", "sort", "count", "suppressed_suburbs", "suburbs", "note",
		// suburbs[]
		"suburb", "sal_code", "postcode",
		"dropped_listing_count", "total_active_listings", "dropped_share_pct",
		"avg_drop_pct", "median_drop_pct",
		"for_sale_count", "median_asking",
	},
}

// restrictedFieldMarkers are substrings that must never appear in a housing
// tool's output schema. They name the per-listing and per-address facts that
// carry source_licence='proprietary-tos-restricted' — the things whose presence
// would turn a derived-aggregate surface back into republication of the rows.
var restrictedFieldMarkers = []string{
	"address", "listing_url", "agency", "bedroom", "bathroom", "car_space",
	"max_drop", "dropped_value", "prev_price", "valuation", "avm",
}

func TestHousingToolOutputsCarryOnlyAllowlistedFields(t *testing.T) {
	cases := []struct {
		name string
		typ  reflect.Type
	}{
		{"GetHousingOverviewOutput", reflect.TypeOf(GetHousingOverviewOutput{})},
		{"GetHousePriceSeriesOutput", reflect.TypeOf(GetHousePriceSeriesOutput{})},
		{"GetSuburbProfileOutput", reflect.TypeOf(GetSuburbProfileOutput{})},
		{"ListSuburbPriceDropsOutput", reflect.TypeOf(ListSuburbPriceDropsOutput{})},
	}

	for _, c := range cases {
		allowed := map[string]bool{}
		for _, f := range housingOutputAllowlist[c.name] {
			allowed[f] = true
		}
		if len(allowed) == 0 {
			t.Fatalf("%s has no allowlist entry — every housing projection needs one", c.name)
		}

		got := jsonFieldNames(c.typ, map[reflect.Type]bool{})
		for _, field := range got {
			if !allowed[field] {
				t.Errorf("%s emits %q, which is not on the housing allowlist. "+
					"Housing responses mix CC-BY official data with ToS-restricted crawl rows; "+
					"add it to housingOutputAllowlist ONLY after establishing which source it comes from.",
					c.name, field)
			}
			for _, marker := range restrictedFieldMarkers {
				if strings.Contains(field, marker) {
					t.Errorf("%s emits %q, which matches restricted marker %q — "+
						"per-listing and per-address facts are never republished",
						c.name, field, marker)
				}
			}
		}

		// The converse: an allowlist entry nothing emits is stale permission.
		emitted := map[string]bool{}
		for _, f := range got {
			emitted[f] = true
		}
		for f := range allowed {
			if !emitted[f] {
				t.Errorf("%s allowlists %q but emits no such field — drop the entry rather than "+
					"leaving standing permission for a field nobody reviewed", c.name, f)
			}
		}
	}
}

// jsonFieldNames walks a struct (and any struct it nests or lists) collecting
// JSON field names. Recursion is what makes the allowlist structural: a field
// added to a nested row type is caught as surely as one added to the top level.
func jsonFieldNames(t reflect.Type, seen map[reflect.Type]bool) []string {
	for t.Kind() == reflect.Ptr || t.Kind() == reflect.Slice {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct || seen[t] {
		return nil
	}
	seen[t] = true

	var out []string
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		tag := strings.Split(f.Tag.Get("json"), ",")[0]
		if tag == "" || tag == "-" {
			continue
		}
		out = append(out, tag)
		out = append(out, jsonFieldNames(f.Type, seen)...)
	}
	sort.Strings(out)
	return out
}

// ---------------------------------------------------------------------------
// get_housing_overview
// ---------------------------------------------------------------------------

func TestGetHousingOverviewProjectsHeadlineMetrics(t *testing.T) {
	src := &fakeDataSource{housingOverview: &shortsv1alpha1.GetHousingOverviewResponse{
		AsOf: timestamppb.New(time.Date(2026, 3, 31, 0, 0, 0, 0, time.UTC)),
		Metrics: []*shortsv1alpha1.HousingMetric{{
			RegionCode: "AUS", RegionName: "Australia", RegionType: "national",
			Measure: "mean_price", DwellingType: "all", Value: 1_002_300, Unit: "AUD",
			Period: timestamppb.New(time.Date(2026, 3, 31, 0, 0, 0, 0, time.UTC)),
			QoqPct: 1.2, YoyPct: 4.5,
		}},
	}}

	_, out, err := getHousingOverviewHandler(src)(context.Background(), nil, GetHousingOverviewInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 1 || len(out.Metrics) != 1 {
		t.Fatalf("expected 1 metric, got %d", out.Count)
	}
	m := out.Metrics[0]
	if m.Region != "Australia" || m.Measure != "mean_price" || m.Value != 1_002_300 {
		t.Errorf("metric projected wrong: %+v", m)
	}
	if m.Period != "2026-03-31" {
		t.Errorf("period = %q, want 2026-03-31", m.Period)
	}
	if out.AsOf != "2026-03-31" {
		t.Errorf("as_of = %q", out.AsOf)
	}
	if !strings.Contains(out.Source, "ABS") {
		t.Errorf("source attribution missing CC-BY provenance: %q", out.Source)
	}
}

func TestGetHousingOverviewRejectsSuburbRegionType(t *testing.T) {
	src := &fakeDataSource{}
	_, _, err := getHousingOverviewHandler(src)(context.Background(), nil,
		GetHousingOverviewInput{RegionType: "suburb"})
	if err == nil {
		t.Fatal("expected suburb region_type to be rejected")
	}
	if !strings.Contains(err.Error(), "get_suburb_profile") {
		t.Errorf("error should point at the suburb tool, got %q", err)
	}
	if src.gotHousingOverview != nil {
		t.Error("the RPC should not have been reached")
	}
}

func TestGetHousingOverviewSaysSoWhenEmpty(t *testing.T) {
	src := &fakeDataSource{housingOverview: &shortsv1alpha1.GetHousingOverviewResponse{}}
	res, out, err := getHousingOverviewHandler(src)(context.Background(), nil, GetHousingOverviewInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 0 {
		t.Fatalf("expected zero metrics")
	}
	if !strings.Contains(textOf(t, res), "No ") {
		t.Errorf("empty result should say so, got %q", textOf(t, res))
	}
}

func TestGetHousingOverviewSurfacesBackendFailure(t *testing.T) {
	src := &fakeDataSource{err: errors.New("boom")}
	_, _, err := getHousingOverviewHandler(src)(context.Background(), nil, GetHousingOverviewInput{})
	if err == nil {
		t.Fatal("expected a backend failure to surface")
	}
}

// ---------------------------------------------------------------------------
// get_house_price_series
// ---------------------------------------------------------------------------

func TestGetHousePriceSeriesProjectsPoints(t *testing.T) {
	src := &fakeDataSource{housePriceSeries: &shortsv1alpha1.GetHousePriceSeriesResponse{
		RegionCode: "NSW", RegionName: "New South Wales", Measure: "median_price",
		DwellingType: "all", Unit: "AUD", Source: "abs", SourceLicence: "CC-BY-4.0",
		Points: []*shortsv1alpha1.HousePricePoint{
			{Period: timestamppb.New(time.Date(2025, 12, 31, 0, 0, 0, 0, time.UTC)), Value: 1_100_000},
			{Period: timestamppb.New(time.Date(2026, 3, 31, 0, 0, 0, 0, time.UTC)), Value: 1_150_000, IsPreliminary: true},
		},
	}}

	_, out, err := getHousePriceSeriesHandler(src)(context.Background(), nil,
		GetHousePriceSeriesInput{RegionCode: "nsw", Measure: "Median_Price"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotHousePriceSeries.GetRegionCode() != "NSW" || src.gotHousePriceSeries.GetMeasure() != "median_price" {
		t.Errorf("request not normalised: %+v", src.gotHousePriceSeries)
	}
	if src.gotHousePriceSeries.GetDwellingType() != "all" {
		t.Errorf("dwelling_type should default to all, got %q", src.gotHousePriceSeries.GetDwellingType())
	}
	if out.Count != 2 || out.Points[1].Period != "2026-03-31" || !out.Points[1].Preliminary {
		t.Errorf("points projected wrong: %+v", out.Points)
	}
	if out.SourceLicence != "CC-BY-4.0" {
		t.Errorf("licence must travel with the series, got %q", out.SourceLicence)
	}
}

// The store excludes proprietary-tos-restricted rows in SQL. This is the second
// reading of that rule: if one ever reaches the tool, the tool refuses rather
// than handing a restricted series to a model that will quote it.
func TestGetHousePriceSeriesRefusesRestrictedLicence(t *testing.T) {
	src := &fakeDataSource{housePriceSeries: &shortsv1alpha1.GetHousePriceSeriesResponse{
		RegionCode: "SUBURB:VIC-RICHMOND", Measure: "median_price",
		Source: "crawl_rea", SourceLicence: "proprietary-tos-restricted",
		Points: []*shortsv1alpha1.HousePricePoint{
			{Period: timestamppb.New(time.Date(2026, 3, 31, 0, 0, 0, 0, time.UTC)), Value: 950_000},
		},
	}}

	_, out, err := getHousePriceSeriesHandler(src)(context.Background(), nil,
		GetHousePriceSeriesInput{RegionCode: "SUBURB:VIC-RICHMOND", Measure: "median_price"})
	if err == nil {
		t.Fatal("a restricted-licence series must not be returned")
	}
	if len(out.Points) != 0 {
		t.Errorf("no restricted points may leak into the output: %+v", out.Points)
	}
	if !strings.Contains(err.Error(), "licence") {
		t.Errorf("the refusal should name the reason, got %q", err)
	}
}

func TestGetHousePriceSeriesRequiresRegionAndMeasure(t *testing.T) {
	src := &fakeDataSource{}
	if _, _, err := getHousePriceSeriesHandler(src)(context.Background(), nil,
		GetHousePriceSeriesInput{Measure: "median_price"}); err == nil {
		t.Error("expected a missing region_code to be rejected")
	}
	if _, _, err := getHousePriceSeriesHandler(src)(context.Background(), nil,
		GetHousePriceSeriesInput{RegionCode: "AUS"}); err == nil {
		t.Error("expected a missing measure to be rejected")
	}
	if src.gotHousePriceSeries != nil {
		t.Error("the RPC should not have been reached")
	}
}

func TestGetHousePriceSeriesDownsamplesLongSeries(t *testing.T) {
	pts := make([]*shortsv1alpha1.HousePricePoint, 0, 600)
	base := time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 600; i++ {
		pts = append(pts, &shortsv1alpha1.HousePricePoint{
			Period: timestamppb.New(base.AddDate(0, 3*i, 0)), Value: float64(i),
		})
	}
	src := &fakeDataSource{housePriceSeries: &shortsv1alpha1.GetHousePriceSeriesResponse{
		RegionCode: "AUS", Measure: "price_index", SourceLicence: "CC-BY-4.0", Points: pts,
	}}
	_, out, err := getHousePriceSeriesHandler(src)(context.Background(), nil,
		GetHousePriceSeriesInput{RegionCode: "AUS", Measure: "price_index"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count > maxHousingSeriesPoints {
		t.Errorf("series not downsampled: %d points", out.Count)
	}
	if out.Points[out.Count-1].Value != 599 {
		t.Errorf("downsampling dropped the latest observation: %+v", out.Points[out.Count-1])
	}
}

// ---------------------------------------------------------------------------
// get_suburb_profile
// ---------------------------------------------------------------------------

func fullProfile() *shortsv1alpha1.GetSuburbProfileResponse {
	return &shortsv1alpha1.GetSuburbProfileResponse{
		Summary: &shortsv1alpha1.SuburbSummary{
			SalCode: "SAL21234", SalName: "Richmond", StateCode: "VIC", Postcode: "3121",
			LatestMedianPrice: 1_450_000,
			LatestPeriod:      timestamppb.New(time.Date(2024, 12, 31, 0, 0, 0, 0, time.UTC)),
			YoyPct:            3.2, Population: 28_000, MedianAge: 34,
			MedianWeeklyHhdIncome: 2_400, PctBornOverseas: 31.4,
			TopLanguage: "Mandarin", PctTopLanguage: 4.2,
			FederalDivision: "Melbourne", FederalMember: "A Member", FederalParty: "Australian Greens",
			StateDistrict: "Richmond", StateMember: "A State Member", StateParty: "Australian Labor Party",
			Seifa: &shortsv1alpha1.SuburbSeifa{
				Irsad: &shortsv1alpha1.SuburbSeifaIndex{Score: 1080, DecileAus: 9, DecileState: 9},
			},
		},
		Demographics: &shortsv1alpha1.SuburbDemographics{
			MedianWeeklyRent: 550, MedianMonthlyMortgage: 2_800, PctRented: 48.2, CensusYear: 2021,
		},
		Baselines: &shortsv1alpha1.ComparisonBaselines{
			StateMedianPrice: 900_000, NationalMedianPrice: 850_000,
		},
		Council: &shortsv1alpha1.LgaInfo{LgaName: "Yarra"},
		Crime: &shortsv1alpha1.SuburbCrime{
			SourceJurisdiction: "NSW",
			Stats: []*shortsv1alpha1.SuburbCrimeStat{
				{CrimeType: "break_ins", PctRank: 62.5},
				{CrimeType: "violent", PctRank: 71.1},
				{CrimeType: "motor_vehicle", PctRank: 44.0},
			},
		},
	}
}

func TestGetSuburbProfileProjectsPublishableFacts(t *testing.T) {
	src := &fakeDataSource{suburbProfile: fullProfile()}
	_, out, err := getSuburbProfileHandler(src)(context.Background(), nil,
		GetSuburbProfileInput{SalCode: " SAL21234 "})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotSuburbProfile.GetSalCode() != "SAL21234" {
		t.Errorf("sal_code not trimmed: %q", src.gotSuburbProfile.GetSalCode())
	}
	if out.Suburb != "Richmond" || out.State != "VIC" || out.MedianPrice != 1_450_000 {
		t.Errorf("profile projected wrong: %+v", out)
	}
	if out.MedianPricePeriod != "2024-12-31" {
		t.Errorf("median_price_period = %q", out.MedianPricePeriod)
	}
	if out.Council != "Yarra" || out.SeifaIrsadDecileAus != 9 {
		t.Errorf("council/seifa projected wrong: %+v", out)
	}
	if out.CrimeBreakInsRank != 62.5 || out.CrimeJurisdiction != "NSW" {
		t.Errorf("crime ranks projected wrong: %+v", out)
	}
}

// The handler strips listing_stats when HOUSING_DROP_LISTINGS_ENABLED is off,
// so an absent block is how the kill switch reaches this tool. It must read as
// "not available", never as zero listings.
func TestGetSuburbProfileHandlesAbsentListingStats(t *testing.T) {
	src := &fakeDataSource{suburbProfile: fullProfile()}
	_, out, err := getSuburbProfileHandler(src)(context.Background(), nil,
		GetSuburbProfileInput{SalCode: "SAL21234"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.ListingsForSaleCount != 0 || out.ListingsMedianAsking != 0 {
		t.Errorf("absent listing stats must not become numbers: %+v", out)
	}
	if out.ListingsNote == "" {
		t.Error("an absent listing block must be explained, not silently omitted")
	}
}

func TestGetSuburbProfileSuppressesThinListingAggregates(t *testing.T) {
	p := fullProfile()
	p.ListingStats = &shortsv1alpha1.SuburbListingStats{
		ForSaleCount: 1, MedianAsking: 1_275_000, AvgAsking: 1_275_000,
		SoldCount: 2, MedianSold: 1_100_000,
	}
	src := &fakeDataSource{suburbProfile: p}
	_, out, err := getSuburbProfileHandler(src)(context.Background(), nil,
		GetSuburbProfileInput{SalCode: "SAL21234"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// One for-sale listing means median_asking IS that listing's asking price —
	// republication of a proprietary-tos-restricted row through an aggregate.
	if out.ListingsMedianAsking != 0 {
		t.Errorf("median asking published over %d listings, below the k=%d floor: %v",
			1, kAnonFloor, out.ListingsMedianAsking)
	}
	if out.ListingsMedianSold != 0 {
		t.Errorf("median sold published over 2 listings, below the k=%d floor: %v",
			kAnonFloor, out.ListingsMedianSold)
	}
	if out.ListingsForSaleCount != 1 || out.ListingsSoldCount != 2 {
		t.Errorf("counts are aggregates and may be published: %+v", out)
	}
}

// The handler strips listing_stats itself, so this only fires if that ever
// stops happening. It is the second reading of the takedown switch, on the
// surface that does the republishing.
func TestGetSuburbProfileStripsListingStatsWhenTheKillSwitchIsOff(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "off")
	p := fullProfile()
	p.ListingStats = &shortsv1alpha1.SuburbListingStats{
		ForSaleCount: 42, MedianAsking: 1_275_000, SoldCount: 18, MedianSold: 1_100_000,
	}
	src := &fakeDataSource{suburbProfile: p}
	_, out, err := getSuburbProfileHandler(src)(context.Background(), nil,
		GetSuburbProfileInput{SalCode: "SAL21234"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.ListingsForSaleCount != 0 || out.ListingsMedianAsking != 0 ||
		out.ListingsSoldCount != 0 || out.ListingsMedianSold != 0 {
		t.Errorf("no crawl-derived aggregate may survive the kill switch: %+v", out)
	}
	if out.ListingsNote == "" {
		t.Error("the absence should be explained")
	}
}

func TestGetSuburbProfilePublishesListingAggregatesAtTheFloor(t *testing.T) {
	p := fullProfile()
	p.ListingStats = &shortsv1alpha1.SuburbListingStats{
		ForSaleCount: 3, MedianAsking: 1_275_000, SoldCount: 5, MedianSold: 1_100_000,
	}
	src := &fakeDataSource{suburbProfile: p}
	_, out, err := getSuburbProfileHandler(src)(context.Background(), nil,
		GetSuburbProfileInput{SalCode: "SAL21234"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// median_sold publishes: sold_count counts only priced rows, so the floor
	// is keyed to the population the median was computed over.
	if out.ListingsMedianSold != 1_100_000 {
		t.Errorf("median_sold at or above the floor should publish: %+v", out)
	}
	// median_asking does NOT, at any count. for_sale_count counts every active
	// listing while the median covers priced listings only, so the floor cannot
	// be keyed correctly and the value is withheld outright.
	if out.ListingsMedianAsking != 0 {
		t.Errorf("median_asking must be withheld while the floor cannot be keyed to the priced count: %+v", out)
	}
}

func TestGetSuburbProfileDistinguishesNotFoundFromFailure(t *testing.T) {
	notFound := &fakeDataSource{err: connect.NewError(connect.CodeNotFound, errors.New("suburb not found"))}
	_, _, err := getSuburbProfileHandler(notFound)(context.Background(), nil,
		GetSuburbProfileInput{SalCode: "SAL99999"})
	if err == nil || !strings.Contains(err.Error(), "no suburb") {
		t.Errorf("a not-found should say the suburb does not exist, got %v", err)
	}

	broken := &fakeDataSource{err: errors.New("connection reset")}
	_, _, err = getSuburbProfileHandler(broken)(context.Background(), nil,
		GetSuburbProfileInput{SalCode: "SAL21234"})
	if err == nil || strings.Contains(err.Error(), "no suburb") {
		t.Errorf("a backend failure must not be reported as not-found, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// list_suburb_price_drops
// ---------------------------------------------------------------------------

func dropRow(name string, dropped, active, forSale int32) *shortsv1alpha1.SuburbPriceDrop {
	return &shortsv1alpha1.SuburbPriceDrop{
		RegionCode: "SUBURB:VIC-" + strings.ToUpper(name), SalCode: "SAL2" + name,
		SalName: name, StateCode: "VIC", Postcode: "3121",
		DroppedListingCount: dropped, TotalActiveListings: active,
		AvgDropPct: 0.062, MedianDropPct: 0.055, MaxDropPct: 0.39,
		MaxDropAbs: 410_000, DroppedShare: 0.24, DroppedValue: 1_200_000,
		ForSaleCount: forSale, AvgAsking: 1_300_000, MedianAsking: 1_275_000,
		SoldCount: 9, AvgSold: 1_100_000, MedianSold: 1_090_000,
	}
}

func TestListSuburbPriceDropsProjectsAggregatesOnly(t *testing.T) {
	src := &fakeDataSource{suburbPriceDrops: &shortsv1alpha1.ListSuburbPriceDropsResponse{
		Suburbs: []*shortsv1alpha1.SuburbPriceDrop{dropRow("Richmond", 12, 50, 50)},
	}}
	res, out, err := listSuburbPriceDropsHandler(src)(context.Background(), nil,
		ListSuburbPriceDropsInput{State: "vic"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.gotSuburbPriceDrops.GetStateCode() != "VIC" {
		t.Errorf("state not normalised: %q", src.gotSuburbPriceDrops.GetStateCode())
	}
	if out.Count != 1 {
		t.Fatalf("expected 1 suburb, got %d", out.Count)
	}
	row := out.Suburbs[0]
	if row.Suburb != "Richmond" || row.DroppedListingCount != 12 {
		t.Errorf("row projected wrong: %+v", row)
	}
	// Fractions in the proto, percentages on the wire.
	if row.AvgDropPct < 6.19 || row.AvgDropPct > 6.21 {
		t.Errorf("avg_drop_pct should be a percentage, got %v", row.AvgDropPct)
	}
	if row.DroppedSharePct < 23.9 || row.DroppedSharePct > 24.1 {
		t.Errorf("dropped_share_pct should be a percentage, got %v", row.DroppedSharePct)
	}
	// The extremum fields must not survive the projection in any form —
	// including the human-readable summary. Scanning only the structured
	// output left a hole: a restricted value formatted into the text content
	// was invisible to every test in the package, and the text is precisely
	// what gets pasted into a model's context.
	structured, _ := json.Marshal(out)
	full, _ := json.Marshal(res)
	for _, forbidden := range []string{"410000", "0.39", "1200000"} {
		if strings.Contains(string(structured), forbidden) {
			t.Errorf("structured output leaks a single-listing extremum (%s): %s", forbidden, structured)
		}
		if strings.Contains(string(full), forbidden) {
			t.Errorf("tool result (including the text summary) leaks a single-listing extremum (%s): %s", forbidden, full)
		}
	}
	if !strings.Contains(textOf(t, res), "aggregate") {
		t.Errorf("the summary should state that these are derived aggregates: %q", textOf(t, res))
	}
}

func TestListSuburbPriceDropsAppliesKAnonFloor(t *testing.T) {
	src := &fakeDataSource{suburbPriceDrops: &shortsv1alpha1.ListSuburbPriceDropsResponse{
		Suburbs: []*shortsv1alpha1.SuburbPriceDrop{
			dropRow("Thin", 1, 4, 1),
			dropRow("AlsoThin", 2, 6, 2),
			dropRow("Thick", 9, 40, 40),
		},
	}}
	_, out, err := listSuburbPriceDropsHandler(src)(context.Background(), nil, ListSuburbPriceDropsInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 1 || out.Suburbs[0].Suburb != "Thick" {
		t.Fatalf("suburbs below the k=%d floor must be suppressed entirely, got %+v", kAnonFloor, out.Suburbs)
	}
	if out.SuppressedSuburbs != 2 {
		t.Errorf("suppression must be reported, got %d", out.SuppressedSuburbs)
	}
	if !strings.Contains(out.Note, "fewer than") {
		t.Errorf("the note should explain the floor, got %q", out.Note)
	}
}

func TestListSuburbPriceDropsFloorsAskingSeparately(t *testing.T) {
	src := &fakeDataSource{suburbPriceDrops: &shortsv1alpha1.ListSuburbPriceDropsResponse{
		// Enough drops to publish the drop aggregates, but only two active
		// for-sale listings behind median_asking.
		Suburbs: []*shortsv1alpha1.SuburbPriceDrop{dropRow("Sparse", 4, 12, 2)},
	}}
	_, out, err := listSuburbPriceDropsHandler(src)(context.Background(), nil, ListSuburbPriceDropsInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.Count != 1 {
		t.Fatalf("expected the row to survive")
	}
	if out.Suburbs[0].MedianAsking != 0 {
		t.Errorf("median asking over %d listings is below the k=%d floor: %v",
			2, kAnonFloor, out.Suburbs[0].MedianAsking)
	}
}

func TestListSuburbPriceDropsHonoursTheKillSwitch(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "false")
	src := &fakeDataSource{suburbPriceDrops: &shortsv1alpha1.ListSuburbPriceDropsResponse{
		Suburbs: []*shortsv1alpha1.SuburbPriceDrop{dropRow("Richmond", 12, 50, 50)},
	}}
	res, out, err := listSuburbPriceDropsHandler(src)(context.Background(), nil, ListSuburbPriceDropsInput{})
	if err != nil {
		t.Fatalf("the kill switch must not be an obscure error: %v", err)
	}
	if out.Count != 0 || len(out.Suburbs) != 0 {
		t.Errorf("no crawl-derived rows may be served with the kill switch off: %+v", out)
	}
	if src.gotSuburbPriceDrops != nil {
		t.Error("the RPC should not have been reached at all")
	}
	if !strings.Contains(textOf(t, res), "unavailable") {
		t.Errorf("the caller should be told the surface is off, got %q", textOf(t, res))
	}
}

func TestListSuburbPriceDropsValidatesStateAndSort(t *testing.T) {
	src := &fakeDataSource{}
	if _, _, err := listSuburbPriceDropsHandler(src)(context.Background(), nil,
		ListSuburbPriceDropsInput{State: "QLDX"}); err == nil {
		t.Error("expected an invalid state to be rejected")
	}
	if _, _, err := listSuburbPriceDropsHandler(src)(context.Background(), nil,
		ListSuburbPriceDropsInput{Sort: "max"}); err == nil {
		t.Error("sorting by an extremum this tool does not publish must be rejected")
	}
	if src.gotSuburbPriceDrops != nil {
		t.Error("the RPC should not have been reached")
	}
}

func TestListSuburbPriceDropsClampsLimit(t *testing.T) {
	src := &fakeDataSource{suburbPriceDrops: &shortsv1alpha1.ListSuburbPriceDropsResponse{}}
	if _, _, err := listSuburbPriceDropsHandler(src)(context.Background(), nil,
		ListSuburbPriceDropsInput{Limit: 5000}); err != nil {
		t.Fatalf("over-asking should clamp, not error: %v", err)
	}
	if got := src.gotSuburbPriceDrops.GetLimit(); got != maxSuburbDropsLimit {
		t.Errorf("limit = %d, want %d", got, maxSuburbDropsLimit)
	}
}

func TestHousingToolsAreRegistered(t *testing.T) {
	want := map[string]string{
		"get_housing_overview":    "shorts.v1alpha1.HousingService.GetHousingOverview",
		"get_house_price_series":  "shorts.v1alpha1.HousingService.GetHousePriceSeries",
		"get_suburb_profile":      "shorts.v1alpha1.HousingService.GetSuburbProfile",
		"list_suburb_price_drops": "shorts.v1alpha1.HousingService.ListSuburbPriceDrops",
	}
	got := map[string]string{}
	for _, tool := range Registry() {
		if tool.Domain == "housing" {
			got[tool.Name] = tool.RPC
		}
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("housing tools registered as %v, want %v", got, want)
	}
}
