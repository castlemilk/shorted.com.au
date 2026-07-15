package shorts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net/http"
	"sort"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
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

	s.logger.Debugf("get top shorts, period: %s, limit: %d, offset: %d, summaryOnly: %v", req.Msg.GetPeriod(), req.Msg.Limit, req.Msg.Offset, req.Msg.SummaryOnly)

	// Check cache first — include summaryOnly in cache key to avoid mixing full/summary responses
	summaryTag := ""
	if req.Msg.SummaryOnly {
		summaryTag = ":summary"
	}
	// A code-scoped request returns a DIFFERENT series set than the top-N call
	// with the same period/limit/offset — fingerprint the (order-independent)
	// code set into the key so the two never collide in the cache.
	if len(req.Msg.ProductCodes) > 0 {
		codes := append([]string(nil), req.Msg.ProductCodes...)
		sort.Strings(codes)
		h := fnv.New32a()
		for _, c := range codes {
			_, _ = h.Write([]byte(c))
			_, _ = h.Write([]byte{0})
		}
		summaryTag += fmt.Sprintf(":codes:%x", h.Sum32())
	}
	cacheKey := s.cache.GetTopShortsKey(req.Msg.Period+summaryTag, req.Msg.Limit, req.Msg.Offset)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		s.logger.Debugf("cache miss for GetTopShorts, fetching from database")

		result, offset, err := s.store.GetTopShorts(req.Msg.GetPeriod(), req.Msg.GetLimit(), req.Msg.Offset, req.Msg.SummaryOnly, req.Msg.ProductCodes...)
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

	// Check cache first
	cacheKey := s.cache.GetStockDataKey(req.Msg.ProductCode, req.Msg.Period)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		s.logger.Debugf("cache miss for GetStockData, fetching from database: product_code=%s, period=%s",
			req.Msg.ProductCode, req.Msg.Period)
		return s.store.GetStockData(req.Msg.ProductCode, req.Msg.Period)
	})

	if err != nil {
		s.logger.Errorf("database error in GetStockData: product_code=%s, period=%s, err=%v",
			req.Msg.ProductCode, req.Msg.Period, err)
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("stock data not found: %s for period %s", req.Msg.ProductCode, req.Msg.Period))
	}

	stock := cachedResponse.(*stocksv1alpha1.TimeSeriesData)
	return connect.NewResponse(stock), nil
}

func (s *ShortsServer) GetStockDetails(ctx context.Context, req *connect.Request[shortsv1alpha1.GetStockDetailsRequest]) (*connect.Response[stocksv1alpha1.StockDetails], error) {
	// Set default values and validate
	SetDefaultValues(req.Msg)
	if err := ValidateGetStockDetailsRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetStockDetails: %v", err)
		return nil, err
	}

	// Check cache first
	cacheKey := s.cache.GetStockDetailsKey(req.Msg.ProductCode)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		s.logger.Debugf("cache miss for GetStockDetails, fetching from database: product_code=%s", req.Msg.ProductCode)
		return s.store.GetStockDetails(req.Msg.ProductCode)
	})

	if err != nil {
		s.logger.Errorf("database error in GetStockDetails: product_code=%s, err=%v", req.Msg.ProductCode, err)
		return nil, connect.NewError(connect.CodeNotFound,
			fmt.Errorf("stock details not found: %s", req.Msg.ProductCode))
	}

	stock := cachedResponse.(*stocksv1alpha1.StockDetails)
	return connect.NewResponse(stock), nil
}

func (s *ShortsServer) GetIndustryTreeMap(ctx context.Context, req *connect.Request[shortsv1alpha1.GetIndustryTreeMapRequest]) (*connect.Response[stocksv1alpha1.IndustryTreeMap], error) {
	// Set default values and validate
	SetDefaultValues(req.Msg)
	if err := ValidateGetIndustryTreeMapRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetIndustryTreeMap: %v", err)
		return nil, err
	}

	// Check cache first
	cacheKey := s.cache.GetIndustryTreeMapKey(req.Msg.Limit, req.Msg.Period, req.Msg.ViewMode.String())

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		s.logger.Debugf("cache miss for GetIndustryTreeMap, fetching from database: limit=%d, period=%s, viewMode=%s",
			req.Msg.Limit, req.Msg.Period, req.Msg.ViewMode.String())
		return s.store.GetIndustryTreeMap(req.Msg.Limit, req.Msg.Period, req.Msg.ViewMode.String())
	})

	if err != nil {
		s.logger.Errorf("database error in GetIndustryTreeMap: limit=%d, period=%s, viewMode=%s, err=%v",
			req.Msg.Limit, req.Msg.Period, req.Msg.ViewMode.String(), err)
		return nil, connect.NewError(connect.CodeInternal,
			fmt.Errorf("failed to get industry tree map data"))
	}

	treeMap := cachedResponse.(*stocksv1alpha1.IndustryTreeMap)
	return connect.NewResponse(treeMap), nil
}

