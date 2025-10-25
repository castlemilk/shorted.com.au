package shorts

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	connectcors "connectrpc.com/cors"
	"github.com/rs/cors"

	"github.com/castlemilk/shorted.com.au/services/pkg/log"

	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/register/v1/registerv1connect"
	shortsv1alpha1connect "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1/shortsv1alpha1connect"
	"github.com/rakyll/statik/fs"

	_ "github.com/castlemilk/shorted.com.au/services/shorts/internal/api/schema/statik"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

// withCORS adds CORS support to a Connect HTTP handler.
func withCORS(h http.Handler) http.Handler {
	middleware := cors.New(cors.Options{
		AllowedOrigins:   []string{"http://localhost:3000", "http://localhost:3001", "http://localhost:3020", "https://*.vercel.app", "https://*.shorted.com.au", "https://shorted.com.au"},
		AllowedMethods:   connectcors.AllowedMethods(),
		AllowedHeaders:   append([]string{"Authorization"}, connectcors.AllowedHeaders()...),
		ExposedHeaders:   connectcors.ExposedHeaders(),
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
		w.Write([]byte("OK"))
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
		}
		
		// Search stocks
		if s.store == nil {
			logger.Errorf("Store is nil")
			http.Error(w, "Service not initialized", http.StatusInternalServerError)
			return
		}
		
		stocks, err := s.store.SearchStocks(query, limit)
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
		
		// Convert to JSON response
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		
		// Create proper JSON response structure
		type StockResponse struct {
			ProductCode           string  `json:"productCode"`
			Name                  string  `json:"name"`
			PercentageShorted     float64 `json:"percentageShorted"`
			TotalProductInIssue   float64 `json:"totalProductInIssue"`
			ReportedShortPositions float64 `json:"reportedShortPositions"`
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
				ProductCode:           stock.ProductCode,
				Name:                  stock.Name,
				PercentageShorted:     float64(stock.PercentageShorted),
				TotalProductInIssue:   float64(stock.TotalProductInIssue),
				ReportedShortPositions: float64(stock.ReportedShortPositions),
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
