package shorts

import (
	"context"
	"errors"
	"testing"
	"time"

	"connectrpc.com/connect"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// TestGetDropIndexSeries_RejectsMalformedInput pins the input contract of the
// public index RPC. Every one of these used to pass straight through: a bad
// date reached Postgres's ::date cast and came back CodeInternal, and any
// grain/grain_key minted its own MemoryCache entry.
func TestGetDropIndexSeries_RejectsMalformedInput(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")

	for _, tc := range []struct {
		name string
		req  *shortsv1alpha1.GetDropIndexSeriesRequest
	}{
		{"unknown grain", &shortsv1alpha1.GetDropIndexSeriesRequest{Grain: "county"}},
		{"national with a state key", &shortsv1alpha1.GetDropIndexSeriesRequest{Grain: "national", GrainKey: "NSW"}},
		{"state without a key", &shortsv1alpha1.GetDropIndexSeriesRequest{Grain: "state"}},
		{"state with a bogus code", &shortsv1alpha1.GetDropIndexSeriesRequest{Grain: "state", GrainKey: "XX"}},
		{"suburb with a non-SAL key", &shortsv1alpha1.GetDropIndexSeriesRequest{Grain: "suburb", GrainKey: "SAL00001"}},
		{"suburb with a short key", &shortsv1alpha1.GetDropIndexSeriesRequest{Grain: "suburb", GrainKey: "2000"}},
		{"from not a date", &shortsv1alpha1.GetDropIndexSeriesRequest{From: "2026-13-01"}},
		{"to not ISO", &shortsv1alpha1.GetDropIndexSeriesRequest{To: "15/09/2026"}},
		{"to before tracking starts", &shortsv1alpha1.GetDropIndexSeriesRequest{To: "2026-08-01"}},
		{"from after to", &shortsv1alpha1.GetDropIndexSeriesRequest{From: "2026-09-10", To: "2026-09-01"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			// No expectations: validation must short-circuit before the store.
			srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
			_, err := srv.GetDropIndexSeries(context.Background(), connect.NewRequest(tc.req))
			if connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Fatalf("want InvalidArgument, got %v", err)
			}
		})
	}
}

// TestGetDropIndexSeries_NormalizesKeysAndCapsTo asserts equivalent requests
// share one normalized store call (and so one cache key), and that a future
// `to` is capped at today rather than minting a new key every day.
func TestGetDropIndexSeries_NormalizesKeysAndCapsTo(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")

	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	today := time.Now().UTC().Format("2006-01-02")
	store.EXPECT().GetDropIndexSeries("state", "VIC", dropIndexTrackingSince, today).
		Return([]*shortsstore.DropIndexPointRow{}, nil).Times(1)
	store.EXPECT().GetDropIndexSeries("suburb", "20495", dropIndexTrackingSince, today).
		Return([]*shortsstore.DropIndexPointRow{}, nil).Times(1)

	srv := newTestServer(t, store)
	for _, req := range []*shortsv1alpha1.GetDropIndexSeriesRequest{
		{Grain: " State ", GrainKey: " vic ", To: "2999-01-01"},
		{Grain: "state", GrainKey: "VIC"},
		{Grain: "suburb", GrainKey: " 20495 "},
	} {
		if _, err := srv.GetDropIndexSeries(context.Background(), connect.NewRequest(req)); err != nil {
			t.Fatalf("unexpected error for %+v: %v", req, err)
		}
	}
}

