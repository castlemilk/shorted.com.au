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
// reads the SAME ToS-restricted per-listing data as ListSuburbDropListings, so it
// must be gated behind the same HOUSING_DROP_LISTINGS_ENABLED flag: OFF (the
// default) returns an empty response and never touches the store.
func TestGetPropertyHistory_FlagGate_ReturnsEmptyWhenDisabled(t *testing.T) {
	t.Setenv("HOUSING_DROP_LISTINGS_ENABLED", "")

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
