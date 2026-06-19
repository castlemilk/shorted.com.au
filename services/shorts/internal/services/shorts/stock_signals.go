package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ValidateGetStockSignalsRequest validates and normalizes the request.
func ValidateGetStockSignalsRequest(req *shortsv1alpha1.GetStockSignalsRequest) error {
	req.StockCode = NormalizeStockCode(req.StockCode)
	if req.StockCode == "" {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stock_code is required"))
	}
	if req.Limit <= 0 {
		req.Limit = 10
	} else if req.Limit > 50 {
		req.Limit = 50
	}
	return nil
}

// GetStockSignals returns a stock's adverse and positive reputation/risk signals.
func (s *ShortsServer) GetStockSignals(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockSignalsRequest]) (*connect.Response[shortsv1alpha1.GetStockSignalsResponse], error) {
	if err := ValidateGetStockSignalsRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetStockSignals: %v", err)
		return nil, err
	}

	s.logger.Debugf("get stock signals: stock_code=%s, limit=%d", req.Msg.StockCode, req.Msg.Limit)

	cacheKey := s.cache.GetStockSignalsKey(req.Msg.StockCode, req.Msg.Limit)
	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		result, err := s.store.GetStockSignals(req.Msg.StockCode, req.Msg.Limit)
		if err != nil {
			return nil, err
		}
		return &shortsv1alpha1.GetStockSignalsResponse{
			Adverse:  convertSignals(result.Adverse),
			Positive: convertSignals(result.Positive),
		}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetStockSignals: stock_code=%s, err=%v", req.Msg.StockCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get stock signals"))
	}

	return connect.NewResponse(cachedResponse.(*shortsv1alpha1.GetStockSignalsResponse)), nil
}

// convertSignals converts store StockSignalRow slice to proto StockSignal slice.
func convertSignals(rows []*shortsstore.StockSignalRow) []*shortsv1alpha1.StockSignal {
	out := make([]*shortsv1alpha1.StockSignal, 0, len(rows))
	for _, r := range rows {
		if r == nil {
			continue
		}
		out = append(out, &shortsv1alpha1.StockSignal{
			Polarity:   r.Polarity,
			Kind:       r.Kind,
			Headline:   r.Headline,
			Detail:     r.Detail,
			EventDate:  r.EventDate,
			Severity:   r.Severity,
			Confidence: r.Confidence,
			Citations:  r.Citations,
		})
	}
	return out
}
