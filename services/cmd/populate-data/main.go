package main

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/transform"
)

const (
	dataURL = "https://download.asic.gov.au/short-selling/short-selling-data.json"
	baseURL = "https://download.asic.gov.au/short-selling/"
	dataDir = "./data/shorts"
)

var (
	forceDownload = flag.Bool("force-download", false, "Re-download all CSV files even if they exist")
	skipDownload  = flag.Bool("skip-download", false, "Skip downloading, only process existing CSV files")
	forceReload   = flag.Bool("force-reload", false, "Truncate database and reload all data (ignores existing data)")
	limitRecords  = flag.Int("limit", 4000, "Number of recent records to process (default: 4000, covers all ASIC data back to 2010)")
)

type ShortSellingRecord struct {
	Date    int    `json:"date"`
	Version string `json:"version"`
}

type CSVRecord struct {
	Date                                                 time.Time
	Product                                              string
	ProductCode                                          string
	ReportedShortPositions                               float64
	TotalProductInIssue                                  float64
	PercentOfTotalProductInIssueReportedAsShortPositions float64
}

func main() {
	flag.Parse()
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	log.Println("🚀 Starting ASIC short selling data population...")

	// Create data directory
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return fmt.Errorf("failed to create data directory: %w", err)
	}

	// Connect to database first to check existing data
	log.Println("🔌 Connecting to database...")
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return fmt.Errorf("DATABASE_URL environment variable is required")
	}

	pool, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}
	defer pool.Close()

	// Test connection
	if err := pool.Ping(context.Background()); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}

	// Get existing dates from database
	existingDates, err := getExistingDates(pool)
	if err != nil {
		return fmt.Errorf("failed to get existing dates: %w", err)
	}
	log.Printf("📊 Found %d existing dates in database", len(existingDates))

	if len(existingDates) > 0 && !*forceReload {
		// Show date range
		var dates []time.Time
		for d := range existingDates {
			dates = append(dates, d)
		}
		sort.Slice(dates, func(i, j int) bool { return dates[i].Before(dates[j]) })
		log.Printf("   Existing data range: %s to %s", dates[0].Format("2006-01-02"), dates[len(dates)-1].Format("2006-01-02"))
	}

	var records []ShortSellingRecord

	if !*skipDownload {
		// Fetch available data records
		log.Println("📥 Fetching available data records from ASIC...")
		records, err = fetchDataRecords()
		if err != nil {
			return fmt.Errorf("failed to fetch data records: %w", err)
		}

		log.Printf("Found %d records available from ASIC", len(records))

		// Apply limit
		limit := *limitRecords
		if len(records) < limit {
			limit = len(records)
		}
		records = records[:limit]

		// Filter out records we already have (unless force reload)
		if !*forceReload && len(existingDates) > 0 {
			var missingRecords []ShortSellingRecord
			for _, r := range records {
				dateStr := fmt.Sprintf("%d", r.Date)
				t, err := time.Parse("20060102", dateStr)
				if err != nil {
					continue
				}
				if _, exists := existingDates[t]; !exists {
					missingRecords = append(missingRecords, r)
				}
			}
			log.Printf("📋 %d records missing from database (out of %d checked)", len(missingRecords), len(records))
			records = missingRecords
		}

		if len(records) == 0 {
			log.Println("✅ Database is up to date, no new records to process")
			return nil
		}

		// Download CSV files
		log.Printf("⬇️  Downloading %d CSV files...", len(records))
		if err := downloadCSVFiles(records); err != nil {
			return fmt.Errorf("failed to download CSV files: %w", err)
		}
	} else {
		log.Println("⏭️  Skipping download, using existing CSV files...")
	}

	// Process and load data
	log.Println("📊 Processing and loading data into database...")
	if err := processAndLoadData(pool, existingDates, records); err != nil {
		return fmt.Errorf("failed to process and load data: %w", err)
	}

	log.Println("✅ Data population completed successfully!")
	return nil
}

func getExistingDates(pool *pgxpool.Pool) (map[time.Time]bool, error) {
	ctx := context.Background()
	rows, err := pool.Query(ctx, `SELECT DISTINCT DATE("DATE") FROM shorts`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	dates := make(map[time.Time]bool)
	for rows.Next() {
		var d time.Time
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		// Normalize to date only (no time component)
		dates[time.Date(d.Year(), d.Month(), d.Day(), 0, 0, 0, 0, time.UTC)] = true
	}

	return dates, rows.Err()
}

func fetchDataRecords() ([]ShortSellingRecord, error) {
	resp, err := http.Get(dataURL)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			log.Printf("Error closing response body: %v", err)
		}
	}()

	var records []ShortSellingRecord
	if err := json.NewDecoder(resp.Body).Decode(&records); err != nil {
		return nil, err
	}

	return records, nil
}

