package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"time"

	"connectrpc.com/connect"
	connectcors "connectrpc.com/cors"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/cors"
	"google.golang.org/protobuf/types/known/timestamppb"

	marketdatav1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/marketdata/v1"
	"github.com/castlemilk/shorted.com.au/services/gen/proto/go/marketdata/v1/marketdatav1connect"
)

type MarketDataService struct {
	db *pgxpool.Pool
}

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

// GetStockPrice returns the latest price for a stock
func (s *MarketDataService) GetStockPrice(
	ctx context.Context,
	req *connect.Request[marketdatav1.GetStockPriceRequest],
) (*connect.Response[marketdatav1.GetStockPriceResponse], error) {
	// Set defaults and normalize input
	SetDefaultValues(req.Msg)

	// Validate request
	if err := ValidateGetStockPriceRequest(req.Msg); err != nil {
		return nil, err
	}

	query := `
		SELECT date, open, high, low, close, volume, adjusted_close
		FROM stock_prices
		WHERE stock_code = $1
		ORDER BY date DESC
		LIMIT 1
	`

	var (
		date          time.Time
		open          float64
		high          float64
		low           float64
		close         float64
		volume        int64
		adjustedClose sql.NullFloat64
	)

	err := s.db.QueryRow(ctx, query, req.Msg.StockCode).Scan(
		&date,
		&open,
		&high,
		&low,
		&close,
		&volume,
		&adjustedClose,
	)

	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("stock not found: %s", req.Msg.StockCode))
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}

	// Create the price struct with converted timestamp
	adjClose := close // Default to close if NULL
	if adjustedClose.Valid {
		adjClose = adjustedClose.Float64
	}

	price := marketdatav1.StockPrice{
		StockCode:     req.Msg.StockCode,
		Date:          timestamppb.New(date),
		Open:          open,
		High:          high,
		Low:           low,
		Close:         close,
		Volume:        volume,
		AdjustedClose: adjClose,
	}

	// Calculate change from previous close
	prevQuery := `
		SELECT close 
		FROM stock_prices 
		WHERE stock_code = $1 AND date < $2
		ORDER BY date DESC 
		LIMIT 1
	`

	var prevClose float64
	err = s.db.QueryRow(ctx, prevQuery, req.Msg.StockCode, date).Scan(&prevClose)
	if err == nil && prevClose > 0 {
		price.Change = close - prevClose
		price.ChangePercent = (price.Change / prevClose) * 100
	}

	return connect.NewResponse(&marketdatav1.GetStockPriceResponse{
		Price: &price,
	}), nil
}

// GetHistoricalPrices returns historical prices for a stock
func (s *MarketDataService) GetHistoricalPrices(
	ctx context.Context,
	req *connect.Request[marketdatav1.GetHistoricalPricesRequest],
) (*connect.Response[marketdatav1.GetHistoricalPricesResponse], error) {
	// Set defaults and normalize input
	SetDefaultValues(req.Msg)

	// Validate request
	if err := ValidateGetHistoricalPricesRequest(req.Msg); err != nil {
		return nil, err
	}

	// Calculate date range based on period
	endDate := time.Now()
	var startDate time.Time

	switch req.Msg.Period {
	case "1d":
		startDate = endDate.AddDate(0, 0, -1)
	case "1w":
		startDate = endDate.AddDate(0, 0, -7)
	case "1m":
		startDate = endDate.AddDate(0, -1, 0)
	case "3m":
		startDate = endDate.AddDate(0, -3, 0)
	case "6m":
		startDate = endDate.AddDate(0, -6, 0)
	case "1y":
		startDate = endDate.AddDate(-1, 0, 0)
	case "2y":
		startDate = endDate.AddDate(-2, 0, 0)
	case "5y":
		startDate = endDate.AddDate(-5, 0, 0)
	case "10y":
		startDate = endDate.AddDate(-10, 0, 0)
	case "max":
		startDate = endDate.AddDate(-10, 0, 0) // Max is 10 years
	default:
		startDate = endDate.AddDate(0, -1, 0) // Default to 1 month
	}

	query := `
		SELECT date, open, high, low, close, volume, adjusted_close
		FROM stock_prices
		WHERE stock_code = $1 AND date >= $2 AND date <= $3
		ORDER BY date ASC
	`

	// Add timeout to prevent hanging
	queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	rows, err := s.db.Query(queryCtx, query, req.Msg.StockCode, startDate, endDate)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	defer rows.Close()

	var prices []*marketdatav1.StockPrice
	var prevClose float64

	for rows.Next() {
		var (
			date          time.Time
			open          float64
			high          float64
			low           float64
			close         float64
			volume        int64
			adjustedClose sql.NullFloat64
		)

		err := rows.Scan(
			&date,
			&open,
			&high,
			&low,
			&close,
			&volume,
			&adjustedClose,
		)
		if err != nil {
			continue
		}

		// Create the price struct with converted timestamp
		adjClose := close // Default to close if NULL
		if adjustedClose.Valid {
			adjClose = adjustedClose.Float64
		}

		price := marketdatav1.StockPrice{
			StockCode:     req.Msg.StockCode,
			Date:          timestamppb.New(date),
			Open:          open,
			High:          high,
			Low:           low,
			Close:         close,
			Volume:        volume,
			AdjustedClose: adjClose,
		}

		// Calculate daily change
		if prevClose > 0 {
			price.Change = close - prevClose
			price.ChangePercent = (price.Change / prevClose) * 100
		}
		prevClose = close

		prices = append(prices, &price)
	}

	return connect.NewResponse(&marketdatav1.GetHistoricalPricesResponse{
		Prices: prices,
	}), nil
}

