package shorts

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
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

// ListStateSuburbs lists every suburb in a state with price + headline demographics.
func (s *ShortsServer) ListStateSuburbs(ctx context.Context, req *connect.Request[shortsv1alpha1.ListStateSuburbsRequest]) (*connect.Response[shortsv1alpha1.ListStateSuburbsResponse], error) {
	m := req.Msg
	if m.StateCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("state_code is required"))
	}
	cacheKey := s.cache.GetStateSuburbsKey(m.StateCode, m.Query, m.Limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListStateSuburbs(m.StateCode, m.Query, m.Limit)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.SuburbSummary, 0, len(rows))
		for _, r := range rows {
			if r == nil {
				continue
			}
			ss := &shortsv1alpha1.SuburbSummary{
				SalCode: r.SALCode, SalName: r.SALName, StateCode: r.StateCode,
				Postcode: r.Postcode, LatestMedianPrice: r.LatestMedianPrice,
				YoyPct: r.YoYPct, Population: r.Population, MedianAge: r.MedianAge,
				MedianWeeklyHhdIncome: r.MedianWeeklyHhdIncome, RegionCode: r.RegionCode,
				PctBornOverseas: r.PctBornOverseas, TopReligion: r.TopReligion,
				TopLanguage: r.TopLanguage, PctTopLanguage: r.PctTopLanguage,
			}
			if r.LatestPeriod != nil {
				ss.LatestPeriod = timestamppb.New(*r.LatestPeriod)
			}
			out = append(out, ss)
		}
		return &shortsv1alpha1.ListStateSuburbsResponse{Suburbs: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListStateSuburbs: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list state suburbs"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListStateSuburbsResponse)), nil
}

// GetSuburbProfile returns one suburb's full profile.
func (s *ShortsServer) GetSuburbProfile(ctx context.Context, req *connect.Request[shortsv1alpha1.GetSuburbProfileRequest]) (*connect.Response[shortsv1alpha1.GetSuburbProfileResponse], error) {
	m := req.Msg
	if m.SalCode == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("sal_code is required"))
	}
	cacheKey := s.cache.GetSuburbProfileKey(m.SalCode)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		p, err := s.store.GetSuburbProfile(m.SalCode)
		if err != nil {
			return nil, err
		}
		summary := &shortsv1alpha1.SuburbSummary{
			SalCode: p.Summary.SALCode, SalName: p.Summary.SALName, StateCode: p.Summary.StateCode,
			Postcode: p.Summary.Postcode, LatestMedianPrice: p.Summary.LatestMedianPrice,
			YoyPct: p.Summary.YoYPct, Population: p.Summary.Population, MedianAge: p.Summary.MedianAge,
			MedianWeeklyHhdIncome: p.Summary.MedianWeeklyHhdIncome, RegionCode: p.Summary.RegionCode,
			PctBornOverseas: p.Summary.PctBornOverseas, TopReligion: p.Summary.TopReligion,
			TopLanguage: p.Summary.TopLanguage, PctTopLanguage: p.Summary.PctTopLanguage,
		}
		if p.Summary.LatestPeriod != nil {
			summary.LatestPeriod = timestamppb.New(*p.Summary.LatestPeriod)
		}
		return &shortsv1alpha1.GetSuburbProfileResponse{
			Summary: summary,
			Demographics: &shortsv1alpha1.SuburbDemographics{
				Population: p.Summary.Population, MedianAge: p.Summary.MedianAge,
				MedianWeeklyHhdIncome: p.Summary.MedianWeeklyHhdIncome,
				MedianWeeklyPerIncome: p.MedianWeeklyPerIncome, MedianWeeklyRent: p.MedianWeeklyRent,
				MedianMonthlyMortgage: p.MedianMonthlyMortgage, PctOwnedOutright: p.PctOwnedOutright,
				PctOwnedMortgage: p.PctOwnedMortgage, PctRented: p.PctRented,
				DwellingCount: p.DwellingCount, CensusYear: p.CensusYear,
				PctBornOverseas: p.Summary.PctBornOverseas, PctEnglishOnly: p.PctEnglishOnly,
				TopReligion: p.Summary.TopReligion, PctTopReligion: p.PctTopReligion,
				PctNoReligion: p.PctNoReligion, TopLanguage: p.Summary.TopLanguage,
				PctTopLanguage: p.Summary.PctTopLanguage,
			},
			Baselines: &shortsv1alpha1.ComparisonBaselines{
				StateMedianPrice: p.StateMedianPrice, NationalMedianPrice: p.NationalMedianPrice,
				StateMedianWeeklyHhdIncome: p.StateMedianHhdIncome,
				NationalMedianWeeklyHhdIncome: p.NationalMedianHhdIncome,
			},
		}, nil
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("suburb not found"))
		}
		s.logger.Errorf("database error in GetSuburbProfile: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get suburb profile"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetSuburbProfileResponse)), nil
}
