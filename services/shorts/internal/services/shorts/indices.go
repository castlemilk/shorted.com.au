package shorts

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ListIndices returns the benchmark registry.
func (s *ShortsServer) ListIndices(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.ListIndicesRequest],
) (*connect.Response[shortsv1alpha1.ListIndicesResponse], error) {
	cached, err := s.cache.GetOrSet(s.cache.GetIndicesKey(), func() (interface{}, error) {
		indices, err := s.store.ListIndices()
		if err != nil {
			return nil, err
		}
		return &shortsv1alpha1.ListIndicesResponse{Indices: indices}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in ListIndices: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to list indices"))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.ListIndicesResponse)), nil
}

// GetIndexSeries returns daily levels for one benchmark index.
//
// This exists because absolute returns on the ASX are mostly beta: a strategy
// reporting +38% over twelve months is reporting a market return with a
// strategy on top of it, and without a benchmark every result in the product —
// and every result a caller builds on the API — overstates itself by the same
// amount.
func (s *ShortsServer) GetIndexSeries(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetIndexSeriesRequest],
) (*connect.Response[shortsv1alpha1.GetIndexSeriesResponse], error) {
	if err := ValidateGetIndexSeriesRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetIndexSeries: %v", err)
		return nil, err
	}

	code := strings.ToUpper(strings.TrimSpace(req.Msg.IndexCode))
	period := req.Msg.Period
	if period == "" && req.Msg.From == "" && req.Msg.To == "" {
		period = "1Y"
	}

	cacheKey := s.cache.GetIndexSeriesKey(code, period, req.Msg.From, req.Msg.To, req.Msg.MaxPoints)
	cached, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		return s.store.GetIndexSeries(shortsstore.IndexSeriesQuery{
			IndexCode: code,
			Period:    period,
			From:      req.Msg.From,
			To:        req.Msg.To,
			MaxPoints: req.Msg.MaxPoints,
		})
	})
	if err != nil {
		s.logger.Errorf("database error in GetIndexSeries: code=%s err=%v", code, err)
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("no index series for %q — call ListIndices for the available codes", code))
	}
	return connect.NewResponse(cached.(*shortsv1alpha1.GetIndexSeriesResponse)), nil
}
