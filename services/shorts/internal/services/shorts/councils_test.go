package shorts

import (
	"context"
	"errors"
	"testing"
	"time"

	"connectrpc.com/connect"
	"go.uber.org/mock/gomock"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"

	optionsv1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/options/v1"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestListCouncils_RejectsBadStates(t *testing.T) {
	for _, state := range []string{"", "   ", "XYZ", "New South Wales", "NSW; DROP TABLE lga"} {
		ctrl := gomock.NewController(t)
		srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
		_, err := srv.ListCouncils(context.Background(), connect.NewRequest(&shortsv1alpha1.ListCouncilsRequest{StateCode: state}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("state %q: want InvalidArgument, got %v", state, err)
		}
	}
}

func TestListCouncils_NormalizesStateBeforeStoreAndCache(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	store.EXPECT().ListCouncils("VIC").Return([]*shortsstore.CouncilSummaryRow{{
		LgaCode: "27350", Slug: "yarra", DisplayName: "Yarra", Kind: "council", StateCode: "VIC",
		Population: 101356, ErpYear: 2025, PopGrowthPct: f64(1.234567),
		DensityPerSqkm: f64(5197.743589), FloodSharePct: f64(12.3456), PriceDropShare: f64(0.041666),
		HouseMedian: f64(1_500_000), HouseMedianPeriod: "2023-24",
	}}, nil).Times(1)
	srv := newTestServer(t, store)
	for _, state := range []string{" vic ", "VIC", "Vic"} {
		resp, err := srv.ListCouncils(context.Background(), connect.NewRequest(&shortsv1alpha1.ListCouncilsRequest{StateCode: state}))
		if err != nil {
			t.Fatalf("%q: %v", state, err)
		}
		c := resp.Msg.Councils[0]
		if c.GetPopGrowthPct() != 1.23 || c.GetDensityPerSqkm() != 5197.7 || c.GetFloodSharePct() != 12.3 || c.GetPriceDropShare() != 0.042 {
			t.Errorf("rounding: %+v", c)
		}
		if c.GetCouncilHouseMedian() != 1_500_000 || c.CouncilHouseMedianPeriod != "2023-24" {
			t.Errorf("council median not mapped: %+v", c)
		}
		// NULL stays absent: no FAG, no approvals, no bushfire source.
		if c.FagPerResident != nil || c.ApprovalsPer_1000 != nil || c.BushfireSharePct != nil || c.SeifaIrsadDecile != nil {
			t.Errorf("absent facts must stay absent: %+v", c)
		}
		if resp.Msg.LgaVintage == "" {
			t.Error("no LGA vintage")
		}
	}
}

func TestGetCouncilProfile_ValidatesAndNormalizes(t *testing.T) {
	t.Run("bad state is InvalidArgument", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
		_, err := srv.GetCouncilProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCouncilProfileRequest{StateCode: "QQ", Slug: "yarra"}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("want InvalidArgument, got %v", err)
		}
	})
	t.Run("empty slug is InvalidArgument", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
		_, err := srv.GetCouncilProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCouncilProfileRequest{StateCode: "VIC", Slug: "  "}))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("want InvalidArgument, got %v", err)
		}
	})
	t.Run("a slug that cannot exist is NotFound without a query", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		srv := newTestServer(t, mocks.NewMockShortsStore(ctrl)) // no EXPECT: any store call fails
		for _, slug := range []string{"../etc", "yarra--city", "yarra city", "-yarra", "yarra'", "a%20b"} {
			_, err := srv.GetCouncilProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCouncilProfileRequest{StateCode: "VIC", Slug: slug}))
			if connect.CodeOf(err) != connect.CodeNotFound {
				t.Errorf("slug %q: want NotFound, got %v", slug, err)
			}
		}
	})
	t.Run("unknown slug is NotFound", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mocks.NewMockShortsStore(ctrl)
		store.EXPECT().GetCouncilProfile("VIC", "nowhere").Return(nil, shortsstore.ErrCouncilNotFound)
		srv := newTestServer(t, store)
		_, err := srv.GetCouncilProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCouncilProfileRequest{StateCode: "VIC", Slug: "nowhere"}))
		if connect.CodeOf(err) != connect.CodeNotFound {
			t.Fatalf("want NotFound, got %v", err)
		}
	})
	t.Run("a database error is Internal, not NotFound", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mocks.NewMockShortsStore(ctrl)
		store.EXPECT().GetCouncilProfile("VIC", "yarra").Return(nil, errors.New("relation lga_series does not exist"))
		srv := newTestServer(t, store)
		_, err := srv.GetCouncilProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCouncilProfileRequest{StateCode: "VIC", Slug: "yarra"}))
		if connect.CodeOf(err) != connect.CodeInternal {
			t.Fatalf("want Internal, got %v", err)
		}
	})
	t.Run("case and whitespace share one store call and cache entry", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mocks.NewMockShortsStore(ctrl)
		store.EXPECT().GetCouncilProfile("VIC", "yarra").Return(&shortsstore.CouncilProfileRow{
			Summary: &shortsstore.CouncilSummaryRow{LgaCode: "27350", Slug: "yarra"},
		}, nil).Times(1)
		srv := newTestServer(t, store)
		for _, req := range [][2]string{{"vic", " Yarra "}, {"VIC", "yarra"}, {" Vic", "YARRA"}} {
			if _, err := srv.GetCouncilProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCouncilProfileRequest{StateCode: req[0], Slug: req[1]})); err != nil {
				t.Fatalf("%v: %v", req, err)
			}
		}
	})
}