// TestGetDropIndexSeries_StampsAsOfAndCapsDataThroughAtCrawlHorizon covers the
// freshness pair on the index. The collector writes a snapshot every day even
// when the crawl is dead, so the snapshot date alone would claim data the
// numbers do not have: data_through must fall back to the crawl horizon the
// last MV refresh recorded when that is earlier.
func TestGetDropIndexSeries_StampsAsOfAndCapsDataThroughAtCrawlHorizon(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")

	computedEarly := time.Date(2026, 9, 21, 18, 0, 0, 0, time.UTC)
	computedLate := time.Date(2026, 9, 22, 18, 0, 5, 0, time.UTC)
	rows := []*shortsstore.DropIndexPointRow{
		{SnapshotDate: "2026-09-21", ComputedAt: computedEarly},
		{SnapshotDate: "2026-09-22", ComputedAt: computedLate},
	}

	for _, tc := range []struct {
		name  string
		crawl *time.Time
		want  time.Time
	}{
		{
			name:  "crawl stopped before the last snapshot",
			crawl: timePtr(time.Date(2026, 9, 15, 1, 46, 0, 0, time.UTC)),
			want:  time.Date(2026, 9, 15, 1, 46, 0, 0, time.UTC),
		},
		{
			name:  "crawl current",
			crawl: timePtr(time.Date(2026, 9, 23, 2, 0, 0, 0, time.UTC)),
			want:  time.Date(2026, 9, 22, 23, 59, 59, 0, time.UTC),
		},
		{
			name: "no refresh recorded",
			want: time.Date(2026, 9, 22, 23, 59, 59, 0, time.UTC),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mocks.NewMockShortsStore(ctrl)
			store.EXPECT().GetDropIndexSeries("national", "AU", gomock.Any(), gomock.Any()).Return(rows, nil)
			refresh := map[string]shortsstore.HousingMVRefreshRow{}
			if tc.crawl != nil {
				refresh[mvStatePriceDrops] = shortsstore.HousingMVRefreshRow{RefreshedAt: *tc.crawl, DataThrough: tc.crawl}
			}
			store.EXPECT().GetHousingMVRefresh([]string{mvStatePriceDrops}).Return(refresh, nil)

			srv := newTestServer(t, store)
			resp, err := srv.GetDropIndexSeries(context.Background(),
				connect.NewRequest(&shortsv1alpha1.GetDropIndexSeriesRequest{}))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got := resp.Msg.GetAsOf().AsTime(); !got.Equal(computedLate) {
				t.Errorf("as_of = %v, want latest computed_at %v", got, computedLate)
			}
			if got := resp.Msg.GetDataThrough().AsTime(); !got.Equal(tc.want) {
				t.Errorf("data_through = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestDropsFreshness_OlderViewWinsAndUnknownStaysUnset: a board joining two
// views is only as fresh as the staler one, and a missing refresh row, a
// missing table (the store maps that to an empty map) or a read error must
// leave the stamp unset rather than fail or invent a date.
func TestDropsFreshness_OlderViewWinsAndUnknownStaysUnset(t *testing.T) {
	older := time.Date(2026, 9, 15, 2, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 9, 20, 2, 0, 0, 0, time.UTC)
	crawlOld := time.Date(2026, 9, 15, 1, 46, 0, 0, time.UTC)
	crawlNew := time.Date(2026, 9, 20, 1, 0, 0, 0, time.UTC)

	t.Run("older of two", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mocks.NewMockShortsStore(ctrl)
		store.EXPECT().GetHousingMVRefresh(gomock.Any()).Return(map[string]shortsstore.HousingMVRefreshRow{
			mvSuburbListingStats: {RefreshedAt: newer, DataThrough: &crawlNew},
			mvSuburbPriceDrops:   {RefreshedAt: older, DataThrough: &crawlOld},
		}, nil)
		asOf, through := newTestServer(t, store).dropsFreshness(mvSuburbListingStats, mvSuburbPriceDrops)
		if !asOf.AsTime().Equal(older) || !through.AsTime().Equal(crawlOld) {
			t.Fatalf("got as_of=%v data_through=%v, want the older view's %v / %v", asOf.AsTime(), through.AsTime(), older, crawlOld)
		}
	})

	for name, stub := range map[string]func(*mocks.MockShortsStore){
		"one view never refreshed": func(m *mocks.MockShortsStore) {
			m.EXPECT().GetHousingMVRefresh(gomock.Any()).Return(map[string]shortsstore.HousingMVRefreshRow{
				mvSuburbListingStats: {RefreshedAt: newer, DataThrough: &crawlNew},
			}, nil)
		},
		"table missing": func(m *mocks.MockShortsStore) {
			m.EXPECT().GetHousingMVRefresh(gomock.Any()).Return(map[string]shortsstore.HousingMVRefreshRow{}, nil)
		},
		"read error": func(m *mocks.MockShortsStore) {
			m.EXPECT().GetHousingMVRefresh(gomock.Any()).Return(nil, errors.New("boom"))
		},
	} {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mocks.NewMockShortsStore(ctrl)
			stub(store)
			asOf, through := newTestServer(t, store).dropsFreshness(mvSuburbListingStats, mvSuburbPriceDrops)
			if asOf != nil || through != nil {
				t.Fatalf("want both unset, got as_of=%v data_through=%v", asOf, through)
			}
		})
	}
}

// TestGetPriceDropsOverview_MapsCoverageAndFreshness: the state rows carry the
// crawl coverage the UI uses to annotate rather than rank a barely-swept state,
// and the response carries the MV's refresh stamp.
func TestGetPriceDropsOverview_MapsCoverageAndFreshness(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")

	refreshed := time.Date(2026, 9, 15, 2, 0, 0, 0, time.UTC)
	crawl := time.Date(2026, 9, 15, 1, 46, 0, 0, time.UTC)
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	store.EXPECT().GetPriceDropsOverview().Return([]*shortsstore.StatePriceDropSummaryRow{
		{StateCode: "AU", DroppedCount: 10, SuburbsSwept14d: 196, CatalogSuburbs: 500},
		{StateCode: "SA", DroppedCount: 2, SuburbsSwept14d: 0, CatalogSuburbs: 66},
	}, nil)
	store.EXPECT().GetHousingMVRefresh([]string{mvStatePriceDrops}).Return(map[string]shortsstore.HousingMVRefreshRow{
		mvStatePriceDrops: {RefreshedAt: refreshed, DataThrough: &crawl},
	}, nil)

	resp, err := newTestServer(t, store).GetPriceDropsOverview(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetPriceDropsOverviewRequest{}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n := resp.Msg.GetNational(); n.GetSuburbsSwept_14D() != 196 || n.GetCatalogSuburbs() != 500 {
		t.Errorf("national coverage = %d/%d, want 196/500", n.GetSuburbsSwept_14D(), n.GetCatalogSuburbs())
	}
	if len(resp.Msg.GetStates()) != 1 || resp.Msg.GetStates()[0].GetCatalogSuburbs() != 66 {
		t.Errorf("state coverage not mapped: %+v", resp.Msg.GetStates())
	}
	if !resp.Msg.GetAsOf().AsTime().Equal(refreshed) || !resp.Msg.GetDataThrough().AsTime().Equal(crawl) {
		t.Errorf("freshness = %v / %v, want %v / %v",
			resp.Msg.GetAsOf().AsTime(), resp.Msg.GetDataThrough().AsTime(), refreshed, crawl)
	}
}

// TestListSuburbPriceDrops_ShareSortIsAllowed: 'share' is a public sort now,
// threaded to the store verbatim (the store owns the minimum-active floor).
func TestListSuburbPriceDrops_ShareSortIsAllowed(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")

	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	store.EXPECT().ListSuburbPriceDrops("NSW", "share", int32(25)).Return([]*shortsstore.SuburbPriceDropRow{}, nil)
	store.EXPECT().GetHousingMVRefresh(gomock.Any()).Return(nil, nil)
	if _, err := newTestServer(t, store).ListSuburbPriceDrops(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListSuburbPriceDropsRequest{StateCode: "NSW", Sort: " Share ", Limit: 25})); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestDropsKillSwitch_OnePolicyForEveryCrawlDerivedRead: with
// HOUSING_DROP_LISTINGS_ENABLED off, EVERY read derived from the ToS-restricted
// crawl — aggregates included — returns an empty success without touching the
// store. It used to differ by surface: the profile and MCP withheld the
// aggregates while ListSuburbPriceDrops and the index kept serving them.
func TestDropsKillSwitch_OnePolicyForEveryCrawlDerivedRead(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "false")

	calls := map[string]func(*ShortsServer) (int, error){
		"ListSuburbPriceDrops": func(s *ShortsServer) (int, error) {
			r, err := s.ListSuburbPriceDrops(context.Background(), connect.NewRequest(&shortsv1alpha1.ListSuburbPriceDropsRequest{}))
			if err != nil {
				return 0, err
			}
			return len(r.Msg.GetSuburbs()), nil
		},
		"GetPriceDropsOverview": func(s *ShortsServer) (int, error) {
			r, err := s.GetPriceDropsOverview(context.Background(), connect.NewRequest(&shortsv1alpha1.GetPriceDropsOverviewRequest{}))
			if err != nil {
				return 0, err
			}
			n := len(r.Msg.GetStates())
			if r.Msg.GetNational() != nil {
				n++
			}
			return n, nil
		},
		"GetDropIndexSeries": func(s *ShortsServer) (int, error) {
			r, err := s.GetDropIndexSeries(context.Background(), connect.NewRequest(&shortsv1alpha1.GetDropIndexSeriesRequest{Grain: "suburb", GrainKey: "20495"}))
			if err != nil {
				return 0, err
			}
			return len(r.Msg.GetPoints()), nil
		},
		"ListAgencyPriceStats": func(s *ShortsServer) (int, error) {
			r, err := s.ListAgencyPriceStats(context.Background(), connect.NewRequest(&shortsv1alpha1.ListAgencyPriceStatsRequest{}))
			if err != nil {
				return 0, err
			}
			return len(r.Msg.GetAgencies()), nil
		},
		"ListAddressPriceDrops": func(s *ShortsServer) (int, error) {
			r, err := s.ListAddressPriceDrops(context.Background(), connect.NewRequest(&shortsv1alpha1.ListAddressPriceDropsRequest{}))
			if err != nil {
				return 0, err
			}
			return len(r.Msg.GetAddresses()), nil
		},
		"ListSuburbDropListings": func(s *ShortsServer) (int, error) {
			r, err := s.ListSuburbDropListings(context.Background(), connect.NewRequest(&shortsv1alpha1.ListSuburbDropListingsRequest{SalCode: "20495"}))
			if err != nil {
				return 0, err
			}
			return len(r.Msg.GetListings()), nil
		},
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			// No expectations: the switch must stop the read before the store.
			n, err := call(newTestServer(t, mocks.NewMockShortsStore(ctrl)))
			if err != nil {
				t.Fatalf("want an empty success, got %v", err)
			}
			if n != 0 {
				t.Fatalf("want no rows, got %d", n)
			}
		})
	}

	t.Run("GetSuburbProfile listing_stats", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mocks.NewMockShortsStore(ctrl)
		store.EXPECT().GetSuburbProfile("20495").Return(&shortsstore.SuburbProfileRow{
			Summary:      shortsstore.SuburbSummaryRow{SALCode: "20495", SALName: "Richmond", StateCode: "VIC"},
			ListingStats: &shortsstore.SuburbListingStatsRow{ForSaleCount: 40, MedianAsking: 1.1e6},
		}, nil)
		store.EXPECT().GetHousingMVRefresh(gomock.Any()).Return(nil, nil).AnyTimes()
		resp, err := newTestServer(t, store).GetSuburbProfile(context.Background(),
			connect.NewRequest(&shortsv1alpha1.GetSuburbProfileRequest{SalCode: "20495"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if resp.Msg.GetListingStats() != nil {
			t.Fatal("listing_stats must be withheld while the kill switch is off")
		}
	})
}

// TestGetSuburbProfile_ListingStatsCarryFreshness: the profile's asking/sold
// estimate carries the refresh stamp of the view it came from.
func TestGetSuburbProfile_ListingStatsCarryFreshness(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")

	refreshed := time.Date(2026, 9, 15, 2, 0, 0, 0, time.UTC)
	crawl := time.Date(2026, 9, 15, 1, 46, 0, 0, time.UTC)
	ctrl := gomock.NewController(t)
	store := mocks.NewMockShortsStore(ctrl)
	store.EXPECT().GetSuburbProfile("20495").Return(&shortsstore.SuburbProfileRow{
		Summary:      shortsstore.SuburbSummaryRow{SALCode: "20495", SALName: "Richmond", StateCode: "VIC"},
		ListingStats: &shortsstore.SuburbListingStatsRow{ForSaleCount: 40, MedianAsking: 1.1e6},
	}, nil)
	store.EXPECT().GetHousingMVRefresh([]string{mvSuburbListingStats}).Return(map[string]shortsstore.HousingMVRefreshRow{
		mvSuburbListingStats: {RefreshedAt: refreshed, DataThrough: &crawl},
	}, nil)
	resp, err := newTestServer(t, store).GetSuburbProfile(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetSuburbProfileRequest{SalCode: "20495"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	stats := resp.Msg.GetListingStats()
	if !stats.GetAsOf().AsTime().Equal(refreshed) || !stats.GetDataThrough().AsTime().Equal(crawl) {
		t.Fatalf("listing_stats freshness = %v / %v, want %v / %v",
			stats.GetAsOf().AsTime(), stats.GetDataThrough().AsTime(), refreshed, crawl)
	}
}

func timePtr(t time.Time) *time.Time { return &t }
