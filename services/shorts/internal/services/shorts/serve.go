package shorts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	connectcors "connectrpc.com/cors"
	"github.com/rs/cors"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"

	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/register/v1/registerv1connect"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"github.com/rakyll/statik/fs"

	_ "github.com/castlemilk/shorted.com.au/services/shorts/internal/api/schema/statik"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

// withCORS adds CORS support to a Connect HTTP handler.
func withCORS(h http.Handler) http.Handler {
	middleware := cors.New(cors.Options{
		AllowedOrigins: []string{"http://localhost:3000", "http://localhost:3001", "http://localhost:3020", "https://*.vercel.app", "https://*.shorted.com.au", "https://shorted.com.au"},
		AllowedMethods: connectcors.AllowedMethods(),
		AllowedHeaders: append([]string{"Authorization"}, connectcors.AllowedHeaders()...),
		ExposedHeaders: connectcors.ExposedHeaders(),
	})
	return middleware.Handler(h)
}

func (s *ShortsServer) Serve(ctx context.Context, logger *log.Logger, address string) error {

	mux := http.NewServeMux()
	shortsPath, shortsHandler := shortsv1alpha1connect.NewShortedStocksServiceHandler(s)
	registerPath, registerHandler := registerv1connect.NewRegisterServiceHandler(s.registerServer)
	shortsHandler = withCORS(shortsHandler)
	registerHandler = withCORS(registerHandler)
	// handler = AuthMiddleware(handler)
	mux.Handle(shortsPath, shortsHandler)
	mux.Handle(registerPath, registerHandler)

	// Add health check endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte("OK")); err != nil {
			log.Errorf("Error writing response: %v", err)
		}
	})

	// Add stock search endpoint
	mux.HandleFunc("/api/stocks/search", func(w http.ResponseWriter, r *http.Request) {
		// Add CORS headers
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		// Handle preflight OPTIONS request
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		query := r.URL.Query().Get("q")
		if query == "" {
			http.Error(w, "Missing query parameter 'q'", http.StatusBadRequest)
			return
		}

		limitStr := r.URL.Query().Get("limit")
		limit := int32(50) // default
		if limitStr != "" {
			if _, err := fmt.Sscanf(limitStr, "%d", &limit); err != nil {
				http.Error(w, "Invalid limit parameter", http.StatusBadRequest)
				return
			}
			// Validate limit is non-negative and reasonable
			if limit < 0 {
				http.Error(w, "Limit must be non-negative", http.StatusBadRequest)
				return
			}
			// Cap limit at 1000 to prevent DOS
			if limit > 1000 {
				limit = 1000
			}
		}

		// Search stocks
		if s.store == nil {
			logger.Errorf("Store is nil")
			http.Error(w, "Service not initialized", http.StatusInternalServerError)
			return
		}

		// Check cache first
		cacheKey := s.cache.GetSearchStocksKey(query, limit)
		
		// Use cached result or fetch from Algolia/database
		cachedResult, err := s.cache.GetOrSet(cacheKey, func() (interface{}, error) {
			// Try Algolia first if configured
			if s.config.AlgoliaAppID != "" && s.config.AlgoliaSearchKey != "" {
				logger.Debugf("searching via Algolia: query='%s'", query)
				stocks, algoliaErr := s.searchAlgolia(query, limit)
				if algoliaErr == nil && len(stocks) > 0 {
					return stocks, nil
				}
				logger.Warnf("Algolia search failed or returned no results for '%s', falling back to PostgreSQL: %v", query, algoliaErr)
			}
			
			// Fall back to PostgreSQL
			logger.Debugf("cache miss for SearchStocks, fetching from database: query='%s'", query)
			return s.store.SearchStocks(query, limit)
		})

		if err != nil {
			logger.Errorf("Error searching stocks for query '%s': %v", query, err)
			// Check if it's a timeout error
			if err.Error() == "search query timed out" {
				http.Error(w, "Search timeout", http.StatusRequestTimeout)
			} else {
				http.Error(w, "Internal server error", http.StatusInternalServerError)
			}
			return
		}
		
		stocks := cachedResult.([]*stocksv1alpha1.Stock)

		// Convert to JSON response
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)

		// Create proper JSON response structure
		type StockResponse struct {
			ProductCode            string   `json:"product_code"`
			Name                   string   `json:"name"`
			PercentageShorted      float64  `json:"percentage_shorted"`
			TotalProductInIssue    float64  `json:"total_product_in_issue"`
			ReportedShortPositions float64  `json:"reported_short_positions"`
			Industry               string   `json:"industry"`
			Tags                   []string `json:"tags"`
			LogoUrl                string   `json:"logoUrl"`
		}

		type SearchResponse struct {
			Query  string          `json:"query"`
			Stocks []StockResponse `json:"stocks"`
			Count  int             `json:"count"`
		}

		// Convert stocks to response format
		stockResponses := make([]StockResponse, len(stocks))
		for i, stock := range stocks {
			stockResponses[i] = StockResponse{
				ProductCode:            stock.ProductCode,
				Name:                   stock.Name,
				PercentageShorted:      float64(stock.PercentageShorted),
				TotalProductInIssue:    float64(stock.TotalProductInIssue),
				ReportedShortPositions: float64(stock.ReportedShortPositions),
				Industry:               stock.Industry,
				Tags:                   stock.Tags,
				LogoUrl:                stock.LogoUrl,
			}
		}

		response := SearchResponse{
			Query:  query,
			Stocks: stockResponses,
			Count:  len(stocks),
		}

		// Marshal to JSON
		if err := json.NewEncoder(w).Encode(response); err != nil {
			logger.Errorf("Error encoding JSON response: %v", err)
			return
		}
	})

	// Add Algolia search proxy endpoint
	mux.HandleFunc("/api/algolia/search", func(w http.ResponseWriter, r *http.Request) {
		// Add CORS headers
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		// Handle preflight OPTIONS request
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method != http.MethodPost && r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Check if Algolia is configured
		if s.config.AlgoliaAppID == "" || s.config.AlgoliaSearchKey == "" {
			logger.Warnf("Algolia not configured, falling back to PostgreSQL search")
			http.Error(w, "Algolia not configured", http.StatusServiceUnavailable)
			return
		}

		var query string
		var hitsPerPage int = 20

		if r.Method == http.MethodGet {
			query = r.URL.Query().Get("q")
			if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
				fmt.Sscanf(limitStr, "%d", &hitsPerPage)
			}
		} else {
			// Parse POST body
			var reqBody struct {
				Query       string `json:"query"`
				HitsPerPage int    `json:"hitsPerPage"`
			}
			if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
				http.Error(w, "Invalid request body", http.StatusBadRequest)
				return
			}
			query = reqBody.Query
			if reqBody.HitsPerPage > 0 {
				hitsPerPage = reqBody.HitsPerPage
			}
		}

		if query == "" {
			http.Error(w, "Missing query parameter", http.StatusBadRequest)
			return
		}

		// Cap hitsPerPage
		if hitsPerPage > 100 {
			hitsPerPage = 100
		}

		// Build Algolia request
		indexName := s.config.AlgoliaIndex
		if indexName == "" {
			indexName = "stocks"
		}

		algoliaURL := fmt.Sprintf("https://%s-dsn.algolia.net/1/indexes/%s/query",
			s.config.AlgoliaAppID, indexName)

		algoliaReqBody := map[string]interface{}{
			"query":       query,
			"hitsPerPage": hitsPerPage,
		}
		reqBodyBytes, _ := json.Marshal(algoliaReqBody)

		algoliaReq, err := http.NewRequest("POST", algoliaURL, bytes.NewReader(reqBodyBytes))
		if err != nil {
			logger.Errorf("Error creating Algolia request: %v", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		// Use search key (safe for read operations)
		algoliaReq.Header.Set("X-Algolia-API-Key", s.config.AlgoliaSearchKey)
		algoliaReq.Header.Set("X-Algolia-Application-Id", s.config.AlgoliaAppID)
		algoliaReq.Header.Set("Content-Type", "application/json")

		// Make request to Algolia
		client := &http.Client{}
		resp, err := client.Do(algoliaReq)
		if err != nil {
			logger.Errorf("Error calling Algolia: %v", err)
			http.Error(w, "Search service unavailable", http.StatusServiceUnavailable)
			return
		}
		defer resp.Body.Close()

		// Forward response
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})

	// Add admin sync status endpoint
	mux.HandleFunc("/api/admin/sync-status", func(w http.ResponseWriter, r *http.Request) {
		// Add CORS headers
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Parse limit parameter
		limitStr := r.URL.Query().Get("limit")
		limit := 10 // default
		if limitStr != "" {
			fmt.Sscanf(limitStr, "%d", &limit)
		}
		if limit > 100 {
			limit = 100
		}

		// Get sync status from store
		runs, err := s.store.GetSyncStatus(limit)
		if err != nil {
			logger.Errorf("Failed to get sync status: %v", err)
			http.Error(w, "Failed to get sync status", http.StatusInternalServerError)
			return
		}

		// Build response
		type SyncRunResponse struct {
			RunId                 string  `json:"runId"`
			StartedAt             string  `json:"startedAt"`
			CompletedAt           string  `json:"completedAt"`
			Status                string  `json:"status"`
			ErrorMessage          string  `json:"errorMessage"`
			ShortsRecordsUpdated  int32   `json:"shortsRecordsUpdated"`
			PricesRecordsUpdated  int32   `json:"pricesRecordsUpdated"`
			MetricsRecordsUpdated int32   `json:"metricsRecordsUpdated"`
			AlgoliaRecordsSynced  int32   `json:"algoliaRecordsSynced"`
			TotalDurationSeconds  float64 `json:"totalDurationSeconds"`
			Environment           string  `json:"environment"`
			Hostname              string  `json:"hostname"`
		}

		type Response struct {
			Runs []SyncRunResponse `json:"runs"`
		}

		runResponses := make([]SyncRunResponse, len(runs))
		for i, run := range runs {
			runResponses[i] = SyncRunResponse{
				RunId:                 run.RunId,
				StartedAt:             run.StartedAt,
				CompletedAt:           run.CompletedAt,
				Status:                run.Status,
				ErrorMessage:          run.ErrorMessage,
				ShortsRecordsUpdated:  run.ShortsRecordsUpdated,
				PricesRecordsUpdated:  run.PricesRecordsUpdated,
				MetricsRecordsUpdated: run.MetricsRecordsUpdated,
				AlgoliaRecordsSynced:  run.AlgoliaRecordsSynced,
				TotalDurationSeconds:  run.TotalDurationSeconds,
				Environment:           run.Environment,
				Hostname:              run.Hostname,
			}
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(Response{Runs: runResponses}); err != nil {
			logger.Errorf("Error encoding JSON response: %v", err)
			return
		}
	})

	// Add statik file server
	statikFS, err := fs.New()
	if err != nil {
		return fmt.Errorf("failed to create statik filesystem: %w", err)
	}
	mux.Handle("/api/docs/", withCORS(http.StripPrefix("/api/docs/", http.FileServer(statikFS))))

	return http.ListenAndServe(
		address,
		// Use h2c so we can serve HTTP/2 without TLS.
		h2c.NewHandler(mux, &http2.Server{}),
	)
}