func TestGetCouncilProfile_MapsEveryBlock(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	asOf := time.Date(2026, 9, 20, 3, 0, 0, 0, time.UTC)
	period := time.Date(2026, 6, 30, 0, 0, 0, 0, time.UTC)
	row := &shortsstore.CouncilProfileRow{
		LgaName: "Canterbury-Bankstown", AreaSqkm: 110.2, FagAud: 13_757_751, FagYear: "2025-26", FactsAsOf: &asOf,
		Facts: shortsstore.SuburbCouncilRow{
			Slug: "canterbury-bankstown", DisplayName: "Canterbury-Bankstown", Kind: "council", ErpYear: 2025,
			PopGrowthPct: f64(1.05), Website: "https://www.cbcity.nsw.gov.au/", WikidataQID: "Q24070750",
			DominantShare: f64(0.5), HouseMedian: f64(1_399_999), HouseMedianPeriod: "2023-24",
		},
		Summary: &shortsstore.CouncilSummaryRow{LgaCode: "11570", Slug: "canterbury-bankstown", Population: 389687, ErpYear: 2025},
		Series: []shortsstore.CouncilSeriesRow{
			{Measure: "erp", Unit: "persons", Source: "abs_erp_lga", SourceLicence: "CC-BY-4.0",
				Points: []shortsstore.CouncilSeriesPointRow{{Period: period, PeriodLabel: "2025", Value: 389687}}},
			{Measure: "dwelling_approvals_total", Unit: "count", Source: "abs_ba_lga", SourceLicence: "CC-BY-4.0",
				Points: []shortsstore.CouncilSeriesPointRow{{Period: period, PeriodLabel: "2026-06", Value: 140}}},
		},
		Suburbs: []shortsstore.CouncilSuburbRow{
			{SALCode: "12166", SALName: "Kingsgrove", Population: 14000, Share: 0.49123, Dominant: true,
				VGMedian: f64(1_900_000), VGMedianPeriod: &period, BushfireSharePct: f64(0)},
			{SALCode: "99999", SALName: "Unpriced", Population: 10, Share: 0.07, Dominant: false,
				VGMedian: f64(1), VGMedianPeriod: nil},
		},
		Rollup:       shortsstore.CouncilRollupRow{MemberSuburbs: 2, DominantSuburbs: 1, BushfireSharePct: f64(5.19327), BushfireCoveredSuburbs: 41},
		FederalSeats: []shortsstore.CouncilRepresentativeRow{{Name: "Watson", PopulationShare: 0.6, SuburbCount: 12}},
		PriceDrops: &shortsstore.CouncilPriceDropsRow{Dropped: 7, Tracked: 100, DroppedShare: 0.07, MedianDropPct: f64(0.04123),
			Suburbs: []shortsstore.CouncilDropSuburbRow{{SALCode: "12166", SALName: "Kingsgrove", Dropped: 4, Tracked: 30}}},
		Neighbours: []shortsstore.CouncilNeighbourRow{{LgaCode: "12930", Slug: "georges-river", DisplayName: "Georges River", SharesBorder: true, SharedSuburbs: 3}},
	}
	store.EXPECT().GetCouncilProfile("NSW", "canterbury-bankstown").Return(row, nil)
	srv := newTestServer(t, store)
	resp, err := srv.GetCouncilProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCouncilProfileRequest{StateCode: "NSW", Slug: "canterbury-bankstown"}))
	if err != nil {
		t.Fatal(err)
	}
	p := resp.Msg.Profile
	if p.Council.LgaCode != "11570" || p.Council.Population != 389687 || p.Council.DisplayName != "Canterbury-Bankstown" {
		t.Errorf("identity: %+v", p.Council)
	}
	if p.Council.DominantShare != nil {
		t.Error("dominant_share is a suburb fact and must not appear on the council")
	}
	if p.Council.GetCouncilHouseMedian() != 1_399_999 || p.Council.CouncilHouseMedianPeriod != "2023-24" {
		t.Errorf("council median: %+v", p.Council)
	}
	if p.FactsAsOf != "2026-09-20" || p.LgaVintage == "" {
		t.Errorf("as-of %q vintage %q", p.FactsAsOf, p.LgaVintage)
	}
	if got := p.Series[0]; got.Frequency != "annual" || got.Points[0].Period != "2026-06-30" || got.Points[0].PeriodLabel != "2025" {
		t.Errorf("erp series: %+v", got)
	}
	if p.Series[1].Frequency != "monthly" {
		t.Errorf("approvals frequency %q", p.Series[1].Frequency)
	}
	k := p.Suburbs[0]
	if k.Share != 0.491 || !k.Dominant || k.GetVgMedian() != 1_900_000 || k.VgMedianPeriod != "2026-06-30" {
		t.Errorf("member suburb: %+v", k)
	}
	if k.BushfireSharePct == nil || *k.BushfireSharePct != 0 {
		t.Error("a measured 0% bushfire share must survive as a present 0")
	}
	if k.FloodSharePct != nil {
		t.Error("an uncovered flood share must stay absent")
	}
	if p.Suburbs[1].VgMedian != nil {
		t.Error("a median without a period must not be published")
	}
	if p.Rollup.GetBushfireSharePct() != 5.2 || p.Rollup.FloodSharePct != nil {
		t.Errorf("rollup: %+v", p.Rollup)
	}
	if p.PriceDrops.DroppedListingCount != 7 || p.PriceDrops.GetMedianDropPct() != 0.0412 || p.PriceDrops.Suburbs[0].DroppedShare != 0.133 {
		t.Errorf("drops: %+v", p.PriceDrops)
	}
	if len(p.FederalElectorates) != 1 || len(p.StateDistricts) != 0 {
		t.Errorf("representation: %v / %v", p.FederalElectorates, p.StateDistricts)
	}
	if n := p.Neighbours[0]; !n.SharesBorder || n.SharedSuburbs != 3 || n.Slug != "georges-river" {
		t.Errorf("neighbour: %+v", n)
	}
}

