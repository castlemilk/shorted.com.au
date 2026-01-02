//go:build integration
// +build integration

package main

import (
	"context"
	"os"
	"testing"
	"time"

	"cloud.google.com/go/storage"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/providers"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/sync"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/option"
)

func TestMarketDataSync_FullCycle(t *testing.T) {
	ctx := context.Background()

	// 1. Setup DB
	pool, err := pgxpool.New(ctx, testDBURL)
	require.NoError(t, err)
	defer pool.Close()

	// 2. Setup GCS Emulator Client
	os.Setenv("STORAGE_EMULATOR_HOST", testGCSURL)
	gcsClient, err := storage.NewClient(ctx, option.WithoutAuthentication())
	require.NoError(t, err)
	defer gcsClient.Close()

	// 3. Create mock CSV in GCS
	bucketName := "test-bucket"
	err = gcsClient.Bucket(bucketName).Create(ctx, "test-project", nil)
	require.NoError(t, err)

	csvData := "ASX code,Company name\nCBA,COMMONWEALTH BANK\nBHP,BHP GROUP LIMITED"
	w := gcsClient.Bucket(bucketName).Object("asx-stocks/latest.csv").NewWriter(ctx)
	_, err = w.Write([]byte(csvData))
	require.NoError(t, err)
	err = w.Close()
	require.NoError(t, err)

	// 4. Run Sync with mock provider
	mockProvider := &mockDataProvider{}
	syncManager := sync.NewSyncManager(pool, gcsClient, []providers.DataProvider{mockProvider})

	t.Run("sync_new_stocks", func(t *testing.T) {
		err := syncManager.Run(ctx, bucketName)
		require.NoError(t, err)

		// Verify data in DB
		var count int
		err = pool.QueryRow(ctx, "SELECT COUNT(*) FROM stock_prices").Scan(&count)
		require.NoError(t, err)
		assert.Equal(t, 4, count) // 2 stocks * 2 days of mock data

		// Verify sync_status
		var status string
		err = pool.QueryRow(ctx, "SELECT status FROM sync_status ORDER BY started_at DESC LIMIT 1").Scan(&status)
		require.NoError(t, err)
		assert.Equal(t, "completed", status)
	})
}

// Mock Data Provider for testing
type mockDataProvider struct{}

func (m *mockDataProvider) Name() string { return "Mock Provider" }
func (m *mockDataProvider) GetRateLimit() time.Duration { return 0 }
func (m *mockDataProvider) FetchHistoricalData(ctx context.Context, symbol string, startDate, endDate time.Time) ([]providers.PriceRecord, error) {
	return []providers.PriceRecord{
		{StockCode: symbol, Date: time.Now().AddDate(0, 0, -1), Close: 100.0, Volume: 1000},
		{StockCode: symbol, Date: time.Now().AddDate(0, 0, -2), Close: 99.0, Volume: 1100},
	}, nil
}