func generateDownloadURL(record ShortSellingRecord) string {
	dateStr := fmt.Sprintf("%d", record.Date)
	year, month, day := dateStr[:4], dateStr[4:6], dateStr[6:]
	return fmt.Sprintf("%sRR%s%s%s-%s-SSDailyAggShortPos.csv", baseURL, year, month, day, record.Version)
}

func downloadCSVFiles(records []ShortSellingRecord) error {
	for i, record := range records {
		url := generateDownloadURL(record)
		filename := filepath.Base(url)
		filePath := filepath.Join(dataDir, filename)

		// Skip if file already exists (unless force download is enabled)
		if !*forceDownload {
			if _, err := os.Stat(filePath); err == nil {
				log.Printf("📄 [%d/%d] Skipping %s (already downloaded)", i+1, len(records), filename)
				continue
			}
		}

		log.Printf("📄 [%d/%d] Downloading %s...", i+1, len(records), filename)
		if err := downloadFile(url, filePath); err != nil {
			log.Printf("⚠️  Failed to download %s: %v", filename, err)
			continue
		}
	}
	return nil
}

func downloadFile(url, filePath string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			log.Printf("Error closing response body: %v", err)
		}
	}()

	file, err := os.Create(filePath)
	if err != nil {
		return err
	}
	defer func() {
		if err := file.Close(); err != nil {
			log.Printf("Error closing file: %v", err)
		}
	}()

	_, err = io.Copy(file, resp.Body)
	return err
}

func processAndLoadData(pool *pgxpool.Pool, existingDates map[time.Time]bool, recordsToProcess []ShortSellingRecord) error {
	ctx := context.Background()

	// If force reload, truncate the table
	if *forceReload {
		log.Println("🗑️  Force reload enabled - truncating shorts table...")
		_, err := pool.Exec(ctx, "TRUNCATE TABLE shorts")
		if err != nil {
			return fmt.Errorf("failed to truncate shorts table: %w", err)
		}
		existingDates = make(map[time.Time]bool) // Clear existing dates map
	}

	// Build set of dates we need to process
	datesToProcess := make(map[time.Time]bool)
	if *skipDownload {
		// Process all CSV files that aren't in database
		files, err := filepath.Glob(filepath.Join(dataDir, "*.csv"))
		if err != nil {
			return err
		}
		for _, file := range files {
			basename := filepath.Base(file)
			dateStr := strings.TrimPrefix(basename, "RR")
			if len(dateStr) >= 8 {
				dateStr = dateStr[:8]
				if t, err := time.Parse("20060102", dateStr); err == nil {
					normalizedDate := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
					if !existingDates[normalizedDate] {
						datesToProcess[normalizedDate] = true
					}
				}
			}
		}
	} else {
		// Process only the records we downloaded
		for _, r := range recordsToProcess {
			dateStr := fmt.Sprintf("%d", r.Date)
			if t, err := time.Parse("20060102", dateStr); err == nil {
				normalizedDate := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
				datesToProcess[normalizedDate] = true
			}
		}
	}

	if len(datesToProcess) == 0 {
		log.Println("✅ No new dates to process")
		return nil
	}

	// Get CSV files to process
	files, err := filepath.Glob(filepath.Join(dataDir, "*.csv"))
	if err != nil {
		return err
	}

	// Filter files to only those we need to process
	var filesToProcess []string
	for _, file := range files {
		basename := filepath.Base(file)
		dateStr := strings.TrimPrefix(basename, "RR")
		if len(dateStr) >= 8 {
			dateStr = dateStr[:8]
			if t, err := time.Parse("20060102", dateStr); err == nil {
				normalizedDate := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
				if datesToProcess[normalizedDate] || *forceReload {
					filesToProcess = append(filesToProcess, file)
				}
			}
		}
	}

	log.Printf("Processing %d CSV files...", len(filesToProcess))

	var allRecords []CSVRecord
	for i, file := range filesToProcess {
		log.Printf("📋 [%d/%d] Processing %s...", i+1, len(filesToProcess), filepath.Base(file))

		records, err := parseCSVFile(file)
		if err != nil {
			log.Printf("⚠️  Failed to parse %s: %v", filepath.Base(file), err)
			continue
		}

		allRecords = append(allRecords, records...)
	}

	if len(allRecords) == 0 {
		log.Println("✅ No new records to insert")
		return nil
	}

	log.Printf("💾 Loading %d records into database...", len(allRecords))

	// Batch upsert records
	return batchUpsertRecords(pool, allRecords)
}

