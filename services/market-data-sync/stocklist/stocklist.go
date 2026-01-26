package stocklist

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"strings"

	"cloud.google.com/go/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Stock holds stock info with priority flag
type Stock struct {
	Code       string
	IsPriority bool
}

// CompanyData holds full company information from ASX CSV
type CompanyData struct {
	Code        string
	CompanyName string
	Industry    string
	ListingDate string
	MarketCap   int64
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
	// 1. Fetch full list from GCS (source of truth) and sync company metadata
	companies, err := s.fetchCompaniesFromGCS(ctx, bucket, "asx-stocks/latest.csv")
	if err != nil {
		return nil, fmt.Errorf("failed to fetch from GCS: %w", err)
	}

	log.Printf("📋 Fetched %d companies from GCS", len(companies))

	// 2. Sync company metadata to database (upsert industry, name, market cap)
	synced, err := s.syncCompanyMetadata(ctx, companies)
	if err != nil {
		log.Printf("⚠️ Warning: failed to sync company metadata: %v", err)
	} else {
		log.Printf("✅ Synced %d companies to company-metadata", synced)
	}

	// 3. Extract stock codes for price sync
	allCodes := make([]string, len(companies))
	for i, c := range companies {
		allCodes[i] = c.Code
	}

	// 4. Query top shorted stocks from database
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

	// 5. Build prioritized list
	return s.prioritize(allCodes, topShorted), nil
}

// syncCompanyMetadata upserts company data from ASX CSV into company-metadata table
func (s *Service) syncCompanyMetadata(ctx context.Context, companies []CompanyData) (int, error) {
	if len(companies) == 0 {
		return 0, nil
	}

	query := `
		INSERT INTO "company-metadata" (stock_code, company_name, industry, market_cap)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (stock_code) DO UPDATE SET
			company_name = COALESCE(NULLIF(EXCLUDED.company_name, ''), "company-metadata".company_name),
			industry = COALESCE(NULLIF(EXCLUDED.industry, ''), "company-metadata".industry),
			market_cap = COALESCE(NULLIF(EXCLUDED.market_cap, ''), "company-metadata".market_cap),
			updated_at = CURRENT_TIMESTAMP
	`

	synced := 0
	for _, c := range companies {
		// Clean company name - remove common suffixes and title case
		cleanName := cleanCompanyName(c.CompanyName)

		// Convert market cap to string since the column is text type
		marketCapStr := ""
		if c.MarketCap > 0 {
			marketCapStr = strconv.FormatInt(c.MarketCap, 10)
		}

		_, err := s.db.Exec(ctx, query, c.Code, cleanName, c.Industry, marketCapStr)
		if err != nil {
			log.Printf("⚠️ Warning: failed to upsert company %s: %v", c.Code, err)
			continue
		}
		synced++
	}

	return synced, nil
}

// cleanCompanyName removes common suffixes and title cases the name
func cleanCompanyName(name string) string {
	if name == "" {
		return ""
	}

	result := strings.ToUpper(name)

	// Remove common suffixes
	suffixes := []string{
		" ORDINARY",
		" ORD",
		" CDI",
		" LIMITED",
		" LTD",
		" CORPORATION",
		" CORP",
		" INC",
		" PLC",
	}
	for _, suffix := range suffixes {
		result = strings.TrimSuffix(result, suffix)
	}

	// Title case
	result = strings.Title(strings.ToLower(strings.TrimSpace(result)))
	return result
}

// fetchCompaniesFromGCS fetches full company data from GCS CSV file
func (s *Service) fetchCompaniesFromGCS(ctx context.Context, bucket, object string) ([]CompanyData, error) {
	// Check if LOCAL_ASX_CSV is set (skip GCS entirely)
	if localPath := os.Getenv("LOCAL_ASX_CSV"); localPath != "" {
		log.Printf("ℹ️ Using local ASX CSV file: %s", localPath)
		return s.fetchCompaniesFromLocalFile(localPath)
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

	return s.parseCompaniesCSV(r)
}

// fetchCompaniesFromLocalFile reads company data from a local CSV file
func (s *Service) fetchCompaniesFromLocalFile(filePath string) ([]CompanyData, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to open local file: %w", err)
	}
	defer file.Close()

	return s.parseCompaniesCSV(file)
}

// parseCompaniesCSV parses company data from a CSV reader
func (s *Service) parseCompaniesCSV(r io.Reader) ([]CompanyData, error) {
	reader := csv.NewReader(r)

	// Read header
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("failed to read CSV header: %w", err)
	}

	// Find column indices
	indices := struct {
		code     int
		name     int
		industry int
		listing  int
		marketCap int
	}{-1, -1, -1, -1, -1}

	for i, col := range header {
		switch col {
		case "ASX code":
			indices.code = i
		case "Company name":
			indices.name = i
		case "GICs industry group":
			indices.industry = i
		case "Listing date":
			indices.listing = i
		case "Market Cap":
			indices.marketCap = i
		}
	}

	if indices.code == -1 {
		return nil, fmt.Errorf("column 'ASX code' not found in CSV header: %v", header)
	}

	var companies []CompanyData
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			log.Printf("⚠️ Warning: error reading CSV row: %v", err)
			continue
		}

		if indices.code >= len(record) || record[indices.code] == "" {
			continue
		}

		company := CompanyData{
			Code: record[indices.code],
		}

		if indices.name >= 0 && indices.name < len(record) {
			company.CompanyName = record[indices.name]
		}
		if indices.industry >= 0 && indices.industry < len(record) {
			company.Industry = record[indices.industry]
		}
		if indices.listing >= 0 && indices.listing < len(record) {
			company.ListingDate = record[indices.listing]
		}
		if indices.marketCap >= 0 && indices.marketCap < len(record) {
			if mc, err := strconv.ParseInt(record[indices.marketCap], 10, 64); err == nil {
				company.MarketCap = mc
			}
		}

		companies = append(companies, company)
	}

	return companies, nil
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
