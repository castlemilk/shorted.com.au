package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ValidateGetStockGraphRequest validates and normalizes the request.
func ValidateGetStockGraphRequest(req *shortsv1alpha1.GetStockGraphRequest) error {
	req.StockCode = NormalizeStockCode(req.StockCode)
	if req.StockCode == "" {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stock_code is required"))
	}
	if req.Limit <= 0 {
		req.Limit = 12
	} else if req.Limit > 50 {
		req.Limit = 50
	}
	return nil
}

// GetStockGraph returns the people connected to a stock (with their other ASX roles)
// and semantically similar companies.
func (s *ShortsServer) GetStockGraph(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockGraphRequest]) (*connect.Response[shortsv1alpha1.GetStockGraphResponse], error) {
	if err := ValidateGetStockGraphRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetStockGraph: %v", err)
		return nil, err
	}

	s.logger.Debugf("get stock graph: stock_code=%s, limit=%d", req.Msg.StockCode, req.Msg.Limit)

	cacheKey := s.cache.GetStockGraphKey(req.Msg.StockCode, req.Msg.Limit)
	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		result, err := s.store.GetStockGraph(req.Msg.StockCode, req.Msg.Limit)
		if err != nil {
			return nil, err
		}
		return &shortsv1alpha1.GetStockGraphResponse{
			People:           convertGraphPeople(result.People),
			SimilarCompanies: convertGraphPeers(result.SimilarCompanies),
		}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetStockGraph: stock_code=%s, err=%v", req.Msg.StockCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get stock graph"))
	}

	return connect.NewResponse(cachedResponse.(*shortsv1alpha1.GetStockGraphResponse)), nil
}

// convertGraphPeople converts store GraphPersonRow slice to proto GraphPerson slice.
func convertGraphPeople(rows []*shortsstore.GraphPersonRow) []*shortsv1alpha1.GraphPerson {
	out := make([]*shortsv1alpha1.GraphPerson, 0, len(rows))
	for _, r := range rows {
		if r == nil {
			continue
		}
		out = append(out, &shortsv1alpha1.GraphPerson{
			Name:        r.Name,
			Role:        r.Role,
			ImageUrl:    r.ImageURL,
			LinkedinUrl: r.LinkedInURL,
			AlsoAt:      r.AlsoAt,
		})
	}
	return out
}

// convertGraphPeers converts store GraphPeerRow slice to proto GraphPeer slice.
func convertGraphPeers(rows []*shortsstore.GraphPeerRow) []*shortsv1alpha1.GraphPeer {
	out := make([]*shortsv1alpha1.GraphPeer, 0, len(rows))
	for _, r := range rows {
		if r == nil {
			continue
		}
		out = append(out, &shortsv1alpha1.GraphPeer{
			StockCode:   r.StockCode,
			CompanyName: r.CompanyName,
			Industry:    r.Industry,
			Similarity:  r.Similarity,
		})
	}
	return out
}