// GetMultipleStockPrices returns latest prices for multiple stocks
func (s *MarketDataService) GetMultipleStockPrices(
	ctx context.Context,
	req *connect.Request[marketdatav1.GetMultipleStockPricesRequest],
) (*connect.Response[marketdatav1.GetMultipleStockPricesResponse], error) {
	// Set defaults and normalize input
	SetDefaultValues(req.Msg)

	// Validate request
	if err := ValidateGetMultipleStockPricesRequest(req.Msg); err != nil {
		return nil, err
	}

	if len(req.Msg.StockCodes) == 0 {
		return connect.NewResponse(&marketdatav1.GetMultipleStockPricesResponse{
			Prices: make(map[string]*marketdatav1.StockPrice),
		}), nil
	}

	// Use a more efficient query with DISTINCT ON
	query := `
		WITH latest_prices AS (
			SELECT DISTINCT ON (stock_code)
				stock_code, date, open, high, low, close, volume, adjusted_close
			FROM stock_prices
			WHERE stock_code = ANY($1)
			ORDER BY stock_code, date DESC
		),
		prev_prices AS (
			SELECT DISTINCT ON (sp.stock_code)
				sp.stock_code, sp.close as prev_close
			FROM stock_prices sp
			INNER JOIN latest_prices lp ON sp.stock_code = lp.stock_code
			WHERE sp.date < lp.date
			ORDER BY sp.stock_code, sp.date DESC
		)
		SELECT 
			lp.stock_code, lp.date, lp.open, lp.high, lp.low, lp.close, 
			lp.volume, lp.adjusted_close, pp.prev_close
		FROM latest_prices lp
		LEFT JOIN prev_prices pp ON lp.stock_code = pp.stock_code
	`

	rows, err := s.db.Query(ctx, query, req.Msg.StockCodes)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	defer rows.Close()

	prices := make(map[string]*marketdatav1.StockPrice)

	for rows.Next() {
		var (
			stockCode     string
			date          time.Time
			open          float64
			high          float64
			low           float64
			close         float64
			volume        int64
			adjustedClose sql.NullFloat64
			prevClose     sql.NullFloat64
		)

		err := rows.Scan(
			&stockCode,
			&date,
			&open,
			&high,
			&low,
			&close,
			&volume,
			&adjustedClose,
			&prevClose,
		)
		if err != nil {
			continue
		}

		// Create the price struct with converted timestamp
		adjClose := close // Default to close if NULL
		if adjustedClose.Valid {
			adjClose = adjustedClose.Float64
		}

		price := marketdatav1.StockPrice{
			StockCode:     stockCode,
			Date:          timestamppb.New(date),
			Open:          open,
			High:          high,
			Low:           low,
			Close:         close,
			Volume:        volume,
			AdjustedClose: adjClose,
		}

		// Calculate change if we have previous close
		if prevClose.Valid && prevClose.Float64 > 0 {
			price.Change = close - prevClose.Float64
			price.ChangePercent = (price.Change / prevClose.Float64) * 100
		}

		prices[stockCode] = &price
	}

	return connect.NewResponse(&marketdatav1.GetMultipleStockPricesResponse{
		Prices: prices,
	}), nil
}

