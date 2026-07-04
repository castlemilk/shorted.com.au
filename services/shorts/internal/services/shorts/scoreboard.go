package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

const (
	scoreboardDefaultLimit = 25
	scoreboardMaxLimit     = 100
)

// GetShortCampaignScoreboard returns historic short campaigns (peak short
// interest >= 5% over the last 3 years) with 3/6-month price outcomes and
// overall short-seller win rates.
func (s *ShortsServer) GetShortCampaignScoreboard(ctx context.Context, req *connect.Request[shortsv1alpha1.GetShortCampaignScoreboardRequest]) (*connect.Response[shortsv1alpha1.GetShortCampaignScoreboardResponse], error) {
	limit := req.Msg.Limit
	if limit < 0 || limit > scoreboardMaxLimit {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit must be between 0 and %d", scoreboardMaxLimit))
	}
	if limit == 0 {
		limit = scoreboardDefaultLimit
	}

	offset := req.Msg.Offset
	if offset < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("offset must be non-negative"))
	}

	industry := req.Msg.Industry

	s.logger.Debugf("short campaign scoreboard: industry=%q, limit=%d, offset=%d", industry, limit, offset)

	cacheKey := s.cache.GetShortCampaignScoreboardKey(industry, limit, offset)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		campaigns, totalCount, stats, err := s.store.GetShortCampaignScoreboard(industry, limit, offset)
		if err != nil {
			return nil, err
		}

		response := &shortsv1alpha1.GetShortCampaignScoreboardResponse{
			Campaigns:  convertShortCampaigns(campaigns),
			TotalCount: int32(totalCount),
		}
		if stats != nil {
			response.CampaignsTotal = int32(stats.CampaignsTotal)
			response.ShortsWinRate_3M = stats.ShortsWinRate3m
			response.ShortsWinRate_6M = stats.ShortsWinRate6m
		}
		return response, nil
	})

	if err != nil {
		s.logger.Errorf("database error in GetShortCampaignScoreboard: err=%v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get short campaign scoreboard"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetShortCampaignScoreboardResponse)
	return connect.NewResponse(response), nil
}

// convertShortCampaign converts a store ShortCampaign to proto
func convertShortCampaign(c *shortsstore.ShortCampaign) *shortsv1alpha1.ShortCampaign {
	if c == nil {
		return nil
	}
	return &shortsv1alpha1.ShortCampaign{
		StockCode:       c.StockCode,
		CompanyName:     c.CompanyName,
		Industry:        c.Industry,
		LogoUrl:         c.LogoURL,
		PeakDate:        c.PeakDate,
		PeakShortPct:    c.PeakShortPct,
		PriceAtPeak:     c.PriceAtPeak,
		Price_3MAfter:   c.Price3mAfter,
		Price_6MAfter:   c.Price6mAfter,
		Return_3M:       c.Return3m,
		Return_6M:       c.Return6m,
		Has_3M:          c.Has3m,
		Has_6M:          c.Has6m,
		ShortsWon_3M:    c.ShortsWon3m,
		ShortsWon_6M:    c.ShortsWon6m,
		CurrentShortPct: c.CurrentShortPct,
		LatestPrice:     c.LatestPrice,
	}
}

// convertShortCampaigns converts a slice of store ShortCampaigns to proto
func convertShortCampaigns(campaigns []*shortsstore.ShortCampaign) []*shortsv1alpha1.ShortCampaign {
	result := make([]*shortsv1alpha1.ShortCampaign, len(campaigns))
	for i, c := range campaigns {
		result[i] = convertShortCampaign(c)
	}
	return result
}
