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

func TestListStateSuburbs_MapsCrimeRanks(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStateSuburbs("NSW", "", int32(5000)).Return([]*shortsstore.SuburbSummaryRow{{
		SALCode: "121041416", SALName: "Newtown", StateCode: "NSW",
		CrimeBreakInsRank: 72.4, CrimeViolentRank: 43.1, CrimeMotorVehicleRank: 88.8,
	}}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.ListStateSuburbs(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListStateSuburbsRequest{StateCode: "NSW", Limit: 5000}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.Msg.Suburbs) != 1 {
		t.Fatalf("want one suburb, got %d", len(resp.Msg.Suburbs))
	}
	got := resp.Msg.Suburbs[0]
	if got.CrimeBreakInsRank != 72.4 || got.CrimeViolentRank != 43.1 || got.CrimeMotorVehicleRank != 88.8 {
		t.Fatalf("crime ranks not mapped: %+v", got)
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
	t.Setenv("HOUSING_VALUATIONS_ENABLED", "false")

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
	t.Setenv("HOUSING_VALUATIONS_ENABLED", "false")

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

func propertyHistoryForValuation(addressKey string) *shortsstore.PropertyHistoryResult {
	return &shortsstore.PropertyHistoryResult{
		AddressKey:     addressKey,
		DisplayAddress: "1 Smith Street",
		Suburb:         "Richmond",
		StateCode:      "VIC",
		Postcode:       "3121",
		Current: &shortsstore.PropertyListingSnapshotRow{
			Source: "rea", ListingID: "listing-1", ListingURL: "https://realestate.com.au/listing-1",
			Price: 1_200_000, ListingStatus: "for_sale", IsActive: true,
		},
		Events: []*shortsstore.PropertyPriceEventRow{{
			ObservedAt: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
			EventType:  "first_seen",
			Source:     "rea",
			ListingID:  "listing-1",
			Price:      1_200_000,
		}},
		NumListings:  1,
		FirstPrice:   1_200_000,
		CurrentPrice: 1_200_000,
	}
}

func TestGetPropertyHistory_ValuationExact_MapsAllFields(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")
	t.Setenv("HOUSING_VALUATIONS_ENABLED", "")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	const addressKey = "1-smith-street-richmond-vic-3121"
	fetchedAt := time.Date(2026, 7, 20, 9, 30, 0, 0, time.UTC)

	mockStore.EXPECT().GetPropertyHistory(addressKey).Return(propertyHistoryForValuation(addressKey), nil)
	mockStore.EXPECT().GetPropertyValuation(addressKey).Return(&shortsstore.PropertyValuationRow{
		Source:               "property.com.au",
		ProfileURL:           "https://www.property.com.au/vic/richmond-3121/smith-st/1-pid-1/",
		FetchedAt:            fetchedAt,
		EstimateLow:          1_100_000,
		EstimateMid:          1_200_000,
		EstimateHigh:         1_300_000,
		EstimateConfidence:   "high",
		ValuationGranularity: "exact",
		RentEstimateMid:      650,
		Bedrooms:             3,
		Bathrooms:            2,
		CarSpaces:            1,
		LandSizeSqm:          450,
		BuildingSizeSqm:      180,
		YearBuilt:            1998,
		PropertyType:         "house",
	}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetPropertyHistory(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetPropertyHistoryRequest{AddressKey: addressKey}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	v := resp.Msg.Valuation
	if v == nil {
		t.Fatal("want valuation block, got nil")
	}
	if v.Source != "property.com.au" || v.ProfileUrl == "" || v.FetchedAt != fetchedAt.Format(time.RFC3339) {
		t.Fatalf("want source/profile/fetched_at mapped, got %+v", v)
	}
	if v.EstimateLow != 1_100_000 || v.EstimateMid != 1_200_000 || v.EstimateHigh != 1_300_000 {
		t.Fatalf("want estimate range mapped, got %+v", v)
	}
	if v.EstimateConfidence != "high" || v.ValuationGranularity != "exact" || v.RentEstimateMid != 650 {
		t.Fatalf("want confidence/granularity/rent mapped, got %+v", v)
	}
	if v.Bedrooms != 3 || v.Bathrooms != 2 || v.CarSpaces != 1 ||
		v.LandSizeSqm != 450 || v.BuildingSizeSqm != 180 || v.YearBuilt != 1998 ||
		v.PropertyType != "house" {
		t.Fatalf("want property attributes mapped, got %+v", v)
	}
}

func TestGetPropertyHistory_ValuationBuilding_PreservesGranularity(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")
	t.Setenv("HOUSING_VALUATIONS_ENABLED", "")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	const addressKey = "unit-2-1-smith-street-richmond-vic-3121"

	mockStore.EXPECT().GetPropertyHistory(addressKey).Return(propertyHistoryForValuation(addressKey), nil)
	mockStore.EXPECT().GetPropertyValuation(addressKey).Return(&shortsstore.PropertyValuationRow{
		FetchedAt:            time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC),
		EstimateMid:          5_000_000,
		ValuationGranularity: "building",
	}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetPropertyHistory(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetPropertyHistoryRequest{AddressKey: addressKey}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Msg.Valuation == nil || resp.Msg.Valuation.ValuationGranularity != "building" {
		t.Fatalf("want building granularity passed through, got %+v", resp.Msg.Valuation)
	}
}

func TestGetPropertyHistory_ValuationMissing_KeepsHistory(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")
	t.Setenv("HOUSING_VALUATIONS_ENABLED", "")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	const addressKey = "1-smith-street-richmond-vic-3121"

	mockStore.EXPECT().GetPropertyHistory(addressKey).Return(propertyHistoryForValuation(addressKey), nil)
	mockStore.EXPECT().GetPropertyValuation(addressKey).Return(nil, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetPropertyHistory(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetPropertyHistoryRequest{AddressKey: addressKey}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Msg.Valuation != nil {
		t.Fatalf("want valuation omitted, got %+v", resp.Msg.Valuation)
	}
	if resp.Msg.Current == nil || resp.Msg.Current.ListingId != "listing-1" || len(resp.Msg.Events) != 1 {
		t.Fatalf("want property history intact, got %+v", resp.Msg)
	}
}

func TestGetPropertyHistory_ValuationError_IsWarnOnly(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")
	t.Setenv("HOUSING_VALUATIONS_ENABLED", "")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	const addressKey = "1-smith-street-richmond-vic-3121"

	mockStore.EXPECT().GetPropertyHistory(addressKey).Return(propertyHistoryForValuation(addressKey), nil)
	mockStore.EXPECT().GetPropertyValuation(addressKey).Return(nil, errors.New("relation property_valuations does not exist"))

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetPropertyHistory(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetPropertyHistoryRequest{AddressKey: addressKey}))
	if err != nil {
		t.Fatalf("want valuation error to degrade without RPC error, got %v", err)
	}
	if resp.Msg.Valuation != nil {
		t.Fatalf("want valuation omitted on store error, got %+v", resp.Msg.Valuation)
	}
	if resp.Msg.Current == nil || resp.Msg.Current.ListingId != "listing-1" || len(resp.Msg.Events) != 1 {
		t.Fatalf("want property history intact, got %+v", resp.Msg)
	}
}

func TestGetPropertyHistory_ValuationFlagDisabled_SkipsStore(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")
	t.Setenv("HOUSING_VALUATIONS_ENABLED", "false")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	const addressKey = "1-smith-street-richmond-vic-3121"

	mockStore.EXPECT().GetPropertyHistory(addressKey).Return(propertyHistoryForValuation(addressKey), nil)
	// No EXPECT() on GetPropertyValuation: the valuation kill switch must
	// short-circuit without affecting the history response.

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetPropertyHistory(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetPropertyHistoryRequest{AddressKey: addressKey}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Msg.Valuation != nil {
		t.Fatalf("want valuation omitted when disabled, got %+v", resp.Msg.Valuation)
	}
	if resp.Msg.Current == nil || resp.Msg.Current.ListingId != "listing-1" {
		t.Fatalf("want property history intact, got %+v", resp.Msg)
	}
}

func TestGetPropertyHistory_ValuationSalesHistory_MapsUndisclosedPrice(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "true")
	t.Setenv("HOUSING_VALUATIONS_ENABLED", "")

	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	const addressKey = "1-smith-street-richmond-vic-3121"
	soldPrice := 980_000.0

	mockStore.EXPECT().GetPropertyHistory(addressKey).Return(propertyHistoryForValuation(addressKey), nil)
	mockStore.EXPECT().GetPropertyValuation(addressKey).Return(&shortsstore.PropertyValuationRow{
		FetchedAt: time.Date(2026, 7, 20, 0, 0, 0, 0, time.UTC),
		SalesHistory: []shortsstore.PropertyValuationSaleRow{
			{Date: "2019-05-11", Price: &soldPrice, Agency: "Test Realty", Type: "Sold"},
			{Date: "2015-02-02", Price: nil, Type: "Listed for sale"},
		},
	}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetPropertyHistory(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetPropertyHistoryRequest{AddressKey: addressKey}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Msg.Valuation == nil || len(resp.Msg.Valuation.SalesHistory) != 2 {
		t.Fatalf("want two mapped sales, got %+v", resp.Msg.Valuation)
	}
	if got := resp.Msg.Valuation.SalesHistory[0]; got.Price != soldPrice ||
		got.Date != "2019-05-11" || got.Agency != "Test Realty" || got.EventType != "Sold" {
		t.Fatalf("want disclosed sale mapped, got %+v", got)
	}
	if got := resp.Msg.Valuation.SalesHistory[1]; got.Price != 0 || got.EventType != "Listed for sale" {
		t.Fatalf("want nil price mapped to zero, got %+v", got)
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

func TestGetSuburbProfile_MapsCrimeAndEmbeddedSummaryRanks(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)

	mockStore.EXPECT().GetSuburbProfile("121041416").Return(&shortsstore.SuburbProfileRow{
		Summary: shortsstore.SuburbSummaryRow{
			SALCode: "121041416", SALName: "Newtown", StateCode: "NSW",
		},
		Crime: []shortsstore.SuburbCrimeStatRow{
			{
				CrimeType: "break_ins", FYEnding: 2025, RatePer100k: 0, PctRank: 72.4,
				Jurisdiction: "NSW", Source: "bocsar", Licence: "CC-BY-4.0",
			},
			{
				CrimeType: "motor_vehicle", FYEnding: 2025, RatePer100k: 845.2, PctRank: 88.8,
				Jurisdiction: "NSW", Source: "bocsar", Licence: "CC-BY-4.0",
			},
			{
				CrimeType: "violent", FYEnding: 2025, RatePer100k: 1234.5, PctRank: 43.1,
				Jurisdiction: "NSW", Source: "bocsar", Licence: "CC-BY-4.0",
			},
		},
	}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetSuburbProfile(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetSuburbProfileRequest{SalCode: "121041416"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Msg.Crime == nil {
		t.Fatal("want crime message, got nil")
	}
	if resp.Msg.Crime.SourceJurisdiction != "NSW" || resp.Msg.Crime.Source != "bocsar" ||
		resp.Msg.Crime.SourceLicence != "CC-BY-4.0" {
		t.Fatalf("crime attribution not mapped: %+v", resp.Msg.Crime)
	}
	if len(resp.Msg.Crime.Stats) != 3 {
		t.Fatalf("want three crime stats, got %d", len(resp.Msg.Crime.Stats))
	}
	if resp.Msg.Crime.Stats[0].RatePer_100K != 0 || resp.Msg.Crime.Stats[0].PctRank != 72.4 {
		t.Fatalf("zero-rate reliable observation was not preserved: %+v", resp.Msg.Crime.Stats[0])
	}
	if resp.Msg.Summary.CrimeBreakInsRank != 72.4 || resp.Msg.Summary.CrimeViolentRank != 43.1 ||
		resp.Msg.Summary.CrimeMotorVehicleRank != 88.8 {
		t.Fatalf("embedded summary crime ranks not mapped: %+v", resp.Msg.Summary)
	}
}

func TestGetSuburbProfile_OmitsCrimeWhenNoReliableData(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetSuburbProfile("600011234").Return(&shortsstore.SuburbProfileRow{
		Summary: shortsstore.SuburbSummaryRow{
			SALCode: "600011234", SALName: "Uncovered", StateCode: "TAS",
		},
	}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetSuburbProfile(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetSuburbProfileRequest{SalCode: "600011234"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Msg.Crime != nil {
		t.Fatalf("want absent crime message for uncovered suburb, got %+v", resp.Msg.Crime)
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

// TestBannerFallbackBlurb asserts the deterministic templated blurb used when
// no agy-generated banner_blurb exists yet in the DB.
func TestBannerFallbackBlurb(t *testing.T) {
	tests := []struct {
		name      string
		archetype string
		salName   string
		lgaName   string
		want      string
	}{
		{
			name:      "known archetype with LGA",
			archetype: "coastal-beach",
			salName:   "Bondi",
			lgaName:   "Waverley",
			want:      "Bondi is a coastal suburb of Waverley.",
		},
		{
			name:      "known archetype without LGA",
			archetype: "harbour",
			salName:   "Mosman",
			lgaName:   "",
			want:      "Mosman is a harbourside suburb.",
		},
		{
			name:      "unknown archetype falls back to residential suburb",
			archetype: "some-unmapped-archetype",
			salName:   "Richmond",
			lgaName:   "Yarra",
			want:      "Richmond is a residential suburb of Yarra.",
		},
		{
			name:      "empty archetype falls back to residential suburb",
			archetype: "",
			salName:   "Richmond",
			lgaName:   "",
			want:      "Richmond is a residential suburb.",
		},
		{
			name:      "empty suburb name returns empty blurb",
			archetype: "coastal-beach",
			salName:   "",
			lgaName:   "Waverley",
			want:      "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := bannerFallbackBlurb(tt.archetype, tt.salName, tt.lgaName)
			if got != tt.want {
				t.Fatalf("bannerFallbackBlurb(%q, %q, %q) = %q, want %q",
					tt.archetype, tt.salName, tt.lgaName, got, tt.want)
			}
		})
	}
}

// TestGetSuburbProfile_BannerBlurbFallback asserts that when the store row has
// no banner_blurb yet (agy hasn't generated one), GetSuburbProfile fills in
// the templated fallback rather than leaving Blurb empty.
func TestGetSuburbProfile_BannerBlurbFallback(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)

	mockStore.EXPECT().GetSuburbProfile("21063110123").Return(&shortsstore.SuburbProfileRow{
		Summary: shortsstore.SuburbSummaryRow{
			SALCode: "21063110123", SALName: "Richmond", StateCode: "VIC",
		},
		BannerArchetype: "inner-terraces",
		BannerBlurb:     "",
		LgaName:         "Yarra",
	}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetSuburbProfile(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetSuburbProfileRequest{SalCode: "21063110123"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := "Richmond is a dense inner suburb of Yarra."
	if resp.Msg.Banner.Blurb != want {
		t.Fatalf("want fallback blurb %q, got %q", want, resp.Msg.Banner.Blurb)
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
