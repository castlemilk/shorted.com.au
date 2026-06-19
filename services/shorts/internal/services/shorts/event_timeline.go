package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// ValidateGetEventTimelineRequest validates and normalizes the request.
func ValidateGetEventTimelineRequest(req *shortsv1alpha1.GetEventTimelineRequest) error {
	req.StockCode = NormalizeStockCode(req.StockCode)
	if req.StockCode == "" {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stock_code is required"))
	}
	if req.DaysBack <= 0 {
		// Default to a full year: announcements/director-trades/price-sensitive
		// news are sparse, so a 90-day window leaves most stocks' timelines empty.
		req.DaysBack = 365
	} else if req.DaysBack > 365 {
		req.DaysBack = 365
	}
	if req.Limit <= 0 {
		req.Limit = 50
	} else if req.Limit > 200 {
		req.Limit = 200
	}
	return nil
}

// GetEventTimeline returns a chronological feed of events for a stock, merging
// ASX announcements, director trades, price-sensitive news, and short position spikes.
func (s *ShortsServer) GetEventTimeline(ctx context.Context, req *connect.Request[shortsv1alpha1.GetEventTimelineRequest]) (*connect.Response[shortsv1alpha1.GetEventTimelineResponse], error) {
	if err := ValidateGetEventTimelineRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetEventTimeline: %v", err)
		return nil, err
	}

	s.logger.Debugf("get event timeline: stock_code=%s, days_back=%d, limit=%d", req.Msg.StockCode, req.Msg.DaysBack, req.Msg.Limit)

	cacheKey := s.cache.GetEventTimelineKey(req.Msg.StockCode, req.Msg.DaysBack, req.Msg.Limit)
	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		rows, err := s.store.GetEventTimeline(req.Msg.StockCode, req.Msg.DaysBack, req.Msg.Limit)
		if err != nil {
			return nil, err
		}
		return &shortsv1alpha1.GetEventTimelineResponse{
			Events: convertTimelineEvents(rows),
		}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetEventTimeline: stock_code=%s, err=%v", req.Msg.StockCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get event timeline"))
	}

	return connect.NewResponse(cachedResponse.(*shortsv1alpha1.GetEventTimelineResponse)), nil
}

// convertTimelineEvents converts store TimelineEventRow slice to proto TimelineEvent slice.
func convertTimelineEvents(rows []*shortsstore.TimelineEventRow) []*shortsv1alpha1.TimelineEvent {
	out := make([]*shortsv1alpha1.TimelineEvent, 0, len(rows))
	for _, r := range rows {
		if r == nil {
			continue
		}
		out = append(out, &shortsv1alpha1.TimelineEvent{
			Date:             r.Date,
			Type:             r.Type,
			Title:            r.Title,
			Detail:           r.Detail,
			Url:              r.URL,
			Sentiment:        r.Sentiment,
			IsPriceSensitive: r.IsPriceSensitive,
		})
	}
	return out
}
