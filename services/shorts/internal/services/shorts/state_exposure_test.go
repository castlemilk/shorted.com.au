package shorts

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestListStateCompanies_RejectsInvalidState(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	_, err := srv.ListStateCompanies(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListStateCompaniesRequest{State: "nowhereland"}))
	if err == nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("want InvalidArgument for bad state, got %v", err)
	}
}

// TestListStateCompanies_RejectsInternational asserts 'international' is a
// valid region in the MV but is NOT a listable "state" — it must be
// explicitly rejected with a clear message, not silently accepted.
func TestListStateCompanies_RejectsInternational(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	_, err := srv.ListStateCompanies(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListStateCompaniesRequest{State: "international"}))
	if err == nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("want InvalidArgument for 'international', got %v", err)
	}
}

// TestListStateCompanies_LowercasesState asserts a mixed-case state slug is
// normalized before hitting the store/cache.
func TestListStateCompanies_LowercasesState(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStateCompanies("wa", int32(10)).Return(
		[]*shortsstore.StateCompanyRow{}, nil)

	srv := newTestServer(t, mockStore)
	_, err := srv.ListStateCompanies(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListStateCompaniesRequest{State: "WA"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestListStateCompanies_DefaultLimit asserts limit<=0 defaults to 10.
func TestListStateCompanies_DefaultLimit(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStateCompanies("wa", int32(10)).Return(
		[]*shortsstore.StateCompanyRow{}, nil)

	srv := newTestServer(t, mockStore)
	_, err := srv.ListStateCompanies(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListStateCompaniesRequest{State: "wa"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestListStateCompanies_ClampsLimitAbove50 asserts limit>50 is clamped to 50
// before it reaches the store.
func TestListStateCompanies_ClampsLimitAbove50(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStateCompanies("wa", int32(50)).Return(
		[]*shortsstore.StateCompanyRow{}, nil)

	srv := newTestServer(t, mockStore)
	_, err := srv.ListStateCompanies(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListStateCompaniesRequest{State: "wa", Limit: 500}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestListStateCompanies_HappyPath(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStateCompanies("wa", int32(5)).Return(
		[]*shortsstore.StateCompanyRow{{
			StockCode: "FMG", CompanyName: "Fortescue", Industry: "Materials",
			Weight: 0.85, Basis: "Pilbara iron ore operations", MarketCap: 60_000_000_000,
			ShortPercent: 1.2, LogoURL: "https://logos/fmg.png", Source: "llm",
		}}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.ListStateCompanies(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListStateCompaniesRequest{State: "wa", Limit: 5}))
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Msg.Companies) != 1 || resp.Msg.Companies[0].StockCode != "FMG" {
		t.Fatalf("unexpected response: %+v", resp.Msg)
	}
	if resp.Msg.Companies[0].Weight != 0.85 || resp.Msg.Companies[0].Source != "llm" {
		t.Fatalf("field mismatch: %+v", resp.Msg.Companies[0])
	}
}

func TestGetStateCompanyAggregates_HappyPath(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetStateCompanyAggregates().Return(
		[]*shortsstore.StateCompanyAggregateRow{
			{State: "wa", CompanyCount: 42, ExposureWeightedMarketCap: 400_000_000_000, ExposureWeightedShortPercent: 2.1},
			{State: "nsw", CompanyCount: 60, ExposureWeightedMarketCap: 350_000_000_000, ExposureWeightedShortPercent: 1.5},
		}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetStateCompanyAggregates(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetStateCompanyAggregatesRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Msg.Aggregates) != 2 || resp.Msg.Aggregates[0].State != "wa" {
		t.Fatalf("unexpected response: %+v", resp.Msg)
	}
	if resp.Msg.Aggregates[0].CompanyCount != 42 || resp.Msg.Aggregates[0].ExposureWeightedMarketCap != 400_000_000_000 {
		t.Fatalf("field mismatch: %+v", resp.Msg.Aggregates[0])
	}
}
