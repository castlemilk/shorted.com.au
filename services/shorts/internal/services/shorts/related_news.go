package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// ValidateGetRelatedNewsRequest validates and normalizes the request.
func ValidateGetRelatedNewsRequest(req *shortsv1alpha1.GetRelatedNewsRequest) error {
	req.StockCode = NormalizeStockCode(req.StockCode)
	if req.StockCode == "" {
		return connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("stock_code is required"))
	}
	if req.Limit <= 0 {
		req.Limit = 6
	} else if req.Limit > 50 {
		req.Limit = 50
	}
	return nil
}

// GetRelatedNews returns news semantically related to a stock (or anchor article).
func (s *ShortsServer) GetRelatedNews(ctx context.Context, req *connect.Request[shortsv1alpha1.GetRelatedNewsRequest]) (*connect.Response[shortsv1alpha1.GetRelatedNewsResponse], error) {
	if err := ValidateGetRelatedNewsRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetRelatedNews: %v", err)
		return nil, err
	}

	s.logger.Debugf("get related news: stock_code=%s, article_id=%s, limit=%d", req.Msg.StockCode, req.Msg.ArticleId, req.Msg.Limit)

	cacheKey := s.cache.GetRelatedNewsKey(req.Msg.StockCode, req.Msg.ArticleId, req.Msg.Limit)
	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		articles, err := s.store.GetRelatedNews(req.Msg.StockCode, req.Msg.ArticleId, req.Msg.Limit)
		if err != nil {
			return nil, err
		}
		return &shortsv1alpha1.GetRelatedNewsResponse{
			Articles: convertNewsArticles(articles),
		}, nil
	})
	if err != nil {
		s.logger.Errorf("database error in GetRelatedNews: stock_code=%s, err=%v", req.Msg.StockCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get related news"))
	}

	return connect.NewResponse(cachedResponse.(*shortsv1alpha1.GetRelatedNewsResponse)), nil
}
