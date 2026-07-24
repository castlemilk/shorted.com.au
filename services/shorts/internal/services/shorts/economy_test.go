package shorts

import (
	"context"
	"strconv"
	"testing"
	"time"

	"connectrpc.com/connect"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestGetEconomicSeries_RequiresSeriesKeys(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	_, err := srv.GetEconomicSeries(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetEconomicSeriesRequest{}))
	if err == nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("want InvalidArgument for empty keys, got %v", err)
	}
}

func TestGetEconomicSeries_RejectsOver50RawKeys(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	tooMany := make([]string, 51)
	for i := range tooMany {
		// distinct keys (index-suffixed) so dedup can't rescue this below the 50 cap
		tooMany[i] = "cpi.index.all_groups.aus" + strconv.Itoa(i)
	}
	_, err := srv.GetEconomicSeries(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetEconomicSeriesRequest{SeriesKeys: tooMany}))
	if err == nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("want InvalidArgument for >50 unique keys, got %v", err)
	}
}

// TestGetEconomicSeries_DedupBelow50IsOK asserts that 60 raw keys which dedup
// down to <=50 unique keys is NOT rejected — the >50 check must run AFTER
// dedup, not on the raw request slice.
func TestGetEconomicSeries_DedupBelow50IsOK(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)

	// 60 raw keys, only 40 unique (case/whitespace variants of the same 40).
	raw := make([]string, 0, 60)
	for i := 0; i < 40; i++ {
		raw = append(raw, "topic.metric.aus"+strconv.Itoa(i))
	}
	for i := 0; i < 20; i++ {
		// duplicate the first 20 with case/whitespace noise
		raw = append(raw, "  TOPIC.METRIC.AUS"+strconv.Itoa(i)+" ")
	}

	mockStore.EXPECT().
		GetEconomicSeries(gomock.Any(), gomock.Any(), int32(0)).
		DoAndReturn(func(keys []string, _ time.Time, _ int32) ([]*shortsstore.EconomicSeriesDataRow, error) {
			if len(keys) != 40 {
				t.Fatalf("want 40 deduped keys reaching the store, got %d: %v", len(keys), keys)
			}
			return nil, nil
		})

	srv := newTestServer(t, mockStore)
	_, err := srv.GetEconomicSeries(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetEconomicSeriesRequest{SeriesKeys: raw}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestGetEconomicSeries_CacheKeyOrderInsensitive asserts two requests with the
// same keys in different order (and different case/whitespace) hit the SAME
// cache entry — normalization (including sort) must happen before the cache
// key is built, not just before the store call.
func TestGetEconomicSeries_CacheKeyOrderInsensitive(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)

	sorted := []string{"cpi.index.all_groups.aus", "rates.cash_rate_target.aus"}
	mockStore.EXPECT().GetEconomicSeries(sorted, gomock.Any(), int32(0)).Return(
		[]*shortsstore.EconomicSeriesDataRow{}, nil,
	).Times(1) // EXACTLY one call: the second request must be served from cache.

	srv := newTestServer(t, mockStore)

	_, err := srv.GetEconomicSeries(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetEconomicSeriesRequest{
			SeriesKeys: []string{"RATES.cash_rate_target.aus", " cpi.index.all_groups.aus "},
		}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	_, err = srv.GetEconomicSeries(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetEconomicSeriesRequest{
			SeriesKeys: []string{"cpi.index.all_groups.aus", "rates.CASH_RATE_TARGET.aus"},
		}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGetEconomicSeries_HappyPath(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().GetEconomicSeries([]string{"rates.cash_rate_target.aus"}, gomock.Any(), int32(12)).Return(
		[]*shortsstore.EconomicSeriesDataRow{{
			Info: shortsstore.EconomicSeriesRow{
				SeriesKey: "rates.cash_rate_target.aus", Topic: "rates",
				Metric: "cash_rate_target", RegionType: "national", RegionCode: "aus",
				RegionName: "Australia", Unit: "percent", Frequency: "monthly",
				Adjustment: "original", SourceKey: "rba-key-indicators", SourceLicence: "CC-BY-4.0",
			},
			Points: []shortsstore.EconomicObservationRow{
				{Period: time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC), Value: 3.6},
			},
		}}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.GetEconomicSeries(context.Background(),
		connect.NewRequest(&shortsv1alpha1.GetEconomicSeriesRequest{
			SeriesKeys:      []string{"rates.cash_rate_target.aus"},
			MaxObservations: 12,
		}))
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Msg.Series) != 1 || resp.Msg.Series[0].Info.SeriesKey != "rates.cash_rate_target.aus" {
		t.Fatalf("unexpected response: %+v", resp.Msg)
	}
	if len(resp.Msg.Series[0].Observations) != 1 || resp.Msg.Series[0].Observations[0].Value != 3.6 {
		t.Fatalf("value mismatch: %+v", resp.Msg.Series[0].Observations)
	}
}

func TestGetEconomicSeries_PassesRawMaxObservationsToStoreAndCache(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	key := []string{"rates.cash_rate_target.aus"}
	mockStore.EXPECT().GetEconomicSeries(key, gomock.Any(), int32(0)).Return(nil, nil).Times(1)
	mockStore.EXPECT().GetEconomicSeries(key, gomock.Any(), int32(900)).Return(nil, nil).Times(1)
	mockStore.EXPECT().GetEconomicSeries(key, gomock.Any(), int32(-4)).Return(nil, nil).Times(1)

	srv := newTestServer(t, mockStore)
	for _, maxObservations := range []int32{0, 900, -4} {
		_, err := srv.GetEconomicSeries(context.Background(),
			connect.NewRequest(&shortsv1alpha1.GetEconomicSeriesRequest{
				SeriesKeys:      key,
				MaxObservations: maxObservations,
			}))
		if err != nil {
			t.Fatalf("max_observations=%d: %v", maxObservations, err)
		}
	}
}

func TestListSeriesCorrelations_RequiresBaseSeriesKey(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))

	_, err := srv.ListSeriesCorrelations(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListSeriesCorrelationsRequest{}))
	if err == nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("want InvalidArgument for empty base_series_key, got %v", err)
	}
}

