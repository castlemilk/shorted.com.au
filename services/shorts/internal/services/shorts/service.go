package shorts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

// validate ServerServer implements productpb.ServerService
var _ shortsv1alpha1connect.ShortedStocksServiceHandler = (*ShortsServer)(nil)

func (s *ShortsServer) GetTopShorts(ctx context.Context, req *connect.Request[shortsv1alpha1.GetTopShortsRequest]) (*connect.Response[shortsv1alpha1.GetTopShortsResponse], error) {
	// Set default values
	SetDefaultValues(req.Msg)

	// Validate request
	if err := ValidateGetTopShortsRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetTopShorts: %v", err)
		return nil, err
	}

	s.logger.Debugf("get top shorts, period: %s, limit: %d, offset: %d", req.Msg.GetPeriod(), req.Msg.Limit, req.Msg.Offset)

	// Check cache first
	cacheKey := s.cache.GetTopShortsKey(req.Msg.Period, req.Msg.Limit, req.Msg.Offset)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		s.logger.Debugf("cache miss for GetTopShorts, fetching from database")

		result, offset, err := s.store.GetTopShorts(req.Msg.GetPeriod(), req.Msg.GetLimit(), req.Msg.Offset)
		if err != nil {
			return nil, err
		}

		return &shortsv1alpha1.GetTopShortsResponse{
			TimeSeries: result,
			Offset:     int32(offset),
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in GetTopShorts: period=%s, limit=%d, offset=%d, err=%v",
			req.Msg.Period, req.Msg.Limit, req.Msg.Offset, err)
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	response := cachedResponse.(*shortsv1alpha1.GetTopShortsResponse)

	return connect.NewResponse(response), nil
}

func (s *ShortsServer) GetStock(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockRequest]) (*connect.Response[stocksv1alpha1.Stock], error) {
	// Set default values and validate
	SetDefaultValues(req.Msg)
	if err := ValidateGetStockRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetStock: %v", err)
		return nil, err
	}

	// Check cache first
	cacheKey := s.cache.GetStockKey(req.Msg.ProductCode)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		return s.store.GetStock(req.Msg.ProductCode)
	})

	if err != nil {
		s.logger.Errorf("database error in GetStock: product_code=%s, err=%v", req.Msg.ProductCode, err)
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("stock not found: %s", req.Msg.ProductCode))
	}

	stock := cachedResponse.(*stocksv1alpha1.Stock)
	return connect.NewResponse(stock), nil
}

func (s *ShortsServer) GetStockData(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockDataRequest]) (*connect.Response[stocksv1alpha1.TimeSeriesData], error) {
	// Set default values and validate
	SetDefaultValues(req.Msg)
	if err := ValidateGetStockDataRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetStockData: %v", err)
		return nil, err
	}

	stock, err := s.store.GetStockData(req.Msg.ProductCode, req.Msg.Period)
	if err != nil {
		s.logger.Errorf("database error in GetStockData: product_code=%s, period=%s, err=%v",
			req.Msg.ProductCode, req.Msg.Period, err)
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("stock data not found: %s for period %s", req.Msg.ProductCode, req.Msg.Period))
	}

	return connect.NewResponse(stock), nil
}

func (s *ShortsServer) GetStockDetails(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockDetailsRequest]) (*connect.Response[stocksv1alpha1.StockDetails], error) {
	// Set default values and validate
	SetDefaultValues(req.Msg)
	if err := ValidateGetStockDetailsRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetStockDetails: %v", err)
		return nil, err
	}

	stock, err := s.store.GetStockDetails(req.Msg.ProductCode)
	if err != nil {
		s.logger.Errorf("database error in GetStockDetails: product_code=%s, err=%v", req.Msg.ProductCode, err)
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("stock details not found: %s", req.Msg.ProductCode))
	}

	return connect.NewResponse(stock), nil
}

func (s *ShortsServer) GetIndustryTreeMap(ctx context.Context, req *connect.Request[shortsv1alpha1.GetIndustryTreeMapRequest]) (*connect.Response[stocksv1alpha1.IndustryTreeMap], error) {
	// Set default values and validate
	SetDefaultValues(req.Msg)
	if err := ValidateGetIndustryTreeMapRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetIndustryTreeMap: %v", err)
		return nil, err
	}

	treeMap, err := s.store.GetIndustryTreeMap(req.Msg.Limit, req.Msg.Period, req.Msg.ViewMode.String())
	if err != nil {
		s.logger.Errorf("database error in GetIndustryTreeMap: limit=%d, period=%s, viewMode=%s, err=%v",
			req.Msg.Limit, req.Msg.Period, req.Msg.ViewMode.String(), err)
		return nil, connect.NewError(connect.CodeInternal,
			fmt.Errorf("failed to get industry tree map data"))
	}

	return connect.NewResponse(treeMap), nil
}