// GetStockCorrelations returns correlation matrix for stocks
func (s *MarketDataService) GetStockCorrelations(
	ctx context.Context,
	req *connect.Request[marketdatav1.GetStockCorrelationsRequest],
) (*connect.Response[marketdatav1.GetStockCorrelationsResponse], error) {
	// Set defaults and normalize input
	SetDefaultValues(req.Msg)

	// Validate request
	if err := ValidateGetStockCorrelationsRequest(req.Msg); err != nil {
		return nil, err
	}

	// Calculate date range
	endDate := time.Now()
	var startDate time.Time

	switch req.Msg.Period {
	case "1m":
		startDate = endDate.AddDate(0, -1, 0)
	case "3m":
		startDate = endDate.AddDate(0, -3, 0)
	case "6m":
		startDate = endDate.AddDate(0, -6, 0)
	case "1y":
		startDate = endDate.AddDate(-1, 0, 0)
	default:
		startDate = endDate.AddDate(0, -3, 0)
	}

	// Get daily returns for all stocks
	query := `
		WITH daily_returns AS (
			SELECT 
				stock_code,
				date,
				LN(close / LAG(close) OVER (PARTITION BY stock_code ORDER BY date)) as log_return
			FROM stock_prices
			WHERE stock_code = ANY($1) AND date >= $2 AND date <= $3
		),
		aligned_returns AS (
			SELECT date
			FROM daily_returns
			WHERE log_return IS NOT NULL
			GROUP BY date
			HAVING COUNT(DISTINCT stock_code) = $4
		)
		SELECT 
			dr.stock_code,
			dr.date,
			dr.log_return
		FROM daily_returns dr
		INNER JOIN aligned_returns ar ON dr.date = ar.date
		WHERE dr.log_return IS NOT NULL
		ORDER BY dr.date, dr.stock_code
	`

	rows, err := s.db.Query(ctx, query, req.Msg.StockCodes, startDate, endDate, len(req.Msg.StockCodes))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	defer rows.Close()

	// Organize returns by stock
	returns := make(map[string][]float64)
	dateSet := make(map[time.Time]bool)

	for rows.Next() {
		var stockCode string
		var date time.Time
		var logReturn float64

		err := rows.Scan(&stockCode, &date, &logReturn)
		if err != nil {
			continue
		}

		returns[stockCode] = append(returns[stockCode], logReturn)
		dateSet[date] = true
	}

	// Need at least 20 data points for meaningful correlation
	if len(dateSet) < 20 {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("insufficient data for correlation calculation"))
	}

	// Calculate correlations
	correlations := make(map[string]*marketdatav1.CorrelationRow)

	for _, stock1 := range req.Msg.StockCodes {
		row := &marketdatav1.CorrelationRow{
			Correlations: make(map[string]float64),
		}

		returns1, ok1 := returns[stock1]
		if !ok1 {
			continue
		}

		for _, stock2 := range req.Msg.StockCodes {
			if stock1 == stock2 {
				row.Correlations[stock2] = 1.0
				continue
			}

			returns2, ok2 := returns[stock2]
			if !ok2 {
				continue
			}

			// Calculate Pearson correlation
			corr := calculateCorrelation(returns1, returns2)
			row.Correlations[stock2] = corr
		}

		correlations[stock1] = row
	}

	return connect.NewResponse(&marketdatav1.GetStockCorrelationsResponse{
		Correlations: correlations,
		DataPoints:   int32(len(dateSet)),
	}), nil
}

