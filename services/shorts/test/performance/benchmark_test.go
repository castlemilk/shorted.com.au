package performance

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand"
	"os"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	_ "github.com/lib/pq"
)

var (
	testDB     *sql.DB
	testStore  shortsstore.Store
	testServer *shorts.ShortsServer
)

// setupBenchmark initializes test environment for benchmarks
func setupBenchmark() error {
	// Database connection
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return fmt.Errorf("DATABASE_URL environment variable is required for benchmark tests")
	}
	
	var err error
	testDB, err = sql.Open("postgres", dbURL)
	if err != nil {
		return fmt.Errorf("failed to open database: %w", err)
	}
	
	if err = testDB.Ping(); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}
	
	// Initialize store
	storeConfig := shortsstore.Config{
		StorageBackend:   shortsstore.StorageBackend("postgres"),
		PostgresAddress:  "localhost:5432",
		PostgresUsername: "admin", 
		PostgresPassword: "password",
		PostgresDatabase: "shorts",
	}
	
	testStore, err = shortsstore.NewStore(storeConfig)
	if err != nil {
		return fmt.Errorf("failed to create store: %v", err)
	}
	
	// Initialize server (this would normally be done with proper config)
	ctx := context.Background()
	serverConfig := shorts.Config{
		// Add any required config here
	}
	testServer, err = shorts.New(ctx, serverConfig)
	if err != nil {
		return fmt.Errorf("failed to create server: %v", err)
	}
	
	return nil
}

// teardownBenchmark cleans up test resources
func teardownBenchmark() {
	if testDB != nil {
		testDB.Close()
	}
}

// BenchmarkGetTopShorts benchmarks the GetTopShorts endpoint
func BenchmarkGetTopShorts(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	// Test different period configurations
	periods := []string{"1w", "1m", "3m", "6m", "1y"}
	limits := []int32{5, 10, 25, 50}
	
	for _, period := range periods {
		for _, limit := range limits {
			b.Run(fmt.Sprintf("Period_%s_Limit_%d", period, limit), func(b *testing.B) {
				req := &connect.Request[shortsv1alpha1.GetTopShortsRequest]{
					Msg: &shortsv1alpha1.GetTopShortsRequest{
						Period: period,
						Limit:  limit,
						Offset: 0,
					},
				}
				
				b.ResetTimer()
				b.ReportAllocs()
				
				for i := 0; i < b.N; i++ {
					ctx := context.Background()
					_, err := testServer.GetTopShorts(ctx, req)
					if err != nil {
						b.Errorf("GetTopShorts failed: %v", err)
					}
				}
			})
		}
	}
}

// BenchmarkGetTopShortsParallel benchmarks GetTopShorts with parallel execution
func BenchmarkGetTopShortsParallel(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	req := &connect.Request[shortsv1alpha1.GetTopShortsRequest]{
		Msg: &shortsv1alpha1.GetTopShortsRequest{
			Period: "1m",
			Limit:  10,
			Offset: 0,
		},
	}
	
	b.ResetTimer()
	b.ReportAllocs()
	
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			ctx := context.Background()
			_, err := testServer.GetTopShorts(ctx, req)
			if err != nil {
				b.Errorf("GetTopShorts failed: %v", err)
			}
		}
	})
}

// BenchmarkGetStock benchmarks the GetStock endpoint
func BenchmarkGetStock(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	// Test with common stock codes
	stockCodes := []string{"CBA", "BHP", "ANZ", "WBC", "NAB", "CSL", "WOW", "TLS", "RIO", "WES"}
	
	for _, stockCode := range stockCodes {
		b.Run(fmt.Sprintf("Stock_%s", stockCode), func(b *testing.B) {
			req := &connect.Request[shortsv1alpha1.GetStockRequest]{
				Msg: &shortsv1alpha1.GetStockRequest{
					ProductCode: stockCode,
				},
			}
			
			b.ResetTimer()
			b.ReportAllocs()
			
			for i := 0; i < b.N; i++ {
				ctx := context.Background()
				_, err := testServer.GetStock(ctx, req)
				if err != nil {
					b.Errorf("GetStock failed for %s: %v", stockCode, err)
				}
			}
		})
	}
}

