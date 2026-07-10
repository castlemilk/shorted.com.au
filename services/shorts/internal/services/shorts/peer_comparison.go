package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// GetPeerComparison retrieves peer stocks for comparison within the same industry
func (s *ShortsServer) GetPeerComparison(ctx context.Context, req *connect.Request[shortsv1alpha1.GetPeerComparisonRequest]) (*connect.Response[shortsv1alpha1.GetPeerComparisonResponse], error) {
	SetDefaultValues(req.Msg)
	if err := ValidateGetPeerComparisonRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetPeerComparison: %v", err)
		return nil, err
	}

	s.logger.Debugf("get peer comparison: stock_code=%s, limit=%d", req.Msg.StockCode, req.Msg.Limit)

	cacheKey := s.cache.GetPeerComparisonKey(req.Msg.StockCode, req.Msg.Limit)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		result, err := s.store.GetPeerComparison(req.Msg.StockCode, req.Msg.Limit)
		if err != nil {
			return nil, err
		}

		return &shortsv1alpha1.GetPeerComparisonResponse{
			Subject:  convertPeerStock(result.Subject),
			Peers:    convertPeerStocks(result.Peers),
			Industry: result.Industry,
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in GetPeerComparison: stock_code=%s, err=%v", req.Msg.StockCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get peer comparison"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetPeerComparisonResponse)
	return connect.NewResponse(response), nil
}

// convertPeerStock converts a store PeerStock to a proto PeerStock
func convertPeerStock(p *shortsstore.PeerStock) *shortsv1alpha1.PeerStock {
	if p == nil {
		return nil
	}
	return &shortsv1alpha1.PeerStock{
		StockCode:            p.StockCode,
		CompanyName:          p.CompanyName,
		Industry:             p.Industry,
		ShortPositionPercent: p.ShortPositionPercent,
		MarketCap:            p.MarketCap,
		PeRatio:              p.PERatio,
		DividendYield:        p.DividendYield,
		PriceChange_1M:       p.PriceChange1M,
		LogoUrl:              p.LogoUrl,
	}
}

// convertPeerStocks converts a slice of store PeerStocks to proto PeerStocks
func convertPeerStocks(peers []*shortsstore.PeerStock) []*shortsv1alpha1.PeerStock {
	result := make([]*shortsv1alpha1.PeerStock, len(peers))
	for i, p := range peers {
		result[i] = convertPeerStock(p)
	}
	return result
}
