package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// GetStockPrices returns adjusted daily OHLCV for a stock, on the same codes
// and the same dates as the short-position series.
//
// It exists so that short interest can be joined to returns without leaving
// the API. Every question the product is actually asked — do heavily shorted
// names underperform, what happened after the squeeze, show me short interest
// against price — needs both series, and doing the join outside meant
// reconciling two ticker conventions and two unauditable adjustment
// methodologies over two universes that need not agree.
func (s *ShortsServer) GetStockPrices(
	ctx context.Context,
	req *connect.Request[shortsv1alpha1.GetStockPricesRequest],
) (*connect.Response[shortsv1alpha1.GetStockPricesResponse], error) {
	SetDefaultValues(req.Msg)
	if err := ValidateGetStockPricesRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetStockPrices: %v", err)
		return nil, err
	}

	cacheKey := s.cache.GetStockPricesKey(req.Msg.ProductCode, req.Msg.Period,
		req.Msg.From, req.Msg.To, req.Msg.MaxPoints)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		return s.store.GetStockPrices(shortsstore.StockPricesQuery{
			ProductCode: req.Msg.ProductCode,
			Period:      req.Msg.Period,
			From:        req.Msg.From,
			To:          req.Msg.To,
			MaxPoints:   req.Msg.MaxPoints,
		})
	})
	if err != nil {
		s.logger.Errorf("database error in GetStockPrices: product_code=%s, err=%v", req.Msg.ProductCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get stock prices"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetStockPricesResponse)

	// An empty series is NotFound rather than a 200 with no points: a code we
	// hold no prices for and a window that happens to contain none are
	// different answers, and only the first is worth a caller changing their
	// request over.
	if len(response.Points) == 0 && response.TotalObservations == 0 {
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("no price history for %s", req.Msg.ProductCode))
	}

	return connect.NewResponse(response), nil
}