// BenchmarkGetStockParallel benchmarks GetStock with parallel execution
func BenchmarkGetStockParallel(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	stockCodes := []string{"CBA", "BHP", "ANZ", "WBC", "NAB"}
	
	b.ResetTimer()
	b.ReportAllocs()
	
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			// Random stock selection for more realistic load
			stockCode := stockCodes[rand.Intn(len(stockCodes))]
			
			req := &connect.Request[shortsv1alpha1.GetStockRequest]{
				Msg: &shortsv1alpha1.GetStockRequest{
					ProductCode: stockCode,
				},
			}
			
			ctx := context.Background()
			_, err := testServer.GetStock(ctx, req)
			if err != nil {
				b.Errorf("GetStock failed for %s: %v", stockCode, err)
			}
		}
	})
}

// BenchmarkGetStockData benchmarks the GetStockData endpoint
func BenchmarkGetStockData(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	periods := []string{"1w", "1m", "3m", "6m", "1y"}
	stockCode := "CBA" // Use a consistent stock for benchmarking
	
	for _, period := range periods {
		b.Run(fmt.Sprintf("Period_%s", period), func(b *testing.B) {
			req := &connect.Request[shortsv1alpha1.GetStockDataRequest]{
				Msg: &shortsv1alpha1.GetStockDataRequest{
					ProductCode: stockCode,
					Period:      period,
				},
			}
			
			b.ResetTimer()
			b.ReportAllocs()
			
			for i := 0; i < b.N; i++ {
				ctx := context.Background()
				_, err := testServer.GetStockData(ctx, req)
				if err != nil {
					b.Errorf("GetStockData failed: %v", err)
				}
			}
		})
	}
}

// BenchmarkGetStockDataParallel benchmarks GetStockData with parallel execution
func BenchmarkGetStockDataParallel(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	periods := []string{"1w", "1m", "3m", "6m"}
	stockCodes := []string{"CBA", "BHP", "ANZ", "WBC"}
	
	b.ResetTimer()
	b.ReportAllocs()
	
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			// Random selection for realistic load patterns
			period := periods[rand.Intn(len(periods))]
			stockCode := stockCodes[rand.Intn(len(stockCodes))]
			
			req := &connect.Request[shortsv1alpha1.GetStockDataRequest]{
				Msg: &shortsv1alpha1.GetStockDataRequest{
					ProductCode: stockCode,
					Period:      period,
				},
			}
			
			ctx := context.Background()
			_, err := testServer.GetStockData(ctx, req)
			if err != nil {
				b.Errorf("GetStockData failed: %v", err)
			}
		}
	})
}

// BenchmarkGetStockDetails benchmarks the GetStockDetails endpoint
func BenchmarkGetStockDetails(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	stockCodes := []string{"CBA", "BHP", "ANZ", "WBC", "NAB"}
	
	for _, stockCode := range stockCodes {
		b.Run(fmt.Sprintf("Stock_%s", stockCode), func(b *testing.B) {
			req := &connect.Request[shortsv1alpha1.GetStockDetailsRequest]{
				Msg: &shortsv1alpha1.GetStockDetailsRequest{
					ProductCode: stockCode,
				},
			}
			
			b.ResetTimer()
			b.ReportAllocs()
			
			for i := 0; i < b.N; i++ {
				ctx := context.Background()
				_, err := testServer.GetStockDetails(ctx, req)
				if err != nil {
					b.Errorf("GetStockDetails failed for %s: %v", stockCode, err)
				}
			}
		})
	}
}