func parseCSVFile(filename string) ([]CSVRecord, error) {
	// Extract date from filename
	basename := filepath.Base(filename)
	dateStr := strings.TrimPrefix(basename, "RR")
	dateStr = dateStr[:8] // Take first 8 characters (YYYYMMDD)

	date, err := time.Parse("20060102", dateStr)
	if err != nil {
		return nil, fmt.Errorf("failed to parse date from filename: %w", err)
	}

	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := file.Close(); err != nil {
			log.Printf("Error closing file: %v", err)
		}
	}()

	// Try to detect encoding and convert to UTF-8
	reader := transform.NewReader(file, charmap.Windows1252.NewDecoder())

	csvReader := csv.NewReader(reader)
	csvReader.LazyQuotes = true
	csvReader.TrimLeadingSpace = true

	// Read header
	headers, err := csvReader.Read()
	if err != nil {
		return nil, err
	}

	// Normalize headers
	headerMap := make(map[string]int)
	for i, header := range headers {
		normalized := strings.ToUpper(strings.TrimSpace(strings.ReplaceAll(header, " ", "_")))
		normalized = strings.ReplaceAll(normalized, "%", "PERCENT")
		headerMap[normalized] = i
	}

	var records []CSVRecord
	for {
		row, err := csvReader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			log.Printf("Warning: failed to read CSV row in %s: %v", filepath.Base(filename), err)
			continue
		}

		record := CSVRecord{Date: date}

		// Parse Product
		if idx, ok := headerMap["PRODUCT"]; ok && idx < len(row) {
			record.Product = strings.TrimSpace(row[idx])
		}

		// Parse Product Code
		if idx, ok := headerMap["PRODUCT_CODE"]; ok && idx < len(row) {
			record.ProductCode = strings.TrimSpace(row[idx])
		}

		// Parse Reported Short Positions
		if idx, ok := headerMap["REPORTED_SHORT_POSITIONS"]; ok && idx < len(row) {
			if val, err := strconv.ParseFloat(strings.TrimSpace(row[idx]), 64); err == nil {
				record.ReportedShortPositions = val
			}
		}

		// Parse Total Product in Issue
		if idx, ok := headerMap["TOTAL_PRODUCT_IN_ISSUE"]; ok && idx < len(row) {
			if val, err := strconv.ParseFloat(strings.TrimSpace(row[idx]), 64); err == nil {
				record.TotalProductInIssue = val
			}
		}

		// Parse Percentage
		percentKey := "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"
		if idx, ok := headerMap[percentKey]; ok && idx < len(row) {
			if val, err := strconv.ParseFloat(strings.TrimSpace(row[idx]), 64); err == nil {
				record.PercentOfTotalProductInIssueReportedAsShortPositions = val
			}
		}

		// Only add records with valid data
		if record.ProductCode != "" && record.Product != "" {
			records = append(records, record)
		}
	}

	return records, nil
}

func batchUpsertRecords(pool *pgxpool.Pool, records []CSVRecord) error {
	ctx := context.Background()

	// Process in smaller batches to avoid overwhelming the connection
	batchSize := 1000

	// Use ON CONFLICT to handle duplicates (upsert)
	sql := `INSERT INTO shorts ("DATE", "PRODUCT", "PRODUCT_CODE", "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
	        VALUES ($1, $2, $3, $4, $5, $6)
	        ON CONFLICT ("DATE", "PRODUCT_CODE") DO UPDATE SET
	            "PRODUCT" = EXCLUDED."PRODUCT",
	            "REPORTED_SHORT_POSITIONS" = EXCLUDED."REPORTED_SHORT_POSITIONS",
	            "TOTAL_PRODUCT_IN_ISSUE" = EXCLUDED."TOTAL_PRODUCT_IN_ISSUE",
	            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" = EXCLUDED."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"`

	totalInserted := 0
	for i := 0; i < len(records); i += batchSize {
		end := i + batchSize
		if end > len(records) {
			end = len(records)
		}

		batchRecords := records[i:end]
		log.Printf("💾 Upserting batch %d-%d of %d records...", i+1, end, len(records))

		// Begin transaction for this batch
		tx, err := pool.Begin(ctx)
		if err != nil {
			return fmt.Errorf("failed to begin transaction: %w", err)
		}

		// Prepare batch insert
		batch := &pgx.Batch{}
		for _, record := range batchRecords {
			batch.Queue(sql,
				record.Date,
				record.Product,
				record.ProductCode,
				record.ReportedShortPositions,
				record.TotalProductInIssue,
				record.PercentOfTotalProductInIssueReportedAsShortPositions,
			)
		}

		// Execute batch
		br := tx.SendBatch(ctx, batch)

		// Process results
		for j := 0; j < len(batchRecords); j++ {
			_, err := br.Exec()
			if err != nil {
				_ = br.Close()
				_ = tx.Rollback(ctx)
				return fmt.Errorf("failed to upsert record %d: %w", i+j, err)
			}
		}

		if err := br.Close(); err != nil {
			return fmt.Errorf("failed to close batch: %w", err)
		}

		// Commit transaction
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("failed to commit batch %d: %w", i/batchSize+1, err)
		}

		totalInserted += len(batchRecords)
	}

	log.Printf("✅ Successfully upserted %d records", totalInserted)
	return nil
}