// GetMarketByDate returns all short positions for a specific trading date
func (s *ShortsServer) GetMarketByDate(ctx context.Context, req *connect.Request[shortsv1alpha1.GetMarketByDateRequest]) (*connect.Response[shortsv1alpha1.GetMarketByDateResponse], error) {
	SetDefaultValues(req.Msg)
	if err := ValidateGetMarketByDateRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetMarketByDate: %v", err)
		return nil, err
	}

	s.logger.Debugf("get market by date: %s, limit: %d, offset: %d", req.Msg.Date, req.Msg.Limit, req.Msg.Offset)

	cacheKey := s.cache.GetMarketByDateKey(req.Msg.Date, req.Msg.Limit, req.Msg.Offset)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		stocks, totalCount, err := s.store.GetMarketByDate(req.Msg.Date, req.Msg.Limit, req.Msg.Offset)
		if err != nil {
			return nil, err
		}

		// Get previous date (most recent date before this one)
		prevDates, _, _, _, _ := s.store.GetAvailableDates(1, req.Msg.Date)
		previousDate := ""
		if len(prevDates) > 0 {
			previousDate = prevDates[0]
		}

		// Get next date: fetch 2 dates starting from day after this one
		// Dates come back DESC, so we need the last one that's after our date
		nextDate := ""
		recentDates, _, _, _, _ := s.store.GetAvailableDates(90, "")
		for i := len(recentDates) - 1; i >= 0; i-- {
			if recentDates[i] > req.Msg.Date {
				nextDate = recentDates[i]
				break
			}
		}

		return &shortsv1alpha1.GetMarketByDateResponse{
			Date:         req.Msg.Date,
			Stocks:       stocks,
			TotalCount:   int32(totalCount),
			PreviousDate: previousDate,
			NextDate:     nextDate,
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in GetMarketByDate: date=%s, err=%v", req.Msg.Date, err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get market data for date %s", req.Msg.Date))
	}

	response := cachedResponse.(*shortsv1alpha1.GetMarketByDateResponse)
	return connect.NewResponse(response), nil
}

// GetAvailableDates returns available trading dates with short position data
func (s *ShortsServer) GetAvailableDates(ctx context.Context, req *connect.Request[shortsv1alpha1.GetAvailableDatesRequest]) (*connect.Response[shortsv1alpha1.GetAvailableDatesResponse], error) {
	SetDefaultValues(req.Msg)
	if err := ValidateGetAvailableDatesRequest(req.Msg); err != nil {
		s.logger.Errorf("validation failed for GetAvailableDates: %v", err)
		return nil, err
	}

	s.logger.Debugf("get available dates: limit=%d, before=%s", req.Msg.Limit, req.Msg.Before)

	cacheKey := s.cache.GetAvailableDatesKey(req.Msg.Limit, req.Msg.Before)

	cachedResponse, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
		dates, earliest, latest, totalCount, err := s.store.GetAvailableDates(int(req.Msg.Limit), req.Msg.Before)
		if err != nil {
			return nil, err
		}

		return &shortsv1alpha1.GetAvailableDatesResponse{
			Dates:        dates,
			EarliestDate: earliest,
			LatestDate:   latest,
			TotalCount:   int32(totalCount),
		}, nil
	})

	if err != nil {
		s.logger.Errorf("database error in GetAvailableDates: err=%v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to get available dates"))
	}

	response := cachedResponse.(*shortsv1alpha1.GetAvailableDatesResponse)
	return connect.NewResponse(response), nil
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

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("algolia request failed: %w", err)
	}
	defer func() {
		_ = resp.Body.Close()
	}()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("algolia returned status %d", resp.StatusCode)
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

	// Use default filter for gRPC requests (production, exclude local)
	filter := shortsstore.SyncStatusFilter{
		Limit:        int(limit),
		Environment:  "production",
		ExcludeLocal: true,
	}
	runs, err := s.store.GetSyncStatus(filter)
	if err != nil {
		s.logger.Errorf("failed to get sync status: %v", err)
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	return connect.NewResponse(&shortsv1alpha1.GetSyncStatusResponse{
		Runs: runs,
	}), nil
}

func (s *ShortsServer) MintToken(ctx context.Context, req *connect.Request[shortsv1alpha1.MintTokenRequest]) (*connect.Response[shortsv1alpha1.MintTokenResponse], error) {
	// Extract user information from context (populated by AuthInterceptor)
	userClaims, ok := UserFromContext(ctx)
	if !ok {
		return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("user not authenticated"))
	}

	// Check subscription status
	subscription, err := s.store.GetAPISubscription(userClaims.UserID)
	if err != nil {
		s.logger.Errorf("failed to check subscription for %s: %v", userClaims.Email, err)
		// Continue with free tier if DB check fails
	}

	// Determine subscription tier
	tier := "free"
	if subscription != nil && (subscription.Status == "active" || subscription.Status == "trialing") {
		tier = subscription.Tier
	}

	// Admin emails can always mint tokens (for testing/development)
	adminEmails := []string{
		"ben.ebsworth@gmail.com",
		"ben@shorted.com.au",
		"e2e-test@shorted.com.au",
	}

	isAdmin := false
	for _, adminEmail := range adminEmails {
		if userClaims.Email == adminEmail {
			isAdmin = true
			break
		}
	}

	// Non-admin users without active subscription cannot mint tokens
	if !isAdmin && tier == "free" {
		s.logger.Warnf("User %s attempted to mint token without active subscription", userClaims.Email)
		return nil, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("active subscription required to generate API tokens"))
	}

	// Determine roles for the API token
	// All authenticated users get "api-user" role (can access public APIs)
	// Specific emails get "admin" role (can access admin endpoints)
	roles := []string{"api-user"}
	if isAdmin {
		roles = append(roles, "admin")
		// Admins get pro tier by default if they don't have a subscription
		if tier == "free" {
			tier = "pro"
		}
	}

	s.logger.Infof("Minting token for %s (admin=%v, tier=%s, roles=%v)", userClaims.Email, isAdmin, tier, roles)

	// Mint a new API token with determined roles and tier
	token, err := s.tokenService.MintTokenWithTier(userClaims.UserID, userClaims.Email, roles, tier, 30*24*time.Hour)
	if err != nil {
		s.logger.Errorf("failed to mint token: %v", err)
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("failed to generate token"))
	}

	return connect.NewResponse(&shortsv1alpha1.MintTokenResponse{
		Token: token,
	}), nil
}
