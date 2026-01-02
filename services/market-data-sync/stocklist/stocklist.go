package stocklist

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"os"

	"cloud.google.com/go/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Stock holds stock info with priority flag
type Stock struct {
	Code       string
	IsPriority bool
}

// Service provides stock list operations with GCS integration and prioritization
type Service struct {
	db  *pgxpool.Pool
	gcs *storage.Client
}

// New creates a new StockListService
func New(db *pgxpool.Pool, gcs *storage.Client) *Service {
	return &Service{db: db, gcs: gcs}
}

// GetPrioritizedStocks returns all stocks with top shorted first
func (s *Service) GetPrioritizedStocks(ctx context.Context, bucket string, priorityCount int) ([]Stock, error) {
	// 1. Fetch full list from GCS (source of truth)
	allCodes, err := s.fetchFromGCS(ctx, bucket, "asx-stocks/latest.csv")
	if err != nil {
		return nil, fmt.Errorf("failed to fetch from GCS: %w", err)
	}

	log.Printf("📋 Fetched %d stocks from GCS", len(allCodes))

	// 2. Query top shorted stocks from database
	topShorted, err := s.fetchTopShorted(ctx, priorityCount)
	if err != nil {
		log.Printf("⚠️ Warning: could not fetch top shorted, using default order: %v", err)
		// Continue without prioritization - convert all to non-priority
		stocks := make([]Stock, len(allCodes))
		for i, code := range allCodes {
			stocks[i] = Stock{Code: code, IsPriority: false}
		}
		return stocks, nil
	}

	log.Printf("🔝 Fetched %d top shorted stocks for prioritization", len(topShorted))

	// 3. Build prioritized list
	return s.prioritize(allCodes, topShorted), nil
}

// fetchFromGCS fetches the stock list from GCS CSV file
func (s *Service) fetchFromGCS(ctx context.Context, bucket, object string) ([]string, error) {
	// Check if LOCAL_ASX_CSV is set (skip GCS entirely)
	if localPath := os.Getenv("LOCAL_ASX_CSV"); localPath != "" {
		log.Printf("ℹ️ Using local ASX CSV file: %s", localPath)
		return s.fetchFromLocalFile(localPath)
	}

	// Try GCS if client is available
	if s.gcs == nil {
		return nil, fmt.Errorf("GCS client is not initialized and LOCAL_ASX_CSV is not set")
	}

	obj := s.gcs.Bucket(bucket).Object(object)
	r, err := obj.NewReader(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to create reader for gs://%s/%s: %w", bucket, object, err)
	}
	defer r.Close()

	reader := csv.NewReader(r)

	// Read header
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("failed to read CSV header: %w", err)
	}

	// Find "ASX code" column
	codeIdx := -1
	for i, col := range header {
		if col == "ASX code" {
			codeIdx = i
			break
		}
	}

	if codeIdx == -1 {
		return nil, fmt.Errorf("column 'ASX code' not found in CSV header: %v", header)
	}

	var stocks []string
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			log.Printf("⚠️ Warning: error reading CSV row: %v", err)
			continue
		}
		if codeIdx < len(record) {
			code := record[codeIdx]
			if code != "" {
				stocks = append(stocks, code)
			}
		}
	}

	return stocks, nil
}

// fetchFromLocalFile reads stock list from a local CSV file (for development/testing)
func (s *Service) fetchFromLocalFile(filePath string) ([]string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open local file: %w", err)
	}
	defer file.Close()

	reader := csv.NewReader(file)

	// Read header
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("failed to read CSV header: %w", err)
	}

	// Find "ASX code" column
	codeIdx := -1
	for i, col := range header {
		if col == "ASX code" {
			codeIdx = i
			break
		}
	}

	if codeIdx == -1 {
		return nil, fmt.Errorf("column 'ASX code' not found in CSV header: %v", header)
	}

	var stocks []string
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			log.Printf("⚠️ Warning: error reading CSV row: %v", err)
			continue
		}
		if codeIdx < len(record) {
			code := record[codeIdx]
			if code != "" {
				stocks = append(stocks, code)
			}
		}
	}

	return stocks, nil
}

// fetchTopShorted fetches the top shorted stocks from the database
func (s *Service) fetchTopShorted(ctx context.Context, limit int) ([]string, error) {
	query := `
		SELECT "PRODUCT_CODE"
		FROM (
			SELECT DISTINCT ON ("PRODUCT_CODE") 
				"PRODUCT_CODE",
				"PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
			FROM shorts
			WHERE "DATE" = (SELECT MAX("DATE") FROM shorts)
			  AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
			ORDER BY "PRODUCT_CODE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
		) sub
		ORDER BY "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC
		LIMIT $1
	`

	rows, err := s.db.Query(ctx, query, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query top shorted stocks: %w", err)
	}
	defer rows.Close()

	var codes []string
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			log.Printf("⚠️ Warning: error scanning stock code: %v", err)
			continue
		}
		codes = append(codes, code)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating top shorted stocks: %w", err)
	}

	return codes, nil
}

// prioritize reorders the stock list with priority stocks first
func (s *Service) prioritize(all []string, priority []string) []Stock {
	prioritySet := make(map[string]bool)
	for _, code := range priority {
		prioritySet[code] = true
	}

	// Pre-allocate result slice
	result := make([]Stock, 0, len(all))

	// Add priority stocks first (in priority order)
	for _, code := range priority {
		result = append(result, Stock{Code: code, IsPriority: true})
	}

	// Add remaining stocks (non-priority)
	for _, code := range all {
		if !prioritySet[code] {
			result = append(result, Stock{Code: code, IsPriority: false})
		}
	}

	return result
}

// CountPriority counts how many priority stocks are in the list
func CountPriority(stocks []Stock) int {
	count := 0
	for _, s := range stocks {
		if s.IsPriority {
			count++
		}
	}
	return count
}
