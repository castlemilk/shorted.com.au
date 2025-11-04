package testdata

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ShortData represents a short position record for testing
type ShortData struct {
	Date              time.Time
	ProductCode       string
	ProductName       string
	TotalShortPos     int64
	DailyShortVol     int64
	PercentOfShares   float64
	TotalProductIssue int64
}

// CompanyMetadata represents company metadata for testing
type CompanyMetadata struct {
	StockCode   string
	CompanyName string
	Sector      string
	Industry    string
	MarketCap   int64
	LogoURL     string
	Website     string
	Description string
	Exchange    string
}

// StockPrice represents historical stock price data for testing
type StockPrice struct {
	StockCode string
	Date      time.Time
	Open      float64
	High      float64
	Low       float64
	Close     float64
	Volume    int64
}

// Seeder provides methods to seed test data
type Seeder struct {
	db *pgxpool.Pool
}

// NewSeeder creates a new test data seeder
func NewSeeder(db *pgxpool.Pool) *Seeder {
	return &Seeder{db: db}
}

// SeedShorts inserts short position data
func (s *Seeder) SeedShorts(ctx context.Context, shorts []ShortData) error {
	if len(shorts) == 0 {
		return nil
	}

	query := `
		INSERT INTO shorts (
			date, product_code, product_name, total_short_position, 
			daily_short_volume, percent_of_total_shares
		) VALUES ($1, $2, $3, $4, $5, $6)
	`

	for _, short := range shorts {
		_, err := s.db.Exec(ctx, query,
			short.Date,
			short.ProductCode,
			short.ProductName,
			short.TotalShortPos,
			short.DailyShortVol,
			short.PercentOfShares,
		)
		if err != nil {
			return fmt.Errorf("failed to insert short data for %s: %w", short.ProductCode, err)
		}
	}

	return nil
}

// SeedCompanyMetadata inserts company metadata
func (s *Seeder) SeedCompanyMetadata(ctx context.Context, metadata []CompanyMetadata) error {
	if len(metadata) == 0 {
		return nil
	}

	query := `
		INSERT INTO "company-metadata" (
			stock_code, company_name, sector, industry, market_cap,
			logo_url, website, description, exchange
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (stock_code) DO UPDATE SET
			company_name = EXCLUDED.company_name,
			sector = EXCLUDED.sector,
			industry = EXCLUDED.industry,
			market_cap = EXCLUDED.market_cap
	`

	for _, meta := range metadata {
		_, err := s.db.Exec(ctx, query,
			meta.StockCode,
			meta.CompanyName,
			meta.Sector,
			meta.Industry,
			meta.MarketCap,
			meta.LogoURL,
			meta.Website,
			meta.Description,
			meta.Exchange,
		)
		if err != nil {
			return fmt.Errorf("failed to insert metadata for %s: %w", meta.StockCode, err)
		}
	}

	return nil
}

// SeedStockPrices inserts stock price data
func (s *Seeder) SeedStockPrices(ctx context.Context, prices []StockPrice) error {
	if len(prices) == 0 {
		return nil
	}

	query := `
		INSERT INTO stock_prices (
			stock_code, date, open, high, low, close, volume
		) VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (stock_code, date) DO UPDATE SET
			open = EXCLUDED.open,
			high = EXCLUDED.high,
			low = EXCLUDED.low,
			close = EXCLUDED.close,
			volume = EXCLUDED.volume
	`

	for _, price := range prices {
		_, err := s.db.Exec(ctx, query,
			price.StockCode,
			price.Date,
			price.Open,
			price.High,
			price.Low,
			price.Close,
			price.Volume,
		)
		if err != nil {
			return fmt.Errorf("failed to insert price data for %s on %s: %w",
				price.StockCode, price.Date.Format("2006-01-02"), err)
		}
	}

	return nil
}

// TruncateAll removes all data from test tables
func (s *Seeder) TruncateAll(ctx context.Context) error {
	tables := []string{
		"stock_prices",
		"shorts",
		"\"company-metadata\"",
		"subscriptions",
	}

	for _, table := range tables {
		_, err := s.db.Exec(ctx, fmt.Sprintf("TRUNCATE TABLE %s RESTART IDENTITY CASCADE", table))
		if err != nil {
			return fmt.Errorf("failed to truncate table %s: %w", table, err)
		}
	}

	return nil
}

