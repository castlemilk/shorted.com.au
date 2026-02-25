package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// GetDividendHistory retrieves dividend payment history for a stock
func (s *ShortsServer) GetDividendHistory(ctx context.Context, req *connect.Request[shortsv1alpha1.GetDividendHistoryRequest]) (*connect.Response[shortsv1alpha1.GetDividendHistoryResponse], error) {
	SetDefaultValues(req.Msg)
	if err := ValidateGetDividendHistoryRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetDividendHistory: %v", err)
		return nil, err
	}

	s.logger.Debugf("get dividend history: stock_code=%s, years=%d", req.Msg.StockCode, req.Msg.Years)

	cacheKey := s.cache.GetDividendHistoryKey(req.Msg.StockCode, req.Msg.Years)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		dividends, totalCount, err := s.store.GetDividendHistory(req.Msg.StockCode, req.Msg.Years)
		if err != nil {
			return nil, err
		}

		protoDividends := make([]*shortsv1alpha1.DividendRecord, len(dividends))
		for i, d := range dividends {
			record := &shortsv1alpha1.DividendRecord{
				Id:                 d.ID,
				StockCode:          d.StockCode,
				ExDate:             d.ExDate,
				AmountPerShare:     d.AmountPerShare,
				FrankingPercentage: d.FrankingPercentage,
				DividendType:       d.DividendType,
			}
			if d.PaymentDate != nil {
				record.PaymentDate = *d.PaymentDate
			}
			protoDividends[i] = record
		}

		// Calculate trailing 12-month yield (sum of last 4 dividends)
		var trailingYield float64
		for _, d := range dividends {
			trailingYield += d.AmountPerShare
		}

		return &shortsv1alpha1.GetDividendHistoryResponse{
			Dividends:     protoDividends,
			TotalCount:    int32(totalCount),
			TrailingYield: trailingYield,
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in GetDividendHistory: stock_code=%s, err=%v", req.Msg.StockCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get dividend history"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetDividendHistoryResponse)
	return connect.NewResponse(response), nil
}
