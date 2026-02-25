package shorts

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"google.golang.org/protobuf/types/known/timestamppb"
	"time"
)

// GetStockNews retrieves recent news articles for a specific stock
func (s *ShortsServer) GetStockNews(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockNewsRequest]) (*connect.Response[shortsv1alpha1.GetStockNewsResponse], error) {
	SetDefaultValues(req.Msg)
	if err := ValidateGetStockNewsRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetStockNews: %v", err)
		return nil, err
	}

	s.logger.Debugf("get stock news: stock_code=%s, limit=%d", req.Msg.StockCode, req.Msg.Limit)

	cacheKey := s.cache.GetStockNewsKey(req.Msg.StockCode, req.Msg.Limit, req.Msg.Source, req.Msg.Sentiment)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		articles, totalCount, err := s.store.GetStockNews(req.Msg.StockCode, req.Msg.Limit, req.Msg.Source, req.Msg.Sentiment)
		if err != nil {
			return nil, err
		}

		protoArticles := convertNewsArticles(articles)
		return &shortsv1alpha1.GetStockNewsResponse{
			Articles:   protoArticles,
			TotalCount: int32(totalCount),
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in GetStockNews: stock_code=%s, err=%v", req.Msg.StockCode, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get stock news"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetStockNewsResponse)
	return connect.NewResponse(response), nil
}

// GetMarketNews retrieves market-wide news articles
func (s *ShortsServer) GetMarketNews(ctx context.Context, req *connect.Request[shortsv1alpha1.GetMarketNewsRequest]) (*connect.Response[shortsv1alpha1.GetMarketNewsResponse], error) {
	SetDefaultValues(req.Msg)

	s.logger.Debugf("get market news: limit=%d, price_sensitive_only=%v", req.Msg.Limit, req.Msg.PriceSensitiveOnly)

	cacheKey := s.cache.GetMarketNewsKey(req.Msg.Limit, req.Msg.Source, req.Msg.PriceSensitiveOnly)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		articles, totalCount, err := s.store.GetMarketNews(req.Msg.Limit, req.Msg.Source, req.Msg.PriceSensitiveOnly)
		if err != nil {
			return nil, err
		}

		protoArticles := convertNewsArticles(articles)
		return &shortsv1alpha1.GetMarketNewsResponse{
			Articles:   protoArticles,
			TotalCount: int32(totalCount),
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in GetMarketNews: err=%v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get market news"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetMarketNewsResponse)
	return connect.NewResponse(response), nil
}

// convertNewsArticles converts store news articles to proto messages
func convertNewsArticles(articles []*shortsstore.NewsArticle) []*shortsv1alpha1.NewsArticle {
	result := make([]*shortsv1alpha1.NewsArticle, len(articles))
	for i, a := range articles {
		article := &shortsv1alpha1.NewsArticle{
			Id:               a.ID,
			StockCode:        a.StockCode,
			Source:            a.Source,
			Headline:         a.Headline,
			Url:              a.URL,
			RelevanceScore:   a.RelevanceScore,
			IsPriceSensitive: a.IsPriceSensitive,
			Tags:             shortsstore.NewsArticleToTags(a.Tags),
		}
		if a.Sentiment != nil {
			article.Sentiment = *a.Sentiment
		}
		if a.Summary != nil {
			article.Summary = *a.Summary
		}
		if a.PublishedAt != "" {
			if t, err := time.Parse(time.RFC3339, a.PublishedAt); err == nil {
				article.PublishedAt = timestamppb.New(t)
			}
		}
		result[i] = article
	}
	return result
}
