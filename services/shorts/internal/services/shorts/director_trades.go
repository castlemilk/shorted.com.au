package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// GetDirectorTrades retrieves director trading activity for a stock
func (s *ShortsServer) GetDirectorTrades(ctx context.Context, req *connect.Request[shortsv1alpha1.GetDirectorTradesRequest]) (*connect.Response[shortsv1alpha1.GetDirectorTradesResponse], error) {
	SetDefaultValues(req.Msg)
	if err := ValidateGetDirectorTradesRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetDirectorTrades: %v", err)
		return nil, err
	}

	s.logger.Debugf("get director trades: stock_code=%s, limit=%d", req.Msg.StockCode, req.Msg.Limit)

	cacheKey := s.cache.GetDirectorTradesKey(req.Msg.StockCode, req.Msg.Limit)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		trades, totalCount, err := s.store.GetDirectorTrades(req.Msg.StockCode, req.Msg.Limit)
		if err != nil {
			return nil, err
		}

		protoTrades := make([]*shortsv1alpha1.DirectorTrade, len(trades))
		for i, t := range trades {
			trade := &shortsv1alpha1.DirectorTrade{
				Id:           t.ID,
				StockCode:    t.StockCode,
				DirectorName: t.DirectorName,
				TradeType:    t.TradeType,
				SharesTraded: t.SharesTraded,
				TradeDate:    t.TradeDate,
			}
			if t.PricePerShare != nil {
				trade.PricePerShare = *t.PricePerShare
			}
			if t.TotalValue != nil {
				trade.TotalValue = *t.TotalValue
			}
			if t.AnnouncementURL != nil {
				trade.AnnouncementUrl = *t.AnnouncementURL
			}
			protoTrades[i] = trade
		}

		return &shortsv1alpha1.GetDirectorTradesResponse{
			Trades:     protoTrades,
			TotalCount: int32(totalCount),
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in GetDirectorTrades: stock_code=%s, err=%v", req.Msg.StockCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get director trades"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetDirectorTradesResponse)
	return connect.NewResponse(response), nil
}