// The drops aggregate is crawl-derived: it may never carry a listing.
func TestGetCouncilProfile_DropsCarryNoListingFields(t *testing.T) {
	fields := (&shortsv1alpha1.CouncilDropSuburb{}).ProtoReflect().Descriptor().Fields()
	for i := 0; i < fields.Len(); i++ {
		switch name := string(fields.Get(i).Name()); name {
		case "address", "display_address", "listing_url", "address_key", "agency_name", "price":
			t.Errorf("CouncilDropSuburb carries listing field %q", name)
		}
	}
}

func TestCouncilRPCsArePublicOnDomainAndLegacyServices(t *testing.T) {
	for _, svc := range []protoreflect.FullName{"shorts.v1alpha1.HousingService", "shorts.v1alpha1.ShortedStocksService"} {
		desc, err := protoregistry.GlobalFiles.FindDescriptorByName(svc)
		if err != nil {
			t.Fatalf("%s: %v", svc, err)
		}
		methods := desc.(protoreflect.ServiceDescriptor).Methods()
		for _, rpc := range []protoreflect.Name{"ListCouncils", "GetCouncilProfile"} {
			m := methods.ByName(rpc)
			if m == nil {
				t.Errorf("%s.%s is missing", svc, rpc)
				continue
			}
			if vis := proto.GetExtension(m.Options(), optionsv1.E_Visibility).(optionsv1.Visibility); vis != optionsv1.Visibility_VISIBILITY_PUBLIC {
				t.Errorf("%s.%s visibility = %v, want VISIBILITY_PUBLIC", svc, rpc, vis)
			}
		}
	}
}

