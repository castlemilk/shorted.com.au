package shorts

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestListStateSuburbs_RequiresState(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
	_, err := srv.ListStateSuburbs(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListStateSuburbsRequest{StateCode: ""}))
	if err == nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("want InvalidArgument, got %v", err)
	}
}

// TestGetPropertyHistory_FlagGate_ReturnsEmptyWhenDisabled asserts GetPropertyHistory
// reads the SAME ToS-restricted per-listing data as ListSuburbDropListings, so the
// HOUSING_DROP_LISTINGS_ENABLED kill switch (enabled by default, an explicit
// falsey value disables) returns an empty response and never touches the store.
func TestGetPropertyHistory_FlagGate_ReturnsEmptyWhenDisabled(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "false")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	// No EXPECT() on GetPropertyHistory: the flag gate must short-circuit before
	// the store is ever consulted.
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetPropertyHistory(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetPropertyHistoryRequest{AddressKey: "vic-richmond-1-smith-st"}))
	if err != nil {
		t.Fatalf("want nil error when flag disabled, got %v", err)
	}
	if resp.Msg.AddressKey != "" || len(resp.Msg.Events) != 0 || resp.Msg.Current != nil {
		t.Fatalf("want empty response when flag disabled, got %+v", resp.Msg)
	}
}

// TestGetPropertyHistory_RequiresAddressKey asserts an empty address_key returns
// an empty response (not an error) even with the flag enabled.
func TestGetPropertyHistory_RequiresAddressKey(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	srv := newTestServer(t, mockStore)

	resp, err := srv.GetPropertyHistory(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetPropertyHistoryRequest{AddressKey: ""}))
	if err != nil {
		t.Fatalf("want nil error for empty address_key, got %v", err)
	}
	if resp.Msg.AddressKey != "" {
		t.Fatalf("want empty response for empty address_key, got %+v", resp.Msg)
	}
}