// BenchmarkGetIndustryTreeMap benchmarks the GetIndustryTreeMap endpoint
func BenchmarkGetIndustryTreeMap(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	periods := []string{"1m", "3m", "6m"}
	limits := []int32{5, 10, 15, 20}
	viewModes := []shortsv1alpha1.ViewMode{
		shortsv1alpha1.ViewMode_CURRENT_CHANGE,
		shortsv1alpha1.ViewMode_PERCENTAGE_CHANGE,
	}
	
	for _, period := range periods {
		for _, limit := range limits {
			for _, viewMode := range viewModes {
				b.Run(fmt.Sprintf("Period_%s_Limit_%d_ViewMode_%s", period, limit, viewMode.String()), func(b *testing.B) {
					req := &connect.Request[shortsv1alpha1.GetIndustryTreeMapRequest]{
						Msg: &shortsv1alpha1.GetIndustryTreeMapRequest{
							Period:   period,
							Limit:    limit,
							ViewMode: viewMode,
						},
					}
					
					b.ResetTimer()
					b.ReportAllocs()
					
					for i := 0; i < b.N; i++ {
						ctx := context.Background()
						_, err := testServer.GetIndustryTreeMap(ctx, req)
						if err != nil {
							b.Errorf("GetIndustryTreeMap failed: %v", err)
						}
					}
				})
			}
		}
	}
}

// BenchmarkDatabaseQueries benchmarks raw database queries
func BenchmarkDatabaseQueries(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	b.Run("GetTopShorts_Query", func(b *testing.B) {
		query := `
			SELECT product_code, product_name 
			FROM shorts 
			WHERE date >= NOW() - INTERVAL '1 month'
			ORDER BY reported_short_positions_percent_of_issued_shares DESC 
			LIMIT 10
		`
		
		b.ResetTimer()
		b.ReportAllocs()
		
		for i := 0; i < b.N; i++ {
			rows, err := testDB.Query(query)
			if err != nil {
				b.Errorf("Query failed: %v", err)
				continue
			}
			
			// Consume all rows to ensure full query execution
			count := 0
			for rows.Next() {
				var productCode, productName string
				if err := rows.Scan(&productCode, &productName); err != nil {
					b.Errorf("Scan failed: %v", err)
				}
				count++
			}
			rows.Close()
		}
	})
	
	b.Run("GetStock_Query", func(b *testing.B) {
		query := `
			SELECT product_code, product_name, 
				   reported_short_positions_percent_of_issued_shares,
				   date
			FROM shorts 
			WHERE product_code = $1 
			ORDER BY date DESC 
			LIMIT 1
		`
		
		stockCode := "CBA"
		
		b.ResetTimer()
		b.ReportAllocs()
		
		for i := 0; i < b.N; i++ {
			rows, err := testDB.Query(query, stockCode)
			if err != nil {
				b.Errorf("Query failed: %v", err)
				continue
			}
			
			for rows.Next() {
				var productCode, productName string
				var percent float64
				var date time.Time
				if err := rows.Scan(&productCode, &productName, &percent, &date); err != nil {
					b.Errorf("Scan failed: %v", err)
				}
			}
			rows.Close()
		}
	})
}

// BenchmarkMemoryUsage benchmarks memory usage patterns
func BenchmarkMemoryUsage(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	b.Run("LargeResult_GetTopShorts", func(b *testing.B) {
		req := &connect.Request[shortsv1alpha1.GetTopShortsRequest]{
			Msg: &shortsv1alpha1.GetTopShortsRequest{
				Period: "1y", // Large dataset
				Limit:  100,  // Large limit
				Offset: 0,
			},
		}
		
		b.ResetTimer()
		b.ReportAllocs()
		
		for i := 0; i < b.N; i++ {
			ctx := context.Background()
			resp, err := testServer.GetTopShorts(ctx, req)
			if err != nil {
				b.Errorf("GetTopShorts failed: %v", err)
				continue
			}
			
			// Access response data to ensure it's fully loaded
			if resp.Msg != nil && len(resp.Msg.TimeSeries) > 0 {
				_ = resp.Msg.TimeSeries[0].ProductCode
			}
		}
	})
	
	b.Run("HistoricalData_GetStockData", func(b *testing.B) {
		req := &connect.Request[shortsv1alpha1.GetStockDataRequest]{
			Msg: &shortsv1alpha1.GetStockDataRequest{
				ProductCode: "CBA",
				Period:      "5y", // Large time range
			},
		}
		
		b.ResetTimer()
		b.ReportAllocs()
		
		for i := 0; i < b.N; i++ {
			ctx := context.Background()
			resp, err := testServer.GetStockData(ctx, req)
			if err != nil {
				b.Errorf("GetStockData failed: %v", err)
				continue
			}
			
			// Access response data
			if resp.Msg != nil && len(resp.Msg.Points) > 0 {
				_ = resp.Msg.Points[0].Timestamp
			}
		}
	})
}