func TestListSeriesCorrelations_NormalizesInputsAndMapsOverlayMetadata(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	lastPeriod := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	mockStore.EXPECT().
		ListSeriesCorrelations("markets.short_interest_wavg.wa", int32(24), 0.4, int32(250)).
		Return([]*shortsstore.SeriesCorrelationRow{{
			Overlay: shortsstore.EconomicSeriesRow{
				SeriesKey: "commodities.price_index.iron_ore.aus",
				Topic:     "commodities", Metric: "price_index", Product: "iron_ore",
				RegionType: "national", RegionCode: "aus", RegionName: "Australia",
				Unit: "index", Frequency: "monthly", Adjustment: "original",
				SourceKey: "rba-commodity-prices", SourceLicence: "CC-BY-4.0",
			},
			R: -0.72, N: 24, LastPeriod: lastPeriod,
		}}, nil).
		Times(1)

	srv := newTestServer(t, mockStore)
	request := &shortsv1alpha1.ListSeriesCorrelationsRequest{
		BaseSeriesKey: "  MARKETS.short_interest_wavg.WA ",
		MinAbsR:       0.4,
		Limit:         250,
	}
	for range 2 {
		response, err := srv.ListSeriesCorrelations(context.Background(), connect.NewRequest(request))
		if err != nil {
			t.Fatal(err)
		}
		if len(response.Msg.Correlations) != 1 {
			t.Fatalf("correlations = %d, want 1", len(response.Msg.Correlations))
		}
		row := response.Msg.Correlations[0]
		if row.OverlaySeriesKey != "commodities.price_index.iron_ore.aus" || row.R != -0.72 || row.N != 24 {
			t.Fatalf("unexpected correlation row: %+v", row)
		}
		if row.LastPeriod == nil || !row.LastPeriod.AsTime().Equal(lastPeriod) {
			t.Fatalf("last_period = %v, want %v", row.LastPeriod, lastPeriod)
		}
		if row.Overlay == nil || row.Overlay.SeriesKey != row.OverlaySeriesKey || row.Overlay.Unit != "index" {
			t.Fatalf("overlay metadata mismatch: %+v", row.Overlay)
		}
	}
}