// HOUSING_DROP_LISTINGS_ENABLED=false must strip every crawl-derived council
// field on the NEXT request — outside the backend cache, on a clone, so the
// cached response (and a later flip back on) is untouched.
func TestCouncilRPCs_HonourTheDropListingsKillSwitch(t *testing.T) {
	asOf := time.Date(2026, 9, 24, 1, 0, 0, 0, time.UTC)
	through := asOf.Add(-2 * time.Hour)
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	store.EXPECT().ListCouncils("NSW").Return([]*shortsstore.CouncilSummaryRow{
		{LgaCode: "11570", Slug: "canterbury-bankstown", Kind: "council", StateCode: "NSW",
			PriceDropShare: f64(0.07), PriceDropsAsOf: &asOf, PriceDropsDataThrough: &through},
		{LgaCode: "12930", Slug: "georges-river", Kind: "council", StateCode: "NSW"},
	}, nil).Times(1)
	store.EXPECT().GetCouncilProfile("NSW", "canterbury-bankstown").Return(&shortsstore.CouncilProfileRow{
		Summary: &shortsstore.CouncilSummaryRow{LgaCode: "11570", Slug: "canterbury-bankstown", PriceDropShare: f64(0.07)},
		PriceDrops: &shortsstore.CouncilPriceDropsRow{Dropped: 7, Tracked: 100, DroppedShare: 0.07, AsOf: asOf, DataThrough: &through,
			Suburbs: []shortsstore.CouncilDropSuburbRow{{SALCode: "12166", SALName: "Kingsgrove", Dropped: 4, Tracked: 30}}},
	}, nil).Times(1)
	srv := newTestServer(t, store)
	list := func() *shortsv1alpha1.ListCouncilsResponse {
		resp, err := srv.ListCouncils(context.Background(), connect.NewRequest(&shortsv1alpha1.ListCouncilsRequest{StateCode: "NSW"}))
		if err != nil {
			t.Fatal(err)
		}
		return resp.Msg
	}
	profile := func() *shortsv1alpha1.CouncilProfile {
		resp, err := srv.GetCouncilProfile(context.Background(), connect.NewRequest(&shortsv1alpha1.GetCouncilProfileRequest{StateCode: "NSW", Slug: "canterbury-bankstown"}))
		if err != nil {
			t.Fatal(err)
		}
		return resp.Msg.Profile
	}

	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")
	on := list()
	if on.Councils[0].GetPriceDropShare() != 0.07 || !on.PriceDropsAsOf.AsTime().Equal(asOf) || !on.PriceDropsDataThrough.AsTime().Equal(through) {
		t.Fatalf("switch on: share and its dates must be served: %+v", on)
	}
	if p := profile(); p.PriceDrops == nil || !p.PriceDrops.AsOf.AsTime().Equal(asOf) || !p.PriceDrops.DataThrough.AsTime().Equal(through) {
		t.Fatalf("switch on: drops and their dates must be served: %+v", p.PriceDrops)
	}

	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "false")
	off := list()
	for _, c := range off.Councils {
		if c.PriceDropShare != nil {
			t.Errorf("switch off: %s still carries a crawl-derived share", c.Slug)
		}
	}
	if off.PriceDropsAsOf != nil || off.PriceDropsDataThrough != nil {
		t.Error("switch off: drops freshness still served")
	}
	if len(off.Councils) != 2 || off.Councils[0].Slug != "canterbury-bankstown" {
		t.Errorf("switch off must strip only the crawl fields: %+v", off.Councils)
	}
	if p := profile(); p.PriceDrops != nil || p.Summary.PriceDropShare != nil {
		t.Errorf("switch off: profile still carries drops: %+v / %v", p.PriceDrops, p.Summary.PriceDropShare)
	}

	// The cached objects were cloned, not mutated: flipping back serves them again.
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")
	if list().Councils[0].GetPriceDropShare() != 0.07 || profile().PriceDrops == nil {
		t.Error("stripping mutated the cached response")
	}
}