// BenchmarkCacheEffectiveness measures cache performance
func BenchmarkCacheEffectiveness(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	req := &connect.Request[shortsv1alpha1.GetTopShortsRequest]{
		Msg: &shortsv1alpha1.GetTopShortsRequest{
			Period: "1m",
			Limit:  10,
			Offset: 0,
		},
	}
	
	// First call to warm up cache
	ctx := context.Background()
	testServer.GetTopShorts(ctx, req)
	
	b.ResetTimer()
	b.ReportAllocs()
	
	// Subsequent calls should hit cache
	for i := 0; i < b.N; i++ {
		_, err := testServer.GetTopShorts(ctx, req)
		if err != nil {
			b.Errorf("GetTopShorts failed: %v", err)
		}
	}
}

// BenchmarkConcurrentAccess benchmarks concurrent access patterns
func BenchmarkConcurrentAccess(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	stockCodes := []string{"CBA", "BHP", "ANZ", "WBC", "NAB"}
	
	b.Run("MixedEndpoints", func(b *testing.B) {
		b.ResetTimer()
		b.ReportAllocs()
		
		b.RunParallel(func(pb *testing.PB) {
			for pb.Next() {
				ctx := context.Background()
				
				// Simulate mixed workload
				switch rand.Intn(4) {
				case 0:
					req := &connect.Request[shortsv1alpha1.GetTopShortsRequest]{
						Msg: &shortsv1alpha1.GetTopShortsRequest{
							Period: "1m",
							Limit:  10,
							Offset: 0,
						},
					}
					testServer.GetTopShorts(ctx, req)
					
				case 1:
					stockCode := stockCodes[rand.Intn(len(stockCodes))]
					req := &connect.Request[shortsv1alpha1.GetStockRequest]{
						Msg: &shortsv1alpha1.GetStockRequest{
							ProductCode: stockCode,
						},
					}
					testServer.GetStock(ctx, req)
					
				case 2:
					stockCode := stockCodes[rand.Intn(len(stockCodes))]
					req := &connect.Request[shortsv1alpha1.GetStockDataRequest]{
						Msg: &shortsv1alpha1.GetStockDataRequest{
							ProductCode: stockCode,
							Period:      "1m",
						},
					}
					testServer.GetStockData(ctx, req)
					
				case 3:
					req := &connect.Request[shortsv1alpha1.GetIndustryTreeMapRequest]{
						Msg: &shortsv1alpha1.GetIndustryTreeMapRequest{
							Period:   "1m",
							Limit:    10,
							ViewMode: shortsv1alpha1.ViewMode_CURRENT_CHANGE,
						},
					}
					testServer.GetIndustryTreeMap(ctx, req)
				}
			}
		})
	})
}

// BenchmarkDatabaseConnectionPool benchmarks connection pool behavior
func BenchmarkDatabaseConnectionPool(b *testing.B) {
	if err := setupBenchmark(); err != nil {
		b.Fatalf("Failed to setup benchmark: %v", err)
	}
	defer teardownBenchmark()
	
	// Simple query to test connection acquisition/release
	query := "SELECT COUNT(*) FROM shorts"
	
	b.ResetTimer()
	b.ReportAllocs()
	
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			var count int
			err := testDB.QueryRow(query).Scan(&count)
			if err != nil {
				b.Errorf("Query failed: %v", err)
			}
		}
	})
}