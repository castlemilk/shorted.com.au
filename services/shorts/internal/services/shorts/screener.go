package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ScreenStocks filters and sorts stocks using compound criteria from the screener materialized view
func (s *ShortsServer) ScreenStocks(ctx context.Context, req *connect.Request[shortsv1alpha1.ScreenStocksRequest]) (*connect.Response[shortsv1alpha1.ScreenStocksResponse], error) {
	SetDefaultValues(req.Msg)
	if err := ValidateScreenStocksRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for ScreenStocks: %v", err)
		return nil, err
	}

	s.logger.Debugf("screen stocks: sort=%s, dir=%s, limit=%d, offset=%d",
		req.Msg.SortField, req.Msg.SortDirection, req.Msg.Limit, req.Msg.Offset)

	cacheKey := s.cache.GetScreenStocksKey(req.Msg.Filters, req.Msg.SortField, req.Msg.SortDirection, req.Msg.Limit, req.Msg.Offset)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		stocks, totalCount, err := s.store.ScreenStocks(
			req.Msg.Filters,
			req.Msg.SortField,
			req.Msg.SortDirection,
			req.Msg.Limit,
			req.Msg.Offset,
		)
		if err != nil {
			return nil, err
		}

		return &shortsv1alpha1.ScreenStocksResponse{
			Stocks:     convertScreenerStocks(stocks),
			TotalCount: int32(totalCount),
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in ScreenStocks: err=%v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to screen stocks"))
	}

	response := cachedResponse.(*shortsv1alpha1.ScreenStocksResponse)
	return connect.NewResponse(response), nil
}

// convertScreenerStock converts a store ScreenerStock to a proto ScreenerStock
func convertScreenerStock(s *shortsstore.ScreenerStock) *shortsv1alpha1.ScreenerStock {
	if s == nil {
		return nil
	}
	return &shortsv1alpha1.ScreenerStock{
		StockCode:           s.StockCode,
		CompanyName:         s.CompanyName,
		Industry:            s.Industry,
		ShortPct:            s.ShortPct,
		ShortPctChange_4W:   s.ShortPctChange4w,
		LatestPrice:         s.LatestPrice,
		PriceChange_1M:      s.PriceChange1m,
		LatestVolume:        s.LatestVolume,
		MarketCap:           s.MarketCap,
		PeRatio:             s.PERatio,
		DividendYield:       s.DividendYield,
		NetDirectorBuyValue: s.NetDirectorBuyValue,
		DirectorBuyCount:    s.DirectorBuyCount,
		DirectorSellCount:   s.DirectorSellCount,
		NewsCount_30D:       s.NewsCount30d,
		AvgSentiment:        s.AvgSentiment,
		PriceSensitiveCount: s.PriceSensitiveCount,
		Trailing_12MDividend: s.Trailing12mDividend,
		AvgFrankingPct:      s.AvgFrankingPct,
		LogoUrl:             s.LogoURL,
		DaysToCover:         s.DaysToCover,
		AvgVolume_20D:       s.AvgVolume20d,
	}
}

// convertScreenerStocks converts a slice of store ScreenerStocks to proto ScreenerStocks
func convertScreenerStocks(stocks []*shortsstore.ScreenerStock) []*shortsv1alpha1.ScreenerStock {
	result := make([]*shortsv1alpha1.ScreenerStock, len(stocks))
	for i, s := range stocks {
		result[i] = convertScreenerStock(s)
	}
	return result
}