// TestGetPropertyHistory_FlagEnabled_ReturnsTimeline asserts that with the flag
// on, the handler maps the store result through to the response, including the
// current-listing snapshot and the merged event timeline.
func TestGetPropertyHistory_FlagEnabled_ReturnsTimeline(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)

	firstSeen := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	lastSeen := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	observed := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)

	mockStore.EXPECT().GetPropertyHistory("vic-richmond-1-smith-st").Return(&shortsstore.PropertyHistoryResult{
		AddressKey:     "vic-richmond-1-smith-st",
		DisplayAddress: "1 Smith St",
		Suburb:         "Richmond",
		StateCode:      "VIC",
		Postcode:       "3121",
		Current: &shortsstore.PropertyListingSnapshotRow{
			Source: "rea", ListingID: "123", ListingURL: "https://realestate.com.au/123",
			Price: 950000, PriceDisplay: "$950,000", PriceKind: "fixed",
			ListingStatus: "for_sale", IsActive: true,
			Bedrooms: 3, Bathrooms: 2, CarSpaces: 1, LandSizeSqm: 450,
			PropertyType: "house", DisplayAddress: "1 Smith St", Suburb: "Richmond",
			StateCode: "VIC", Postcode: "3121", FirstSeenAt: firstSeen, LastSeenAt: lastSeen,
		},
		Events: []*shortsstore.PropertyPriceEventRow{
			{ObservedAt: observed, EventType: "price_drop", Source: "rea", ListingID: "123",
				Price: 950000, PrevPrice: 1000000, DropAbs: 50000, DropPct: 0.05,
				ListingStatus: "for_sale", PrevStatus: "for_sale"},
		},
		NumListings:  1,
		FirstPrice:   1000000,
		CurrentPrice: 950000,
	}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetPropertyHistory(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetPropertyHistoryRequest{AddressKey: "vic-richmond-1-smith-st"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Msg.AddressKey != "vic-richmond-1-smith-st" {
		t.Fatalf("want address_key echoed, got %q", resp.Msg.AddressKey)
	}
	if resp.Msg.Current == nil || resp.Msg.Current.ListingId != "123" {
		t.Fatalf("want current listing snapshot mapped, got %+v", resp.Msg.Current)
	}
	if resp.Msg.Current.FirstSeenAt != firstSeen.Format(time.RFC3339) {
		t.Fatalf("want RFC3339 first_seen_at, got %q", resp.Msg.Current.FirstSeenAt)
	}
	if len(resp.Msg.Events) != 1 || resp.Msg.Events[0].DropPct != 0.05 {
		t.Fatalf("want 1 mapped price event, got %+v", resp.Msg.Events)
	}
	if resp.Msg.NumListings != 1 || resp.Msg.FirstPrice != 1000000 || resp.Msg.CurrentPrice != 950000 {
		t.Fatalf("want num_listings/first_price/current_price mapped, got %+v", resp.Msg)
	}
}

// TestGetPropertyHistory_SurfacesDistinctDwellings asserts the multi-unit guard:
// when a single address_key groups >1 dwelling profile (a likely over-collapse of
// units the portal listed without a unit number), the store's DistinctDwellings
// count flows through to the response so the view can warn the timeline may blend
// more than one physical dwelling.
func TestGetPropertyHistory_SurfacesDistinctDwellings(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)

	mockStore.EXPECT().GetPropertyHistory("vic-brighton-1-centre-rd").Return(&shortsstore.PropertyHistoryResult{
		AddressKey:     "vic-brighton-1-centre-rd",
		DisplayAddress: "1 Centre Road",
		Suburb:         "Brighton",
		StateCode:      "VIC",
		Postcode:       "3186",
		Current: &shortsstore.PropertyListingSnapshotRow{
			Source: "rea", ListingID: "9", ListingURL: "https://realestate.com.au/9",
			Price: 800000, ListingStatus: "for_sale", IsActive: true, Bedrooms: 2, Bathrooms: 1,
		},
		NumListings:       5,
		DistinctDwellings: 3,
	}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetPropertyHistory(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetPropertyHistoryRequest{AddressKey: "vic-brighton-1-centre-rd"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Msg.DistinctDwellings != 3 {
		t.Fatalf("want distinct_dwellings=3 surfaced, got %d", resp.Msg.DistinctDwellings)
	}
}

// TestListAddressPriceDrops_FlagGate_ReturnsEmptyWhenDisabled asserts the
// drops-by-address board reads the SAME ToS-restricted per-listing rows, so the
// HOUSING_DROP_LISTINGS_ENABLED kill switch (explicit falsey value) returns an
// empty list and never touches the store.
func TestListAddressPriceDrops_FlagGate_ReturnsEmptyWhenDisabled(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "false")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	// No EXPECT() on ListAddressPriceDrops: the flag gate short-circuits first.
	srv := newTestServer(t, mockStore)

	resp, err := srv.ListAddressPriceDrops(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListAddressPriceDropsRequest{StateCode: "VIC", WindowDays: 90, Limit: 50}))
	if err != nil {
		t.Fatalf("want nil error when flag disabled, got %v", err)
	}
	if len(resp.Msg.Addresses) != 0 {
		t.Fatalf("want empty list when flag disabled, got %d", len(resp.Msg.Addresses))
	}
}

// TestListAddressPriceDrops_FlagEnabled_ReturnsRanked asserts the handler maps
// store rows through to the response, converting LastObservedAt to RFC3339.
func TestListAddressPriceDrops_FlagEnabled_ReturnsRanked(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)

	lastObs := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)
	mockStore.EXPECT().ListAddressPriceDrops("VIC", "", int32(90), int32(50)).Return([]*shortsstore.AddressPriceDropRow{
		{
			AddressKey: "vic-brighton-1-centre-rd", DisplayAddress: "1 Centre Road",
			Suburb: "Brighton", StateCode: "VIC", Postcode: "3186",
			FirstPrice: 1000000, CurrentPrice: 900000, DropAbs: 100000, DropPct: 0.1,
			NumListings: 3, LatestSource: "rea", LatestListingURL: "https://realestate.com.au/9",
			LastObservedAt: lastObs, PropertyType: "house", Bedrooms: 4, Bathrooms: 2,
		},
	}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.ListAddressPriceDrops(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListAddressPriceDropsRequest{StateCode: "VIC", WindowDays: 90, Limit: 50}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Msg.Addresses) != 1 {
		t.Fatalf("want 1 address mapped, got %d", len(resp.Msg.Addresses))
	}
	a := resp.Msg.Addresses[0]
	if a.AddressKey != "vic-brighton-1-centre-rd" || a.DropPct != 0.1 || a.NumListings != 3 {
		t.Fatalf("want row mapped, got %+v", a)
	}
	if a.LastObservedAt != lastObs.Format(time.RFC3339) {
		t.Fatalf("want RFC3339 last_observed_at, got %q", a.LastObservedAt)
	}
}

// TestGetSuburbProfile_MapsBanner asserts the editorial banner (archetype,
// blurb, landmarks) threads from the store row through to the response the
// same way council/similar already do, and that an empty bg_key defaults to
// the archetype so the frontend always has a usable background asset key.
func TestGetSuburbProfile_MapsBanner(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)

	mockStore.EXPECT().GetSuburbProfile("21063110123").Return(&shortsstore.SuburbProfileRow{
		Summary: shortsstore.SuburbSummaryRow{
			SALCode: "21063110123", SALName: "Richmond", StateCode: "VIC",
		},
		BannerArchetype: "inner-urban-terrace",
		BannerBlurb:     "Warehouse conversions and laneway cafes minutes from the CBD.",
		BannerLandmarks: []byte(`[{"name":"MCG","kind":"landmark"},{"name":"Bridge Road","kind":"shopping"}]`),
		BannerBgKey:     "",
		BannerBgUrl:     "",
	}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetSuburbProfile(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetSuburbProfileRequest{SalCode: "21063110123"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	banner := resp.Msg.Banner
	if banner == nil {
		t.Fatalf("want banner set, got nil")
	}
	if banner.Archetype != "inner-urban-terrace" {
		t.Fatalf("want archetype mapped, got %q", banner.Archetype)
	}
	if banner.Blurb != "Warehouse conversions and laneway cafes minutes from the CBD." {
		t.Fatalf("want blurb mapped, got %q", banner.Blurb)
	}
	if banner.BgKey != "inner-urban-terrace" {
		t.Fatalf("want bg_key to default to archetype when empty, got %q", banner.BgKey)
	}
	if len(banner.Landmarks) != 2 || banner.Landmarks[0].Name != "MCG" || banner.Landmarks[0].Kind != "landmark" {
		t.Fatalf("want 2 landmarks mapped, got %+v", banner.Landmarks)
	}
}

// TestGetSuburbProfile_BannerBgKeyExplicit asserts an explicit bg_key from the
// store is preserved rather than overwritten by the archetype default.
func TestGetSuburbProfile_BannerBgKeyExplicit(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)

	mockStore.EXPECT().GetSuburbProfile("21063110123").Return(&shortsstore.SuburbProfileRow{
		Summary: shortsstore.SuburbSummaryRow{
			SALCode: "21063110123", SALName: "Richmond", StateCode: "VIC",
		},
		BannerArchetype: "inner-urban-terrace",
		BannerBgKey:     "coastal-beach",
	}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetSuburbProfile(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetSuburbProfileRequest{SalCode: "21063110123"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Msg.Banner.BgKey != "coastal-beach" {
		t.Fatalf("want explicit bg_key preserved, got %q", resp.Msg.Banner.BgKey)
	}
}

// TestListAddressPriceDrops_SortThreadsThrough asserts the sort selector reaches
// the store (whitelisted there into an ORDER BY), so the board can rank by
// biggest $ cut or recency, not just percentage.
func TestListAddressPriceDrops_SortThreadsThrough(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListAddressPriceDrops("", "abs", int32(90), int32(50)).
		Return([]*shortsstore.AddressPriceDropRow{}, nil)

	srv := newTestServer(t, mockStore)
	_, err := srv.ListAddressPriceDrops(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListAddressPriceDropsRequest{Sort: "abs", WindowDays: 90, Limit: 50}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
