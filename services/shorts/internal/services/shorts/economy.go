package shorts

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ListEconomicSeries returns catalog entries for the economy snapshot layer.
func (s *ShortsServer) ListEconomicSeries(ctx context.Context, req *connect.Request[shortsv1alpha1.ListEconomicSeriesRequest]) (*connect.Response[shortsv1alpha1.ListEconomicSeriesResponse], error) {
	m := req.Msg
	cacheKey := s.cache.ListEconomicSeriesKey(m.Topic, m.Metric, m.RegionType, m.RegionCode, m.Product, m.Limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListEconomicSeries(m.Topic, m.Metric, m.RegionType, m.RegionCode, m.Product, m.Limit)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.EconomicSeriesInfo, 0, len(rows))
		for _, r := range rows {
			out = append(out, economicSeriesInfoProto(r))
		}
		return &shortsv1alpha1.ListEconomicSeriesResponse{Series: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListEconomicSeries: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list economic series"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListEconomicSeriesResponse)), nil
}

// GetEconomicSeries returns observations for up to 50 named series. Keys are
// fully normalized (trim/lowercase/drop-empty, dedup, then capped/rejected at
// 50) BEFORE both the cache-key build and the store call, so logically-equal
// requests (same keys, different order/case) share one cache entry and the
// cache key can never diverge from what actually reaches the store.
func (s *ShortsServer) GetEconomicSeries(ctx context.Context, req *connect.Request[shortsv1alpha1.GetEconomicSeriesRequest]) (*connect.Response[shortsv1alpha1.GetEconomicSeriesResponse], error) {
	m := req.Msg

	keys, err := normalizeKeys(m.SeriesKeys)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}

	var start time.Time
	startKey := ""
	if m.StartPeriod != nil {
		start = m.StartPeriod.AsTime()
		startKey = start.Format("2006-01-02")
	}

	cacheKey := s.cache.GetEconomicSeriesKey(keys, startKey)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetEconomicSeries(keys, start)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.EconomicSeriesData, 0, len(rows))
		for _, r := range rows {
			obs := make([]*shortsv1alpha1.EconomicObservation, 0, len(r.Points))
			for _, p := range r.Points {
				obs = append(obs, &shortsv1alpha1.EconomicObservation{
					Period: timestamppb.New(p.Period),
					Value:  p.Value,
				})
			}
			out = append(out, &shortsv1alpha1.EconomicSeriesData{
				Info:         economicSeriesInfoProto(&r.Info),
				Observations: obs,
			})
		}
		return &shortsv1alpha1.GetEconomicSeriesResponse{Series: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetEconomicSeries: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get economic series"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetEconomicSeriesResponse)), nil
}

func economicSeriesInfoProto(r *shortsstore.EconomicSeriesRow) *shortsv1alpha1.EconomicSeriesInfo {
	info := &shortsv1alpha1.EconomicSeriesInfo{
		SeriesKey: r.SeriesKey, Topic: r.Topic, Metric: r.Metric, Product: r.Product,
		RegionType: r.RegionType, RegionCode: r.RegionCode, RegionName: r.RegionName,
		Unit: r.Unit, Frequency: r.Frequency, Adjustment: r.Adjustment,
		SourceKey: r.SourceKey, SourceLicence: r.SourceLicence,
	}
	if !r.LatestPeriod.IsZero() && r.LatestPeriod.Year() > 1 {
		info.LatestPeriod = timestamppb.New(r.LatestPeriod)
	}
	return info
}

// normalizeKeys fully normalizes series_keys: trim/lowercase, drop empties,
// dedup, reject (InvalidArgument) if >50 unique keys remain, then sort — so
// the result is stable for both the cache key and the store call regardless
// of request-supplied order/case/whitespace/duplicates.
func normalizeKeys(keys []string) ([]string, error) {
	seen := make(map[string]struct{}, len(keys))
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		k = strings.ToLower(strings.TrimSpace(k))
		if k == "" {
			continue
		}
		if _, dup := seen[k]; dup {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, k)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("series_keys is required")
	}
	if len(out) > 50 {
		return nil, fmt.Errorf("at most 50 series_keys per request")
	}
	sort.Strings(out)
	return out, nil
}