// SearchStocks searches for stocks using Algolia (with PostgreSQL fallback)
func (s *ShortsServer) SearchStocks(ctx context.Context, req *connect.Request[shortsv1alpha1.SearchStocksRequest]) (*connect.Response[shortsv1alpha1.SearchStocksResponse], error) {
	// Set default values
	if req.Msg.Limit <= 0 {
		req.Msg.Limit = 50
	}
	if req.Msg.Limit > 100 {
		req.Msg.Limit = 100 // Cap at 100 results
	}

	// Validate request
	if req.Msg.Query == "" {
		s.logger.Errorf("validation failed for SearchStocks: empty query")
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("search query cannot be empty"))
	}

	s.logger.Debugf("search stocks, query: %s, limit: %d", req.Msg.Query, req.Msg.Limit)

	// Check cache first
	cacheKey := s.cache.GetSearchStocksKey(req.Msg.Query, req.Msg.Limit)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		// Try Algolia first if configured
		if s.config.AlgoliaAppID != "" && s.config.AlgoliaSearchKey != "" {
			s.logger.Debugf("searching via Algolia: query='%s'", req.Msg.Query)
			stocks, algoliaErr := s.searchAlgolia(req.Msg.Query, req.Msg.Limit)
			if algoliaErr == nil && len(stocks) > 0 {
				return &shortsv1alpha1.SearchStocksResponse{
					Query:  req.Msg.Query,
					Stocks: stocks,
					Count:  int32(len(stocks)),
				}, nil
			}
			s.logger.Warnf("Algolia search failed or returned no results, falling back to PostgreSQL: %v", algoliaErr)
		}

		// Fall back to PostgreSQL full-text search
		s.logger.Debugf("cache miss for SearchStocks, fetching from database: query='%s'", req.Msg.Query)
		stocks, err := s.store.SearchStocks(req.Msg.Query, req.Msg.Limit)
		if err != nil {
			return nil, err
		}

		return &shortsv1alpha1.SearchStocksResponse{
			Query:  req.Msg.Query,
			Stocks: stocks,
			Count:  int32(len(stocks)),
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in SearchStocks: query=%s, limit=%d, err=%v",
			req.Msg.Query, req.Msg.Limit, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to search stocks"))
	}

	response := cachedResponse.(*shortsv1alpha1.SearchStocksResponse)
	return connect.NewResponse(response), nil
}

// searchAlgolia queries Algolia for stock search results
func (s *ShortsServer) searchAlgolia(query string, limit int32) ([]*stocksv1alpha1.Stock, error) {
	// Build Algolia request
	indexName := s.config.AlgoliaIndex
	if indexName == "" {
		indexName = "stocks"
	}

	algoliaURL := fmt.Sprintf("https://%s-dsn.algolia.net/1/indexes/%s/query",
		s.config.AlgoliaAppID, indexName)

	reqBody := map[string]interface{}{
		"query":       query,
		"hitsPerPage": limit,
	}
	reqBodyBytes, _ := json.Marshal(reqBody)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", algoliaURL, bytes.NewReader(reqBodyBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create Algolia request: %w", err)
	}

	req.Header.Set("X-Algolia-API-Key", s.config.AlgoliaSearchKey)
	req.Header.Set("X-Algolia-Application-Id", s.config.AlgoliaAppID)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Algolia request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Algolia returned status %d", resp.StatusCode)
	}

	// Parse Algolia response
	var algoliaResp struct {
		Hits []struct {
			StockCode         string   `json:"stock_code"`
			CompanyName       string   `json:"company_name"`
			Industry          string   `json:"industry"`
			Tags              []string `json:"tags"`
			LogoGcsUrl        string   `json:"logo_gcs_url"`
			PercentageShorted float64  `json:"percentage_shorted"`
		} `json:"hits"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&algoliaResp); err != nil {
		return nil, fmt.Errorf("failed to decode Algolia response: %w", err)
	}

	// Convert to Stock protos
	stocks := make([]*stocksv1alpha1.Stock, len(algoliaResp.Hits))
	for i, hit := range algoliaResp.Hits {
		stocks[i] = &stocksv1alpha1.Stock{
			ProductCode:       hit.StockCode,
			Name:              hit.CompanyName,
			Industry:          hit.Industry,
			Tags:              hit.Tags,
			LogoUrl:           hit.LogoGcsUrl,
			PercentageShorted: float32(hit.PercentageShorted),
		}
	}

	return stocks, nil
}

func (s *ShortsServer) GetSyncStatus(ctx context.Context, req *connect.Request[shortsv1alpha1.GetSyncStatusRequest]) (*connect.Response[shortsv1alpha1.GetSyncStatusResponse], error) {
	limit := req.Msg.Limit
	if limit <= 0 {
		limit = 10 // Default limit
	}

	s.logger.Debugf("getting sync status with limit %d", limit)

	runs, err := s.store.GetSyncStatus(int(limit))
	if err != nil {
		s.logger.Errorf("failed to get sync status: %v", err)
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	return connect.NewResponse(&shortsv1alpha1.GetSyncStatusResponse{
		Runs: runs,
	}), nil
}
