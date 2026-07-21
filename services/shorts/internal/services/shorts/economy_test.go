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
		GetEconomicSeries(gomock.Any(), gomock.Any()).
		DoAndReturn(func(keys []string, _ time.Time) ([]*shortsstore.EconomicSeriesDataRow, error) {
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
	mockStore.EXPECT().GetEconomicSeries(sorted, gomock.Any()).Return(
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
	mockStore.EXPECT().GetEconomicSeries([]string{"rates.cash_rate_target.aus"}, gomock.Any()).Return(
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
			SeriesKeys: []string{"rates.cash_rate_target.aus"},
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
