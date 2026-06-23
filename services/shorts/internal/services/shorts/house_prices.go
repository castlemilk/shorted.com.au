package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// GetHousingOverview returns the latest house-price headline metrics (mean/median
// price, price index, debt-to-income) per region with QoQ/YoY change.
func (s *ShortsServer) GetHousingOverview(ctx context.Context, req *connect.Request[shortsv1alpha1.GetHousingOverviewRequest]) (*connect.Response[shortsv1alpha1.GetHousingOverviewResponse], error) {
	regionType := req.Msg.RegionType

	cacheKey := s.cache.GetHousingOverviewKey(regionType)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetHousingOverview(regionType)
		if err != nil {
			return nil, err
		}
		metrics := make([]*shortsv1alpha1.HousingMetric, 0, len(rows))
		var asOf *timestamppb.Timestamp
		for _, r := range rows {
			if r == nil {
				continue
			}
			ts := timestamppb.New(r.Period)
			if asOf == nil || r.Period.After(asOf.AsTime()) {
				asOf = ts
			}
			metrics = append(metrics, &shortsv1alpha1.HousingMetric{
				RegionCode:    r.RegionCode,
				RegionName:    r.RegionName,
				RegionType:    r.RegionType,
				StateCode:     r.StateCode,
				Measure:       r.Measure,
				DwellingType:  r.DwellingType,
				Value:         r.Value,
				Unit:          r.Unit,
				Period:        ts,
				IsPreliminary: r.IsPreliminary,
				QoqPct:        r.QoQPct,
				YoyPct:        r.YoYPct,
			})
		}
		return &shortsv1alpha1.GetHousingOverviewResponse{Metrics: metrics, AsOf: asOf}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetHousingOverview: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get housing overview"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetHousingOverviewResponse)), nil
}

// GetHousePriceSeries returns a single quarterly time series for a region and measure.
func (s *ShortsServer) GetHousePriceSeries(ctx context.Context, req *connect.Request[shortsv1alpha1.GetHousePriceSeriesRequest]) (*connect.Response[shortsv1alpha1.GetHousePriceSeriesResponse], error) {
	m := req.Msg
	if m.RegionCode == "" || m.Measure == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("region_code and measure are required"))
	}

	cacheKey := s.cache.GetHousePriceSeriesKey(m.RegionCode, m.Measure, m.DwellingType)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		res, err := s.store.GetHousePriceSeries(m.RegionCode, m.Measure, m.DwellingType)
		if err != nil {
			return nil, err
		}
		points := make([]*shortsv1alpha1.HousePricePoint, 0, len(res.Points))
		for _, p := range res.Points {
			points = append(points, &shortsv1alpha1.HousePricePoint{
				Period:        timestamppb.New(p.Period),
				Value:         p.Value,
				IsPreliminary: p.IsPreliminary,
			})
		}
		return &shortsv1alpha1.GetHousePriceSeriesResponse{
			RegionCode:    res.RegionCode,
			RegionName:    res.RegionName,
			Measure:       res.Measure,
			DwellingType:  res.DwellingType,
			Unit:          res.Unit,
			Source:        res.Source,
			SourceLicence: res.SourceLicence,
			Points:        points,
		}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetHousePriceSeries: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get house price series"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetHousePriceSeriesResponse)), nil
}

// ListHousingRegions lists selectable house-price regions (suburbs/LGAs/etc),
// optionally filtered by region_type, state, or name — powers the suburb explorer.
func (s *ShortsServer) ListHousingRegions(ctx context.Context, req *connect.Request[shortsv1alpha1.ListHousingRegionsRequest]) (*connect.Response[shortsv1alpha1.ListHousingRegionsResponse], error) {
	m := req.Msg

	cacheKey := s.cache.GetHousingRegionsKey(m.RegionType, m.StateCode, m.Query, m.Limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetHousingRegions(m.RegionType, m.StateCode, m.Query, m.Limit)
		if err != nil {
			return nil, err
		}
		regions := make([]*shortsv1alpha1.HousingRegion, 0, len(rows))
		for _, r := range rows {
			if r == nil {
				continue
			}
			regions = append(regions, &shortsv1alpha1.HousingRegion{
				RegionCode: r.RegionCode,
				RegionName: r.RegionName,
				RegionType: r.RegionType,
				StateCode:  r.StateCode,
				Postcode:   r.Postcode,
			})
		}
		return &shortsv1alpha1.ListHousingRegionsResponse{Regions: regions}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListHousingRegions: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list housing regions"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListHousingRegionsResponse)), nil
}
