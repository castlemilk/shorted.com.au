package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

const (
	battlegroundsDefaultLimit = 25
	battlegroundsMaxLimit     = 100
)

// GetBattlegroundStocks returns stocks ranked by squeeze risk or bull-vs-bear divergence
func (s *ShortsServer) GetBattlegroundStocks(ctx context.Context, req *connect.Request[shortsv1alpha1.GetBattlegroundStocksRequest]) (*connect.Response[shortsv1alpha1.GetBattlegroundStocksResponse], error) {
	view := req.Msg.View
	if view == shortsv1alpha1.BattlegroundView_BATTLEGROUND_VIEW_UNSPECIFIED {
		view = shortsv1alpha1.BattlegroundView_BATTLEGROUND_VIEW_SQUEEZE
	}

	limit := req.Msg.Limit
	if limit < 0 || limit > battlegroundsMaxLimit {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and %d", battlegroundsMaxLimit))
	}
	if limit == 0 {
		limit = battlegroundsDefaultLimit
	}

	offset := req.Msg.Offset
	if offset < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("offset must be non-negative"))
	}

	s.logger.Debugf("battleground stocks: view=%s, limit=%d, offset=%d", view, limit, offset)

	cacheKey := s.cache.GetBattlegroundStocksKey(view, limit, offset)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		stocks, totalCount, err := s.store.GetBattlegroundStocks(view, limit, offset)
		if err != nil {
			return nil, err
		}

		return &shortsv1alpha1.GetBattlegroundStocksResponse{
			Stocks:     convertBattlegroundStocks(stocks),
			TotalCount: int32(totalCount),
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in GetBattlegroundStocks: err=%v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get battleground stocks"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetBattlegroundStocksResponse)
	return connect.NewResponse(response), nil
}

// convertBattlegroundStock converts a store BattlegroundStock to a proto BattlegroundStock
func convertBattlegroundStock(s *shortsstore.BattlegroundStock) *shortsv1alpha1.BattlegroundStock {
	if s == nil {
		return nil
	}
	return &shortsv1alpha1.BattlegroundStock{
		StockCode:         s.StockCode,
		CompanyName:       s.CompanyName,
		Industry:          s.Industry,
		LogoUrl:           s.LogoURL,
		ShortPct:          s.ShortPct,
		ShortPctChange_4W: s.ShortPctChange4w,
		LatestPrice:       s.LatestPrice,
		PriceChange_1M:    s.PriceChange1m,
		DaysToCover:       s.DaysToCover,
		SqueezeScore:      s.SqueezeScore,
		DivergenceScore:   s.DivergenceScore,
		MarketCap:         s.MarketCap,
	}
}

// convertBattlegroundStocks converts a slice of store BattlegroundStocks to proto
func convertBattlegroundStocks(stocks []*shortsstore.BattlegroundStock) []*shortsv1alpha1.BattlegroundStock {
	result := make([]*shortsv1alpha1.BattlegroundStock, len(stocks))
	for i, s := range stocks {
		result[i] = convertBattlegroundStock(s)
	}
	return result
}