func TestListSeriesCorrelations_PassesRawDefaultLimitToStoreAndCache(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().
		ListSeriesCorrelations("markets.short_interest_wavg.wa", int32(24), 0.0, int32(0)).
		Return(nil, nil).
		Times(1)

	srv := newTestServer(t, mockStore)
	for range 2 {
		_, err := srv.ListSeriesCorrelations(
			context.Background(),
			connect.NewRequest(&shortsv1alpha1.ListSeriesCorrelationsRequest{
				BaseSeriesKey: "markets.short_interest_wavg.wa",
			}),
		)
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestListSeriesCorrelations_RejectsInvalidInputs(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*shortsv1alpha1.ListSeriesCorrelationsRequest)
	}{
		{name: "negative window", mutate: func(request *shortsv1alpha1.ListSeriesCorrelationsRequest) {
			request.WindowMonths = -1
		}},
		{name: "negative threshold", mutate: func(request *shortsv1alpha1.ListSeriesCorrelationsRequest) {
			request.MinAbsR = -0.1
		}},
		{name: "threshold above one", mutate: func(request *shortsv1alpha1.ListSeriesCorrelationsRequest) {
			request.MinAbsR = 1.1
		}},
		{name: "negative limit", mutate: func(request *shortsv1alpha1.ListSeriesCorrelationsRequest) {
			request.Limit = -1
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			defer ctrl.Finish()
			srv := newTestServer(t, mocks.NewMockShortsStore(ctrl))
			request := &shortsv1alpha1.ListSeriesCorrelationsRequest{BaseSeriesKey: "markets.short_interest_wavg.wa"}
			test.mutate(request)
			_, err := srv.ListSeriesCorrelations(context.Background(), connect.NewRequest(request))
			if err == nil || connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Fatalf("want InvalidArgument, got %v", err)
			}
		})
	}
}

func TestListEconomicSeries_HappyPath(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListEconomicSeries("cpi", "", "", "", "", int32(0)).Return(
		[]*shortsstore.EconomicSeriesRow{{
			SeriesKey: "cpi.index.all_groups.aus", Topic: "cpi", Metric: "index",
			Product: "all_groups", RegionType: "national", RegionCode: "aus",
			RegionName: "Australia", Unit: "index", Frequency: "quarterly",
			Adjustment: "original", SourceKey: "abs-cpi", SourceLicence: "CC-BY-4.0",
			LatestPeriod: time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC),
		}}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.ListEconomicSeries(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListEconomicSeriesRequest{Topic: "cpi"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Msg.Series) != 1 || resp.Msg.Series[0].SeriesKey != "cpi.index.all_groups.aus" {
		t.Fatalf("unexpected response: %+v", resp.Msg)
	}
	if resp.Msg.Series[0].LatestPeriod == nil {
		t.Fatalf("want LatestPeriod set for a real period, got nil")
	}
}

// TestListEconomicSeries_ZeroLatestPeriodOmitted asserts the LatestPeriod year>1
// guard: a series with no observations yet (LatestPeriod left at the zero
// time.Time) must NOT surface a bogus proto timestamp.
func TestListEconomicSeries_ZeroLatestPeriodOmitted(t *testing.T) {
	ctrl := gomock.NewController(t)
	defer ctrl.Finish()
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListEconomicSeries("", "", "", "", "", int32(0)).Return(
		[]*shortsstore.EconomicSeriesRow{{
			SeriesKey: "cpi.index.all_groups.aus", Topic: "cpi", Metric: "index",
			// LatestPeriod intentionally left zero-value.
		}}, nil)

	srv := newTestServer(t, mockStore)
	resp, err := srv.ListEconomicSeries(context.Background(),
		connect.NewRequest(&shortsv1alpha1.ListEconomicSeriesRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Msg.Series[0].LatestPeriod != nil {
		t.Fatalf("want nil LatestPeriod for zero-value period, got %v", resp.Msg.Series[0].LatestPeriod)
	}
}
