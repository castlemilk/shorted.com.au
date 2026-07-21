package shorts

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ListStateCompanies returns ASX-listed companies with operations-weighted
// exposure to a given Australian state, ranked by exposure-weighted market
// cap.
func (s *ShortsServer) ListStateCompanies(ctx context.Context, req *connect.Request[shortsv1alpha1.ListStateCompaniesRequest]) (*connect.Response[shortsv1alpha1.ListStateCompaniesResponse], error) {
	m := req.Msg

	state := strings.ToLower(strings.TrimSpace(m.State))
	if state == "international" {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("state must be one of nsw, vic, qld, sa, wa, tas, nt, act (got %q — 'international' is not a listable state)", m.State))
	}
	if !shortsstore.IsValidStateSlug(state) {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("state must be one of nsw, vic, qld, sa, wa, tas, nt, act (got %q)", m.State))
	}

	limit := m.Limit
	if limit <= 0 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}

	cacheKey := s.cache.ListStateCompaniesKey(state, limit)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.ListStateCompanies(state, limit)
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.StateCompany, 0, len(rows))
		for _, r := range rows {
			out = append(out, &shortsv1alpha1.StateCompany{
				StockCode:    r.StockCode,
				CompanyName:  r.CompanyName,
				Industry:     r.Industry,
				Weight:       r.Weight,
				Basis:        r.Basis,
				MarketCap:    r.MarketCap,
				ShortPercent: r.ShortPercent,
				LogoUrl:      r.LogoURL,
				Source:       r.Source,
			})
		}
		return &shortsv1alpha1.ListStateCompaniesResponse{Companies: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListStateCompanies: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list state companies"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListStateCompaniesResponse)), nil
}

// GetStateCompanyAggregates returns exposure-weighted market cap and short
// interest aggregates for every Australian state/territory present in the
// company state-exposure layer (excludes 'international').
func (s *ShortsServer) GetStateCompanyAggregates(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStateCompanyAggregatesRequest]) (*connect.Response[shortsv1alpha1.GetStateCompanyAggregatesResponse], error) {
	cacheKey := s.cache.GetStateCompanyAggregatesKey()
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetStateCompanyAggregates()
		if err != nil {
			return nil, err
		}
		out := make([]*shortsv1alpha1.StateCompanyAggregate, 0, len(rows))
		for _, r := range rows {
			out = append(out, &shortsv1alpha1.StateCompanyAggregate{
				State:                        r.State,
				CompanyCount:                 r.CompanyCount,
				ExposureWeightedMarketCap:    r.ExposureWeightedMarketCap,
				ExposureWeightedShortPercent: r.ExposureWeightedShortPercent,
			})
		}
		return &shortsv1alpha1.GetStateCompanyAggregatesResponse{Aggregates: out}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetStateCompanyAggregates: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get state company aggregates"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetStateCompanyAggregatesResponse)), nil
}