// Helper function to calculate Pearson correlation
func calculateCorrelation(x, y []float64) float64 {
	if len(x) != len(y) || len(x) == 0 {
		return 0
	}

	n := float64(len(x))
	var sumX, sumY, sumXY, sumX2, sumY2 float64

	for i := range x {
		sumX += x[i]
		sumY += y[i]
		sumXY += x[i] * y[i]
		sumX2 += x[i] * x[i]
		sumY2 += y[i] * y[i]
	}

	numerator := n*sumXY - sumX*sumY
	denominator := math.Sqrt((n*sumX2 - sumX*sumX) * (n*sumY2 - sumY*sumY))

	if denominator == 0 {
		return 0
	}

	return numerator / denominator
}

func main() {
	// Get database URL from environment
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgres://user:password@localhost/shorted"
	}

	// Log startup
	log.Printf("Starting market data service")
	log.Printf("Database URL configured: %t", dbURL != "")

	// Create connection pool configuration
	config, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		log.Printf("WARNING: Failed to parse database URL: %v", err)
		log.Printf("Service will start but database operations will fail")
		// Don't exit - allow server to start
	}

	var pool *pgxpool.Pool

	if config != nil {
		// Configure connection pool settings
		config.MaxConns = 10
		config.MinConns = 2
		config.MaxConnLifetime = 30 * time.Minute
		config.MaxConnIdleTime = 5 * time.Minute
		config.HealthCheckPeriod = 1 * time.Minute
		config.ConnConfig.ConnectTimeout = 10 * time.Second // Increased timeout

		// CRITICAL: Disable prepared statements for Supabase transaction pooler (port 6543)
		// This prevents "prepared statement already exists" errors
		config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol

		log.Printf("Attempting to connect to database (simple protocol mode)")

		// Try to connect with context timeout
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		pool, err = pgxpool.NewWithConfig(ctx, config)
		if err != nil {
			log.Printf("WARNING: Failed to create connection pool: %v", err)
			log.Printf("Service will start but database operations will fail")
			// Don't exit - allow server to start
		} else {
			// Test connection with timeout
			pingCtx, pingCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer pingCancel()

			if err := pool.Ping(pingCtx); err != nil {
				log.Printf("WARNING: Failed to ping database: %v", err)
				log.Printf("Service will start but database operations may fail")
				// Don't close pool or exit - allow retries
			} else {
				log.Printf("Database connection successful")
			}
		}
	}

	// Create service (pool may be nil, which will cause requests to fail but service will start)
	service := &MarketDataService{db: pool}

	// Create Connect handler
	path, handler := marketdatav1connect.NewMarketDataServiceHandler(service)
	handler = withCORS(handler)

	// Create HTTP server
	mux := http.NewServeMux()
	mux.Handle(path, handler)

	// Add health check (always returns 200 OK for Cloud Run startup)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		// Add CORS headers for browser requests
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		// Handle preflight request
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)

		status := map[string]interface{}{
			"status": "healthy",
		}

		// Include database status as metadata (but don't fail health check)
		if pool != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
			defer cancel()

			if err := pool.Ping(ctx); err != nil {
				status["database"] = "unavailable"
				status["database_error"] = err.Error()
			} else {
				status["database"] = "connected"
			}
		} else {
			status["database"] = "not_configured"
		}

		if err := json.NewEncoder(w).Encode(status); err != nil {
			log.Printf("Error encoding status response: %v", err)
		}
	})

	// Add readiness check (for Kubernetes/Cloud Run)
	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
		// Add CORS headers for browser requests
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		// Handle preflight request
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		w.Header().Set("Content-Type", "application/json")

		if pool == nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			if err := json.NewEncoder(w).Encode(map[string]string{"status": "not ready", "reason": "database not configured"}); err != nil {
				log.Printf("Error encoding response: %v", err)
			}
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()

		if err := pool.Ping(ctx); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			if err := json.NewEncoder(w).Encode(map[string]string{"status": "not ready", "reason": err.Error()}); err != nil {
				log.Printf("Error encoding response: %v", err)
			}
			return
		}

		w.WriteHeader(http.StatusOK)
		if err := json.NewEncoder(w).Encode(map[string]string{"status": "ready"}); err != nil {
			log.Printf("Error encoding response: %v", err)
		}
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}

	log.Printf("Starting HTTP server on port %s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal("Server failed:", err)
	}
}
